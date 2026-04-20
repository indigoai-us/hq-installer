// cognito.ts — token lifecycle + keychain persistence.
//
// Authentication itself lives in `google-oauth.ts` (Google via Cognito Hosted
// UI + PKCE). This module is responsible for:
//   - Storing/loading/clearing Cognito tokens in the macOS keychain.
//   - Refreshing expired sessions via REFRESH_TOKEN_AUTH.
//   - Exposing the current authenticated user derived from the stored idToken.
//   - Global sign-out.

import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  GlobalSignOutCommand,
  type InitiateAuthCommandOutput,
} from "@aws-sdk/client-cognito-identity-provider";
import { invoke } from "@tauri-apps/api/core";

// ---------------------------------------------------------------------------
// Config (build-time env vars — read lazily so tests can stub import.meta.env)
// ---------------------------------------------------------------------------

function getUserPoolId(): string {
  return import.meta.env.VITE_COGNITO_USER_POOL_ID as string;
}

function getClientId(): string {
  return import.meta.env.VITE_COGNITO_CLIENT_ID as string;
}

/** Extract region from pool ID format: "us-east-1_XXXXX" → "us-east-1" */
function regionFromPoolId(poolId: string): string {
  const parts = poolId.split("_");
  if (parts.length < 2) {
    throw new Error(`Invalid Cognito User Pool ID: ${poolId}`);
  }
  return parts[0];
}

