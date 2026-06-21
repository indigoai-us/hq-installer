import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { gzipSync } from "fflate";

// template-fetcher.ts imports fetch from @tauri-apps/plugin-http so GitHub
// requests go through Rust reqwest (bypassing WKWebView CORS). In tests, we
// delegate to globalThis.fetch so the existing stubbing pattern keeps working.
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (input: RequestInfo | URL, init?: RequestInit) =>
    globalThis.fetch(input, init),
}));

// template-fetcher invokes Rust filesystem commands for install-path writes.
// Capture invocations so tests can assert what was sent without booting Tauri.
const mockInvoke = vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(
  async () => undefined,
);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => mockInvoke(cmd, args),
}));

// ---------------------------------------------------------------------------
// Import module under test AFTER mocks are registered
// ---------------------------------------------------------------------------

import {
  fetchAndExtract,
  TemplateFetchError,
  type ProgressEvent,
} from "../template-fetcher.js";
import { DOWNLOAD_HARD_STALL_MS } from "../timeouts.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal tar buffer with file and/or symlink entries.
 * Layout: [512-byte header][padded data blocks]
 *
 * - Regular file: `content` set, `linkname` absent → typeflag '0', data
 *   blocks follow the header.
 * - Symlink: `linkname` set → typeflag '2', size=0, link target lives in
 *   the header's `linkname` field at offset 157–256 (no data blocks).
 */
type TarEntryInput =
  | { name: string; content: string; linkname?: undefined }
  | { name: string; content?: undefined; linkname: string };

function buildTarBuffer(entries: TarEntryInput[]): Uint8Array {
  const blocks: Uint8Array[] = [];

  const encoder = new TextEncoder();

  const writeHeader = (
    name: string,
    size: number,
    typeflag: "0" | "2",
    linkname?: string,
  ): Uint8Array => {
    const header = new Uint8Array(512);
    const nameBytes = encoder.encode(name.slice(0, 100));
    header.set(nameBytes, 0);

    // mode
    const modeBytes = encoder.encode("0000644\0");
    header.set(modeBytes, 100);

    // uid / gid
    const zeroOctal = encoder.encode("0000000\0");
    header.set(zeroOctal, 108);
    header.set(zeroOctal, 116);

    // size (octal, 11 digits + null) — 0 for symlinks (no data block)
    const sizeStr = size.toString(8).padStart(11, "0") + "\0";
    header.set(encoder.encode(sizeStr), 124);

    // mtime
    const mtime = Math.floor(Date.now() / 1000).toString(8).padStart(11, "0") + "\0";
    header.set(encoder.encode(mtime), 136);

    // typeflag — '0' regular file, '2' symbolic link
    header[156] = typeflag.charCodeAt(0);

    // linkname (offset 157, 100 bytes, null-padded) — only set for symlinks
    if (linkname !== undefined) {
      const linkBytes = encoder.encode(linkname.slice(0, 100));
      header.set(linkBytes, 157);
    }

    // magic "ustar"
    header.set(encoder.encode("ustar\0"), 257);
    header.set(encoder.encode("00"), 263);

    // Compute checksum
    let checksum = 0;
    // Treat checksum field (148-155) as spaces for calculation
    for (let i = 0; i < 512; i++) {
      checksum += i >= 148 && i < 156 ? 32 : header[i];
    }
    const checksumStr = checksum.toString(8).padStart(6, "0") + "\0 ";
    header.set(encoder.encode(checksumStr), 148);

    return header;
  };

  for (const entry of entries) {
    if (entry.linkname !== undefined) {
      // Symlink: size=0, no data block follows.
      blocks.push(writeHeader(entry.name, 0, "2", entry.linkname));
    } else {
      const data = encoder.encode(entry.content);
      blocks.push(writeHeader(entry.name, data.length, "0"));

      // Pad data to 512-byte boundary
      const paddedSize = Math.ceil(data.length / 512) * 512;
      const paddedData = new Uint8Array(paddedSize);
      paddedData.set(data, 0);
      blocks.push(paddedData);
    }
  }

  // Two 512-byte zero EOF blocks
  blocks.push(new Uint8Array(512));
  blocks.push(new Uint8Array(512));

  const total = blocks.reduce((n, b) => n + b.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) {
    result.set(block, offset);
    offset += block.length;
  }
  return result;
}

