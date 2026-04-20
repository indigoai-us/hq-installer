import { describe, it, expect, beforeAll } from "vitest";
import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  generatePkce,
  generateState,
  getDefaultConfig,
  DEFAULT_LOOPBACK_PORT,
  DEFAULT_REDIRECT_URI,
} from "../google-oauth.js";

// ---------------------------------------------------------------------------
// crypto.subtle is needed for generatePkce. jsdom polyfills it on recent
// Node, but we make sure it's available explicitly.
// ---------------------------------------------------------------------------
beforeAll(async () => {
  if (!globalThis.crypto?.subtle) {
    const { webcrypto } = await import("node:crypto");
    Object.defineProperty(globalThis, "crypto", { value: webcrypto });
  }
  import.meta.env.VITE_COGNITO_CLIENT_ID = "test-client-id";
  import.meta.env.VITE_COGNITO_DOMAIN = "https://auth.example.com";
});

const CONFIG = {
  clientId: "test-client-id",
  cognitoDomain: "auth.example.com",
  redirectUri: DEFAULT_REDIRECT_URI,
};

describe("DEFAULT_LOOPBACK_PORT", () => {
  it("matches the port registered in Cognito app client callback URLs", () => {
    // 53682 is the rclone-standard OAuth loopback port and is pre-registered.
    // Changing it here requires updating Cognito app client callback URLs.
    expect(DEFAULT_LOOPBACK_PORT).toBe(53682);
    expect(DEFAULT_REDIRECT_URI).toBe("http://localhost:53682/callback");
  });
});

describe("getDefaultConfig", () => {
  it("strips https:// scheme from VITE_COGNITO_DOMAIN", () => {
    const cfg = getDefaultConfig();
    expect(cfg.cognitoDomain).toBe("auth.example.com");
  });

  it("uses the loopback redirect URI", () => {
    const cfg = getDefaultConfig();
    expect(cfg.redirectUri).toBe(DEFAULT_REDIRECT_URI);
  });
});

describe("generatePkce", () => {
  it("returns a verifier of valid length and a base64url challenge", async () => {
    const { verifier, challenge, method } = await generatePkce();
    // 32 random bytes → 43 base64url chars (no padding)
    expect(verifier).toHaveLength(43);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    // SHA-256 digest → 32 bytes → 43 base64url chars
    expect(challenge).toHaveLength(43);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(method).toBe("S256");
  });

  it("produces different verifiers on each call", async () => {
    const a = await generatePkce();
    const b = await generatePkce();
    expect(a.verifier).not.toBe(b.verifier);
  });

  it("challenge is SHA-256(verifier), base64url-encoded", async () => {
    const { verifier, challenge } = await generatePkce();
    const hash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(verifier),
    );
    const hashArr = new Uint8Array(hash);
    let bin = "";
    for (let i = 0; i < hashArr.length; i++) bin += String.fromCharCode(hashArr[i]);
    const expected = btoa(bin)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(challenge).toBe(expected);
  });
});

describe("generateState", () => {
  it("returns a base64url string", () => {
    const s = generateState();
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(s.length).toBeGreaterThanOrEqual(20);
  });

  it("is unique per call", () => {
    expect(generateState()).not.toBe(generateState());
  });
});

describe("buildAuthorizeUrl", () => {
  it("includes all required OAuth params including PKCE and Google IdP", () => {
    const url = buildAuthorizeUrl({
      config: CONFIG,
      state: "STATE",
      codeChallenge: "CHALLENGE",
    });
    const u = new URL(url);

    expect(u.origin).toBe("https://auth.example.com");
    expect(u.pathname).toBe("/oauth2/authorize");
    expect(u.searchParams.get("client_id")).toBe("test-client-id");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("scope")).toBe("openid email profile");
    expect(u.searchParams.get("redirect_uri")).toBe(DEFAULT_REDIRECT_URI);
    expect(u.searchParams.get("identity_provider")).toBe("Google");
    expect(u.searchParams.get("state")).toBe("STATE");
    expect(u.searchParams.get("code_challenge")).toBe("CHALLENGE");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("prompt")).toBe("select_account");
  });
});

describe("exchangeCodeForTokens", () => {
  it("POSTs code + verifier and returns tokens with expiresAt timestamp", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const fakeFetch: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), body: String(init?.body ?? "") });
      return new Response(
        JSON.stringify({
          access_token: "AT",
          id_token: "IT",
          refresh_token: "RT",
          expires_in: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const before = Date.now();
    const tokens = await exchangeCodeForTokens({
      config: CONFIG,
      code: "AUTH_CODE",
      verifier: "VERIFIER",
      fetchFn: fakeFetch,
    });
    const after = Date.now();

    expect(tokens.accessToken).toBe("AT");
    expect(tokens.idToken).toBe("IT");
    expect(tokens.refreshToken).toBe("RT");
    expect(tokens.expiresAt).toBeGreaterThanOrEqual(before + 3600_000);
    expect(tokens.expiresAt).toBeLessThanOrEqual(after + 3600_000);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://auth.example.com/oauth2/token");
    expect(calls[0].body).toContain("grant_type=authorization_code");
    expect(calls[0].body).toContain("client_id=test-client-id");
    expect(calls[0].body).toContain("code=AUTH_CODE");
    expect(calls[0].body).toContain("code_verifier=VERIFIER");
  });

  it("throws on non-2xx responses with the response body in the message", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response("invalid_grant", { status: 400 });
    await expect(
      exchangeCodeForTokens({
        config: CONFIG,
        code: "bad",
        verifier: "v",
        fetchFn: fakeFetch,
      }),
    ).rejects.toThrow(/invalid_grant/);
  });

  it("throws when response is missing access_token or id_token", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ refresh_token: "only" }), { status: 200 });
    await expect(
      exchangeCodeForTokens({
        config: CONFIG,
        code: "c",
        verifier: "v",
        fetchFn: fakeFetch,
      }),
    ).rejects.toThrow(/access_token or id_token/);
  });
});
