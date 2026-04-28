// vault-handoff.ts — US-003
// Look up the user's existing company from vault-service after Cognito sign-in.
// Uses tauri-plugin-http (not window.fetch) so requests go through Rust
// reqwest instead of WKWebView — sidesteps the API Gateway CORS allowlist,
// which does not include `tauri://localhost`.

import { fetch } from "@tauri-apps/plugin-http";
import type { HandoffResult } from "../types/handoff";

// hq-prod custom domain (canonical post-2026-04-28 cutover). Override via VITE_VAULT_API_URL.
const DEFAULT_VAULT_API_URL = "https://hqapi.getindigo.ai";

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
  bucketName?: string;
  metadata?: Record<string, unknown>;
}

interface MembershipEntry {
  membershipKey: string;
  personUid: string;
  companyUid: string;
  role: string;
  status: string;
}

/** Optional hints needed to claim email-keyed pending invites on first sign-in.
 *  When provided, `resolveUserCompany` will list pending invites and, if any
 *  exist, bootstrap a person entity + rewrite the invites to personUid-keyed
 *  BEFORE running the normal lookup. Mirrors the hq-onboarding flow. */
interface ClaimHints {
  /** Cognito `sub` — used as the ownerUid on the created person entity. */
  ownerSub: string;
  /** Used as the person entity's `name` when creating it. */
  displayName: string;
}

/** Slugify a name for use as a person entity slug (matches hq-onboarding). */
function nameToSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

/** Return the caller's person entity if one exists, else null. */
async function getPersonEntityForOwner(
  base: string,
  headers: Record<string, string>
): Promise<VaultEntity | null> {
  const res = await fetch(`${base}/entity/by-type/person`, { headers });
  if (!res.ok) return null;
  const body = (await res.json()) as { entities: VaultEntity[] };
  return body.entities[0] ?? null;
}

