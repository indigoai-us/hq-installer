// @vitest-environment node

/**
 * Regression: parity between installer extraction and canonical `tar` extraction.
 *
 * Downloads the latest stable HQ release tarball once and drives two extraction
 * paths into sibling tmpdirs:
 *
 *   Path A — canonical:  system `tar -xzf` (what `create-hq` uses)
 *   Path B — installer:  the production extraction seam from template-fetcher.ts
 *
 * The resulting directory trees are compared as sorted file/symlink lists,
 * file mode bits, symlink targets, and SHA-256 content hashes. Paths matching
 * entries in allowed-diffs.json are excluded. Any unexpected diff fails the
 * test with a precise path-level report.
 *
 * Runs nightly — see .github/workflows/regression.yml. Can also be triggered
 * on demand: pnpm vitest run --config vitest.config.regression.ts
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import {
  mkdtemp,
  rm,
  mkdir,
  writeFile,
  readFile,
  readdir,
  lstat,
  readlink,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { gzipSync } from "fflate";
import allowedDiffs from "./allowed-diffs.json" with { type: "json" };

vi.mock("../../src/lib/client-info", () => ({
  CLIENT_HEADERS: {
    "User-Agent": "hq-installer-regression/test",
    "x-hq-client-name": "hq-installer-regression",
    "x-hq-client-version": "test",
  },
}));

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (input: RequestInfo | URL, init?: RequestInit) =>
    globalThis.fetch(input, init),
}));

vi.mock("@tauri-apps/plugin-fs", async () => {
  const fs = await import("node:fs/promises");
  const nodePath = await import("node:path");
  return {
    mkdir: (pathName: string, opts?: { recursive?: boolean }) =>
      fs.mkdir(pathName, { recursive: opts?.recursive }),
    writeFile: async (
      pathName: string,
      data: Uint8Array,
      opts?: { mode?: number },
    ) => {
      await fs.mkdir(nodePath.dirname(pathName), { recursive: true });
      await fs.writeFile(pathName, data);
      if (typeof opts?.mode === "number") {
        await fs.chmod(pathName, opts.mode & 0o777);
      }
    },
  };
});

vi.mock("@tauri-apps/api/core", async () => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  return {
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd !== "create_symlink") {
        throw new Error(`Unexpected invoke in parity test: ${cmd}`);
      }
      const target = String(args?.target ?? "");
      const linkPath = String(args?.linkPath ?? "");
      await fs.mkdir(path.dirname(linkPath), { recursive: true });
      await fs.rm(linkPath, { recursive: true, force: true });

      const resolvedTarget = path.resolve(path.dirname(linkPath), target);
      const targetIsDir = await fs
        .lstat(resolvedTarget)
        .then((st) => st.isDirectory())
        .catch(() => false);
      const symlinkType =
        targetIsDir && process.platform === "win32" ? "junction" : undefined;
      const symlinkTarget = symlinkType === "junction" ? resolvedTarget : target;
      await fs.symlink(symlinkTarget, linkPath, symlinkType);
    },
  };
});

import { __templateFetcherTestHooks } from "../../src/lib/template-fetcher.js";
import { resolveLocalPath } from "../../src/lib/s3-sync.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GITHUB_API = "https://api.github.com";
const REPO = "indigoai-us/hq-core";
const GITHUB_HEADERS = { Accept: "application/vnd.github+json" };

/** Timeout for the beforeAll network + extraction step (ms) */
const SETUP_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// GitHub release helpers
// ---------------------------------------------------------------------------

interface ReleaseInfo {
  tag_name: string;
  tarball_url: string;
  prerelease: boolean;
  draft: boolean;
}

/**
 * Resolve the tarball URL and a human-readable version string.
 *
 * Priority:
 *   1. Latest stable (non-prerelease, non-draft) release.
 *   2. Latest pre-release (when no stable release exists yet).
 *   3. HEAD of the default branch via GitHub's archive endpoint
 *      — used when the repo has no releases at all.
 */
async function resolveSource(): Promise<{ tarballUrl: string; version: string }> {
  const url = `${GITHUB_API}/repos/${REPO}/releases`;
  const res = await fetch(url, { headers: GITHUB_HEADERS });
  if (!res.ok) {
    throw new Error(`GitHub API error ${res.status}: ${res.statusText}`);
  }
  const releases = (await res.json()) as ReleaseInfo[];

  if (releases.length > 0) {
    const pick = releases.find((r) => !r.prerelease && !r.draft) ??
      releases.find((r) => !r.draft);
    if (pick) {
      if (pick.prerelease) {
        console.warn(
          `[parity] No stable release — using pre-release ${pick.tag_name}`,
        );
      }
      return { tarballUrl: pick.tarball_url, version: pick.tag_name };
    }
  }

  // No releases at all — fall back to the branch HEAD tarball
  const branch = "main";
  const tarballUrl = `${GITHUB_API}/repos/${REPO}/tarball/${branch}`;
  console.warn(
    `[parity] No releases found for ${REPO} — using ${branch} branch HEAD`,
  );
  return { tarballUrl, version: `${branch}@HEAD` };
}

