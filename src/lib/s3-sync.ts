// s3-sync.ts — US-005
// Pull company files from S3 using scoped STS credentials from vault-service.

import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { invoke } from "@tauri-apps/api/core";
import { fetch } from "@tauri-apps/plugin-http";
import { TauriHttpHandler } from "./tauri-http-handler";
import { CLIENT_HEADERS } from "./client-info";

interface StsVendResponse {
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken: string;
    expiration: string;
  };
  expiresAt: string;
}

export interface StsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  bucketName: string;
  /** Optional S3 key prefix to strip when computing relative paths. */
  prefix?: string;
  expiresAt: string;
}

export interface SyncProgress {
  totalFiles: number;
  downloadedFiles: number;
  totalBytes: number;
  downloadedBytes: number;
  currentFile: string;
}

export type SyncProgressCallback = (progress: SyncProgress) => void;

/**
 * Resolve an S3 object key to a safe on-disk path under `installPath`.
 *
 * Context:
 *   Each company's S3 bucket is scaffolded by hq-onboarding's /api/provision/scaffold
 *   route and its contents mirror `companies/{slug}/` in HQ — i.e. the bucket
 *   root holds `.hq/manifest.json`, `knowledge/`, `settings/`, `data/`, etc.
 *   We therefore write each object at `{installPath}/{destSubpath}/{key}`,
 *   where `destSubpath` is typically `companies/{slug}`. Without that prefix
 *   the bucket's `knowledge/` would shadow the HQ's own top-level `knowledge/`.
 *
 * Returns null if the resolved path would escape `installPath` (e.g. because
 * the key contains `..` segments, starts with `/`, or uses Windows drive/UNC
 * prefixes). Callers should skip those entries — a well-behaved bucket never
 * produces them, so this is a defense-in-depth guard against a compromised or
 * buggy writer.
 */
export function resolveLocalPath(
  installPath: string,
  s3Key: string,
  destSubpath?: string,
  s3Prefix?: string,
): string | null {
  // 1. Strip the (optional) S3 key prefix so we're working with a relative path.
  const stripped =
    s3Prefix && s3Key.startsWith(s3Prefix)
      ? s3Key.slice(s3Prefix.length).replace(/^\//, "")
      : s3Key;

  if (!stripped) return null;

  // 2. Treat both slash forms as path separators. S3 keys normally use `/`,
  //    but a compromised writer can still upload names containing `\`, which
  //    Windows resolves as traversal unless we reject it here.
  const keyRelative = normalizeSafeRelativePath(stripped);
  if (!keyRelative) return null;

  if (destSubpath && /^[\\/]{2}/.test(destSubpath)) return null;
  const cleanedDestSubpath = destSubpath?.replace(/^[\\/]+|[\\/]+$/g, "");
  const destRelative = cleanedDestSubpath
    ? normalizeSafeRelativePath(cleanedDestSubpath)
    : null;
  if (destSubpath && cleanedDestSubpath && !destRelative) return null;

  // 3. Join { installPath, destSubpath?, relativeKey } with single separators.
  //    Trim trailing slashes on installPath so we don't double-slash.
  const trimmedBase = installPath.replace(/[\\/]+$/, "");
  const relativePath = destRelative
    ? `${destRelative}/${keyRelative}`
    : keyRelative;
  const localPath = `${trimmedBase || installPath}/${relativePath}`;

  const root = normalizeTrustedPath(installPath);
  const resolved = normalizeTrustedPath(localPath);
  if (!root || !resolved || !isPathWithinRoot(resolved, root)) return null;

  return resolved;
}

function normalizeSafeRelativePath(relative: string): string | null {
  if (!relative || relative.includes("\0")) return null;
  if (hasUnsafePathPrefix(relative) || relative.includes(":")) return null;

  const safe: string[] = [];
  for (const seg of relative.replace(/\\/g, "/").split("/")) {
    if (seg === "" || seg === "." || seg === "..") return null;
    safe.push(seg);
  }

  return safe.length > 0 ? safe.join("/") : null;
}

function hasUnsafePathPrefix(path: string): boolean {
  return (
    path.startsWith("/") ||
    path.startsWith("\\") ||
    path.startsWith("//") ||
    path.startsWith("\\\\") ||
    /^[A-Za-z]:/.test(path)
  );
}

function normalizeTrustedPath(path: string): string | null {
  if (!path || path.includes("\0")) return null;

  const normalized = path.replace(/\\/g, "/");
  const driveMatch = normalized.match(/^([A-Za-z]:)\/?/);
  let prefix = "";
  let rest = normalized;

  if (driveMatch) {
    prefix = driveMatch[1].toUpperCase();
    rest = normalized.slice(driveMatch[0].length);
  } else if (normalized.startsWith("//")) {
    prefix = "//";
    rest = normalized.replace(/^\/+/, "");
  } else if (normalized.startsWith("/")) {
    prefix = "/";
    rest = normalized.replace(/^\/+/, "");
  }

  const parts: string[] = [];
  for (const seg of rest.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(seg);
    }
  }

  if (prefix === "/") return parts.length > 0 ? `/${parts.join("/")}` : "/";
  if (prefix === "//") return `//${parts.join("/")}`;
  if (prefix) return parts.length > 0 ? `${prefix}/${parts.join("/")}` : `${prefix}/`;
  return parts.join("/");
}