/** Create a person entity for the caller if none exists; return it. */
async function ensurePersonEntity(
  base: string,
  headers: Record<string, string>,
  hints: ClaimHints
): Promise<VaultEntity | null> {
  const existing = await getPersonEntityForOwner(base, headers);
  if (existing) return existing;

  const slug =
    nameToSlug(hints.displayName) ||
    `user-${hints.ownerSub.slice(-8).toLowerCase()}`;
  const res = await fetch(`${base}/entity`, {
    method: "POST",
    headers,
    body: JSON.stringify({ type: "person", name: hints.displayName, slug }),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { entity?: VaultEntity };
  return body.entity ?? null;
}

/**
 * Check for email-keyed pending invites and, if any exist, bootstrap a person
 * entity + rewrite the invites to be personUid-keyed. Idempotent — safe to
 * run on every sign-in. Returns silently on any failure (non-fatal; the
 * downstream `resolveUserCompany` lookup will still try to succeed).
 */
async function claimPendingInvites(
  base: string,
  headers: Record<string, string>,
  hints: ClaimHints
): Promise<void> {
  console.log("[vault-handoff] claim: GET /membership/pending-by-email");
  const pendingRes = await fetch(`${base}/membership/pending-by-email`, {
    headers,
  });
  if (!pendingRes.ok) {
    const detail = await pendingRes.text().catch(() => "");
    console.warn(
      `[vault-handoff] claim: pending-by-email failed (${pendingRes.status}) — ${detail}`
    );
    return;
  }
  const pendingBody = (await pendingRes.json()) as {
    invites?: MembershipEntry[];
  };
  const pending = pendingBody.invites ?? [];
  console.log(`[vault-handoff] claim: ${pending.length} pending invite(s)`);
  if (!pending.length) return;

  const person = await ensurePersonEntity(base, headers, hints);
  if (!person) {
    console.warn("[vault-handoff] claim: ensurePersonEntity returned null — aborting claim");
    return;
  }
  console.log(`[vault-handoff] claim: person ${person.uid} ready, POST /membership/claim-by-email`);

  const claimRes = await fetch(`${base}/membership/claim-by-email`, {
    method: "POST",
    headers,
    body: JSON.stringify({ personUid: person.uid }),
  });
  if (!claimRes.ok) {
    const detail = await claimRes.text().catch(() => "");
    console.warn(
      `[vault-handoff] claim: claim-by-email failed (${claimRes.status}) — ${detail}`
    );
  } else {
    console.log("[vault-handoff] claim: claim-by-email succeeded");
  }
}

/**
 * Resolve the user's company from vault-service using their Cognito access token.
 *
 * Flow:
 *  0. (optional, if hints provided) Claim any email-keyed pending invites so
 *     a freshly-invited user has a person entity + personUid-keyed memberships
 *     before the main lookup runs.
 *  1. GET /entity/by-type/person → find person matching the user's email slug
 *  2. GET /membership/list?memberEntityUid={personUid} → find company membership
 *  3. GET /entity/{companyUid} → get company details (name, slug, bucket)
 *
 * Returns { found: false } if the user has no provisioned company.
 */
export async function resolveUserCompany(
  accessToken: string,
  hints?: ClaimHints
): Promise<HandoffResult> {
  const base = getVaultApiUrl();
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };

  console.log(`[vault-handoff] resolveUserCompany start (base=${base}, hints=${hints ? "yes" : "no"})`);

  // Step 0: Claim email-keyed pending invites (first-sign-in bootstrap).
  if (hints) {
    await claimPendingInvites(base, headers, hints);
  }

  // Step 1: Find the person entity (scoped to caller via JWT)
  console.log("[vault-handoff] step 1: GET /entity/by-type/person");
  const personsRes = await fetch(`${base}/entity/by-type/person`, { headers });
  if (!personsRes.ok) {
    throw new Error(
      `vault-service /entity/by-type/person failed: ${personsRes.status}`
    );
  }
  const personsBody = (await personsRes.json()) as { entities: VaultEntity[] };
  const persons = personsBody.entities;
  console.log(`[vault-handoff] step 1: ${persons.length} person entity/entities`);
  if (!persons.length) {
    console.log("[vault-handoff] no person entity → found:false");
    return { found: false };
  }

  // Step 2: pick the person that actually owns memberships. The server's
  // /entity/by-type GSI has no sort key, so order is unspecified — naïvely
  // taking persons[0] returns "no company" whenever Dynamo hands back a
  // duplicate orphan first. (That orphan-person scenario is rare but real:
  // see 2026-04-25 Vercel-env outage that left the user with three
  // person rows for a single Cognito sub.) Walk the list, return the first
  // person with at least one active membership; fall back to memberships[0]
  // for backwards compat with single-person callers.
  let person: VaultEntity | null = null;
  let memberships: MembershipEntry[] = [];
  for (const p of persons) {
    console.log(`[vault-handoff] step 2: GET /membership/person/${p.uid}`);
    const r = await fetch(`${base}/membership/person/${p.uid}`, { headers });
    if (!r.ok) {
      throw new Error(
        `vault-service /membership/person/${p.uid} failed: ${r.status}`
      );
    }
    const body = (await r.json()) as { memberships: MembershipEntry[] };
    if (body.memberships.length) {
      person = p;
      memberships = body.memberships;
      break;
    }
  }
  if (!person || !memberships.length) {
    return { found: false };
  }
  // MVP: use the first company membership for the chosen person
  const membership = memberships[0];

  // Step 3: Get company entity details
  const companyRes = await fetch(
    `${base}/entity/${membership.companyUid}`,
    { headers }
  );
  if (!companyRes.ok) {
    throw new Error(
      `vault-service /entity/${membership.companyUid} failed: ${companyRes.status}`
    );
  }
  const companyBody = (await companyRes.json()) as { entity: VaultEntity };
  const company = companyBody.entity;

  return {
    found: true,
    companyUid: company.uid,
    companySlug: company.slug,
    companyName: company.name,
    bucketName:
      company.bucketName ??
      (company.metadata?.["bucketName"] as string) ??
      `hq-vault-${company.slug}`,
    personUid: person.uid,
    role: membership.role,
  };
}

export interface UserCompanyEntry {
  companyUid: string;
  companySlug: string;
  companyName: string;
  bucketName: string;
  role: string;
  status: string;
}

/**
 * List every cloud company the user is a member of.
 *
 * Same first two steps as `resolveUserCompany` (find person → list memberships),
 * but fans out to fetch all company entities in parallel and returns them all.
 * Used by the Personalize screen to show every HQ-Pro/Cloud company the user
 * has access to, so we can sync each one's folder during setup.
 */
export async function listUserCompanies(
  accessToken: string
): Promise<UserCompanyEntry[]> {
  const base = getVaultApiUrl();
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };

  const personsRes = await fetch(`${base}/entity/by-type/person`, { headers });
  if (!personsRes.ok) {
    throw new Error(
      `vault-service /entity/by-type/person failed: ${personsRes.status}`
    );
  }
  const personsBody = (await personsRes.json()) as { entities: VaultEntity[] };
  if (!personsBody.entities.length) return [];

  // Same orphan-person guard as resolveUserCompany — pick the person that
  // actually has memberships, since the server-side GSI returns persons in
  // unspecified order.
  let memberships: MembershipEntry[] = [];
  for (const p of personsBody.entities) {
    const r = await fetch(`${base}/membership/person/${p.uid}`, { headers });
    if (!r.ok) {
      throw new Error(
        `vault-service /membership/person/${p.uid} failed: ${r.status}`
      );
    }
    const body = (await r.json()) as { memberships: MembershipEntry[] };
    if (body.memberships.length) {
      memberships = body.memberships;
      break;
    }
  }
  if (!memberships.length) return [];

  const companies = await Promise.all(
    memberships.map(async (m) => {
      const res = await fetch(`${base}/entity/${m.companyUid}`, { headers });
      if (!res.ok) return null;
      const body = (await res.json()) as { entity: VaultEntity };
      const c = body.entity;
      return {
        companyUid: c.uid,
        companySlug: c.slug,
        companyName: c.name,
        bucketName:
          c.bucketName ??
          (c.metadata?.["bucketName"] as string) ??
          `hq-vault-${c.slug}`,
        role: m.role,
        status: m.status,
      } satisfies UserCompanyEntry;
    })
  );

  return companies.filter((c): c is UserCompanyEntry => c !== null);
}
