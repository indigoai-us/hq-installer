import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// CognitoAuth screen tests — Google OAuth via Cognito Hosted UI + PKCE
// ---------------------------------------------------------------------------
//
// The screen should render a single "Continue with Google" button. Clicking
// it kicks off the OAuth flow:
//   1. generate PKCE + state (mocked here)
//   2. invoke("oauth_listen_for_code", ...) — Rust loopback waits for redirect
//   3. openInBrowser(authorizeUrl) — shells out to the system browser
//   4. exchangeCodeForTokens(...) — POST /oauth2/token
//   5. storeTokens(...) → onNext()
// ---------------------------------------------------------------------------

// Env values must be set before the module under test reads them via getDefaultConfig
import.meta.env.VITE_COGNITO_USER_POOL_ID = "us-east-1_TESTPOOL";
import.meta.env.VITE_COGNITO_CLIENT_ID = "test-client-id";
import.meta.env.VITE_COGNITO_DOMAIN = "https://auth.example.com";

// ---------------------------------------------------------------------------
// Tauri API mocks — must be declared before any component imports
// ---------------------------------------------------------------------------
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-shell", () => ({
  open: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// cognito module mock — screen should call storeTokens after exchange
// ---------------------------------------------------------------------------
vi.mock("../../lib/cognito.js", () => ({
  storeTokens: vi.fn().mockResolvedValue(undefined),
  getCurrentUser: vi.fn(),
  signOut: vi.fn(),
  refreshSession: vi.fn(),
}));

// ---------------------------------------------------------------------------
// google-oauth module mock — deterministic PKCE/state + stubbed token exchange
// ---------------------------------------------------------------------------
vi.mock("../../lib/google-oauth.js", () => ({
  generatePkce: vi.fn().mockResolvedValue({
    verifier: "v-123",
    challenge: "c-123",
    method: "S256",
  }),
  generateState: vi.fn().mockReturnValue("st-abc"),
  buildAuthorizeUrl: vi
    .fn()
    .mockReturnValue("https://auth.example.com/oauth2/authorize?stub"),
  exchangeCodeForTokens: vi.fn(),
  getDefaultConfig: vi.fn().mockReturnValue({
    clientId: "test-client-id",
    cognitoDomain: "auth.example.com",
    redirectUri: "http://localhost:53682/callback",
  }),
  DEFAULT_LOOPBACK_PORT: 53682,
  DEFAULT_REDIRECT_URI: "http://localhost:53682/callback",
}));

import { CognitoAuth } from "../02-cognito-auth.js";
import { invoke } from "@tauri-apps/api/core";
import { open as openInBrowser } from "@tauri-apps/plugin-shell";
import * as cognito from "../../lib/cognito.js";
import * as oauth from "../../lib/google-oauth.js";

const mockInvoke = vi.mocked(invoke);
const mockOpen = vi.mocked(openInBrowser);
const mockStoreTokens = vi.mocked(cognito.storeTokens);
const mockExchange = vi.mocked(oauth.exchangeCodeForTokens);
const mockBuildUrl = vi.mocked(oauth.buildAuthorizeUrl);

const FAKE_TOKENS: cognito.CognitoTokens = {
  accessToken: "a",
  idToken: "i",
  refreshToken: "r",
  expiresAt: Date.now() + 3_600_000,
};

