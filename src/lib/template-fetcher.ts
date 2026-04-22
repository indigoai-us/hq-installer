import { gunzipSync } from "fflate";
import { mkdir, writeFile } from "@tauri-apps/plugin-fs";
import { fetch } from "@tauri-apps/plugin-http";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GITHUB_API = "https://api.github.com";
const REPO = "indigoai-us/hq-core";
const GITHUB_HEADERS = { Accept: "application/vnd.github+json" };

/** Minimum ms between onProgress callbacks (≈60fps cadence) */
const PROGRESS_THROTTLE_MS = 16;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ProgressEvent {
  bytes: number;
  total: number;
}

export class TemplateFetchError extends Error {
  constructor(
    message: string,
    public readonly retriable: boolean,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "TemplateFetchError";
    // Ensure proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, TemplateFetchError.prototype);
  }
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ReleaseInfo {
  tag_name: string;
  tarball_url: string;
  prerelease: boolean;
  draft: boolean;
}

interface TarEntry {
  name: string;
  /** typeflag: '0' or '' = regular file, '5' = directory */
  typeflag: string;
  size: number;
  data: Uint8Array;
  /**
   * Unix file mode (permissions) parsed from the tar header at offset 100-107.
   * We preserve this so executable scripts (e.g. `compute-checksums.sh`) keep
   * their execute bit after extraction — otherwise `bash -c <path>` fails with
   * exit code 126 ("command invoked cannot execute") on macOS/Linux.
   */
  mode: number;
}

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

async function fetchRelease(
  url: string,
  signal?: AbortSignal,
): Promise<ReleaseInfo> {
  let response: Response;
  try {
    response = await fetch(url, { headers: GITHUB_HEADERS, signal });
  } catch (err) {
    throw new TemplateFetchError(
      `Network error fetching release info: ${String(err)}`,
      /* retriable */ true,
      err,
    );
  }

  if (response.status === 404) {
    throw new TemplateFetchError(
      `Release not found (404): ${url}`,
      /* retriable */ false,
    );
  }
  if (!response.ok) {
    throw new TemplateFetchError(
      `GitHub API error ${response.status}: ${response.statusText}`,
      /* retriable */ response.status >= 500,
    );
  }

  return (await response.json()) as ReleaseInfo;
}

/**
 * Look up the latest stable release.
 *
 * Returns `null` when the repo has no stable non-draft releases yet — this is
 * a normal state for early-stage repos and must NOT throw, because the
 * caller's fallback path (branch snapshot via `/tarball/HEAD`) depends on
 * distinguishing "no releases" from "network/auth error".
 */
async function getLatestRelease(
  signal?: AbortSignal,
): Promise<ReleaseInfo | null> {
  const url = `${GITHUB_API}/repos/${REPO}/releases`;
  let response: Response;
  try {
    response = await fetch(url, { headers: GITHUB_HEADERS, signal });
  } catch (err) {
    throw new TemplateFetchError(
      `Network error fetching releases: ${String(err)}`,
      true,
      err,
    );
  }
  if (!response.ok) {
    throw new TemplateFetchError(
      `GitHub API error ${response.status}: ${response.statusText}`,
      response.status >= 500,
    );
  }

  const releases = (await response.json()) as ReleaseInfo[];
  return releases.find((r) => !r.prerelease && !r.draft) ?? null;
}

/**
 * Build the URL for a branch-snapshot tarball of the template repo.
 *
 * GitHub's REST API exposes `/repos/{owner}/{repo}/tarball/{ref}` which 302s
 * to `codeload.github.com` — the same endpoint `gh api repos/.../tarball/HEAD`
 * uses under the hood. The HTTP allowlist already permits both domains, so
 * `downloadTarball` can follow the redirect transparently.
 *
 * We use this when no release has been published yet, to mirror the
 * `create-hq` fallback path.
 */
function branchTarballUrl(ref: string): string {
  return `${GITHUB_API}/repos/${REPO}/tarball/${ref}`;
}

async function getTagRelease(
  tag: string,
  signal?: AbortSignal,
): Promise<ReleaseInfo> {
  return fetchRelease(
    `${GITHUB_API}/repos/${REPO}/releases/tags/${tag}`,
    signal,
  );
}

// ---------------------------------------------------------------------------
// Download with streaming progress
// ---------------------------------------------------------------------------

async function downloadTarball(
  tarballUrl: string,
  onProgress?: (event: ProgressEvent) => void,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetch(tarballUrl, {
      headers: GITHUB_HEADERS,
      redirect: "follow",
      signal,
    });
  } catch (err) {
    if (signal?.aborted) {
      throw new TemplateFetchError("Download cancelled", false, err);
    }
    throw new TemplateFetchError(
      `Network error downloading tarball: ${String(err)}`,
      true,
      err,
    );
  }