async function downloadTarball(
  tarballUrl: string,
): Promise<{ bytes: Uint8Array }> {
  const res = await fetch(tarballUrl, {
    headers: GITHUB_HEADERS,
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(`Download failed ${res.status}: ${res.statusText}`);
  }
  const buf = await res.arrayBuffer();
  return { bytes: new Uint8Array(buf) };
}

// ---------------------------------------------------------------------------
// Minimal tar fixture builder for extraction-safety tests
// ---------------------------------------------------------------------------

type TarEntryInput =
  | { name: string; content: string; mode?: number; linkname?: undefined }
  | { name: string; content?: undefined; mode?: number; linkname: string }
  | { name: string; content?: undefined; mode?: number; linkname?: undefined };

function buildTarBuffer(entries: TarEntryInput[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  const encoder = new TextEncoder();

  const writeOctal = (value: number, width: number): Uint8Array =>
    encoder.encode(value.toString(8).padStart(width - 1, "0") + "\0");

  const writeHeader = (
    entry: TarEntryInput,
    size: number,
    typeflag: "0" | "2" | "5",
  ): Uint8Array => {
    const header = new Uint8Array(512);
    header.set(encoder.encode(entry.name.slice(0, 100)), 0);
    header.set(writeOctal(entry.mode ?? (typeflag === "5" ? 0o755 : 0o644), 8), 100);
    header.set(writeOctal(0, 8), 108);
    header.set(writeOctal(0, 8), 116);
    header.set(writeOctal(size, 12), 124);
    header.set(writeOctal(Math.floor(Date.now() / 1000), 12), 136);
    header[156] = typeflag.charCodeAt(0);

    if ("linkname" in entry && entry.linkname !== undefined) {
      header.set(encoder.encode(entry.linkname.slice(0, 100)), 157);
    }

    header.set(encoder.encode("ustar\0"), 257);
    header.set(encoder.encode("00"), 263);

    let checksum = 0;
    for (let i = 0; i < 512; i++) {
      checksum += i >= 148 && i < 156 ? 32 : header[i];
    }
    header.set(encoder.encode(checksum.toString(8).padStart(6, "0") + "\0 "), 148);
    return header;
  };

  for (const entry of entries) {
    if ("linkname" in entry && entry.linkname !== undefined) {
      blocks.push(writeHeader(entry, 0, "2"));
      continue;
    }

    if (entry.name.endsWith("/")) {
      blocks.push(writeHeader(entry, 0, "5"));
      continue;
    }

    const data = encoder.encode(entry.content ?? "");
    blocks.push(writeHeader(entry, data.length, "0"));
    const paddedSize = Math.ceil(data.length / 512) * 512;
    const paddedData = new Uint8Array(paddedSize);
    paddedData.set(data, 0);
    blocks.push(paddedData);
  }

  blocks.push(new Uint8Array(512));
  blocks.push(new Uint8Array(512));

  const total = blocks.reduce((n, block) => n + block.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) {
    out.set(block, offset);
    offset += block.length;
  }
  return out;
}

function buildGitHubTarGz(entries: TarEntryInput[]): Uint8Array {
  const prefixed = entries.map((entry) => ({
    ...entry,
    name: `indigoai-us-hq-core-abc123/${entry.name}`,
  }));
  return gzipSync(buildTarBuffer(prefixed));
}

// ---------------------------------------------------------------------------
// Path A — canonical: extract using system `tar`
// ---------------------------------------------------------------------------

async function extractWithSystemTar(
  compressedBytes: Uint8Array,
  targetDir: string,
): Promise<void> {
  const tarballPath = join(targetDir, "..", "_source.tar.gz");
  await writeFile(tarballPath, compressedBytes);
  // --strip-components=1 to remove the top-level "<owner>-<repo>-<sha>/" prefix,
  // exactly mirroring what the installer's stripTopLevelDir() does.
  execFileSync("tar", [
    "-xzf",
    tarballPath,
    "-C",
    targetDir,
    "--strip-components=1",
  ]);
  await rm(tarballPath, { force: true });
}

// ---------------------------------------------------------------------------
// Path B — installer: drive the real template-fetcher extraction seam
// ---------------------------------------------------------------------------

async function extractWithInstallerLogic(
  compressedBytes: Uint8Array,
  targetDir: string,
): Promise<void> {
  await __templateFetcherTestHooks.extractTarball(compressedBytes, targetDir);
}

// ---------------------------------------------------------------------------
// File tree walker
// ---------------------------------------------------------------------------

// Walk dir and return a map of relativePath -> metadata/content fingerprint.
// Files include mode bits and SHA-256 content hashes. Symlinks include their
// literal link target. This keeps the regression harness aligned with the
// installer, which now preserves executable bits and creates symlinks.
async function buildFileTree(
  dir: string,
  base: string = dir,
): Promise<Map<string, string>> {
  const tree = new Map<string, string>();

  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      const relPath = fullPath.slice(base.length + 1); // strip leading dir
      if (entry.isSymbolicLink()) {
        const target = await readlink(fullPath);
        tree.set(relPath, `symlink:${target}`);
      } else if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const content = await readFile(fullPath);
        const hash = createHash("sha256").update(content).digest("hex");
        const mode = (await lstat(fullPath)).mode & 0o777;
        tree.set(relPath, `file:${mode.toString(8).padStart(4, "0")}:${hash}`);
      }
    }
  }

  await walk(dir);
  return tree;
}

