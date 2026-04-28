#!/usr/bin/env npx tsx
/**
 * E2E Setup — Provision a test user for the full onboarding → installer flow.
 *
 * Creates:
 *   1. Cognito user (admin API — no email verification needed)
 *   2. Person entity in vault-service
 *   3. Company entity in vault-service
 *   4. S3 bucket via provision/bucket endpoint
 *   5. Membership (person → company, role: owner)
 *   6. Caches Cognito tokens to ~/.hq-installer-e2e-tokens.json
 *
 * Usage:
 *   npx tsx scripts/e2e-setup.ts [--email test@example.com] [--company "Test Co"]
 *
 * Requires: AWS CLI credentials with Cognito admin access (default profile or AWS_PROFILE=default)
 */

import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  InitiateAuthCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// hq-prod custom domain (canonical post-2026-04-28 cutover).
const VAULT_API_URL = "https://hqapi.getindigo.ai";
const USER_POOL_ID = "us-east-1_AXf6Kb5nE";
const CLIENT_ID = "7acei2c8v870enheptb1j5foln";
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
// Parse args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
function getArg(name: string, fallback: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const suffix = randomBytes(4).toString("hex");
const testEmail = getArg("email", `e2e-test-${suffix}@getindigo.ai`);
const testCompanyName = getArg("company", `E2E Test Co ${suffix}`);
const testPassword = `E2e-Test!${randomBytes(8).toString("base64url")}`;
const emailSlug = testEmail.split("@")[0].toLowerCase();
const companySlug = testCompanyName
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/(^-|-$)/g, "");

// ---------------------------------------------------------------------------
// Cognito client
// ---------------------------------------------------------------------------

const cognito = new CognitoIdentityProviderClient({ region: REGION });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  const data = await res.json();
  if (!res.ok) {
    throw new Error(
      `${method} ${path} → ${res.status}: ${JSON.stringify(data)}`
    );
  }
  return data;
}

function log(step: string, msg: string) {
  console.log(`  [${step}] ${msg}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("\nE2E Setup: Provisioning test user\n");
  console.log(`  Email:    ${testEmail}`);
  console.log(`  Company:  ${testCompanyName}`);
  console.log(`  Slug:     ${companySlug}`);
  console.log("");

  // Step 1: Create Cognito user
  log("1/6", "Creating Cognito user...");
  await cognito.send(
    new AdminCreateUserCommand({
      UserPoolId: USER_POOL_ID,
      Username: testEmail,
      UserAttributes: [
        { Name: "email", Value: testEmail },
        { Name: "email_verified", Value: "true" },
      ],
      MessageAction: "SUPPRESS", // Don't send welcome email
    })
  );

  // Set permanent password (skip temp password flow)
  await cognito.send(
    new AdminSetUserPasswordCommand({
      UserPoolId: USER_POOL_ID,
      Username: testEmail,
      Password: testPassword,
      Permanent: true,
    })
  );
  log("1/6", `Cognito user created: ${testEmail}`);

  // Step 2: Authenticate to get tokens
  log("2/6", "Authenticating...");
  const authResult = await cognito.send(
    new InitiateAuthCommand({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: CLIENT_ID,
      AuthParameters: {
        USERNAME: testEmail,
        PASSWORD: testPassword,
      },
    })
  );
  const accessToken = authResult.AuthenticationResult?.AccessToken;
  const idToken = authResult.AuthenticationResult?.IdToken;
  const refreshToken = authResult.AuthenticationResult?.RefreshToken;
  if (!accessToken || !idToken) {
    throw new Error("Authentication failed — no tokens returned");
  }
  log("2/6", "Authenticated successfully");

  // Cache tokens for the installer
  writeFileSync(
    TOKEN_CACHE_PATH,
    JSON.stringify(
      { accessToken, idToken, refreshToken, email: testEmail },
      null,
      2
    )
  );
  log("2/6", `Tokens cached to ${TOKEN_CACHE_PATH}`);

  // Step 3: Create person entity
  log("3/6", "Creating person entity...");
  const personResult = (await vaultApi("POST", "/entity", accessToken, {
    type: "person",
    name: testEmail.split("@")[0],
    slug: emailSlug,
  })) as { entity: { uid: string } };
  const personUid = personResult.entity.uid;
  log("3/6", `Person created: ${personUid}`);

  // Step 4: Create company entity
  log("4/6", "Creating company entity...");
  const companyResult = (await vaultApi("POST", "/entity", accessToken, {
    type: "company",
    name: testCompanyName,
    slug: companySlug,
  })) as { entity: { uid: string } };
  const companyUid = companyResult.entity.uid;
  log("4/6", `Company created: ${companyUid}`);

  // Step 5: Provision S3 bucket
  log("5/6", "Provisioning S3 bucket...");
  try {
    await vaultApi("POST", "/provision/bucket", accessToken, {
      uid: companyUid,
    });
    log("5/6", "Bucket provisioned");
  } catch (err) {
    // Bucket provisioning may take time or require specific permissions
    log(
      "5/6",
      `Bucket provisioning request sent (may be async): ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Step 6: Create membership (bootstrap — first member becomes owner)
  log("6/6", "Creating membership...");
  const inviteResult = (await vaultApi(
    "POST",
    "/membership/invite",
    accessToken,
    {
      personUid,
      companyUid,
      role: "owner",
    }
  )) as { inviteToken: string };

  // Accept the invite
  await vaultApi("POST", "/membership/accept", accessToken, {
    token: inviteResult.inviteToken,
    personUid,
  });
  log("6/6", "Membership created and accepted (owner)");

  // Save state for teardown
  const state = {
    email: testEmail,
    password: testPassword,
    personUid,
    companyUid,
    companySlug,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));

  console.log("\n" + "─".repeat(50));
  console.log("\n✓ E2E setup complete!\n");
  console.log(`  Email:      ${testEmail}`);
  console.log(`  Password:   ${testPassword}`);
  console.log(`  Person:     ${personUid}`);
  console.log(`  Company:    ${companyUid} (${companySlug})`);
  console.log(`  Tokens:     ${TOKEN_CACHE_PATH}`);
  console.log(`  State:      ${STATE_PATH}`);
  console.log(
    `\n  Run the installer: pnpm tauri dev`
  );
  console.log(`  Teardown:   npx tsx scripts/e2e-teardown.ts\n`);
}

main().catch((err) => {
  console.error("\nFatal error:", err);
  process.exit(1);
});
