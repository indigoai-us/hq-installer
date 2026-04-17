// s3-sync.ts — US-005
// Pull company files from S3 using scoped STS credentials from vault-service.

import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { invoke } from "@tauri-apps/api/core";
import { fetch } from "@tauri-apps/plugin-http";

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

function getVaultApiUrl(): string {
  return (
    (import.meta.env.VITE_VAULT_API_URL as string | undefined) ??
    "https://tqdwdqxv75.execute-api.us-east-1.amazonaws.com"
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
 */
export async function syncFromS3(
  creds: StsCredentials,
  installPath: string,
  onProgress?: SyncProgressCallback
): Promise<{ fileCount: number; totalBytes: number }> {
  const client = new S3Client({
    region: "us-east-1",
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    },
  });

  // List all objects under the company prefix
  const listRes = await client.send(
    new ListObjectsV2Command({
      Bucket: creds.bucketName,
      // List all objects in the company bucket (no prefix — bucket is per-company)
    })
  );

  const objects = (listRes.Contents ?? []).filter(
    (obj) => obj.Key && obj.Size && obj.Size > 0
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

  const prefix = creds.prefix ?? "";
  for (const obj of objects) {
    const key = obj.Key!;
    // Strip the prefix to get the relative path
    const relativePath = prefix && key.startsWith(prefix)
      ? key.slice(prefix.length).replace(/^\//, "")
      : key;

    if (!relativePath) continue;

    progress.currentFile = relativePath;
    onProgress?.(progress);

    const getRes = await client.send(
      new GetObjectCommand({ Bucket: creds.bucketName, Key: key })
    );

    if (getRes.Body) {
      // Read body as bytes and write via Tauri
      const bytes = await getRes.Body.transformToByteArray();
      const filePath = `${installPath}/${relativePath}`;

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
