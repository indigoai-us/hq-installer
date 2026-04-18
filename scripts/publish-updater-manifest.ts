#!/usr/bin/env tsx
/**
 * publish-updater-manifest.ts
 *
 * Builds a Tauri update manifest (latest.json) and publishes it + the DMG
 * to the `indigo-hq-installer-updates` S3 bucket via presigned PUT URLs.
 * No public-read ACLs are used; CloudFront fronts the bucket for distribution.
 *
 * Usage:
 *   pnpm tsx scripts/publish-updater-manifest.ts \
 *     --version 0.1.0 \
 *     --notes "Release notes" \
 *     --signature "<ed25519-sig>" \
 *     --dmg path/to/hq-installer_0.1.0_universal.dmg
 *
 * Required env vars:
 *   AWS_REGION             (defaults to "us-east-1")
 *   AWS_ACCESS_KEY_ID      (or use the default credential chain)
 *   AWS_SECRET_ACCESS_KEY  (or use the default credential chain)
 */

import * as fs from "fs";
import * as path from "path";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (value !== undefined && !value.startsWith("--")) {
        args[key] = value;
        i++; // consume the value token
      }
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

const { version, notes, signature, dmg } = args;

if (!version || !notes || !signature || !dmg) {
  console.error(
    "Usage: publish-updater-manifest.ts --version <ver> --notes <notes> --signature <sig> --dmg <path>"
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BUCKET = "indigo-hq-installer-updates";
const CLOUDFRONT_ORIGIN = "https://updates.hq-installer.getindigo.ai";
const AWS_REGION = process.env.AWS_REGION ?? "us-east-1";
// Presigned URL expiry: 15 minutes (upload must complete within this window)
const PRESIGNED_EXPIRES_IN = 900;

const dmgS3Key = `releases/v${version}/hq-installer-universal.dmg`;
const manifestS3Key = "latest.json";

const dmgCloudFrontUrl = `${CLOUDFRONT_ORIGIN}/releases/v${version}/hq-installer-universal.dmg`;

// ---------------------------------------------------------------------------
// Build manifest
// ---------------------------------------------------------------------------

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    "darwin-universal": {
      signature,
      url: dmgCloudFrontUrl,
    },
  },
};

const manifestJson = JSON.stringify(manifest, null, 2);

// ---------------------------------------------------------------------------
// S3 client — uses env vars or the default credential chain (IAM role, etc.)
// ---------------------------------------------------------------------------

const s3 = new S3Client({ region: AWS_REGION });

// ---------------------------------------------------------------------------
// Helper: upload a Buffer via presigned PUT URL (no public-read ACL)
// ---------------------------------------------------------------------------

async function uploadViaPresignedPut(
  key: string,
  body: Buffer,
  contentType: string
): Promise<void> {
  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: contentType,
    // No ACL — bucket policy denies public access; CloudFront uses OAC
  });

  const presignedUrl = await getSignedUrl(s3, command, {
    expiresIn: PRESIGNED_EXPIRES_IN,
  });

  const response = await fetch(presignedUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Upload failed for key "${key}": HTTP ${response.status} — ${text}`
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // 1. Upload DMG
  const dmgAbsPath = path.resolve(dmg);
  if (!fs.existsSync(dmgAbsPath)) {
    throw new Error(`DMG not found: ${dmgAbsPath}`);
  }
  const dmgBuffer = fs.readFileSync(dmgAbsPath);

  console.log(`Uploading DMG → s3://${BUCKET}/${dmgS3Key} …`);
  await uploadViaPresignedPut(
    dmgS3Key,
    dmgBuffer,
    "application/octet-stream"
  );
  console.log("DMG uploaded.");

  // 2. Upload latest.json manifest
  const manifestBuffer = Buffer.from(manifestJson, "utf-8");

  console.log(`Uploading manifest → s3://${BUCKET}/${manifestS3Key} …`);
  await uploadViaPresignedPut(
    manifestS3Key,
    manifestBuffer,
    "application/json"
  );

  console.log("Published latest.json to S3");
  console.log(`  version : ${version}`);
  console.log(`  dmg url : ${dmgCloudFrontUrl}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
