import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Set import.meta.env before any module under test reads it (lazy getters)
import.meta.env.VITE_COGNITO_USER_POOL_ID = "us-east-1_TESTPOOL";
import.meta.env.VITE_COGNITO_CLIENT_ID = "test-client-id";
import.meta.env.VITE_COGNITO_DOMAIN = "https://auth.example.com";

// ---------------------------------------------------------------------------
// Fake keychain (in-memory Map, keyed by account name)
// ---------------------------------------------------------------------------
const fakeKeychain = new Map<string, string>();

// ---------------------------------------------------------------------------
// Module mocks — must be hoisted before any imports from the module under test
// ---------------------------------------------------------------------------

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(
    async (command: string, args?: Record<string, string>) => {
      switch (command) {
        case "keychain_set":
          fakeKeychain.set(args!.account, args!.secret);
          return null;
        case "keychain_get": {
          const val = fakeKeychain.get(args!.account);
          if (val === undefined) throw new Error("not found");
          return val;
        }
        case "keychain_delete":
          fakeKeychain.delete(args!.account);
          return null;
        default:
          throw new Error(`Unknown command: ${command}`);
      }
    }
  ),
}));

// Mock the AWS SDK
let mockSendImpl: (command: unknown) => Promise<unknown> = async () => ({});

vi.mock("@aws-sdk/client-cognito-identity-provider", () => {
  class MockClient {
    async send(command: unknown) {
      return mockSendImpl(command);
    }
  }
  class InitiateAuthCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class GlobalSignOutCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  return {
    CognitoIdentityProviderClient: MockClient,
    InitiateAuthCommand,
    GlobalSignOutCommand,
  };
});

// ---------------------------------------------------------------------------
// Import module under test AFTER all mocks are registered
// ---------------------------------------------------------------------------
import {
  signOut,
  storeTokens,
  refreshSession,
  getCurrentUser,
  type CognitoTokens,
} from "../cognito.js";
import { invoke } from "@tauri-apps/api/core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal valid idToken JWT payload (base64url encoded middle segment) */
function makeIdToken(sub: string, email: string): string {
  const payload = { sub, email, exp: Math.floor(Date.now() / 1000) + 3600 };
  const encoded = btoa(JSON.stringify(payload))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `header.${encoded}.signature`;
}

function makeTokens(overrides: Partial<CognitoTokens> = {}): CognitoTokens {
  return {
    accessToken: "access-tok",
    idToken: makeIdToken("sub-123", "user@example.com"),
    refreshToken: "refresh-tok",
    expiresAt: Date.now() + 3600_000,
    ...overrides,
  };
}

