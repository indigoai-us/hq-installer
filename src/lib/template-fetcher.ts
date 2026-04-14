import { gunzipSync } from "fflate";
import { mkdir, writeFile } from "@tauri-apps/plugin-fs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GITHUB_API = "https://api.github.com";
const REPO = "indigoai-us/hq";
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

async function getLatestRelease(signal?: AbortSignal): Promise<ReleaseInfo> {
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
  const latest = releases.find((r) => !r.prerelease && !r.draft);
  if (!latest) {
    throw new TemplateFetchError(
      "No stable non-draft release found on GitHub",
      false,
    );
  }
  return latest;
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
    const size = readOctal(headerStart + 124, 12);
    const typeflag = String.fromCharCode(buf[headerStart + 156]);

    // GNU/POSIX long name extension: type 'L' = long link, 'K' = long link name
    if (typeflag === "L" || typeflag === "K") {
      // The data block contains the real filename
      pos += 512;
      const nameBytes = buf.slice(pos, pos + size);
      pendingLongName = new TextDecoder().decode(nameBytes).replace(/\0/g, "");
      // Advance past data blocks
      pos += Math.ceil(size / 512) * 512;
      continue;
    }

    pos += 512; // advance past header

    const actualName = pendingLongName ?? name;
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

// ---------------------------------------------------------------------------
// Extraction using @tauri-apps/plugin-fs
// ---------------------------------------------------------------------------

/**
 * Strip the top-level GitHub archive directory prefix.
 * GitHub tarballs look like: `indigoai-us-hq-<sha>/path/to/file`
 * We want: `path/to/file`
 */
function stripTopLevelDir(entryName: string): string {
  const slash = entryName.indexOf("/");
  if (slash === -1) return entryName;
  return entryName.slice(slash + 1);
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

  // 3. Write each entry via Tauri plugin-fs
  for (const entry of entries) {
    const relative = stripTopLevelDir(entry.name);
    if (!relative || relative === "./" || relative.endsWith("/")) {
      // Name-based directory entry — create it if non-trivial
      if (relative && relative !== "./") {
        const dirPath = safeJoin(targetDir, relative.replace(/\/+$/, ""));
        if (!dirPath) continue; // path traversal attempt — skip
        await mkdir(dirPath, { recursive: true });
      }
      continue;
    }

    const isDir = entry.typeflag === "5";
    if (isDir) {
      const dirPath = safeJoin(targetDir, relative);
      if (!dirPath) continue; // path traversal attempt — skip
      await mkdir(dirPath, { recursive: true });
      continue;
    }

    // Regular file
    const filePath = safeJoin(targetDir, relative);
    if (!filePath) continue; // path traversal attempt — skip

    // Ensure parent directory exists
    const lastSlash = filePath.lastIndexOf("/");
    if (lastSlash > 0) {
      const parentDir = filePath.slice(0, lastSlash);
      await mkdir(parentDir, { recursive: true });
    }

    await writeFile(filePath, entry.data);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch the HQ template from GitHub and extract it into targetDir.
 *
 * @param targetDir - Absolute path where the template should be extracted
 * @param tag - Optional: pin to a specific release tag. Defaults to latest non-prerelease.
 * @param onProgress - Optional callback receiving {bytes, total} progress events
 * @param signal - Optional AbortSignal for cancellation
 * @returns { version: string } — the release tag that was fetched
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

  // 1. Resolve release info
  const release = tag
    ? await getTagRelease(tag, signal)
    : await getLatestRelease(signal);

  const version = release.tag_name;
  const tarballUrl = release.tarball_url;

  // 2. Download tarball with streaming progress
  const compressedBytes = await downloadTarball(tarballUrl, onProgress, signal);

  // 3. Ensure target directory exists
  await mkdir(targetDir, { recursive: true });

  // 4. Extract
  await extractTarball(compressedBytes, targetDir);

  return { version };
}
