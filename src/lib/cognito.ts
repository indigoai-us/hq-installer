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

export async function storeTokens(tokens: CognitoTokens): Promise<void> {
  await invoke("keychain_set", {
    service: KC_SERVICE,
    account: KC_ACCOUNT,
    secret: JSON.stringify(tokens),
  });
}

async function loadTokens(): Promise<CognitoTokens | null> {
  try {
    const raw = await invoke<string>("keychain_get", {
      service: KC_SERVICE,
      account: KC_ACCOUNT,
    });
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CognitoTokens>;
    if (
      typeof parsed.accessToken !== "string" ||
      typeof parsed.idToken !== "string" ||
      typeof parsed.refreshToken !== "string" ||
      typeof parsed.expiresAt !== "number"
    ) {
      return null;
    }
    return {
      accessToken: parsed.accessToken,
      idToken: parsed.idToken,
      refreshToken: parsed.refreshToken,
      expiresAt: parsed.expiresAt,
    };
  } catch {
    return null;
  }
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
