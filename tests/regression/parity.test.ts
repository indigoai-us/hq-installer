// @vitest-environment node

/**
 * Regression: parity between installer extraction and canonical `tar` extraction.
 *
 * Downloads the latest stable HQ release tarball once and drives two extraction
 * paths into sibling tmpdirs:
 *
 *   Path A — canonical:  system `tar -xzf` (what `create-hq` uses)
 *   Path B — installer:  the pure-TS tar parser replicated from template-fetcher.ts
 *
 * The resulting directory trees are compared as sorted file lists + SHA-256
 * content hashes. Paths matching entries in allowed-diffs.json are excluded.
 * Any unexpected diff fails the test with a precise path-level report.
 *
 * Runs nightly — see .github/workflows/regression.yml. Can also be triggered
 * on demand: pnpm vitest run --config vitest.config.regression.ts
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import {
  mkdtemp,
  rm,
  mkdir,
  writeFile,
  readFile,
  readdir,
  stat,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { gunzipSync } from "fflate";
import allowedDiffs from "./allowed-diffs.json" with { type: "json" };

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
// Path B — installer: replicate the pure-TS tar parser from template-fetcher.ts
//
// This is an intentional copy of the production parser. If the two diverge,
// the unit tests for template-fetcher.ts will catch it first; this test catches
// drift at the directory-tree level (new files, corrupt content, etc.).
// ---------------------------------------------------------------------------

interface TarEntry {
  name: string;
  typeflag: string;
  size: number;
  data: Uint8Array;
}

function parseTar(buf: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  let pos = 0;

  const readString = (start: number, len: number): string => {
    let end = start;
    while (end < start + len && buf[end] !== 0) end++;
    return new TextDecoder().decode(buf.slice(start, end));
  };

  const readOctal = (start: number, len: number): number => {
    const str = readString(start, len).trim();
    return str ? parseInt(str, 8) : 0;
  };

  let pendingLongName: string | null = null;

  while (pos + 512 <= buf.length) {
    let allZero = true;
    for (let i = 0; i < 512; i++) {
      if (buf[pos + i] !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) break;

    const headerStart = pos;
    const name = readString(headerStart, 100);
    const size = readOctal(headerStart + 124, 12);
    const typeflag = String.fromCharCode(buf[headerStart + 156]);

    // GNU long-name extension: type 'L' = long filename, 'K' = long link name
    if (typeflag === "L" || typeflag === "K") {
      pos += 512;
      const nameBytes = buf.slice(pos, pos + size);
      pendingLongName = new TextDecoder()
        .decode(nameBytes)
        .replace(/\0/g, "");
      pos += Math.ceil(size / 512) * 512;
      continue;
    }

    // PAX extended headers: 'g' = global (skip), 'x' = local (parse path)
    if (typeflag === "g") {
      pos += 512;
      pos += Math.ceil(size / 512) * 512;
      continue;
    }
    if (typeflag === "x") {
      pos += 512;
      const paxData = new TextDecoder().decode(buf.slice(pos, pos + size));
      pos += Math.ceil(size / 512) * 512;
      const pathMatch = paxData.match(/\d+ path=([^\n]+)/);
      if (pathMatch) {
        pendingLongName = pathMatch[1];
      }
      continue;
    }

    pos += 512;

    // USTAR prefix field (bytes 345–499): combine with name when no GNU/PAX
    // long-name override is pending and the tar uses the USTAR split.
    const magic = readString(headerStart + 257, 6);
    const usesUstar = magic.startsWith("ustar");
    const ustarPrefix = usesUstar ? readString(headerStart + 345, 155) : "";
    const baseName = ustarPrefix ? `${ustarPrefix}/${name}` : name;

    const actualName = pendingLongName ?? baseName;
    pendingLongName = null;

    const dataBlocks = Math.ceil(size / 512) * 512;
    const data = buf.slice(pos, pos + size);
    pos += dataBlocks;

    if (actualName) {
      entries.push({ name: actualName, typeflag, size, data });
    }
  }

  return entries;
}

function stripTopLevelDir(entryName: string): string {
  const slash = entryName.indexOf("/");
  if (slash === -1) return entryName;
  return entryName.slice(slash + 1);
}

function safeJoin(targetDir: string, relative: string): string | null {
  const segments = relative.split("/");
  const safe: string[] = [];
  for (const seg of segments) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") return null;
    safe.push(seg);
  }
  if (safe.length === 0) return null;
  return `${targetDir}/${safe.join("/")}`;
}

async function extractWithInstallerLogic(
  compressedBytes: Uint8Array,
  targetDir: string,
): Promise<void> {
  let tarBytes: Uint8Array;
  try {
    tarBytes = gunzipSync(compressedBytes);
  } catch (err) {
    throw new Error(`Failed to decompress tarball: ${String(err)}`);
  }

  const entries = parseTar(tarBytes);

  for (const entry of entries) {
    const relative = stripTopLevelDir(entry.name);
    if (!relative || relative === "./" || relative.endsWith("/")) {
      if (relative && relative !== "./") {
        const dirPath = safeJoin(targetDir, relative.replace(/\/+$/, ""));
        if (!dirPath) continue;
        await mkdir(dirPath, { recursive: true });
      }
      continue;
    }

    const isDir = entry.typeflag === "5";
    if (isDir) {
      const dirPath = safeJoin(targetDir, relative);
      if (!dirPath) continue;
      await mkdir(dirPath, { recursive: true });
      continue;
    }

    const filePath = safeJoin(targetDir, relative);
    if (!filePath) continue;

    const lastSlash = filePath.lastIndexOf("/");
    if (lastSlash > 0) {
      const parentDir = filePath.slice(0, lastSlash);
      await mkdir(parentDir, { recursive: true });
    }

    await writeFile(filePath, entry.data);
  }
}

// ---------------------------------------------------------------------------
// File tree walker
// ---------------------------------------------------------------------------

// Walk dir and return a map of relativePath -> SHA-256 content hash.
//
// NOTE: executable bits are intentionally NOT included in the fingerprint.
// Tauri plugin-fs writeFile does not expose a mode parameter, so the
// installer always creates files with the platform default umask. Executable
// scripts in the HQ template will lose their +x bit after installer
// extraction — this is a known, accepted difference tracked in
// allowed-diffs.json under "knownLimitations".
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
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const content = await readFile(fullPath);
        const hash = createHash("sha256").update(content).digest("hex");
        tree.set(relPath, hash);
      }
      // Symlinks: skip — git archive rarely emits them in template content
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
  type: "only-in-canonical" | "only-in-installer" | "content-mismatch";
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
        type: "content-mismatch",
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
        case "content-mismatch":
          return `  CONTENT_MISMATCH      ${d.path}\n    canonical: ${d.canonical}\n    installer: ${d.installer}`;
      }
    })
    .join("\n");
}

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
