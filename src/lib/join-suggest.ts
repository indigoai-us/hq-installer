// join-suggest.ts — US-019
// Neutral, anti-enumeration client for the held server-side join matcher.
//
// The client never tries to discover organizations by email/domain itself.
// It only asks an authenticated endpoint for the caller's own verified JWT
// domain, receives a neutral `{ match: false }` or one joinable company, and
// never receives names/ids for organizations the caller cannot request to
// join. Generic/public email domains are excluded client-side as
// defense-in-depth, and the server endpoint remains the authoritative matcher
// for "exactly one existing company creator has this verified domain".

import {
  extractEmailDomain,
  isGenericEmailDomain,
} from "@/lib/generic-email-domains";

export type JoinSuggestion =
  | { match: false }
  | { match: true; company: { uid: string; name: string } };

export const DEFAULT_JOIN_API_URL = "https://hqapi.getindigo.ai";

function apiBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function parseJoinSuggestion(value: unknown): JoinSuggestion {
  if (typeof value !== "object" || value === null) {
    return { match: false };
  }

  const body = value as {
    match?: unknown;
    company?: { uid?: unknown; name?: unknown };
  };

  if (body.match === false) {
    return { match: false };
  }

  if (
    body.match === true &&
    typeof body.company === "object" &&
    body.company !== null &&
    typeof body.company.uid === "string" &&
    typeof body.company.name === "string" &&
    body.company.uid.length > 0 &&
    body.company.name.length > 0
  ) {
    return {
      match: true,
      company: {
        uid: body.company.uid,
        name: body.company.name,
      },
    };
  }

  return { match: false };
}

export async function fetchJoinSuggestion(
  accessToken: string,
  email: string,
  opts: { fetchImpl?: typeof fetch; baseUrl?: string } = {},
): Promise<JoinSuggestion> {
  const domain = extractEmailDomain(email);
  if (!domain || isGenericEmailDomain(domain)) {
    return { match: false };
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = apiBase(opts.baseUrl ?? DEFAULT_JOIN_API_URL);

  try {
    const res = await fetchImpl(`${base}/membership/suggest-join`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      // Do not send email or domain; the server derives the verified domain
      // from the bearer JWT to avoid turning this endpoint into an oracle.
      body: "{}",
    });
    if (!res.ok) return { match: false };
    return parseJoinSuggestion(await res.json());
  } catch {
    return { match: false };
  }
}

export async function requestJoinCompany(
  accessToken: string,
  companyUid: string,
  opts: { fetchImpl?: typeof fetch; baseUrl?: string } = {},
): Promise<{ ok: boolean; detail?: string }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = apiBase(opts.baseUrl ?? DEFAULT_JOIN_API_URL);

  try {
    // Reuses the shipped Access Funnel request-access path; join approval
    // semantics (auto vs admin-approve) follow the funnel and are pending
    // product confirm.
    const res = await fetchImpl(`${base}/membership/request-access`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ companyUid }),
    });
    if (res.ok) return { ok: true };
    const detail = await res.text().catch(() => `HTTP ${res.status}`);
    return { ok: false, detail: detail || `HTTP ${res.status}` };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, detail };
  }
}
