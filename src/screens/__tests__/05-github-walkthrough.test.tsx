// 05-github-walkthrough.test.tsx — US-015

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { GithubWalkthrough } from "../05-github-walkthrough.js";

// ---------------------------------------------------------------------------
// GithubWalkthrough screen tests (US-015)
//
// These tests are written BEFORE the implementation exists.
// They will fail until src/screens/05-github-walkthrough.tsx is created.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tauri API mocks
// ---------------------------------------------------------------------------
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/plugin-shell", () => ({
  open: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
}));

import { invoke } from "@tauri-apps/api/core";
const mockInvoke = vi.mocked(invoke);

// ---------------------------------------------------------------------------

describe("GithubWalkthrough screen (05-github-walkthrough.tsx)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  describe("sub-step rendering", () => {
    it("renders a 'Create GitHub Account' sub-step", () => {
      render(<GithubWalkthrough onNext={vi.fn()} />);
      const el =
        screen.queryByText(/create github account/i) ||
        screen.queryByText(/github account/i);
      expect(el).not.toBeNull();
    });

    it("renders an 'Add SSH Key' sub-step", () => {
      render(<GithubWalkthrough onNext={vi.fn()} />);
      const el =
        screen.queryByText(/add ssh key/i) ||
        screen.queryByText(/ssh key/i);
      expect(el).not.toBeNull();
    });

    it("renders a 'Create PAT' sub-step", () => {
      render(<GithubWalkthrough onNext={vi.fn()} />);
      const el =
        screen.queryByText(/create pat/i) ||
        screen.queryByText(/personal access token/i) ||
        screen.queryByText(/\bpat\b/i);
      expect(el).not.toBeNull();
    });

    it("renders 3 checkboxes — one per sub-step", () => {
      render(<GithubWalkthrough onNext={vi.fn()} />);
      const checkboxes = document.querySelectorAll("input[type='checkbox']");
      expect(checkboxes).toHaveLength(3);
    });

    it("all 3 checkboxes start unchecked", () => {
      render(<GithubWalkthrough onNext={vi.fn()} />);
      const checkboxes = Array.from(
        document.querySelectorAll("input[type='checkbox']")
      ) as HTMLInputElement[];
      expect(checkboxes.every((cb) => !cb.checked)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe("open webview on sub-step click", () => {
    it("clicking the 'Create GitHub Account' button invokes open_webview with a github.com URL", async () => {
      const user = userEvent.setup();
      render(<GithubWalkthrough onNext={vi.fn()} />);

      const btn =
        screen.queryByRole("button", { name: /create github account/i }) ||
        screen.queryByRole("button", { name: /github account/i }) ||
        screen.queryByRole("button", { name: /open.*account/i });
      expect(btn).not.toBeNull();

      await user.click(btn!);

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith(
          "open_webview",
          expect.objectContaining({ url: expect.stringMatching(/github\.com/i) })
        );
      });
    });

    it("clicking the 'Add SSH Key' button invokes open_webview with a github.com SSH URL", async () => {
      const user = userEvent.setup();
      render(<GithubWalkthrough onNext={vi.fn()} />);

      const btn =
        screen.queryByRole("button", { name: /add ssh key/i }) ||
        screen.queryByRole("button", { name: /ssh key/i }) ||
        screen.queryByRole("button", { name: /open.*ssh/i });
      expect(btn).not.toBeNull();

      await user.click(btn!);

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith(
          "open_webview",
          expect.objectContaining({ url: expect.stringMatching(/github\.com/i) })
        );
      });
    });

    it("clicking the 'Create PAT' button invokes open_webview with a github.com token URL", async () => {
      const user = userEvent.setup();
      render(<GithubWalkthrough onNext={vi.fn()} />);

      const btn =
        screen.queryByRole("button", { name: /create pat/i }) ||
        screen.queryByRole("button", { name: /personal access token/i }) ||
        screen.queryByRole("button", { name: /\bpat\b/i }) ||
        screen.queryByRole("button", { name: /open.*token/i });
      expect(btn).not.toBeNull();

      await user.click(btn!);

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith(
          "open_webview",
          expect.objectContaining({ url: expect.stringMatching(/github\.com/i) })
        );
      });
    });
  });

  // -------------------------------------------------------------------------
  describe("PAT input + keychain_set", () => {
    it("renders a PAT input field", () => {
      render(<GithubWalkthrough onNext={vi.fn()} />);
      const patInput =
        screen.queryByLabelText(/pat/i) ||
        screen.queryByLabelText(/personal access token/i) ||
        screen.queryByPlaceholderText(/pat/i) ||
        screen.queryByPlaceholderText(/token/i) ||
        screen.queryByPlaceholderText(/ghp_/i);
      expect(patInput).not.toBeNull();
    });

    it("calls invoke('keychain_set', ...) with service='pat' and account='github' when a PAT is entered", async () => {
      const user = userEvent.setup();
      render(<GithubWalkthrough onNext={vi.fn()} />);

      const patInput =
        screen.queryByLabelText(/pat/i) ||
        screen.queryByLabelText(/personal access token/i) ||
        screen.queryByPlaceholderText(/pat/i) ||
        screen.queryByPlaceholderText(/token/i) ||
        screen.queryByPlaceholderText(/ghp_/i);
      expect(patInput).not.toBeNull();

      await user.type(patInput!, "ghp_testtoken123");

      // Trigger storage — may happen on blur, change, or a "Save" button
      await user.tab(); // blur the field

      await waitFor(() => {
        const keychainCall = mockInvoke.mock.calls.find(
          ([cmd]) => cmd === "keychain_set"
        );
        expect(keychainCall).toBeDefined();
        const [, args] = keychainCall!;
        expect((args as Record<string, string>).service).toBe("pat");
        expect((args as Record<string, string>).account).toBe("github");
        expect((args as Record<string, string>).secret).toBe("ghp_testtoken123");
      });
    });

    it("does NOT call keychain_set when the PAT input is empty", async () => {
      render(<GithubWalkthrough onNext={vi.fn()} />);

      // No typing — just render and blur
      const patInput =
        screen.queryByLabelText(/pat/i) ||
        screen.queryByLabelText(/personal access token/i) ||
        screen.queryByPlaceholderText(/pat/i) ||
        screen.queryByPlaceholderText(/token/i);

      if (patInput) {
        patInput.dispatchEvent(new Event("blur"));
      }

      // Wait a tick then assert
      await new Promise((r) => setTimeout(r, 50));

      const keychainCall = mockInvoke.mock.calls.find(
        ([cmd]) => cmd === "keychain_set"
      );
      expect(keychainCall).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  describe("Continue button gate — all checkboxes required", () => {
    it("does NOT render a Continue button when no checkboxes are checked", () => {
      render(<GithubWalkthrough onNext={vi.fn()} />);
      const continueBtn =
        screen.queryByRole("button", { name: /continue/i }) ||
        screen.queryByRole("button", { name: /next/i });

      if (continueBtn) {
        // If present, it must be disabled
        expect((continueBtn as HTMLButtonElement).disabled).toBe(true);
      }
      // Acceptable if button is simply absent
    });

    it("Continue button is still absent/disabled when only 2 of 3 checkboxes are checked", async () => {
      const user = userEvent.setup();
      render(<GithubWalkthrough onNext={vi.fn()} />);

      const checkboxes = Array.from(
        document.querySelectorAll("input[type='checkbox']")
      ) as HTMLInputElement[];
      expect(checkboxes.length).toBe(3);

      // Check only first two
      await user.click(checkboxes[0]);
      await user.click(checkboxes[1]);

      const continueBtn =
        screen.queryByRole("button", { name: /continue/i }) ||
        screen.queryByRole("button", { name: /next/i });

      if (continueBtn) {
        expect((continueBtn as HTMLButtonElement).disabled).toBe(true);
      }
    });

    it("Continue button appears (and is enabled) only when all 3 checkboxes are checked", async () => {
      const user = userEvent.setup();
      render(<GithubWalkthrough onNext={vi.fn()} />);

      const checkboxes = Array.from(
        document.querySelectorAll("input[type='checkbox']")
      ) as HTMLInputElement[];
      expect(checkboxes.length).toBe(3);

      await user.click(checkboxes[0]);
      await user.click(checkboxes[1]);
      await user.click(checkboxes[2]);

      await waitFor(() => {
        const continueBtn =
          screen.queryByRole("button", { name: /continue/i }) ||
          screen.queryByRole("button", { name: /next/i });
        expect(continueBtn).not.toBeNull();
        expect((continueBtn as HTMLButtonElement).disabled).toBe(false);
      });
    });

    it("clicking Continue with all 3 checked calls onNext()", async () => {
      const user = userEvent.setup();
      const onNext = vi.fn();
      render(<GithubWalkthrough onNext={onNext} />);

      const checkboxes = Array.from(
        document.querySelectorAll("input[type='checkbox']")
      ) as HTMLInputElement[];

      await user.click(checkboxes[0]);
      await user.click(checkboxes[1]);
      await user.click(checkboxes[2]);

      const continueBtn = await waitFor(() => {
        const btn =
          screen.queryByRole("button", { name: /continue/i }) ||
          screen.queryByRole("button", { name: /next/i });
        expect(btn).not.toBeNull();
        return btn!;
      });

      await user.click(continueBtn);
      expect(onNext).toHaveBeenCalledTimes(1);
    });

    it("does NOT call onNext on initial render", () => {
      const onNext = vi.fn();
      render(<GithubWalkthrough onNext={onNext} />);
      expect(onNext).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  describe("UI policy — no-purple-monochrome-ui", () => {
    it("does NOT use 'purple' class names in the DOM", () => {
      const { container } = render(<GithubWalkthrough onNext={vi.fn()} />);
      expect(container.innerHTML).not.toMatch(/\bpurple\b/);
    });

    it("does NOT use 'indigo' class names in the DOM", () => {
      const { container } = render(<GithubWalkthrough onNext={vi.fn()} />);
      expect(container.innerHTML).not.toMatch(/\bindigo\b/);
    });
  });

  // -------------------------------------------------------------------------
  describe("Tauri environment compatibility", () => {
    it("renders cleanly when Tauri APIs are mocked", () => {
      expect(() => {
        render(<GithubWalkthrough onNext={vi.fn()} />);
      }).not.toThrow();
    });
  });
});
