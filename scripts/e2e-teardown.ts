#!/usr/bin/env npx tsx
/**
 * E2E Teardown — Clean up test user and all associated resources.
 *
 * Deletes:
 *   1. Membership (revoke via API)
 *   2. Person entity (DELETE /entity/{uid})
 *   3. Company entity (DELETE /entity/{uid})
 *   4. S3 bucket (empty + delete)
 *   5. KMS key alias (schedule deletion)
 *   6. Cognito user (admin-delete-user)
 *   7. Cached token + state files
 *
 * Usage:
 *   npx tsx scripts/e2e-teardown.ts
 *   npx tsx scripts/e2e-teardown.ts --email specific@test.com
 *
 * Reads state from ~/.hq-installer-e2e-state.json (written by e2e-setup.ts).
 */

import {
  CognitoIdentityProviderClient,
  AdminDeleteUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  DeleteBucketCommand,
  ListObjectVersionsCommand,
} from "@aws-sdk/client-s3";
import {
  KMSClient,
  ScheduleKeyDeletionCommand,
  DeleteAliasCommand,
  DescribeKeyCommand,
} from "@aws-sdk/client-kms";
import { readFileSync, unlinkSync, existsSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const VAULT_API_URL = "https://tqdwdqxv75.execute-api.us-east-1.amazonaws.com";
const USER_POOL_ID = "us-east-1_IksCYBcBr";
const REGION = "us-east-1";
const TOKEN_CACHE_PATH = join(
  process.env.HOME ?? "/tmp",
  ".hq-installer-e2e-tokens.json"
);
const STATE_PATH = join(
  process.env.HOME ?? "/tmp",
  ".hq-installer-e2e-state.json"
);

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

const cognito = new CognitoIdentityProviderClient({ region: REGION });
const s3 = new S3Client({ region: REGION });
const kms = new KMSClient({ region: REGION });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(step: string, msg: string) {
  console.log(`  [${step}] ${msg}`);
}

function logSkip(step: string, msg: string) {
  console.log(`  [${step}] SKIP: ${msg}`);
}

async function vaultApi(
  method: string,
  path: string,
  token: string,
  body?: Record<string, unknown>
): Promise<unknown> {
  const res = await fetch(`${VAULT_API_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(
      `${method} ${path} → ${res.status}: ${JSON.stringify(data)}`
    );
  }
  return res.json();
}

function entityUidToSlug(uid: string): string {
  return uid.toLowerCase().replace(/_/g, "-");
}

async function emptyAndDeleteBucket(bucketName: string): Promise<boolean> {
  try {
    // Delete all object versions (handles versioned buckets)
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;
    let deleted = 0;

    do {
      const versions = await s3.send(
        new ListObjectVersionsCommand({
          Bucket: bucketName,
          KeyMarker: keyMarker,
          VersionIdMarker: versionIdMarker,
        })
      );

      const objects = [
        ...(versions.Versions ?? []),
        ...(versions.DeleteMarkers ?? []),
      ];

      if (objects.length > 0) {
        await s3.send(
          new DeleteObjectsCommand({
            Bucket: bucketName,
            Delete: {
              Objects: objects.map((o) => ({
                Key: o.Key!,
                VersionId: o.VersionId,
              })),
              Quiet: true,
            },
          })
        );
        deleted += objects.length;
      }

      keyMarker = versions.NextKeyMarker;
      versionIdMarker = versions.NextVersionIdMarker;
    } while (keyMarker);

    if (deleted > 0) {
      log("4/7", `Deleted ${deleted} objects/versions`);
    }

    // Delete the bucket
    await s3.send(new DeleteBucketCommand({ Bucket: bucketName }));
    return true;
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      (err.name === "NoSuchBucket" ||
        err.message.includes("NoSuchBucket") ||
        err.message.includes("does not exist"))
    ) {
      return false; // Bucket doesn't exist — already cleaned
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("\nE2E Teardown: Cleaning up test resources\n");

  // Load state
  if (!existsSync(STATE_PATH)) {
    console.error(
      `No state file at ${STATE_PATH}. Run e2e-setup.ts first, or specify --email.`
    );
    process.exit(1);
  }

  const state = JSON.parse(readFileSync(STATE_PATH, "utf-8")) as {
    email: string;
    personUid: string;
    companyUid: string;
    companySlug: string;
  };

  console.log(`  Email:    ${state.email}`);
  console.log(`  Person:   ${state.personUid}`);
  console.log(`  Company:  ${state.companyUid}`);
  console.log("");

  // Load access token for API calls
  let accessToken: string | null = null;
  if (existsSync(TOKEN_CACHE_PATH)) {
    try {
      const cached = JSON.parse(readFileSync(TOKEN_CACHE_PATH, "utf-8"));
      accessToken = cached.accessToken;
    } catch {
      // ignore
    }
  }

  // Step 1: Revoke membership via API
  if (accessToken) {
    try {
      const membershipKey = `${state.personUid}#${state.companyUid}`;
      await vaultApi("POST", "/membership/revoke", accessToken, {
        membershipKey,
        companyUid: state.companyUid,
      });
      log("1/7", "Membership revoked");
    } catch (err) {
      logSkip(
        "1/7",
        `Membership revoke failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  } else {
    logSkip("1/7", "No access token — cannot revoke membership via API");
  }

  // Step 2: Delete person entity
  if (accessToken) {
    try {
      await vaultApi(
        "DELETE",
        `/entity/${state.personUid}`,
        accessToken
      );
      log("2/7", `Person deleted: ${state.personUid}`);
    } catch (err) {
      logSkip(
        "2/7",
        `Person delete failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  } else {
    logSkip("2/7", "No access token");
  }

  // Step 3: Delete company entity
  if (accessToken) {
    try {
      await vaultApi(
        "DELETE",
        `/entity/${state.companyUid}`,
        accessToken
      );
      log("3/7", `Company deleted: ${state.companyUid}`);
    } catch (err) {
      logSkip(
        "3/7",
        `Company delete failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  } else {
    logSkip("3/7", "No access token");
  }

  // Step 4: Empty and delete S3 bucket
  const bucketName = `hq-vault-${entityUidToSlug(state.companyUid)}`;
  try {
    const deleted = await emptyAndDeleteBucket(bucketName);
    if (deleted) {
      log("4/7", `S3 bucket deleted: ${bucketName}`);
    } else {
      logSkip("4/7", `S3 bucket not found: ${bucketName}`);
    }
  } catch (err) {
    logSkip(
      "4/7",
      `S3 bucket cleanup failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Step 5: Schedule KMS key deletion
  const kmsAlias = `alias/hq-vault-${entityUidToSlug(state.companyUid)}`;
  try {
    // Resolve alias to key ID
    const keyInfo = await kms.send(
      new DescribeKeyCommand({ KeyId: kmsAlias })
    );
    const keyId = keyInfo.KeyMetadata?.KeyId;
    if (keyId) {
      await kms.send(
        new ScheduleKeyDeletionCommand({
          KeyId: keyId,
          PendingWindowInDays: 7,
        })
      );
      await kms
        .send(new DeleteAliasCommand({ AliasName: kmsAlias }))
        .catch(() => {});
      log("5/7", `KMS key scheduled for deletion (7-day wait): ${keyId}`);
    }
  } catch (err) {
    if (
      err instanceof Error &&
      (err.name === "NotFoundException" ||
        err.message.includes("is not found"))
    ) {
      logSkip("5/7", `KMS alias not found: ${kmsAlias}`);
    } else {
      logSkip(
        "5/7",
        `KMS cleanup failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // Step 6: Delete Cognito user
  try {
    await cognito.send(
      new AdminDeleteUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: state.email,
      })
    );
    log("6/7", `Cognito user deleted: ${state.email}`);
  } catch (err) {
    if (
      err instanceof Error &&
      err.name === "UserNotFoundException"
    ) {
      logSkip("6/7", `Cognito user not found: ${state.email}`);
    } else {
      logSkip(
        "6/7",
        `Cognito delete failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // Step 7: Clean up local files
  try {
    if (existsSync(TOKEN_CACHE_PATH)) {
      unlinkSync(TOKEN_CACHE_PATH);
    }
    if (existsSync(STATE_PATH)) {
      unlinkSync(STATE_PATH);
    }
    log("7/7", "Local cache files removed");
  } catch (err) {
    logSkip(
      "7/7",
      `File cleanup failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  console.log("\n" + "─".repeat(50));
  console.log("\n✓ E2E teardown complete!\n");
  console.log("  Ready for another test run: npx tsx scripts/e2e-setup.ts\n");
}

main().catch((err) => {
  console.error("\nFatal error:", err);
  process.exit(1);
});
