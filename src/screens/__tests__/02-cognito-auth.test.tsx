import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// CognitoAuth screen tests — provider OAuth via Cognito Hosted UI + PKCE
// ---------------------------------------------------------------------------
//
// The screen should render Google and Microsoft buttons. Clicking either kicks
// off the OAuth flow:
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
  getUserFromTokens: vi.fn(),
  signOut: vi.fn(),
  refreshSession: vi.fn(),
}));

// ---------------------------------------------------------------------------
// wizard-state mock — track setGitIdentity calls
// ---------------------------------------------------------------------------
vi.mock("../../lib/wizard-state.js", () => ({
  setGitIdentity: vi.fn(),
  getWizardState: vi.fn().mockReturnValue({ gitName: null, gitEmail: null }),
  clearWizardState: vi.fn(),
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
  SIGN_IN_PROVIDERS: [
    { key: "Google", label: "Google" },
    { key: "Microsoft", label: "Microsoft" },
  ],
  DEFAULT_LOOPBACK_PORT: 53682,
  DEFAULT_REDIRECT_URI: "http://localhost:53682/callback",
}));

import { CognitoAuth } from "../02-cognito-auth.js";
import { invoke } from "@tauri-apps/api/core";
import { open as openInBrowser } from "@tauri-apps/plugin-shell";
import * as cognito from "../../lib/cognito.js";
import * as oauth from "../../lib/google-oauth.js";
import * as wizardState from "../../lib/wizard-state.js";

const mockInvoke = vi.mocked(invoke);
const mockOpen = vi.mocked(openInBrowser);
const mockStoreTokens = vi.mocked(cognito.storeTokens);
const mockGetUserFromTokens = vi.mocked(cognito.getUserFromTokens);
const mockSetGitIdentity = vi.mocked(wizardState.setGitIdentity);
const mockExchange = vi.mocked(oauth.exchangeCodeForTokens);
const mockBuildUrl = vi.mocked(oauth.buildAuthorizeUrl);

const FAKE_TOKENS: cognito.CognitoTokens = {
  accessToken: "a",
  idToken: "i",
  refreshToken: "r",
  expiresAt: Date.now() + 3_600_000,
};

