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

// Track listen callbacks so tests can fire them
type ListenCallback = (event: { payload: unknown }) => void;
const listenCallbacks = new Map<string, ListenCallback>();

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: ListenCallback) => {
    listenCallbacks.set(event, handler);
    return () => { listenCallbacks.delete(event); };
  }),
}));

vi.mock("@tauri-apps/plugin-shell", () => ({
  open: vi.fn(async () => undefined),
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
  class SignUpCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class ConfirmSignUpCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class GlobalSignOutCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  return {
    CognitoIdentityProviderClient: MockClient,
    InitiateAuthCommand,
    SignUpCommand,
    ConfirmSignUpCommand,
    GlobalSignOutCommand,
  };
});

// Mock fetch for token exchange
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ---------------------------------------------------------------------------
// Import module under test AFTER all mocks are registered
// ---------------------------------------------------------------------------
import {
  signIn,
  signOut,
  signUp,
  confirmSignUp,
  refreshSession,
  getCurrentUser,
  signInWithGitHub,
  type CognitoTokens,
} from "../cognito.js";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-shell";

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
  listenCallbacks.clear();
  mockFetch.mockReset();
  vi.clearAllMocks();

  // Default AWS send: return empty object (overridden per-test as needed)
  mockSendImpl = async () => ({});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// signIn
// ---------------------------------------------------------------------------

describe("signIn", () => {
  it("stores tokens in keychain and returns CognitoTokens", async () => {
    const idToken = makeIdToken("sub-1", "alice@example.com");
    mockSendImpl = async () => ({
      AuthenticationResult: {
        AccessToken: "acc",
        IdToken: idToken,
        RefreshToken: "ref",
        ExpiresIn: 3600,
      },
    });

    const tokens = await signIn("alice@example.com", "password123");

    expect(tokens.accessToken).toBe("acc");
    expect(tokens.idToken).toBe(idToken);
    expect(tokens.refreshToken).toBe("ref");
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());

    // Verify keychain was written
    expect(fakeKeychain.get("access_token")).toBe("acc");
    expect(fakeKeychain.get("id_token")).toBe(idToken);
    expect(fakeKeychain.get("refresh_token")).toBe("ref");
    expect(fakeKeychain.get("expires_at")).toBeDefined();

    // Verify invoke was called for each keychain write
    expect(invoke).toHaveBeenCalledWith("keychain_set", expect.objectContaining({ account: "access_token" }));
    expect(invoke).toHaveBeenCalledWith("keychain_set", expect.objectContaining({ account: "id_token" }));
    expect(invoke).toHaveBeenCalledWith("keychain_set", expect.objectContaining({ account: "refresh_token" }));
    expect(invoke).toHaveBeenCalledWith("keychain_set", expect.objectContaining({ account: "expires_at" }));
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

// ---------------------------------------------------------------------------
// signUp
// ---------------------------------------------------------------------------

describe("signUp", () => {
  it("calls SignUpCommand with email as Username", async () => {
    const calls: unknown[] = [];
    mockSendImpl = async (cmd) => { calls.push(cmd); return {}; };

    await signUp("new@example.com", "Secret123!");

    expect(calls).toHaveLength(1);
    const cmd = calls[0] as { input: Record<string, unknown> };
    expect(cmd.input.Username).toBe("new@example.com");
    expect(cmd.input.Password).toBe("Secret123!");
    expect(cmd.input.ClientId).toBe("test-client-id");
    expect((cmd.input.UserAttributes as Array<{ Name: string; Value: string }>)).toContainEqual({
      Name: "email",
      Value: "new@example.com",
    });
  });
});

// ---------------------------------------------------------------------------
// confirmSignUp
// ---------------------------------------------------------------------------

describe("confirmSignUp", () => {
  it("calls ConfirmSignUpCommand with correct args", async () => {
    const calls: unknown[] = [];
    mockSendImpl = async (cmd) => { calls.push(cmd); return {}; };

    await confirmSignUp("user@example.com", "123456");

    expect(calls).toHaveLength(1);
    const cmd = calls[0] as { input: Record<string, unknown> };
    expect(cmd.input.Username).toBe("user@example.com");
    expect(cmd.input.ConfirmationCode).toBe("123456");
    expect(cmd.input.ClientId).toBe("test-client-id");
  });
});

// ---------------------------------------------------------------------------
// signInWithGitHub
// ---------------------------------------------------------------------------

describe("signInWithGitHub", () => {
  it("opens hosted UI, exchanges code, stores tokens", async () => {
    // Set up mock fetch response
    const githubIdToken = makeIdToken("github-sub", "github@example.com");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: "gh-access",
        id_token: githubIdToken,
        refresh_token: "gh-refresh",
        expires_in: 3600,
      }),
    });

    // Start the signInWithGitHub promise — it will block on the listen callback
    const signInPromise = signInWithGitHub();

    // Allow the open + listen calls to register
    await Promise.resolve();
    await Promise.resolve();

    // Fire the deep-link event
    const callbackUrl =
      "hq-installer://callback?code=auth-code-abc&state=xyz";
    const handler = listenCallbacks.get("deep-link://received");
    expect(handler).toBeDefined();
    handler!({ payload: { url: callbackUrl } });

    const tokens = await signInPromise;

    // Verify browser was opened with correct URL
    expect(open).toHaveBeenCalledWith(
      expect.stringContaining("identity_provider=GitHub")
    );
    expect(open).toHaveBeenCalledWith(
      expect.stringContaining("client_id=test-client-id")
    );

    // Verify token exchange fetch
    expect(mockFetch).toHaveBeenCalledWith(
      "https://auth.example.com/oauth2/token",
      expect.objectContaining({ method: "POST" })
    );
    const fetchBody = (mockFetch.mock.calls[0][1] as RequestInit).body as string;
    expect(fetchBody).toContain("code=auth-code-abc");
    expect(fetchBody).toContain("grant_type=authorization_code");

    // Verify tokens returned and stored
    expect(tokens.accessToken).toBe("gh-access");
    expect(tokens.idToken).toBe(githubIdToken);
    expect(fakeKeychain.get("access_token")).toBe("gh-access");
    expect(fakeKeychain.get("refresh_token")).toBe("gh-refresh");
  });
});
