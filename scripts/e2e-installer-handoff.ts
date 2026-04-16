#!/usr/bin/env npx tsx
/**
 * E2E Smoke Test — Web Onboarding to Installer Handoff (US-007)
 *
 * Verifies the seams between web onboarding, vault-service, and installer
 * without needing to run the Tauri app. Checks:
 *   1. GitHub release .dmg is accessible
 *   2. onboarding.indigo-hq.com completion page has the download link
 *   3. vault-service returns a company for the test Cognito user
 *   4. STS vend returns valid credentials for the resolved company
 *
 * Usage: npx tsx scripts/e2e-installer-handoff.ts
 */

const VAULT_API_URL = "https://tqdwdqxv75.execute-api.us-east-1.amazonaws.com";
const DMG_URL =
  "https://github.com/indigoai-us/hq-installer/releases/latest/download/hq-installer_0.1.0_universal.dmg";
const ONBOARDING_URL = "https://onboarding.indigo-hq.com";

// Cached Cognito tokens path — same as existing e2e scripts
const COGNITO_CACHE_PATH = `${process.env.HOME}/.hq-installer-e2e-tokens.json`;

interface CheckResult {
  name: string;
  passed: boolean;
  message: string;
}

const results: CheckResult[] = [];

function record(name: string, passed: boolean, message: string) {
  results.push({ name, passed, message });
  const icon = passed ? "\u2713" : "\u2717";
  console.log(`  ${icon} ${name}: ${message}`);
}

// ---------------------------------------------------------------------------
// Check 1: GitHub release .dmg is accessible
// ---------------------------------------------------------------------------
async function checkDmgRelease() {
  try {
    const res = await fetch(DMG_URL, { method: "HEAD", redirect: "follow" });
    if (res.ok || res.status === 302 || res.status === 200) {
      record("GitHub release .dmg", true, `HEAD ${DMG_URL} → ${res.status}`);
    } else {
      record(
        "GitHub release .dmg",
        false,
        `Unexpected status ${res.status} for ${DMG_URL}`
      );
    }
  } catch (err) {
    record(
      "GitHub release .dmg",
      false,
      `Fetch failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// ---------------------------------------------------------------------------
// Check 2: Onboarding completion page has download link
// ---------------------------------------------------------------------------
async function checkOnboardingPage() {
  try {
    const res = await fetch(ONBOARDING_URL);
    if (!res.ok) {
      record(
        "Onboarding download link",
        false,
        `Fetch ${ONBOARDING_URL} failed: ${res.status}`
      );
      return;
    }
    const html = await res.text();
    const hasDownloadLink =
      html.includes("hq-installer") || html.includes("Download HQ");
    record(
      "Onboarding download link",
      hasDownloadLink,
      hasDownloadLink
        ? "Download link found in page source"
        : "Download link NOT found in page source (may be client-rendered)"
    );
  } catch (err) {
    record(
      "Onboarding download link",
      false,
      `Fetch failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// ---------------------------------------------------------------------------
// Check 3: vault-service returns company for test user
// ---------------------------------------------------------------------------
async function checkVaultCompany(): Promise<string | null> {
  let accessToken: string | undefined;

  // Try to load cached Cognito tokens
  try {
    const fs = await import("fs");
    if (fs.existsSync(COGNITO_CACHE_PATH)) {
      const cached = JSON.parse(fs.readFileSync(COGNITO_CACHE_PATH, "utf-8"));
      accessToken = cached.accessToken;
    }
  } catch {
    // ignore
  }

  if (!accessToken) {
    record(
      "Vault company lookup",
      false,
      `No cached Cognito tokens at ${COGNITO_CACHE_PATH}. Run the installer e2e first.`
    );
    return null;
  }

  try {
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    };

    // Find person
    const personsRes = await fetch(`${VAULT_API_URL}/entity/by-type/person`, {
      headers,
    });
    if (!personsRes.ok) {
      record(
        "Vault company lookup",
        false,
        `Person lookup failed: ${personsRes.status}`
      );
      return null;
    }

    const persons = (await personsRes.json()) as Array<{
      uid: string;
      name: string;
    }>;
    if (persons.length === 0) {
      record("Vault company lookup", false, "No person entities found");
      return null;
    }

    // Find memberships
    const membershipsRes = await fetch(
      `${VAULT_API_URL}/membership/list?memberEntityUid=${persons[0].uid}`,
      { headers }
    );
    if (!membershipsRes.ok) {
      record(
        "Vault company lookup",
        false,
        `Membership lookup failed: ${membershipsRes.status}`
      );
      return null;
    }

    const memberships = (await membershipsRes.json()) as Array<{
      entityUid: string;
    }>;
    if (memberships.length === 0) {
      record("Vault company lookup", false, "No company memberships found");
      return null;
    }

    const companyUid = memberships[0].entityUid;
    record(
      "Vault company lookup",
      true,
      `Company found: ${companyUid} (person: ${persons[0].uid})`
    );
    return companyUid;
  } catch (err) {
    record(
      "Vault company lookup",
      false,
      `Request failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Check 4: STS vend returns valid credentials
// ---------------------------------------------------------------------------
async function checkStsVend(companyUid: string) {
  let accessToken: string | undefined;

  try {
    const fs = await import("fs");
    if (fs.existsSync(COGNITO_CACHE_PATH)) {
      const cached = JSON.parse(fs.readFileSync(COGNITO_CACHE_PATH, "utf-8"));
      accessToken = cached.accessToken;
    }
  } catch {
    // ignore
  }

  if (!accessToken) {
    record("STS vend", false, "No cached Cognito tokens");
    return;
  }

  try {
    const res = await fetch(`${VAULT_API_URL}/sts/vend`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        entityUid: companyUid,
        action: "sync",
        scope: "full",
      }),
    });

    if (!res.ok) {
      record("STS vend", false, `STS vend failed: ${res.status}`);
      return;
    }

    const creds = (await res.json()) as {
      accessKeyId?: string;
      bucketName?: string;
      expiresAt?: string;
    };
    if (creds.accessKeyId && creds.bucketName) {
      record(
        "STS vend",
        true,
        `Credentials vended for bucket ${creds.bucketName} (expires: ${creds.expiresAt})`
      );
    } else {
      record("STS vend", false, "STS response missing accessKeyId or bucketName");
    }
  } catch (err) {
    record(
      "STS vend",
      false,
      `Request failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log("\nE2E Smoke Test: Web Onboarding → Installer Handoff\n");
  console.log("─".repeat(50));

  await checkDmgRelease();
  await checkOnboardingPage();
  const companyUid = await checkVaultCompany();
  if (companyUid) {
    await checkStsVend(companyUid);
  } else {
    record("STS vend", false, "Skipped — no company UID from previous check");
  }

  console.log("\n" + "─".repeat(50));
  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  console.log(`\nResult: ${passed}/${total} checks passed\n`);

  if (passed < total) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