/**
 * Build a .tar.gz with GitHub's top-level prefix dir.
 * Entry names like `indigoai-us-hq-abc123/path/to/file.ts`
 */
function buildGitHubTarGz(entries: TarEntryInput[]): Uint8Array {
  const prefixed: TarEntryInput[] = entries.map((e) =>
    e.linkname !== undefined
      ? { name: `indigoai-us-hq-abc123/${e.name}`, linkname: e.linkname }
      : { name: `indigoai-us-hq-abc123/${e.name}`, content: e.content },
  );
  const tarBuf = buildTarBuffer(prefixed);
  return gzipSync(tarBuf);
}

/** Build a mock Response that returns a tar.gz body */
function mockTarGzResponse(tarGzBytes: Uint8Array): Response {
  const chunks = [tarGzBytes];
  let chunkIdx = 0;

  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (chunkIdx < chunks.length) {
        controller.enqueue(chunks[chunkIdx++]);
      } else {
        controller.close();
      }
    },
  });

  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers({ "content-length": String(tarGzBytes.length) }),
    body: stream,
    arrayBuffer: async () => tarGzBytes.buffer,
    json: async () => ({}),
    text: async () => "",
  } as unknown as Response;
}

/** Build a minimal valid release JSON object */
function makeRelease(overrides?: Partial<{
  tag_name: string;
  tarball_url: string;
  prerelease: boolean;
  draft: boolean;
}>) {
  return {
    tag_name: "v1.2.3",
    tarball_url: "https://codeload.github.com/indigoai-us/hq-core/legacy.tar.gz/abc123",
    prerelease: false,
    draft: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

const mockFetch = vi.fn<typeof fetch>();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
  mockInvoke.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

function writeFileCalls(): Array<{
  absolutePath: string;
  relativePath: string;
  contents: Uint8Array;
  installRoot: string;
  mode?: number;
}> {
  return mockInvoke.mock.calls
    .filter(([cmd]) => cmd === "write_file")
    .map(([, args]) => {
      const payload = args as {
        path: string;
        contents: number[];
        installRoot: string;
        mode?: number;
      };
      return {
        absolutePath: `${payload.installRoot.replace(/[\\/]+$/, "")}/${payload.path}`,
        relativePath: payload.path,
        contents: Uint8Array.from(payload.contents),
        installRoot: payload.installRoot,
        mode: payload.mode,
      };
    });
}

function writePaths(): string[] {
  return writeFileCalls().map((call) => call.absolutePath);
}

function makeDirCalls(): Array<{ path: string; installRoot: string }> {
  return mockInvoke.mock.calls
    .filter(([cmd]) => cmd === "make_dir")
    .map(([, args]) => args as { path: string; installRoot: string });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("fetchAndExtract", () => {
  // -------------------------------------------------------------------------
  it("success: extracts tarball contents into targetDir and returns version", async () => {
    // hq-core is a standalone template repo — the repo root IS the template.
    // The fetcher strips only the GitHub tarball wrapper (indigoai-us-hq-core-<sha>/)
    // and writes everything inside it.
    const tarGzBytes = buildGitHubTarGz([
      { name: "core.yaml", content: "version: 10.2.0" },
      { name: ".claude/CLAUDE.md", content: "# HQ template" },
      { name: "README.md", content: "hq-core readme" },
      { name: "companies/sample/page.md", content: "starter" },
    ]);

    // First fetch call = releases list
    // Second fetch call = tarball
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [makeRelease()],
      } as unknown as Response)
      .mockResolvedValueOnce(mockTarGzResponse(tarGzBytes));

    const progressEvents: ProgressEvent[] = [];
    const result = await fetchAndExtract(
      "/tmp/target",
      undefined,
      (ev) => progressEvents.push(ev),
    );

    // Correct version returned
    expect(result.version).toBe("v1.2.3");

    // At least one progress event emitted
    expect(progressEvents.length).toBeGreaterThan(0);
    expect(progressEvents[progressEvents.length - 1].bytes).toBeGreaterThan(0);

    // targetDir is created through the root-validated Rust command
    expect(makeDirCalls()).toContainEqual({
      path: "/tmp/target",
      installRoot: "/tmp/target",
    });

    // All entries extracted with the tarball wrapper stripped
    const paths = writePaths();
    expect(paths).toContain("/tmp/target/core.yaml");
    expect(paths).toContain("/tmp/target/.claude/CLAUDE.md");
    expect(paths).toContain("/tmp/target/README.md");
    expect(paths).toContain("/tmp/target/companies/sample/page.md");

    // Correct content for core.yaml
    const coreCall = writeFileCalls().find(
      (c) => c.absolutePath === "/tmp/target/core.yaml",
    );
    expect(coreCall).toBeDefined();
    const coreContent = new TextDecoder().decode(coreCall!.contents);
    expect(coreContent).toBe("version: 10.2.0");
  });

  // -------------------------------------------------------------------------
  it("success with pinned tag: uses tags endpoint", async () => {
    const tarGzBytes = buildGitHubTarGz([
      { name: "README.md", content: "# HQ" },
    ]);

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => makeRelease({ tag_name: "v0.9.0" }),
      } as unknown as Response)
      .mockResolvedValueOnce(mockTarGzResponse(tarGzBytes));

    const result = await fetchAndExtract("/tmp/pinned", "v0.9.0");

    expect(result.version).toBe("v0.9.0");

    // The first fetch should use the tags endpoint
    const firstUrl = mockFetch.mock.calls[0][0] as string;
    expect(firstUrl).toContain("releases/tags/v0.9.0");

    // After stripping the tarball wrapper, README lands at the root of targetDir.
    expect(writePaths()).toContain("/tmp/pinned/README.md");
  });

  // -------------------------------------------------------------------------
  it("404 error: throws TemplateFetchError with retriable=false", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: "Not Found",
      json: async () => ({}),
    } as unknown as Response);

    await expect(fetchAndExtract("/tmp/target", "v9.9.9")).rejects.toSatisfy(
      (err: unknown) => {
        expect(err).toBeInstanceOf(TemplateFetchError);
        expect((err as TemplateFetchError).retriable).toBe(false);
        expect((err as TemplateFetchError).message).toContain("404");
        return true;
      },
    );
  });

  // -------------------------------------------------------------------------
  it("500 error: throws TemplateFetchError with retriable=true", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      json: async () => ({}),
    } as unknown as Response);

    await expect(fetchAndExtract("/tmp/target")).rejects.toSatisfy(
      (err: unknown) => {
        expect(err).toBeInstanceOf(TemplateFetchError);
        expect((err as TemplateFetchError).retriable).toBe(true);
        expect((err as TemplateFetchError).message).toContain("500");
        return true;
      },
    );
  });

  // -------------------------------------------------------------------------
  it("aborts a stalled stream read and throws a stalled retriable error", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [makeRelease()],
      } as unknown as Response)
      .mockImplementationOnce(async (_input, init) => {
        requestSignal = init?.signal ?? undefined;
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Headers({ "content-length": "1024" }),
          body: {
            getReader: () => ({
              read: () => new Promise<ReadableStreamReadResult<Uint8Array>>(() => {}),
              cancel: vi.fn().mockResolvedValue(undefined),
            }),
          },
          arrayBuffer: async () => new ArrayBuffer(0),
          json: async () => ({}),
          text: async () => "",
        } as unknown as Response;
      });

    const stalled = fetchAndExtract("/tmp/stalled").catch((err: unknown) => err);
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));

    await vi.advanceTimersByTimeAsync(DOWNLOAD_HARD_STALL_MS);

    const err = await stalled;
    expect(err).toBeInstanceOf(TemplateFetchError);
    expect((err as TemplateFetchError).retriable).toBe(true);
    expect((err as TemplateFetchError).stalled).toBe(true);
    expect(requestSignal?.aborted).toBe(true);
  });

  // -------------------------------------------------------------------------
  it("cancellation: pre-aborted signal throws TemplateFetchError", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      fetchAndExtract("/tmp/target", undefined, undefined, controller.signal),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(TemplateFetchError);
      expect((err as TemplateFetchError).message).toContain("cancel");
      return true;
    });

    // fetch should never have been called
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  it("network drop: fetch throws network error → retriable TemplateFetchError", async () => {
    mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    await expect(fetchAndExtract("/tmp/target")).rejects.toSatisfy(
      (err: unknown) => {
        expect(err).toBeInstanceOf(TemplateFetchError);
        expect((err as TemplateFetchError).retriable).toBe(true);
        return true;
      },
    );
  });

  // -------------------------------------------------------------------------
  it("path traversal: entries with '..' segments are silently skipped", async () => {
    // Build a tar with malicious entries that try to escape targetDir via "..".
    // safeJoin must reject them after the wrapper is stripped.
    const tarGzBytes = buildGitHubTarGz([
      { name: "safe.txt", content: "safe" },
      { name: "../../etc/passwd", content: "root:x:0:0" },
      { name: "../../../etc/shadow", content: "denied" },
    ]);

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [makeRelease()],
      } as unknown as Response)
      .mockResolvedValueOnce(mockTarGzResponse(tarGzBytes));

    await fetchAndExtract("/tmp/target");

    // Only the safe file should have been written
    const paths = writePaths();
    expect(paths).toContain("/tmp/target/safe.txt");
    // Neither traversal path must ever have been written
    expect(paths.every((p) => !p.includes("passwd"))).toBe(true);
    expect(paths.every((p) => !p.includes("shadow"))).toBe(true);
    expect(paths.every((p) => !p.includes("/etc/"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  it("mid-stream cancellation: AbortSignal aborted during stream read throws non-retriable error", async () => {
    const tarGzBytes = buildGitHubTarGz([
      { name: "big-file.ts", content: "x".repeat(1000) },
    ]);

    const controller = new AbortController();

    // Build a stream that aborts the controller when it starts delivering data
    let chunkIdx = 0;
    const chunks = [tarGzBytes];
    const stream = new ReadableStream<Uint8Array>({
      pull(streamController) {
        if (chunkIdx === 0) {
          // Abort before delivering any data
          controller.abort();
        }
        if (chunkIdx < chunks.length) {
          streamController.enqueue(chunks[chunkIdx++]);
        } else {
          streamController.close();
        }
      },
    });

    const tarballResponse = {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-length": String(tarGzBytes.length) }),
      body: stream,
      arrayBuffer: async () => tarGzBytes.buffer,
      json: async () => ({}),
      text: async () => "",
    } as unknown as Response;

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [makeRelease()],
      } as unknown as Response)
      .mockResolvedValueOnce(tarballResponse);

    await expect(
      fetchAndExtract("/tmp/target", undefined, undefined, controller.signal),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(TemplateFetchError);
      expect((err as TemplateFetchError).retriable).toBe(false);
      expect((err as TemplateFetchError).message).toContain("cancel");
      return true;
    });
  });

  // -------------------------------------------------------------------------
  it("fallback: empty releases list → fetches branch snapshot via /tarball/HEAD", async () => {
    // Mirrors how `create-hq` copes with a repo that has no published
    // releases yet. `/repos/{REPO}/releases` returns `[]` (200 OK with an
    // empty array — NOT 404) and the fetcher falls back to
    // `api.github.com/repos/{REPO}/tarball/HEAD` which 302s to codeload.
    const tarGzBytes = buildGitHubTarGz([
      { name: "core.yaml", content: "version: HEAD" },
    ]);

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [], // <-- no releases published yet
      } as unknown as Response)
      .mockResolvedValueOnce(mockTarGzResponse(tarGzBytes));

    const result = await fetchAndExtract("/tmp/target");

    // "HEAD" is how we signal "no tagged version" — matches `create-hq`'s
    // contract for the same fallback path.
    expect(result.version).toBe("HEAD");

    // Second fetch must target the branch-snapshot endpoint.
    const secondUrl = mockFetch.mock.calls[1][0] as string;
    expect(secondUrl).toBe(
      "https://api.github.com/repos/indigoai-us/hq-core/tarball/HEAD",
    );

    // Entries land at the root of targetDir on the fallback path too.
    expect(writePaths()).toContain("/tmp/target/core.yaml");
  });

  // -------------------------------------------------------------------------
  it("staging source: source override downloads natively and returns ref as version", async () => {
    // When the App-menu "Use Staging Channel" toggle is on, the staging-channel
    // caller passes `source = { repo: 'indigoai-us/hq-core-staging', ref: 'main' }`.
    // The fetcher must:
    //   - skip the releases endpoint entirely (one fetch call, not two)
    //   - hit /repos/<override repo>/tarball/<ref>
    //   - return the ref as the version
    const tarGzBytes = buildGitHubTarGz([
      { name: "core.yaml", content: "version: staging-main" },
      { name: "README.md", content: "from staging" },
    ]);

    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "download_staging_tarball") return Array.from(tarGzBytes);
      return undefined;
    });

    const result = await fetchAndExtract(
      "/tmp/target",
      undefined,
      undefined,
      undefined,
      { repo: "indigoai-us/hq-core-staging", ref: "main" },
    );

    expect(result.version).toBe("main");
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockInvoke).toHaveBeenCalledWith("download_staging_tarball", undefined);

    const paths = writePaths();
    expect(paths).toContain("/tmp/target/core.yaml");
    expect(paths).toContain("/tmp/target/README.md");
  });

  // -------------------------------------------------------------------------
  it("staging source: downloads tarball natively so GitHub tokens stay out of the renderer", async () => {
    // hq-core-staging is a private repo. The fetcher must not put a GitHub
    // token into renderer-owned fetch headers; Rust owns the authenticated
    // download and returns only tarball bytes.
    const tarGzBytes = buildGitHubTarGz([
      { name: "core.yaml", content: "native auth ok" },
    ]);
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "download_staging_tarball") return Array.from(tarGzBytes);
      return undefined;
    });

    await fetchAndExtract(
      "/tmp/target",
      undefined,
      undefined,
      undefined,
      {
        repo: "indigoai-us/hq-core-staging",
        ref: "main",
      },
    );

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockInvoke).toHaveBeenCalledWith("download_staging_tarball", undefined);
    expect(writePaths()).toContain("/tmp/target/core.yaml");
  });

  // -------------------------------------------------------------------------
  it("public default: no authToken means no Authorization header (anonymous request)", async () => {
    // Regression guard: today's anonymous flow against the public hq-core
    // repo must keep working. Sending an empty bearer header could be
    // rejected by GitHub as malformed, so absence-not-empty matters.
    const tarGzBytes = buildGitHubTarGz([
      { name: "core.yaml", content: "anon" },
    ]);
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [makeRelease()],
      } as unknown as Response)
      .mockResolvedValueOnce(mockTarGzResponse(tarGzBytes));

    await fetchAndExtract("/tmp/target");

    for (const [, init] of mockFetch.mock.calls) {
      const headers = ((init as RequestInit | undefined)?.headers ?? {}) as Record<
        string,
        string
      >;
      expect(headers.Authorization).toBeUndefined();
    }
  });

  // -------------------------------------------------------------------------
  it("symlinks: typeflag '2' entries create real symlinks via Rust create_symlink command", async () => {
    // hq-core(-staging) ships git symlinks (mode 120000) like
    // `AGENTS.md → .claude/CLAUDE.md`. In tar these arrive with typeflag '2'
    // and the link target in the header's `linkname` field (offset 157-256),
    // not in a data block. The old parser fell through to writeFile() with
    // empty entry.data, producing zero-byte regular files. The fix routes
    // typeflag '2' entries to the Rust `create_symlink` command (plugin-fs
    // doesn't expose `symlink` from JS).
    const tarGzBytes = buildGitHubTarGz([
      { name: "AGENTS.md", linkname: ".claude/CLAUDE.md" },
      { name: ".codex/output-style.md", linkname: "../.claude/output-style.md" },
      { name: "real-file.txt", content: "regular files still work" },
    ]);

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [makeRelease()],
      } as unknown as Response)
      .mockResolvedValueOnce(mockTarGzResponse(tarGzBytes));

    await fetchAndExtract("/tmp/target");

    // Two symlink entries → two `create_symlink` invocations with the
    // resolved on-disk link path + the literal link target from the tar header.
    const symlinkCalls = mockInvoke.mock.calls.filter(
      ([cmd]) => cmd === "create_symlink",
    );
    expect(symlinkCalls).toHaveLength(2);

    // AGENTS.md → .claude/CLAUDE.md
    expect(symlinkCalls).toContainEqual([
      "create_symlink",
      {
        target: ".claude/CLAUDE.md",
        linkPath: "/tmp/target/AGENTS.md",
        root: "/tmp/target",
      },
    ]);

    // .codex/output-style.md → ../.claude/output-style.md — a relative target
    // with `..` that still resolves INSIDE the install root, so it's allowed.
    expect(symlinkCalls).toContainEqual([
      "create_symlink",
      {
        target: "../.claude/output-style.md",
        linkPath: "/tmp/target/.codex/output-style.md",
        root: "/tmp/target",
      },
    ]);

    // Regular files still go through write_file; symlinks do not.
    const paths = writePaths();
    expect(paths).toContain("/tmp/target/real-file.txt");

    // Critically: writeFile must NOT have been called for the symlink paths.
    // Today's bug is that empty-data symlinks become zero-byte regular files.
    expect(paths).not.toContain("/tmp/target/AGENTS.md");
    expect(paths).not.toContain("/tmp/target/.codex/output-style.md");
  });

  // -------------------------------------------------------------------------
  it("symlinks: a linkname that escapes the install root is rejected (no invocation)", async () => {
    // Hardening (review P0 #1): the link *target* is untrusted archive
    // metadata. A symlink whose target resolves outside the install root
    // (e.g. "../../etc/passwd" from a root-level link) must be skipped, never
    // forwarded to create_symlink — otherwise a later file write could follow
    // it and land outside ~/hq. Targets that resolve INSIDE the root are still
    // allowed (covered by the test above).
    const tarGzBytes = buildGitHubTarGz([
      { name: "weird.lnk", linkname: "../../etc/passwd" },
      { name: "ok.lnk", linkname: "real-file.txt" },
    ]);
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [makeRelease()],
      } as unknown as Response)
      .mockResolvedValueOnce(mockTarGzResponse(tarGzBytes));

    await fetchAndExtract("/tmp/target");

    const symlinkCalls = mockInvoke.mock.calls.filter(
      ([cmd]) => cmd === "create_symlink",
    );
    // The escaping target is skipped; the in-root one is still created.
    expect(symlinkCalls).toEqual([
      [
        "create_symlink",
        {
          target: "real-file.txt",
          linkPath: "/tmp/target/ok.lnk",
          root: "/tmp/target",
        },
      ],
    ]);
  });

  // -------------------------------------------------------------------------
  it("symlinks: link path with .. segments is rejected by safeJoin (no invocation)", async () => {
    // The link *path* itself still goes through safeJoin — a malicious
    // tarball entry named "../../escaping.lnk" would otherwise land outside
    // targetDir. We expect zero symlink invocations for that entry.
    const tarGzBytes = buildGitHubTarGz([
      { name: "../../escaping.lnk", linkname: "anywhere" },
      { name: "safe.lnk", linkname: "ok" },
    ]);
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [makeRelease()],
      } as unknown as Response)
      .mockResolvedValueOnce(mockTarGzResponse(tarGzBytes));

    await fetchAndExtract("/tmp/target");

    const symlinkCalls = mockInvoke.mock.calls.filter(
      ([cmd]) => cmd === "create_symlink",
    );
    expect(symlinkCalls).toHaveLength(1);
    expect((symlinkCalls[0][1] as { linkPath: string }).linkPath).toBe(
      "/tmp/target/safe.lnk",
    );
  });

  // -------------------------------------------------------------------------
  it("wrapper strip: GitHub tarball wrapper dir is stripped but contents kept", async () => {
    // Regression guard: the wrapper dir that GitHub prepends to tarballs
    // (e.g. `indigoai-us-hq-core-abc123/`) must never leak into the user's
    // install dir. Everything inside the wrapper should land at the root.
    const tarGzBytes = buildGitHubTarGz([
      { name: "core.yaml", content: "kept" },
      { name: "nested/deep.txt", content: "also kept" },
      { name: "docs/architecture.md", content: "hq-core docs" },
      { name: "companies/sample/page.md", content: "starter" },
      { name: ".claude/CLAUDE.md", content: "claude config" },
      { name: "README.md", content: "hq-core readme" },
    ]);

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [makeRelease()],
      } as unknown as Response)
      .mockResolvedValueOnce(mockTarGzResponse(tarGzBytes));

    await fetchAndExtract("/tmp/target");

    const paths = writePaths();

    // All entries kept, landing at root of targetDir
    expect(paths).toContain("/tmp/target/core.yaml");
    expect(paths).toContain("/tmp/target/nested/deep.txt");
    expect(paths).toContain("/tmp/target/docs/architecture.md");
    expect(paths).toContain("/tmp/target/companies/sample/page.md");
    expect(paths).toContain("/tmp/target/.claude/CLAUDE.md");
    expect(paths).toContain("/tmp/target/README.md");

    // The wrapper dir itself must never appear in an extraction path
    expect(
      paths.every((p) => !p.includes("indigoai-us-hq-core-")),
      `expected wrapper dir to be stripped, got: ${paths.join(", ")}`,
    ).toBe(true);
  });
});
