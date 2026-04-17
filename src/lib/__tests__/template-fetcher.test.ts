import { describe, it, expect, vi, beforeEach } from "vitest";
import { gzipSync } from "fflate";

// template-fetcher.ts imports fetch from @tauri-apps/plugin-http so GitHub
// requests go through Rust reqwest (bypassing WKWebView CORS). In tests, we
// delegate to globalThis.fetch so the existing stubbing pattern keeps working.
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (input: RequestInfo | URL, init?: RequestInit) =>
    globalThis.fetch(input, init),
}));

// ---------------------------------------------------------------------------
// Mock @tauri-apps/plugin-fs BEFORE importing the module under test
// ---------------------------------------------------------------------------

const mockMkdir = vi.fn<(path: string, opts?: { recursive?: boolean }) => Promise<void>>(
  async () => undefined,
);
const mockWriteFile = vi.fn<(path: string, data: Uint8Array) => Promise<void>>(
  async () => undefined,
);

vi.mock("@tauri-apps/plugin-fs", () => ({
  mkdir: (path: string, opts?: { recursive?: boolean }) => mockMkdir(path, opts),
  writeFile: (path: string, data: Uint8Array) => mockWriteFile(path, data),
}));

// ---------------------------------------------------------------------------
// Import module under test AFTER mocks are registered
// ---------------------------------------------------------------------------

import {
  fetchAndExtract,
  TemplateFetchError,
  type ProgressEvent,
} from "../template-fetcher.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal tar buffer with one file entry.
 * Layout: [512-byte header][padded data blocks]
 */
function buildTarBuffer(entries: Array<{ name: string; content: string }>): Uint8Array {
  const blocks: Uint8Array[] = [];

  const encoder = new TextEncoder();

  const writeHeader = (name: string, size: number): Uint8Array => {
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

    // size (octal, 11 digits + null)
    const sizeStr = size.toString(8).padStart(11, "0") + "\0";
    header.set(encoder.encode(sizeStr), 124);

    // mtime
    const mtime = Math.floor(Date.now() / 1000).toString(8).padStart(11, "0") + "\0";
    header.set(encoder.encode(mtime), 136);

    // typeflag = regular file
    header[156] = 0x30; // '0'

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

  for (const { name, content } of entries) {
    const data = encoder.encode(content);
    const header = writeHeader(name, data.length);
    blocks.push(header);

    // Pad data to 512-byte boundary
    const paddedSize = Math.ceil(data.length / 512) * 512;
    const paddedData = new Uint8Array(paddedSize);
    paddedData.set(data, 0);
    blocks.push(paddedData);
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
function buildGitHubTarGz(
  entries: Array<{ name: string; content: string }>,
): Uint8Array {
  const prefixed = entries.map((e) => ({
    name: `indigoai-us-hq-abc123/${e.name}`,
    content: e.content,
  }));
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
    tarball_url: "https://codeload.github.com/indigoai-us/hq/legacy.tar.gz/abc123",
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
  mockMkdir.mockReset().mockResolvedValue(undefined);
  mockWriteFile.mockReset().mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("fetchAndExtract", () => {
  // -------------------------------------------------------------------------
  it("success: extracts files into targetDir and returns version", async () => {
    const tarGzBytes = buildGitHubTarGz([
      { name: "src/index.ts", content: "export default 42;" },
      { name: "package.json", content: '{"name":"hq"}' },
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

    // mkdir called for targetDir
    expect(mockMkdir).toHaveBeenCalledWith("/tmp/target", { recursive: true });

    // writeFile called for each file in the archive
    const writePaths = mockWriteFile.mock.calls.map((c) => c[0]);
    expect(writePaths.some((p) => p.endsWith("src/index.ts"))).toBe(true);
    expect(writePaths.some((p) => p.endsWith("package.json"))).toBe(true);

    // Correct content for package.json
    const pkgCall = mockWriteFile.mock.calls.find((c) =>
      c[0].endsWith("package.json"),
    );
    expect(pkgCall).toBeDefined();
    const pkgContent = new TextDecoder().decode(pkgCall![1]);
    expect(pkgContent).toBe('{"name":"hq"}');
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
    // Build a tar where one entry attempts to escape the target directory
    const tarGzBytes = buildGitHubTarGz([
      { name: "safe.txt", content: "safe" },
      { name: "../../../etc/passwd", content: "root:x:0:0" },
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
    const writePaths = mockWriteFile.mock.calls.map((c) => c[0]);
    expect(writePaths.some((p) => p.endsWith("safe.txt"))).toBe(true);
    // The traversal path must never have been written
    expect(writePaths.every((p) => !p.includes("passwd"))).toBe(true);
    expect(writePaths.every((p) => !p.includes("etc"))).toBe(true);
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
});