// ---------------------------------------------------------------------------
// Glob matching for allowed-diffs.json
// ---------------------------------------------------------------------------

// Glob matcher: converts glob patterns to regex character-by-character.
// Supports ** (any path segments) and * (non-separator wildcard).
// Handles "star-star-slash" prefix correctly so patterns match at any depth.
function matchesGlob(relPath: string, glob: string): boolean {
  const p = relPath.replace(/\\/g, "/");
  const g = glob.replace(/\\/g, "/");

  let regex = "^";
  let i = 0;
  while (i < g.length) {
    if (g[i] === "*" && g[i + 1] === "*") {
      if (g[i + 2] === "/") {
        // **/ → zero or more path segments (each ending in /)
        regex += "(?:.+/)?";
        i += 3;
      } else {
        // ** at end of pattern → anything
        regex += ".*";
        i += 2;
      }
    } else if (g[i] === "*") {
      // * → any sequence of non-separator characters
      regex += "[^/]*";
      i++;
    } else if (/[.+^${}()|[\]\\]/.test(g[i])) {
      // Escape regex metacharacters
      regex += "\\" + g[i];
      i++;
    } else {
      regex += g[i];
      i++;
    }
  }
  regex += "$";

  return new RegExp(regex).test(p);
}

function isAllowedDiff(relPath: string): boolean {
  const { excludedPaths, excludedGlobs } = allowedDiffs as {
    excludedPaths: string[];
    excludedGlobs: string[];
  };

  if (excludedPaths.includes(relPath)) return true;
  if (excludedGlobs.some((g) => matchesGlob(relPath, g))) return true;

  // Also check if any segment of the path matches a simple filename glob
  const filename = basename(relPath);
  if (
    excludedGlobs.some((g) => {
      const bare = g.replace(/^\*\*\//, "");
      return !bare.includes("/") && !bare.includes("*") && bare === filename;
    })
  ) {
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Diff computation
// ---------------------------------------------------------------------------

interface DiffEntry {
  type: "only-in-canonical" | "only-in-installer" | "metadata-mismatch";
  path: string;
  canonical?: string;
  installer?: string;
}

function computeDiff(
  canonical: Map<string, string>,
  installer: Map<string, string>,
): DiffEntry[] {
  const diffs: DiffEntry[] = [];

  // Files in canonical but not installer
  for (const [relPath, hash] of canonical) {
    if (isAllowedDiff(relPath)) continue;
    if (!installer.has(relPath)) {
      diffs.push({ type: "only-in-canonical", path: relPath, canonical: hash });
    } else if (installer.get(relPath) !== hash) {
      diffs.push({
        type: "metadata-mismatch",
        path: relPath,
        canonical: hash,
        installer: installer.get(relPath),
      });
    }
  }

  // Files in installer but not canonical
  for (const [relPath, hash] of installer) {
    if (isAllowedDiff(relPath)) continue;
    if (!canonical.has(relPath)) {
      diffs.push({ type: "only-in-installer", path: relPath, installer: hash });
    }
  }

  return diffs.sort((a, b) => a.path.localeCompare(b.path));
}

function formatDiffReport(diffs: DiffEntry[]): string {
  return diffs
    .map((d) => {
      switch (d.type) {
        case "only-in-canonical":
          return `  MISSING_IN_INSTALLER  ${d.path}`;
        case "only-in-installer":
          return `  EXTRA_IN_INSTALLER    ${d.path}`;
        case "metadata-mismatch":
          return `  METADATA_MISMATCH     ${d.path}\n    canonical: ${d.canonical}\n    installer: ${d.installer}`;
      }
    })
    .join("\n");
}

describe("extraction path safety guards", () => {
  let tmpDir: string;
  let targetDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "hq-extract-safety-"));
    targetDir = join(tmpDir, "target");
    await mkdir(targetDir, { recursive: true });
  });

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects Windows backslash traversal and drive-prefixed archive paths", async () => {
    const tarball = buildGitHubTarGz([
      { name: "safe.txt", content: "safe", mode: 0o755 },
      { name: "..\\outside.txt", content: "blocked" },
      { name: "C:\\Users\\alice\\evil.txt", content: "blocked" },
      { name: "nested/..\\evil.txt", content: "blocked" },
    ]);

    await extractWithInstallerLogic(tarball, targetDir);

    const tree = await buildFileTree(targetDir);
    expect([...tree.keys()]).toEqual(["safe.txt"]);
    expect(tree.get("safe.txt")).toMatch(/^file:0755:/);
  });

  it("does not create escaping symlink targets or write through created symlink parents", async () => {
    const outsideDir = join(tmpDir, "outside");
    await mkdir(outsideDir, { recursive: true });

    const tarball = buildGitHubTarGz([
      { name: "escape", linkname: "../outside" },
      { name: "escape/payload.txt", content: "outside write must not happen" },
      { name: "safe-link", linkname: "." },
      { name: "safe-link/blocked.txt", content: "must not write through link" },
    ]);

    await extractWithInstallerLogic(tarball, targetDir);

    await expect(readFile(join(outsideDir, "payload.txt"))).rejects.toThrow();
    await expect(readFile(join(targetDir, "blocked.txt"))).rejects.toThrow();
    await expect(readFile(join(targetDir, "safe-link", "blocked.txt"))).rejects.toThrow();
    expect((await lstat(join(targetDir, "safe-link"))).isSymbolicLink()).toBe(true);
  });
});