describe("CognitoAuth screen — provider OAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOpen.mockResolvedValue(undefined);
    mockStoreTokens.mockResolvedValue({ keychain: "stored", sharedFile: "written" });
    mockGetUserFromTokens.mockReturnValue(null);
  });

  it("renders Google and Microsoft provider buttons", () => {
    render(<CognitoAuth onNext={vi.fn()} />);
    expect(screen.getByRole("button", { name: /continue with google/i })).not.toBeNull();
    expect(screen.getByRole("button", { name: /continue with microsoft/i })).not.toBeNull();
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
        provider: "Google",
      }),
    );
    expect(mockExchange).toHaveBeenCalledWith(
      expect.objectContaining({ code: "AUTH_CODE", verifier: "v-123" }),
    );
  });

  it("passes Microsoft through to the authorize URL builder", async () => {
    const user = userEvent.setup();
    mockInvoke.mockResolvedValue({ code: "AUTH_CODE" });
    mockExchange.mockResolvedValue(FAKE_TOKENS);

    render(<CognitoAuth onNext={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /continue with microsoft/i }));

    await waitFor(() => expect(mockExchange).toHaveBeenCalled());
    expect(mockBuildUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "Microsoft",
      }),
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

  it("advances with a non-blocking warning when Keychain persistence fails", async () => {
    const user = userEvent.setup();
    const onNext = vi.fn();
    mockInvoke.mockResolvedValue({ code: "c" });
    mockExchange.mockResolvedValue(FAKE_TOKENS);
    mockStoreTokens.mockResolvedValue({
      keychain: "failed",
      sharedFile: "written",
      keychainError: new Error("locked keychain"),
    });

    render(<CognitoAuth onNext={onNext} />);
    await user.click(screen.getByRole("button", { name: /continue with google/i }));

    await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("status")).toHaveTextContent(
      /signed in.*couldn't save to keychain/i,
    );
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

  it("keeps the active provider button enabled as a retry/reopen action", async () => {
    const user = userEvent.setup();
    mockInvoke.mockReturnValue(new Promise(() => {}));

    render(<CognitoAuth onNext={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /continue with google/i }));

    const google = screen.getByRole("button", {
      name: /reopen google sign-in/i,
    }) as HTMLButtonElement;
    const microsoft = screen.getByRole("button", {
      name: /continue with microsoft/i,
    }) as HTMLButtonElement;
    expect(google.disabled).toBe(false);
    expect(microsoft.disabled).toBe(true);

    await user.click(google);
    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(mockOpen).toHaveBeenCalledTimes(2);
  });

  it("ignores a pending OAuth callback after unmount", async () => {
    const user = userEvent.setup();
    const onNext = vi.fn();
    let resolveListener: ((value: { code: string }) => void) | null = null;
    mockInvoke.mockReturnValue(
      new Promise((resolve) => {
        resolveListener = resolve;
      }),
    );
    mockExchange.mockResolvedValue(FAKE_TOKENS);

    const rendered = render(<CognitoAuth onNext={onNext} />);
    await user.click(screen.getByRole("button", { name: /continue with google/i }));
    rendered.unmount();

    await act(async () => {
      resolveListener?.({ code: "late-code" });
      await Promise.resolve();
    });

    expect(mockExchange).not.toHaveBeenCalled();
    expect(mockStoreTokens).not.toHaveBeenCalled();
    expect(onNext).not.toHaveBeenCalled();
  });

  it("renders an error when the token exchange fails", async () => {
    const user = userEvent.setup();
    const onNext = vi.fn();
    mockInvoke.mockResolvedValue({ code: "c" });
    mockExchange.mockRejectedValue(new Error("Token exchange failed (400)"));

    render(<CognitoAuth onNext={onNext} />);
    await user.click(screen.getByRole("button", { name: /continue with google/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/couldn't finish sign-in/i);
    });
    expect(screen.getAllByRole("button", { name: /^retry$/i }).length).toBeGreaterThan(0);
    expect(onNext).not.toHaveBeenCalled();
  });

  it("cancels the listener and renders a copy-link fallback when browser open fails", async () => {
    const user = userEvent.setup();
    const onNext = vi.fn();
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "oauth_listen_for_code") {
        return new Promise(() => {});
      }
      if (cmd === "oauth_cancel_listen") {
        return undefined;
      }
      throw new Error(`Unknown command: ${cmd}`);
    });
    mockOpen.mockRejectedValue(new Error("shell.open failed"));

    render(<CognitoAuth onNext={onNext} />);
    await user.click(screen.getByRole("button", { name: /continue with google/i }));

    expect(await screen.findByRole("button", { name: /copy sign-in link/i })).not.toBeNull();
    expect(screen.getByText("https://auth.example.com/oauth2/authorize?stub")).not.toBeNull();
    expect(screen.getAllByRole("button", { name: /^retry$/i }).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /continue with google/i })).not.toBeNull();
    expect(mockInvoke).toHaveBeenCalledWith("oauth_cancel_listen");
    expect(mockExchange).not.toHaveBeenCalled();
    expect(onNext).not.toHaveBeenCalled();
  });

  it("maps an OAuth port conflict to a retryable message", async () => {
    const user = userEvent.setup();
    const onNext = vi.fn();
    mockInvoke.mockRejectedValue(
      JSON.stringify({
        code: "OAUTH_PORT_IN_USE",
        message:
          "Sign-in needs local port 53682, but another process is already using it.",
      }),
    );

    render(<CognitoAuth onNext={onNext} />);
    await user.click(screen.getByRole("button", { name: /continue with google/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/port 53682/i);
    });
    expect(screen.getAllByRole("button", { name: /^retry$/i }).length).toBeGreaterThan(0);
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

  describe("Cognito email pre-fill contract", () => {
    it("calls setGitIdentity with the Cognito email and name after a successful sign-in", async () => {
      const user = userEvent.setup();
      const onNext = vi.fn();
      mockGetUserFromTokens.mockReturnValue({
        sub: "sub-123",
        email: "cognito@example.com",
        name: "Cognito User",
        tokens: FAKE_TOKENS,
      });
      mockInvoke.mockResolvedValue({ code: "c" });
      mockExchange.mockResolvedValue(FAKE_TOKENS);

      render(<CognitoAuth onNext={onNext} />);
      await user.click(screen.getByRole("button", { name: /continue with google/i }));

      await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
      expect(mockSetGitIdentity).toHaveBeenCalledWith("Cognito User", "cognito@example.com");
    });

    it("still advances the wizard when getUserFromTokens throws (malformed idToken)", async () => {
      const user = userEvent.setup();
      const onNext = vi.fn();
      mockGetUserFromTokens.mockImplementation(() => {
        throw new Error("Invalid idToken format");
      });
      mockInvoke.mockResolvedValue({ code: "c" });
      mockExchange.mockResolvedValue(FAKE_TOKENS);

      render(<CognitoAuth onNext={onNext} />);
      await user.click(screen.getByRole("button", { name: /continue with google/i }));

      await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
      expect(screen.queryByRole("alert")).toBeNull();
    });
  });
});
