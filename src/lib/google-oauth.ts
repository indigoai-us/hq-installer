// google-oauth.ts
//
// Google sign-in via Cognito Hosted UI + OAuth loopback redirect with PKCE.
//
// Flow:
//   1. generatePkce() creates a random `verifier` and its SHA-256 `challenge`.
//   2. buildAuthorizeUrl(...) produces the URL to open in the system browser.
//   3. Rust `oauth_listen_for_code` command binds 127.0.0.1:53682 and waits
//      for the browser to redirect back with `?code=...&state=...`.
//   4. exchangeCodeForTokens(...) POSTs code + verifier to /oauth2/token and
//      returns Cognito tokens that the existing keychain helpers can store.
//
// All public functions are pure (no env reads baked in) so they can be
// unit-tested with explicit config; the default config comes from Vite env
// vars via getDefaultConfig().

import type { CognitoTokens } from "./cognito";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface OAuthConfig {
  /** Cognito user pool client ID (public client, no secret). */
  clientId: string;
  /** Fully-qualified Cognito Hosted UI domain (no scheme, no trailing slash). */
  cognitoDomain: string;
  /** Loopback redirect URI. Must be registered in the app client. */
  redirectUri: string;
}

export const DEFAULT_LOOPBACK_PORT = 53682;
export const DEFAULT_REDIRECT_URI = `http://localhost:${DEFAULT_LOOPBACK_PORT}/callback`;

/** Strip "https://" and trailing slash from a Cognito domain env value. */
function normalizeDomain(raw: string): string {
  return raw.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

export function getDefaultConfig(): OAuthConfig {
  const clientId = import.meta.env.VITE_COGNITO_CLIENT_ID as string | undefined;
  const domain = import.meta.env.VITE_COGNITO_DOMAIN as string | undefined;
  if (!clientId) throw new Error("VITE_COGNITO_CLIENT_ID is not set");
  if (!domain) throw new Error("VITE_COGNITO_DOMAIN is not set");
  return {
    clientId,
    cognitoDomain: normalizeDomain(domain),
    redirectUri: DEFAULT_REDIRECT_URI,
  };
}

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

export interface Pkce {
  /** Random verifier — sent to /oauth2/token to prove we started the flow. */
  verifier: string;
  /** SHA-256 hash of the verifier, base64url-encoded — sent to /authorize. */
  challenge: string;
  /** Hash method identifier. Always "S256" for SHA-256 challenges. */
  method: "S256";
}

/** base64url encode a Uint8Array (no padding, URL-safe chars). */
function base64UrlEncode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return buf;
}

/** Generate a PKCE verifier/challenge pair per RFC 7636. */
export async function generatePkce(): Promise<Pkce> {
  // RFC 7636 says verifier must be 43-128 chars of [A-Z a-z 0-9 - . _ ~].
  // 32 random bytes → 43 base64url chars (no padding) — satisfies the rule.
  const verifier = base64UrlEncode(randomBytes(32));
  const challengeBytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  const challenge = base64UrlEncode(new Uint8Array(challengeBytes));
  return { verifier, challenge, method: "S256" };
}

/** Generate an opaque random state parameter (CSRF token). */
export function generateState(): string {
  return base64UrlEncode(randomBytes(16));
}

// ---------------------------------------------------------------------------
// Authorize URL
// ---------------------------------------------------------------------------

export interface AuthorizeArgs {
  config: OAuthConfig;
  state: string;
  codeChallenge: string;
}

/**
 * Build the Cognito Hosted UI URL that signs the user in via Google.
 *
 * `identity_provider=Google` skips the Cognito username/password screen and
 * goes straight to Google consent.
 */
export function buildAuthorizeUrl({
  config,
  state,
  codeChallenge,
}: AuthorizeArgs): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    scope: "openid email profile",
    redirect_uri: config.redirectUri,
    identity_provider: "Google",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  return `https://${config.cognitoDomain}/oauth2/authorize?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Token exchange
// ---------------------------------------------------------------------------

export interface TokenExchangeArgs {
  config: OAuthConfig;
  code: string;
  verifier: string;
  /** Injected for tests. Defaults to global fetch. */
  fetchFn?: typeof fetch;
}

/**
 * POST the auth code + PKCE verifier to /oauth2/token and parse the response
 * into the same CognitoTokens shape that the keychain helpers already use.
 */
export async function exchangeCodeForTokens({
  config,
  code,
  verifier,
  fetchFn = fetch,
}: TokenExchangeArgs): Promise<CognitoTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    code,
    code_verifier: verifier,
  });
  const res = await fetchFn(`https://${config.cognitoDomain}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as {
    access_token?: string;
    id_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!data.access_token || !data.id_token) {
    throw new Error("Token exchange missing access_token or id_token");
  }
  return {
    accessToken: data.access_token,
    idToken: data.id_token,
    refreshToken: data.refresh_token ?? "",
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
}