describe("S3 local path safety guards", () => {
  it("rejects Windows traversal, drive prefixes, and mixed separators", () => {
    for (const key of [
      "..\\outside.txt",
      "C:\\Users\\alice\\evil.txt",
      "nested/..\\evil.txt",
    ]) {
      expect(
        resolveLocalPath("C:\\Users\\alice\\hq", key, "companies/indigo"),
      ).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("installer parity with canonical tar extraction", () => {
  let tmpDir: string;
  let canonicalDir: string;
  let installerDir: string;
  let releaseVersion: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "hq-parity-"));
    canonicalDir = join(tmpDir, "canonical");
    installerDir = join(tmpDir, "installer");
    await Promise.all([
      mkdir(canonicalDir, { recursive: true }),
      mkdir(installerDir, { recursive: true }),
    ]);

    const source = await resolveSource();
    releaseVersion = source.version;
    const { bytes } = await downloadTarball(source.tarballUrl);

    // Drive both paths concurrently against the same bytes
    await Promise.all([
      extractWithSystemTar(bytes, canonicalDir),
      extractWithInstallerLogic(bytes, installerDir),
    ]);
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("reports the HQ source version under test", () => {
    expect(releaseVersion.length).toBeGreaterThan(0);
    console.info(`[parity] HQ source under test: ${releaseVersion}`);
  });

  it("installer tree matches canonical tree (excluding allowed diffs)", async () => {
    const [canonicalTree, installerTree] = await Promise.all([
      buildFileTree(canonicalDir),
      buildFileTree(installerDir),
    ]);

    expect(canonicalTree.size).toBeGreaterThan(0);
    expect(installerTree.size).toBeGreaterThan(0);

    const diffs = computeDiff(canonicalTree, installerTree);

    if (diffs.length > 0) {
      const report = formatDiffReport(diffs);
      expect.fail(
        `${diffs.length} unexpected diff(s) between installer and canonical tree ` +
          `(release ${releaseVersion}).\n` +
          `If these differences are intentional, add them to tests/regression/allowed-diffs.json.\n\n` +
          report,
      );
    }
  });

  it("neither tree is empty after extraction", async () => {
    const [canonicalTree, installerTree] = await Promise.all([
      buildFileTree(canonicalDir),
      buildFileTree(installerDir),
    ]);
    expect(canonicalTree.size).toBeGreaterThan(10);
    expect(installerTree.size).toBeGreaterThan(10);
  });

  it("both trees contain the same number of files (after allowed-diff filtering)", async () => {
    const [canonicalTree, installerTree] = await Promise.all([
      buildFileTree(canonicalDir),
      buildFileTree(installerDir),
    ]);

    const filteredCanonical = [...canonicalTree.keys()].filter(
      (p) => !isAllowedDiff(p),
    );
    const filteredInstaller = [...installerTree.keys()].filter(
      (p) => !isAllowedDiff(p),
    );

    expect(filteredInstaller.length).toBe(filteredCanonical.length);
  });
});
