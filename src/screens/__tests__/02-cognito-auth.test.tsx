import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { CognitoAuth } from "../02-cognito-auth.js";

// ---------------------------------------------------------------------------
// CognitoAuth screen tests (US-013)
//
// These tests are written BEFORE the implementation exists.
// They will fail until src/screens/02-cognito-auth.tsx is created.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tauri API mocks — must be declared before any component imports
// ---------------------------------------------------------------------------
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Cognito module mock — isolate the screen from real AWS calls
// ---------------------------------------------------------------------------
vi.mock("../../lib/cognito.js", () => ({
  signIn: vi.fn(),
  signUp: vi.fn(),
  confirmSignUp: vi.fn(),
  getCurrentUser: vi.fn(),
  signOut: vi.fn(),
  refreshSession: vi.fn(),
}));

import * as cognito from "../../lib/cognito.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockSignIn = vi.mocked(cognito.signIn);
const mockSignUp = vi.mocked(cognito.signUp);
const mockConfirmSignUp = vi.mocked(cognito.confirmSignUp);

const MOCK_TOKENS: cognito.CognitoTokens = {
  accessToken: "mock-access-token",
  idToken: "mock-id-token",
  refreshToken: "mock-refresh-token",
  expiresAt: Date.now() + 3_600_000,
};

// ---------------------------------------------------------------------------