  if (response.status === 404) {
    throw new TemplateFetchError(
      `Tarball not found (404): ${tarballUrl}`,
      false,
    );
  }
  if (!response.ok) {
    throw new TemplateFetchError(
      `HTTP ${response.status} downloading tarball: ${response.statusText}`,
      response.status >= 500,
    );
  }

  const total = Number(response.headers.get("content-length")) || 0;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let lastEmit = 0;

  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (signal?.aborted) {
          reader.cancel().catch(() => {});
          throw new TemplateFetchError("Download cancelled", false);
        }
        chunks.push(value);
        bytes += value.length;

        if (onProgress) {
          const now = Date.now();
          if (now - lastEmit >= PROGRESS_THROTTLE_MS) {
            lastEmit = now;
            onProgress({ bytes, total });
          }
        }
      }
    } catch (err) {
      if (err instanceof TemplateFetchError) throw err;
      throw new TemplateFetchError(
        `Stream error: ${String(err)}`,
        true,
        err,
      );
    }
  } else {
    // Fallback for environments without streaming body
    const buf = await response.arrayBuffer();
    chunks.push(new Uint8Array(buf));
    bytes = chunks[0].length;
  }

  // Emit final progress
  if (onProgress && bytes > 0) {
    onProgress({ bytes, total: total || bytes });
  }

  // Concatenate chunks
  const result = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Tar parser (pure TS, no shell-out)
// ---------------------------------------------------------------------------

/**
 * Parse a raw (already-gunzipped) tar byte buffer into entries.
 * Handles POSIX and GNU extended headers for long filenames.
 */
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
    // Check for EOF marker (two 512-byte zero blocks)
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
    // Mode lives at offset 100-107 (8 bytes, ASCII octal). Default to 0o644 if
    // unreadable — that's the tar convention for "no mode specified".
    const mode = readOctal(headerStart + 100, 8) || 0o644;
    const size = readOctal(headerStart + 124, 12);
    const typeflag = String.fromCharCode(buf[headerStart + 156]);

    // GNU long-name extension: type 'L' = long filename, 'K' = long link name
    if (typeflag === "L" || typeflag === "K") {
      pos += 512;
      const nameBytes = buf.slice(pos, pos + size);
      pendingLongName = new TextDecoder().decode(nameBytes).replace(/\0/g, "");
      pos += Math.ceil(size / 512) * 512;
      continue;
    }

    // PAX extended headers: 'g' = global (skip), 'x' = local (parse path)
    if (typeflag === "g") {
      // Global PAX header — skip data block entirely
      pos += 512;
      pos += Math.ceil(size / 512) * 512;
      continue;
    }
    if (typeflag === "x") {
      // Local PAX header — parse "path=..." field if present
      pos += 512;
      const paxData = new TextDecoder().decode(buf.slice(pos, pos + size));
      pos += Math.ceil(size / 512) * 512;
      const pathMatch = paxData.match(/\d+ path=([^\n]+)/);
      if (pathMatch) {
        pendingLongName = pathMatch[1];
      }
      continue;
    }

    pos += 512; // advance past header

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
      entries.push({ name: actualName, typeflag, size, data, mode });
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Extraction using @tauri-apps/plugin-fs
// ---------------------------------------------------------------------------

/**
 * Map a raw tarball entry name to the path (relative to `targetDir`) where it
 * should be extracted, or return `null` to skip the entry entirely.
 *
 * GitHub tarballs wrap everything in a top-level dir (`indigoai-us-hq-core-<sha>/`).
 * hq-core is a standalone template repo — the repo root IS the template — so we
 * strip only the wrapper and keep everything inside:
 *
 *   indigoai-us-hq-core-abc123/core.yaml       →  "core.yaml"          (keep)
 *   indigoai-us-hq-core-abc123/.claude/...     →  ".claude/..."        (keep)
 *   indigoai-us-hq-core-abc123/README.md       →  "README.md"          (keep)
 *   indigoai-us-hq-core-abc123/                →  null (the wrapper itself)
 */
function mapEntryToTemplatePath(entryName: string): string | null {
  const firstSlash = entryName.indexOf("/");
  if (firstSlash === -1) return null; // top-level dir entry with no inner path
  const afterRoot = entryName.slice(firstSlash + 1);
  if (!afterRoot) return null;
  return afterRoot;
}

/**
 * Resolve an untrusted relative path against targetDir, guarding against
 * path-traversal attacks (e.g. entries containing "..").
 * Returns null if the resolved path would escape targetDir.
 */
