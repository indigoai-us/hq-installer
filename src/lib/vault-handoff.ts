// vault-handoff.ts — US-003
// Look up the user's existing company from vault-service after Cognito sign-in.
// Uses plain fetch (not hq-cloud SDK, which requires Node.js fs/crypto).

import type { HandoffResult } from "../types/handoff";

const DEFAULT_VAULT_API_URL =
  "https://tqdwdqxv75.execute-api.us-east-1.amazonaws.com";

function getVaultApiUrl(): string {
  return (
    (import.meta.env.VITE_VAULT_API_URL as string | undefined) ??
    DEFAULT_VAULT_API_URL
  );
}

interface VaultEntity {
  uid: string;
  type: string;
  slug: string;
  name: string;
  metadata?: Record<string, unknown>;
}

interface MembershipEntry {
  uid: string;
  entityUid: string;
  memberEntityUid: string;
  role: string;
  metadata?: Record<string, unknown>;
}

/**
 * Resolve the user's company from vault-service using their Cognito access token.
 *
 * Flow:
 *  1. GET /entity/by-type/person → find person matching the user's email slug
 *  2. GET /membership/list?memberEntityUid={personUid} → find company membership
 *  3. GET /entity/{companyUid} → get company details (name, slug, bucket)
 *
 * Returns { found: false } if the user has no provisioned company.
 */
export async function resolveUserCompany(
  accessToken: string
): Promise<HandoffResult> {
  const base = getVaultApiUrl();
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };

  // Step 1: Find the person entity
  const personsRes = await fetch(`${base}/entity/by-type/person`, { headers });
  if (!personsRes.ok) {
    throw new Error(
      `vault-service /entity/by-type/person failed: ${personsRes.status}`
    );
  }
  const persons: VaultEntity[] = await personsRes.json();
  if (!persons.length) {
    return { found: false };
  }
  // Use the first person entity (single-user context after Cognito auth)
  const person = persons[0];

  // Step 2: Find company memberships for this person
  const membershipsRes = await fetch(
    `${base}/membership/list?memberEntityUid=${person.uid}`,
    { headers }
  );
  if (!membershipsRes.ok) {
    throw new Error(
      `vault-service /membership/list failed: ${membershipsRes.status}`
    );
  }
  const memberships: MembershipEntry[] = await membershipsRes.json();
  if (!memberships.length) {
    return { found: false };
  }
  // MVP: use the first company membership
  const membership = memberships[0];

  // Step 3: Get company entity details
  const companyRes = await fetch(
    `${base}/entity/${membership.entityUid}`,
    { headers }
  );
  if (!companyRes.ok) {
    throw new Error(
      `vault-service /entity/${membership.entityUid} failed: ${companyRes.status}`
    );
  }
  const company: VaultEntity = await companyRes.json();

  return {
    found: true,
    companyUid: company.uid,
    companySlug: company.slug,
    companyName: company.name,
    bucketName:
      (company.metadata?.["bucketName"] as string) ??
      `hq-vault-${company.slug}`,
    personUid: person.uid,
    role: membership.role,
  };
}