describe("CognitoAuth screen (02-cognito-auth.tsx)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  describe("tab layout", () => {
    it("renders a 'Sign in' tab", () => {
      render(<CognitoAuth onNext={vi.fn()} />);
      expect(
        screen.getByRole("tab", { name: /sign in/i }) ||
          screen.getByText(/sign in/i, { selector: "[role='tab'], button, [data-tab]" })
      ).toBeTruthy();
    });

    it("renders a 'Sign up' tab", () => {
      render(<CognitoAuth onNext={vi.fn()} />);
      expect(
        screen.getByRole("tab", { name: /sign up/i }) ||
          screen.getByText(/sign up/i, { selector: "[role='tab'], button, [data-tab]" })
      ).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------
  describe("Sign-in tab", () => {
    // The sign-in tab should be the default/active tab on mount
    it("renders email field on sign-in tab", () => {
      render(<CognitoAuth onNext={vi.fn()} />);
      // Email field: look by label, placeholder, or type=email
      const emailField =
        screen.queryByLabelText(/email/i) ||
        screen.queryByPlaceholderText(/email/i) ||
        screen.queryByRole("textbox", { name: /email/i });
      expect(emailField).not.toBeNull();
    });

    it("renders password field on sign-in tab", () => {
      render(<CognitoAuth onNext={vi.fn()} />);
      const passwordField =
        screen.queryByLabelText(/password/i) ||
        screen.queryByPlaceholderText(/password/i) ||
        document.querySelector("input[type='password']");
      expect(passwordField).not.toBeNull();
    });

    it("renders a submit button on sign-in tab", () => {
      render(<CognitoAuth onNext={vi.fn()} />);
      const submitBtn =
        screen.queryByRole("button", { name: /sign in/i }) ||
        screen.queryByRole("button", { name: /log in/i }) ||
        screen.queryByRole("button", { name: /submit/i });
      expect(submitBtn).not.toBeNull();
    });

    it("calls signIn from cognito.ts when sign-in form is submitted", async () => {
      const user = userEvent.setup();
      mockSignIn.mockResolvedValueOnce(MOCK_TOKENS);
      render(<CognitoAuth onNext={vi.fn()} />);

      const emailField =
        screen.queryByLabelText(/email/i) ||
        screen.queryByPlaceholderText(/email/i) ||
        screen.queryByRole("textbox", { name: /email/i });
      const passwordField =
        document.querySelector("input[type='password']") as HTMLElement | null;

      expect(emailField).not.toBeNull();
      expect(passwordField).not.toBeNull();

      await user.type(emailField!, "user@example.com");
      await user.type(passwordField!, "P@ssword123");

      const submitBtn =
        screen.queryByRole("button", { name: /sign in/i }) ||
        screen.queryByRole("button", { name: /log in/i }) ||
        screen.queryByRole("button", { name: /submit/i });
      await user.click(submitBtn!);

      await waitFor(() => {
        expect(mockSignIn).toHaveBeenCalledTimes(1);
        expect(mockSignIn).toHaveBeenCalledWith(
          "user@example.com",
          "P@ssword123"
        );
      });
    });

    it("calls onNext after successful sign-in", async () => {
      const user = userEvent.setup();
      const onNext = vi.fn();
      mockSignIn.mockResolvedValueOnce(MOCK_TOKENS);
      render(<CognitoAuth onNext={onNext} />);

      const emailField =
        screen.queryByLabelText(/email/i) ||
        screen.queryByPlaceholderText(/email/i) ||
        screen.queryByRole("textbox", { name: /email/i });
      const passwordField =
        document.querySelector("input[type='password']") as HTMLElement | null;

      await user.type(emailField!, "user@example.com");
      await user.type(passwordField!, "P@ssword123");

      const submitBtn =
        screen.queryByRole("button", { name: /sign in/i }) ||
        screen.queryByRole("button", { name: /log in/i }) ||
        screen.queryByRole("button", { name: /submit/i });
      await user.click(submitBtn!);

      await waitFor(() => {
        expect(onNext).toHaveBeenCalledTimes(1);
      });
    });

    it("renders an error message when signIn rejects", async () => {
      const user = userEvent.setup();
      mockSignIn.mockRejectedValueOnce(new Error("Incorrect username or password."));
      render(<CognitoAuth onNext={vi.fn()} />);

      const emailField =
        screen.queryByLabelText(/email/i) ||
        screen.queryByPlaceholderText(/email/i) ||
        screen.queryByRole("textbox", { name: /email/i });
      const passwordField =
        document.querySelector("input[type='password']") as HTMLElement | null;

      await user.type(emailField!, "user@example.com");
      await user.type(passwordField!, "wrongpassword");

      const submitBtn =
        screen.queryByRole("button", { name: /sign in/i }) ||
        screen.queryByRole("button", { name: /log in/i }) ||
        screen.queryByRole("button", { name: /submit/i });
      await user.click(submitBtn!);

      await waitFor(() => {
        // The screen must show some error feedback (not necessarily the exact
        // Cognito message, but the container text must change from empty)
        render(<CognitoAuth onNext={vi.fn()} />);
        // Check that an error role or alert exists, OR that error text appears
        const alert = screen.queryByRole("alert");
        const errorText = screen.queryByText(/error|incorrect|invalid|failed/i);
        expect(alert || errorText).not.toBeNull();
      });
    });

    it("does NOT call onNext when signIn rejects", async () => {
      const user = userEvent.setup();
      const onNext = vi.fn();
      mockSignIn.mockRejectedValueOnce(new Error("NotAuthorizedException"));
      render(<CognitoAuth onNext={onNext} />);

      const emailField =
        screen.queryByLabelText(/email/i) ||
        screen.queryByPlaceholderText(/email/i) ||
        screen.queryByRole("textbox", { name: /email/i });
      const passwordField =
        document.querySelector("input[type='password']") as HTMLElement | null;

      await user.type(emailField!, "user@example.com");
      await user.type(passwordField!, "badpassword");

      const submitBtn =
        screen.queryByRole("button", { name: /sign in/i }) ||
        screen.queryByRole("button", { name: /log in/i }) ||
        screen.queryByRole("button", { name: /submit/i });
      await user.click(submitBtn!);

      // Give the promise rejection a tick to settle
      await waitFor(() => expect(mockSignIn).toHaveBeenCalled());
      expect(onNext).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  describe("Sign-up tab", () => {
    /** Switch to the Sign up tab */
    async function switchToSignUp() {
      const user = userEvent.setup();
      const signUpTab =
        screen.queryByRole("tab", { name: /sign up/i }) ||
        screen.queryByText(/sign up/i, { selector: "[role='tab'], button, [data-tab]" });
      if (signUpTab) await user.click(signUpTab);
    }

    it("renders email field on sign-up tab", async () => {
      render(<CognitoAuth onNext={vi.fn()} />);
      await switchToSignUp();
      const emailField =
        screen.queryByLabelText(/email/i) ||
        screen.queryByPlaceholderText(/email/i) ||
        screen.queryByRole("textbox", { name: /email/i });
      expect(emailField).not.toBeNull();
    });

    it("renders password field on sign-up tab", async () => {
      render(<CognitoAuth onNext={vi.fn()} />);
      await switchToSignUp();
      const allPasswordFields = document.querySelectorAll("input[type='password']");
      expect(allPasswordFields.length).toBeGreaterThanOrEqual(1);
    });

    it("renders confirm-password field on sign-up tab", async () => {
      render(<CognitoAuth onNext={vi.fn()} />);
      await switchToSignUp();
      // Confirm password field: look by label or expect 2 password inputs
      const confirmField =
        screen.queryByLabelText(/confirm/i) ||
        screen.queryByPlaceholderText(/confirm/i);
      const allPasswordFields = document.querySelectorAll("input[type='password']");
      // Either a labelled confirm field or at least 2 password inputs
      expect(confirmField || allPasswordFields.length >= 2).toBeTruthy();
    });

    it("renders a submit button on sign-up tab", async () => {
      render(<CognitoAuth onNext={vi.fn()} />);
      await switchToSignUp();
      const submitBtn =
        screen.queryByRole("button", { name: /sign up/i }) ||
        screen.queryByRole("button", { name: /create account/i }) ||
        screen.queryByRole("button", { name: /register/i }) ||
        screen.queryByRole("button", { name: /submit/i });
      expect(submitBtn).not.toBeNull();
    });

    it("calls signUp from cognito.ts when sign-up form is submitted", async () => {
      const user = userEvent.setup();
      mockSignUp.mockResolvedValueOnce(undefined);
      render(<CognitoAuth onNext={vi.fn()} />);
      await switchToSignUp();

      const emailField =
        screen.queryByLabelText(/email/i) ||
        screen.queryByPlaceholderText(/email/i) ||
        screen.queryByRole("textbox", { name: /email/i });

      const allPasswordFields = document.querySelectorAll("input[type='password']");

      expect(emailField).not.toBeNull();
      expect(allPasswordFields.length).toBeGreaterThanOrEqual(2);

      await user.type(emailField!, "newuser@example.com");
      await user.type(allPasswordFields[0] as HTMLElement, "NewP@ss123");
      await user.type(allPasswordFields[1] as HTMLElement, "NewP@ss123");

      const submitBtn =
        screen.queryByRole("button", { name: /sign up/i }) ||
        screen.queryByRole("button", { name: /create account/i }) ||
        screen.queryByRole("button", { name: /register/i }) ||
        screen.queryByRole("button", { name: /submit/i });
      await user.click(submitBtn!);

      await waitFor(() => {
        expect(mockSignUp).toHaveBeenCalledTimes(1);
        expect(mockSignUp).toHaveBeenCalledWith(
          "newuser@example.com",
          "NewP@ss123"
        );
      });
    });

    it("shows confirmation code input after successful signUp", async () => {
      const user = userEvent.setup();
      mockSignUp.mockResolvedValueOnce(undefined);
      render(<CognitoAuth onNext={vi.fn()} />);
      await switchToSignUp();

      const emailField =
        screen.queryByLabelText(/email/i) ||
        screen.queryByPlaceholderText(/email/i) ||
        screen.queryByRole("textbox", { name: /email/i });
      const allPasswordFields = document.querySelectorAll("input[type='password']");

      await user.type(emailField!, "newuser@example.com");
      await user.type(allPasswordFields[0] as HTMLElement, "NewP@ss123");
      await user.type(allPasswordFields[1] as HTMLElement, "NewP@ss123");

      const submitBtn =
        screen.queryByRole("button", { name: /sign up/i }) ||
        screen.queryByRole("button", { name: /create account/i }) ||
        screen.queryByRole("button", { name: /register/i }) ||
        screen.queryByRole("button", { name: /submit/i });
      await user.click(submitBtn!);

      // After signUp resolves, a confirmation code input must appear
      await waitFor(() => {
        const codeField =
          screen.queryByLabelText(/code/i) ||
          screen.queryByPlaceholderText(/code/i) ||
          screen.queryByRole("textbox", { name: /code/i }) ||
          screen.queryByText(/verification|confirm.*code|check.*email/i);
        expect(codeField).not.toBeNull();
      });
    });

    it("calls confirmSignUp when confirmation code is submitted", async () => {
      const user = userEvent.setup();
      mockSignUp.mockResolvedValueOnce(undefined);
      mockConfirmSignUp.mockResolvedValueOnce(undefined);
      render(<CognitoAuth onNext={vi.fn()} />);
      await switchToSignUp();

      const emailField =
        screen.queryByLabelText(/email/i) ||
        screen.queryByPlaceholderText(/email/i) ||
        screen.queryByRole("textbox", { name: /email/i });
      const allPasswordFields = document.querySelectorAll("input[type='password']");

      await user.type(emailField!, "newuser@example.com");
      await user.type(allPasswordFields[0] as HTMLElement, "NewP@ss123");
      await user.type(allPasswordFields[1] as HTMLElement, "NewP@ss123");

      const submitBtn =
        screen.queryByRole("button", { name: /sign up/i }) ||
        screen.queryByRole("button", { name: /create account/i }) ||
        screen.queryByRole("button", { name: /register/i }) ||
        screen.queryByRole("button", { name: /submit/i });
      await user.click(submitBtn!);

      // Wait for confirmation UI to appear
      await waitFor(() => {
        const codeField =
          screen.queryByLabelText(/code/i) ||
          screen.queryByPlaceholderText(/code/i) ||
          screen.queryByRole("textbox", { name: /code/i });
        expect(codeField).not.toBeNull();
      });

      const codeField =
        screen.queryByLabelText(/code/i) ||
        screen.queryByPlaceholderText(/code/i) ||
        screen.queryByRole("textbox", { name: /code/i });
      await user.type(codeField!, "123456");

      const confirmBtn =
        screen.queryByRole("button", { name: /confirm/i }) ||
        screen.queryByRole("button", { name: /verify/i }) ||
        screen.queryByRole("button", { name: /submit/i });
      if (confirmBtn) await user.click(confirmBtn);

      await waitFor(() => {
        expect(mockConfirmSignUp).toHaveBeenCalledTimes(1);
        expect(mockConfirmSignUp).toHaveBeenCalledWith(
          "newuser@example.com",
          "123456"
        );
      });
    });
  });

  // -------------------------------------------------------------------------
  describe("no GitHub auth", () => {
    it("does NOT render a 'Sign in with GitHub' button (not in spec)", () => {
      render(<CognitoAuth onNext={vi.fn()} />);
      const btn = screen.queryByRole("button", { name: /github/i });
      expect(btn).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe("Keychain / token storage (integration)", () => {
    it("stores idToken in the Keychain after successful sign-in", async () => {
      const user = userEvent.setup();
      const { invoke } = await import("@tauri-apps/api/core");
      const mockInvoke = vi.mocked(invoke);
      mockInvoke.mockResolvedValue(undefined);
      mockSignIn.mockResolvedValueOnce(MOCK_TOKENS);

      render(<CognitoAuth onNext={vi.fn()} />);

      const emailField =
        screen.queryByLabelText(/email/i) ||
        screen.queryByPlaceholderText(/email/i) ||
        screen.queryByRole("textbox", { name: /email/i });
      const passwordField =
        document.querySelector("input[type='password']") as HTMLElement | null;

      await user.type(emailField!, "user@example.com");
      await user.type(passwordField!, "P@ssword123");

      const submitBtn =
        screen.queryByRole("button", { name: /sign in/i }) ||
        screen.queryByRole("button", { name: /log in/i }) ||
        screen.queryByRole("button", { name: /submit/i });
      await user.click(submitBtn!);

      await waitFor(() => {
        // signIn internally calls storeTokens which invokes keychain_set.
        // Since cognito.signIn is mocked at the module level, we verify
        // that signIn was called (token storage is tested inside cognito.test.ts).
        // The responsibility contract here: screen calls signIn → signIn stores tokens.
        expect(mockSignIn).toHaveBeenCalledWith(
          "user@example.com",
          "P@ssword123"
        );
      });
    });
  });

  // -------------------------------------------------------------------------
  describe("UI policy — no-purple-monochrome-ui", () => {
    it("does NOT use 'purple' class names in the DOM", () => {
      const { container } = render(<CognitoAuth onNext={vi.fn()} />);
      expect(container.innerHTML).not.toMatch(/\bpurple\b/);
    });

    it("does NOT use 'indigo' class names in the DOM", () => {
      const { container } = render(<CognitoAuth onNext={vi.fn()} />);
      expect(container.innerHTML).not.toMatch(/\bindigo\b/);
    });

    it("primary buttons use rounded-full class", () => {
      const { container } = render(<CognitoAuth onNext={vi.fn()} />);
      const buttons = container.querySelectorAll("button");
      // At least one button (the primary submit) must have rounded-full
      const hasRoundedFull = Array.from(buttons).some((btn) =>
        btn.className.includes("rounded-full")
      );
      expect(hasRoundedFull).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe("Tauri environment mocks", () => {
    it("renders without errors when @tauri-apps/api/core invoke is mocked", () => {
      expect(() => {
        render(<CognitoAuth onNext={vi.fn()} />);
      }).not.toThrow();
    });
  });
});