function safeJoin(targetDir: string, relative: string): string | null {
  // Normalise the relative portion by collapsing any ".." segments
  const segments = relative.split("/");
  const safe: string[] = [];
  for (const seg of segments) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      // Attempted traversal — reject the whole entry
      return null;
    }
    safe.push(seg);
  }
  if (safe.length === 0) return null;
  return `${targetDir}/${safe.join("/")}`;
}

async function extractTarball(
  compressedBytes: Uint8Array,
  targetDir: string,
): Promise<void> {
  // 1. Decompress gzip
  let tarBytes: Uint8Array;
  try {
    tarBytes = gunzipSync(compressedBytes);
  } catch (err) {
    throw new TemplateFetchError(
      `Failed to decompress tarball: ${String(err)}`,
      false,
      err,
    );
  }

  // 2. Parse tar entries
  const entries = parseTar(tarBytes);

  // 3. Write each entry via Tauri plugin-fs. hq-core is a standalone template
  //    repo, so we strip only the tarball wrapper (indigoai-us-hq-core-<sha>/)
  //    and extract everything inside it.
  for (const entry of entries) {
    const relative = mapEntryToTemplatePath(entry.name);
    if (relative === null) continue; // tarball wrapper — drop
    const trimmed = relative.replace(/\/+$/, "");
    if (!trimmed || trimmed === ".") continue;

    const isDir = entry.typeflag === "5" || entry.name.endsWith("/");
    const destPath = safeJoin(targetDir, trimmed);
    if (!destPath) continue; // path traversal attempt — skip

    if (isDir) {
      await mkdir(destPath, { recursive: true });
      continue;
    }

    // Regular file — ensure parent dir exists, then write.
    // `recursive: true` means repeated mkdir of the same parent is a no-op,
    // so we don't bother deduping across siblings.
    const lastSlash = destPath.lastIndexOf("/");
    if (lastSlash > 0) {
      await mkdir(destPath.slice(0, lastSlash), { recursive: true });
    }
    // Preserve the executable bit from the tar header — shell scripts under
    // `scripts/` are 0o755 and need to stay that way, or later
    // `bash -c <path>` invocations fail with exit code 126.
    await writeFile(destPath, entry.data, { mode: entry.mode });
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch the HQ template from GitHub and extract it into targetDir.
 *
 * Strategy (mirrors `packages/create-hq/src/fetch-template.ts`):
 *
 *   1. If `tag` is given → fetch the tagged release. No fallback: the caller
 *      asked for a specific version, so "release not found" is a real error.
 *   2. Else → try the latest stable release.
 *      - If one exists, use its `tarball_url`.
 *      - If the repo has no stable release yet, fall back to the branch
 *        snapshot endpoint (`/tarball/HEAD`). This is what `gh api
 *        repos/.../tarball/HEAD` does under the hood, and it's how create-hq
 *        kept working during periods where `indigoai-us/hq-core` had no releases.
 *
 * Extraction strips only the GitHub tarball wrapper — see `mapEntryToTemplatePath`.
 *
 * @param targetDir - Absolute path where the template should be extracted
 * @param tag - Optional: pin to a specific release tag. Defaults to latest non-prerelease.
 * @param onProgress - Optional callback receiving {bytes, total} progress events
 * @param signal - Optional AbortSignal for cancellation
 * @returns { version: string } — the tag or ref that was fetched
 */
export async function fetchAndExtract(
  targetDir: string,
  tag?: string,
  onProgress?: (event: ProgressEvent) => void,
  signal?: AbortSignal,
): Promise<{ version: string }> {
  // Check for pre-aborted signal
  if (signal?.aborted) {
    throw new TemplateFetchError("Operation cancelled before it started", false);
  }

  // 1. Resolve tarball URL + version.
  let version: string;
  let tarballUrl: string;

  if (tag) {
    const release = await getTagRelease(tag, signal);
    version = release.tag_name;
    tarballUrl = release.tarball_url;
  } else {
    const release = await getLatestRelease(signal);
    if (release) {
      version = release.tag_name;
      tarballUrl = release.tarball_url;
    } else {
      // No published releases yet — fall back to branch snapshot.
      // We don't know a version in this case; "HEAD" is honest about it
      // and mirrors what `create-hq` returns when it hits the same path.
      version = "HEAD";
      tarballUrl = branchTarballUrl("HEAD");
    }
  }

  // 2. Download tarball with streaming progress
  const compressedBytes = await downloadTarball(tarballUrl, onProgress, signal);

  // 3. Ensure target directory exists
  await mkdir(targetDir, { recursive: true });

  // 4. Extract (strips tarball wrapper internally)
  await extractTarball(compressedBytes, targetDir);

  return { version };
}