/** Pre-populate the fake keychain with a set of tokens */
async function seedKeychain(tokens: CognitoTokens) {
  fakeKeychain.set("access_token", tokens.accessToken);
  fakeKeychain.set("id_token", tokens.idToken);
  fakeKeychain.set("refresh_token", tokens.refreshToken);
  fakeKeychain.set("expires_at", String(tokens.expiresAt));
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  fakeKeychain.clear();
  vi.clearAllMocks();

  // Default AWS send: return empty object (overridden per-test as needed)
  mockSendImpl = async () => ({});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// storeTokens — used by Google OAuth flow to persist tokens after exchange
// ---------------------------------------------------------------------------

describe("storeTokens", () => {
  it("writes all four token fields to the keychain", async () => {
    const tokens = makeTokens({
      accessToken: "acc",
      idToken: makeIdToken("sub-1", "alice@example.com"),
      refreshToken: "ref",
    });

    await storeTokens(tokens);

    expect(fakeKeychain.get("access_token")).toBe("acc");
    expect(fakeKeychain.get("id_token")).toBe(tokens.idToken);
    expect(fakeKeychain.get("refresh_token")).toBe("ref");
    expect(fakeKeychain.get("expires_at")).toBe(String(tokens.expiresAt));
    expect(invoke).toHaveBeenCalledWith(
      "keychain_set",
      expect.objectContaining({ account: "access_token" }),
    );
  });
});

// ---------------------------------------------------------------------------
// signOut
// ---------------------------------------------------------------------------

describe("signOut", () => {
  it("calls GlobalSignOut and clears keychain", async () => {
    const tokens = makeTokens();
    await seedKeychain(tokens);

    const globalSignOutCalls: unknown[] = [];
    mockSendImpl = async (cmd) => {
      globalSignOutCalls.push(cmd);
      return {};
    };

    await signOut();

    expect(globalSignOutCalls).toHaveLength(1);
    expect(fakeKeychain.size).toBe(0);
    expect(invoke).toHaveBeenCalledWith("keychain_delete", expect.objectContaining({ account: "access_token" }));
    expect(invoke).toHaveBeenCalledWith("keychain_delete", expect.objectContaining({ account: "refresh_token" }));
  });

  it("clears keychain even if GlobalSignOut throws", async () => {
    const tokens = makeTokens();
    await seedKeychain(tokens);

    mockSendImpl = async () => { throw new Error("network error"); };

    await signOut();

    expect(fakeKeychain.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getCurrentUser
// ---------------------------------------------------------------------------

describe("getCurrentUser", () => {
  it("returns null when no tokens in keychain", async () => {
    const user = await getCurrentUser();
    expect(user).toBeNull();
  });

  it("decodes email and sub from idToken", async () => {
    const tokens = makeTokens();
    await seedKeychain(tokens);

    const user = await getCurrentUser();

    expect(user).not.toBeNull();
    expect(user!.sub).toBe("sub-123");
    expect(user!.email).toBe("user@example.com");
    expect(user!.tokens.accessToken).toBe(tokens.accessToken);
  });

  it("auto-refreshes when tokens are expired", async () => {
    const expiredTokens = makeTokens({ expiresAt: Date.now() - 1000 });
    await seedKeychain(expiredTokens);

    const freshIdToken = makeIdToken("sub-456", "fresh@example.com");
    mockSendImpl = async () => ({
      AuthenticationResult: {
        AccessToken: "new-access",
        IdToken: freshIdToken,
        RefreshToken: "new-refresh",
        ExpiresIn: 3600,
      },
    });

    const user = await getCurrentUser();

    expect(user).not.toBeNull();
    expect(user!.email).toBe("fresh@example.com");
    expect(user!.tokens.accessToken).toBe("new-access");
    // Keychain should be updated with fresh tokens
    expect(fakeKeychain.get("access_token")).toBe("new-access");
  });

  it("returns null and clears keychain if refresh fails", async () => {
    const expiredTokens = makeTokens({ expiresAt: Date.now() - 1000 });
    await seedKeychain(expiredTokens);

    mockSendImpl = async () => { throw new Error("RefreshTokenExpired"); };

    const user = await getCurrentUser();

    expect(user).toBeNull();
    expect(fakeKeychain.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// refreshSession
// ---------------------------------------------------------------------------

describe("refreshSession", () => {
  it("exchanges refresh token and updates keychain", async () => {
    const tokens = makeTokens();
    await seedKeychain(tokens);

    const newIdToken = makeIdToken("sub-999", "new@example.com");
    mockSendImpl = async () => ({
      AuthenticationResult: {
        AccessToken: "refreshed-access",
        IdToken: newIdToken,
        // Cognito may not return a new refresh token
        RefreshToken: undefined,
        ExpiresIn: 3600,
      },
    });

    const refreshed = await refreshSession();

    expect(refreshed.accessToken).toBe("refreshed-access");
    // Should preserve original refresh token when Cognito doesn't return one
    expect(refreshed.refreshToken).toBe(tokens.refreshToken);
    expect(fakeKeychain.get("access_token")).toBe("refreshed-access");
    expect(fakeKeychain.get("refresh_token")).toBe(tokens.refreshToken);
  });

  it("throws when no refresh token stored", async () => {
    await expect(refreshSession()).rejects.toThrow("No refresh token");
  });
});