function makeClient(): CognitoIdentityProviderClient {
  return new CognitoIdentityProviderClient({
    region: regionFromPoolId(getUserPoolId()),
  });
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CognitoTokens {
  accessToken: string;
  idToken: string;
  refreshToken: string;
  /** Unix timestamp in milliseconds when the access/id tokens expire */
  expiresAt: number;
}

export interface CurrentUser {
  sub: string;
  email: string;
  /** Full display name from the Google-federated idToken (claim: "name").
   *  Absent only when the user signed up without a federated provider. */
  name?: string;
  givenName?: string;
  familyName?: string;
  tokens: CognitoTokens;
}

// ---------------------------------------------------------------------------
// Keychain helpers
// ---------------------------------------------------------------------------

const KC_SERVICE = "cognito";
// Tokens are stored as a single JSON blob under one account name so each
// macOS keychain access is a single ACL prompt in dev builds (unsigned
// binaries prompt per access). Previously we split across four accounts,
// which caused 4-12 prompts per sign-in on dev.
const KC_ACCOUNT = "tokens";

// In-memory cache for the current session's tokens. On unsigned dev builds
// macOS prompts the user on every keychain read, so callers like
// getCurrentUser() — which can run on every mount, including React
// StrictMode's double-mount and screen-to-screen navigation — would each
// trigger a fresh ACL dialog. Caching here means the keychain is hit at
// most once per app launch for reads: storeTokens() populates it after
// sign-in, the first loadTokens() call warms it from the keychain if the
// app was just launched, and every subsequent call serves from memory.
//
// The cache is module-scoped (per-window), so it dies naturally on app
// restart — tokens still live in the keychain as the source of truth.
// clearTokens() invalidates the cache so signOut() doesn't leave a ghost
// session in memory.
let cachedTokens: CognitoTokens | null = null;
let cacheWarmed = false;
// Memoize the pending keychain read so concurrent callers (StrictMode's
// double-mounted effect, two screens racing to detect the user) share one
// invoke() — otherwise both dispatch a keychain_get before either
// populates `cacheWarmed`, causing two ACL prompts on unsigned dev builds.
let pendingLoad: Promise<CognitoTokens | null> | null = null;

export async function storeTokens(tokens: CognitoTokens): Promise<void> {
  await invoke("keychain_set", {
    service: KC_SERVICE,
    account: KC_ACCOUNT,
    secret: JSON.stringify(tokens),
  });
  cachedTokens = tokens;
  cacheWarmed = true;
  pendingLoad = null;
}

async function loadTokens(): Promise<CognitoTokens | null> {
  // Serve from memory if we've already read (or written) once this session.
  // `cacheWarmed` distinguishes "never loaded" (cold start) from
  // "loaded and confirmed no tokens exist" (both leave cachedTokens null).
  if (cacheWarmed) return cachedTokens;
  // Another caller is already asking the keychain — ride their promise.
  if (pendingLoad) return pendingLoad;

  pendingLoad = (async () => {
    try {
      const raw = await invoke<string>("keychain_get", {
        service: KC_SERVICE,
        account: KC_ACCOUNT,
      });
      if (!raw) {
        cachedTokens = null;
        cacheWarmed = true;
        return null;
      }
      const parsed = JSON.parse(raw) as Partial<CognitoTokens>;
      if (
        typeof parsed.accessToken !== "string" ||
        typeof parsed.idToken !== "string" ||
        typeof parsed.refreshToken !== "string" ||
        typeof parsed.expiresAt !== "number"
      ) {
        cachedTokens = null;
        cacheWarmed = true;
        return null;
      }
      cachedTokens = {
        accessToken: parsed.accessToken,
        idToken: parsed.idToken,
        refreshToken: parsed.refreshToken,
        expiresAt: parsed.expiresAt,
      };
      cacheWarmed = true;
      return cachedTokens;
    } catch {
      cachedTokens = null;
      cacheWarmed = true;
      return null;
    } finally {
      pendingLoad = null;
    }
  })();

  return pendingLoad;
}

async function clearTokens(): Promise<void> {
  try {
    await invoke("keychain_delete", {
      service: KC_SERVICE,
      account: KC_ACCOUNT,
    });
  } catch {
    // Best-effort — entry may not exist
  }
  // Always invalidate in-memory state, even if the keychain delete failed —
  // the user's intent is "forget this session".
  cachedTokens = null;
  cacheWarmed = true;
  pendingLoad = null;
}

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

function isExpired(tokens: CognitoTokens): boolean {
  // Consider tokens expired if within 30 seconds of expiry
  return Date.now() >= tokens.expiresAt - 30_000;
}

function expiresAtFromSeconds(expiresIn: number): number {
  return Date.now() + expiresIn * 1000;
}

function tokensFromAuthResult(
  result: InitiateAuthCommandOutput["AuthenticationResult"],
  existingRefreshToken?: string
): CognitoTokens {
  if (!result?.AccessToken || !result?.IdToken) {
    throw new Error("Cognito auth result missing tokens");
  }
  return {
    accessToken: result.AccessToken,
    idToken: result.IdToken,
    refreshToken: result.RefreshToken ?? existingRefreshToken ?? "",
    expiresAt: expiresAtFromSeconds(result.ExpiresIn ?? 3600),
  };
}

/** Decode an idToken payload without verifying signature */
function decodeIdToken(idToken: string): Record<string, unknown> {
  const parts = idToken.split(".");
  if (parts.length < 2) {
    throw new Error("Invalid idToken format");
  }
  // Add padding if needed
  const payload = parts[1];
  const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
  return JSON.parse(atob(padded)) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Test-only: reset the module-scoped token cache. Exposed so unit tests that
 * share a global fake keychain can return to a known-cold state between
 * cases. Not meant for production callers — `clearTokens`/`signOut` already
 * handle session teardown correctly.
 *
 * @internal
 */
export function __resetCacheForTests(): void {
  cachedTokens = null;
  cacheWarmed = false;
  pendingLoad = null;
}

/**
 * Refresh the current session using the stored refresh token.
 * Updates keychain with new tokens, preserving the existing refresh token
 * if Cognito does not return a new one.
 */
export async function refreshSession(): Promise<CognitoTokens> {
  const stored = await loadTokens();
  if (!stored?.refreshToken) {
    throw new Error("No refresh token available — please sign in again");
  }

  const client = makeClient();
  const response = await client.send(
    new InitiateAuthCommand({
      AuthFlow: "REFRESH_TOKEN_AUTH",
      ClientId: getClientId(),
      AuthParameters: {
        REFRESH_TOKEN: stored.refreshToken,
      },
    })
  );

  const tokens = tokensFromAuthResult(
    response.AuthenticationResult,
    stored.refreshToken
  );
  await storeTokens(tokens);
  return tokens;
}

/**
 * Get the currently authenticated user.
 * Automatically refreshes tokens if they are expired.
 * Returns null if no session exists.
 */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  let tokens = await loadTokens();
  if (!tokens) return null;

  if (isExpired(tokens)) {
    try {
      tokens = await refreshSession();
    } catch {
      await clearTokens();
      return null;
    }
  }

  const payload = decodeIdToken(tokens.idToken);
  return {
    sub: payload["sub"] as string,
    email: payload["email"] as string,
    name: (payload["name"] as string | undefined) || undefined,
    givenName: (payload["given_name"] as string | undefined) || undefined,
    familyName: (payload["family_name"] as string | undefined) || undefined,
    tokens,
  };
}

/**
 * Sign out the current user globally (revokes all sessions).
 * Clears tokens from the keychain.
 */
export async function signOut(): Promise<void> {
  const tokens = await loadTokens();
  if (tokens?.accessToken) {
    const client = makeClient();
    try {
      await client.send(
        new GlobalSignOutCommand({ AccessToken: tokens.accessToken })
      );
    } catch {
      // Best-effort — clear local tokens regardless
    }
  }
  await clearTokens();
}