function isPathWithinRoot(path: string, root: string): boolean {
  const caseInsensitive = /^[A-Za-z]:\//.test(root) || root.startsWith("//");
  const candidate = caseInsensitive ? path.toLowerCase() : path;
  const base = caseInsensitive ? root.toLowerCase() : root;

  if (base.endsWith("/")) return candidate.startsWith(base);
  return candidate === base || candidate.startsWith(`${base}/`);
}

function getVaultApiUrl(): string {
  // hq-prod custom domain (canonical post-2026-04-28 cutover). Override via VITE_VAULT_API_URL.
  return (
    (import.meta.env.VITE_VAULT_API_URL as string | undefined) ??
    "https://hqapi.getindigo.ai"
  );
}

/**
 * Vend scoped STS credentials from vault-service for the user's company bucket.
 */
export async function vendStsCredentials(
  accessToken: string,
  companyUid: string,
  bucketName: string
): Promise<StsCredentials> {
  const res = await fetch(`${getVaultApiUrl()}/sts/vend`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...CLIENT_HEADERS,
    },
    body: JSON.stringify({
      companyUid,
    }),
  });

  if (!res.ok) {
    throw new Error(`STS vend failed: ${res.status}`);
  }

  const data: StsVendResponse = await res.json();
  return {
    accessKeyId: data.credentials.accessKeyId,
    secretAccessKey: data.credentials.secretAccessKey,
    sessionToken: data.credentials.sessionToken,
    bucketName,
    expiresAt: data.expiresAt,
  };
}

/**
 * Sync files from S3 to the local install directory.
 *
 * Uses Tauri's `invoke("write_file")` to write downloaded content to disk
 * since browser-context S3Client can't write to the filesystem directly.
 *
 * @param destSubpath Optional relative path under `installPath` where the
 *   bucket contents should land. Callers syncing a company bucket should pass
 *   `"companies/{slug}"` so the bucket's `knowledge/`, `settings/`, etc.
 *   become `{installPath}/companies/{slug}/knowledge/...` on disk. Without
 *   this, the company's knowledge would overwrite the HQ's top-level
 *   `knowledge/` directory (see resolveLocalPath for the rationale).
 */
export async function syncFromS3(
  creds: StsCredentials,
  installPath: string,
  onProgress?: SyncProgressCallback,
  destSubpath?: string
): Promise<{ fileCount: number; totalBytes: number }> {
  // NOTE: requestHandler override is critical.
  // The SDK's default FetchHttpHandler uses WebKit's native fetch, which is
  // subject to CORS and fails with a generic "Load failed" when S3 doesn't
  // return CORS headers for Tauri's origin. TauriHttpHandler routes the
  // request through plugin-http (Rust process), bypassing CORS entirely.
  const client = new S3Client({
    region: "us-east-1",
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    },
    requestHandler: new TauriHttpHandler(),
  });

  // List all objects under the company prefix
  let listRes;
  try {
    listRes = await client.send(
      new ListObjectsV2Command({
        Bucket: creds.bucketName,
        // List all objects in the company bucket (no prefix — bucket is per-company)
      })
    );
  } catch (err) {
    // Surface the underlying SDK error detail instead of "Load failed".
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`S3 ListObjectsV2 failed: ${msg}`);
  }

  // Include zero-byte objects too. hq-onboarding's scaffold route uploads
  // `.gitkeep` markers (0 bytes) for empty canonical dirs — settings/, data/,
  // projects/, policies/, registry/, repos/, knowledge/. Filtering on size > 0
  // would drop them and leave those directories missing after sync. S3 has no
  // real folders; the placeholder IS the folder.
  const objects = (listRes.Contents ?? []).filter(
    (obj) => obj.Key && typeof obj.Size === "number"
  );

  const totalFiles = objects.length;
  const totalBytes = objects.reduce((sum, obj) => sum + (obj.Size ?? 0), 0);

  const progress: SyncProgress = {
    totalFiles,
    downloadedFiles: 0,
    totalBytes,
    downloadedBytes: 0,
    currentFile: "",
  };

  for (const obj of objects) {
    const key = obj.Key!;

    // Resolve the on-disk path (handles prefix stripping + destSubpath +
    // `..` rejection). Null means the key was unsafe or empty — skip it
    // rather than aborting the whole sync, so one bad object doesn't
    // strand an otherwise-good bucket.
    const filePath = resolveLocalPath(installPath, key, destSubpath, creds.prefix);
    if (!filePath) continue;

    // currentFile is purely for the progress UI — show the path the user
    // will see on disk (relative to installPath) rather than the raw S3 key.
    progress.currentFile = filePath.startsWith(installPath)
      ? filePath.slice(installPath.replace(/\/+$/, "").length + 1)
      : filePath;
    onProgress?.(progress);

    let getRes;
    try {
      getRes = await client.send(
        new GetObjectCommand({ Bucket: creds.bucketName, Key: key })
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`S3 GetObject failed for '${key}': ${msg}`);
    }

    if (getRes.Body) {
      // Read body as bytes and write via Tauri
      const bytes = await getRes.Body.transformToByteArray();

      await invoke("write_file", {
        path: filePath,
        contents: Array.from(bytes),
      });
    }

    progress.downloadedFiles += 1;
    progress.downloadedBytes += obj.Size ?? 0;
    onProgress?.(progress);
  }

  return { fileCount: totalFiles, totalBytes };
}