describe("CognitoAuth screen — Google OAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders a Continue with Google button", () => {
    render(<CognitoAuth onNext={vi.fn()} />);
    const btn = screen.getByRole("button", { name: /continue with google/i });
    expect(btn).not.toBeNull();
  });

  it("does not render email, password, or sign-up UI", () => {
    render(<CognitoAuth onNext={vi.fn()} />);
    expect(screen.queryByPlaceholderText(/email/i)).toBeNull();
    expect(
      document.querySelector("input[type='password']"),
    ).toBeNull();
    expect(screen.queryByRole("tab", { name: /sign up/i })).toBeNull();
  });

  it("kicks off the loopback listener before opening the browser", async () => {
    const user = userEvent.setup();
    // Set up listener mock that tracks ordering — resolves after a tick
    let listenerStarted = false;
    let browserOpenedBeforeListener = false;
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "oauth_listen_for_code") {
        listenerStarted = true;
        return { code: "auth-code-xyz" };
      }
      return undefined;
    });
    mockOpen.mockImplementation(async () => {
      if (!listenerStarted) browserOpenedBeforeListener = true;
    });
    mockExchange.mockResolvedValue(FAKE_TOKENS);

    render(<CognitoAuth onNext={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /continue with google/i }));

    await waitFor(() => expect(mockExchange).toHaveBeenCalled());
    expect(browserOpenedBeforeListener).toBe(false);
  });

  it("passes PKCE challenge into the authorize URL and the verifier into the token exchange", async () => {
    const user = userEvent.setup();
    mockInvoke.mockResolvedValue({ code: "AUTH_CODE" });
    mockExchange.mockResolvedValue(FAKE_TOKENS);

    render(<CognitoAuth onNext={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /continue with google/i }));

    await waitFor(() => expect(mockExchange).toHaveBeenCalled());

    expect(mockBuildUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "st-abc",
        codeChallenge: "c-123",
      }),
    );
    expect(mockExchange).toHaveBeenCalledWith(
      expect.objectContaining({ code: "AUTH_CODE", verifier: "v-123" }),
    );
  });

  it("passes the expected state into the Rust listener", async () => {
    const user = userEvent.setup();
    mockInvoke.mockResolvedValue({ code: "c" });
    mockExchange.mockResolvedValue(FAKE_TOKENS);

    render(<CognitoAuth onNext={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /continue with google/i }));

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("oauth_listen_for_code", {
        expectedState: "st-abc",
      }),
    );
  });

  it("stores tokens and calls onNext after a successful exchange", async () => {
    const user = userEvent.setup();
    const onNext = vi.fn();
    mockInvoke.mockResolvedValue({ code: "c" });
    mockExchange.mockResolvedValue(FAKE_TOKENS);

    render(<CognitoAuth onNext={onNext} />);
    await user.click(screen.getByRole("button", { name: /continue with google/i }));

    await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
    expect(mockStoreTokens).toHaveBeenCalledWith(FAKE_TOKENS);
  });

  it("renders an error and does not advance when the listener rejects", async () => {
    const user = userEvent.setup();
    const onNext = vi.fn();
    mockInvoke.mockRejectedValue(new Error("Timed out waiting for sign-in"));

    render(<CognitoAuth onNext={onNext} />);
    await user.click(screen.getByRole("button", { name: /continue with google/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/timed out/i);
    });
    expect(onNext).not.toHaveBeenCalled();
    expect(mockStoreTokens).not.toHaveBeenCalled();
  });

  it("renders an error when the token exchange fails", async () => {
    const user = userEvent.setup();
    const onNext = vi.fn();
    mockInvoke.mockResolvedValue({ code: "c" });
    mockExchange.mockRejectedValue(new Error("Token exchange failed (400)"));

    render(<CognitoAuth onNext={onNext} />);
    await user.click(screen.getByRole("button", { name: /continue with google/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/token exchange/i);
    });
    expect(onNext).not.toHaveBeenCalled();
  });

  describe("UI policy — no-purple-monochrome-ui", () => {
    it("does NOT use 'purple' class names in the DOM", () => {
      const { container } = render(<CognitoAuth onNext={vi.fn()} />);
      expect(container.innerHTML).not.toMatch(/\bpurple\b/);
    });

    it("does NOT use 'indigo' class names in the DOM", () => {
      const { container } = render(<CognitoAuth onNext={vi.fn()} />);
      expect(container.innerHTML).not.toMatch(/\bindigo\b/);
    });

    it("primary button uses rounded-full class", () => {
      const { container } = render(<CognitoAuth onNext={vi.fn()} />);
      const btn = container.querySelector("button");
      expect(btn?.className).toContain("rounded-full");
    });
  });

  describe("GitHub negative", () => {
    it("does NOT render a 'Sign in with GitHub' button", () => {
      render(<CognitoAuth onNext={vi.fn()} />);
      expect(screen.queryByRole("button", { name: /github/i })).toBeNull();
    });
  });
});
