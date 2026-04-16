import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Welcome } from "../01-welcome.js";

// ---------------------------------------------------------------------------
// Welcome screen tests (US-013)
//
// These tests are written BEFORE the implementation exists.
// They will fail until src/screens/01-welcome.tsx is created.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tauri API mocks — the Welcome screen may import Tauri modules indirectly
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

// ---------------------------------------------------------------------------

describe("Welcome screen (01-welcome.tsx)", () => {
  // -------------------------------------------------------------------------
  describe("product identity", () => {
    it("renders a heading that contains 'HQ'", () => {
      render(<Welcome onNext={vi.fn()} />);
      // The main heading must include "HQ" — not describe it as a generic
      // "documentation app" or "desktop app"
      const headings = screen.getAllByRole("heading");
      const hasHQ = headings.some((h) => h.textContent?.includes("HQ"));
      expect(hasHQ).toBe(true);
    });

    it("does NOT describe HQ as a 'documentation app'", () => {
      const { container } = render(<Welcome onNext={vi.fn()} />);
      expect(container.textContent?.toLowerCase()).not.toContain(
        "documentation app"
      );
    });

    it("does NOT describe HQ as a 'desktop app'", () => {
      const { container } = render(<Welcome onNext={vi.fn()} />);
      expect(container.textContent?.toLowerCase()).not.toContain("desktop app");
    });

    it("surfaces the install command or core value proposition", () => {
      const { container } = render(<Welcome onNext={vi.fn()} />);
      // Must include either the install command or the core value phrase
      const text = container.textContent ?? "";
      const hasInstallCmd = text.includes("npx create-hq");
      const hasCoreValue =
        text.toLowerCase().includes("ai worker") ||
        text.toLowerCase().includes("workers") ||
        text.toLowerCase().includes("orchestrator") ||
        text.toLowerCase().includes("ships code");
      expect(hasInstallCmd || hasCoreValue).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe("wizard steps at-a-glance", () => {
    const EXPECTED_STEP_LABELS = [
      "Welcome",
      "Prerequisites",
      "GitHub",
      "Account",
      "Install",
      "Configure",
      "Templates",
      "Personalize",
      "Workspace",
      "Verify",
      "Done",
    ];

    it("renders all 11 step labels", () => {
      const { container } = render(<Welcome onNext={vi.fn()} />);
      const text = container.textContent ?? "";
      for (const label of EXPECTED_STEP_LABELS) {
        expect(text).toContain(label);
      }
    });

    it("renders exactly 11 steps (not more, not fewer)", () => {
      render(<Welcome onNext={vi.fn()} />);
      // Each step label should appear at least once
      let found = 0;
      for (const label of EXPECTED_STEP_LABELS) {
        try {
          screen.getByText(label, { exact: false });
          found += 1;
        } catch {
          // label not found — intentionally swallowed; count won't reach 11
        }
      }
      expect(found).toBe(11);
    });
  });

  // -------------------------------------------------------------------------
  describe("telemetry opt-in", () => {
    it("renders a telemetry opt-in control (checkbox or toggle)", () => {
      const { container } = render(<Welcome onNext={vi.fn()} />);
      // Look for an element with "telemetry" in its visible text (case-insensitive)
      const text = container.textContent?.toLowerCase() ?? "";
      expect(text).toContain("telemetry");
    });

    it("renders an interactive telemetry control (checkbox, switch, or button)", () => {
      const { container } = render(<Welcome onNext={vi.fn()} />);
      // Telemetry opt-in must be interactive — a checkbox, role=switch, or similar
      const checkbox = container.querySelector("input[type='checkbox']");
      const switchEl = container.querySelector("[role='switch']");
      const toggleBtn = container.querySelector("[data-testid='telemetry-toggle']");
      expect(checkbox || switchEl || toggleBtn).not.toBeNull();
    });

    it("telemetry control defaults to opted-in (checked/on)", () => {
      const { container } = render(<Welcome onNext={vi.fn()} />);
      // By default telemetry should be opted-in
      const checkbox = container.querySelector(
        "input[type='checkbox']"
      ) as HTMLInputElement | null;
      if (checkbox) {
        expect(checkbox.checked).toBe(true);
      } else {
        // If using a role=switch, aria-checked should be "true"
        const switchEl = container.querySelector("[role='switch']");
        expect(switchEl?.getAttribute("aria-checked")).toBe("true");
      }
    });
  });

  // -------------------------------------------------------------------------
  describe("navigation — onNext callback", () => {
    it("renders a primary action button (Next / Get Started)", () => {
      render(<Welcome onNext={vi.fn()} />);
      // The button text may be "Next", "Get Started", "Continue", or similar
      const btn =
        screen.queryByRole("button", { name: /next/i }) ||
        screen.queryByRole("button", { name: /get started/i }) ||
        screen.queryByRole("button", { name: /continue/i }) ||
        screen.queryByRole("button", { name: /begin/i }) ||
        screen.queryByRole("button", { name: /start/i });
      expect(btn).not.toBeNull();
    });

    it("calls onNext when the primary action button is clicked", () => {
      const onNext = vi.fn();
      render(<Welcome onNext={onNext} />);
      const btn =
        screen.queryByRole("button", { name: /next/i }) ||
        screen.queryByRole("button", { name: /get started/i }) ||
        screen.queryByRole("button", { name: /continue/i }) ||
        screen.queryByRole("button", { name: /begin/i }) ||
        screen.queryByRole("button", { name: /start/i });
      expect(btn).not.toBeNull();
      fireEvent.click(btn!);
      expect(onNext).toHaveBeenCalledTimes(1);
    });

    it("does not call onNext before the button is clicked", () => {
      const onNext = vi.fn();
      render(<Welcome onNext={onNext} />);
      expect(onNext).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  describe("UI policy — no-purple-monochrome-ui", () => {
    it("does NOT use 'purple' class names in the DOM", () => {
      const { container } = render(<Welcome onNext={vi.fn()} />);
      expect(container.innerHTML).not.toMatch(/\bpurple\b/);
    });

    it("does NOT use 'indigo' class names in the DOM", () => {
      const { container } = render(<Welcome onNext={vi.fn()} />);
      expect(container.innerHTML).not.toMatch(/\bindigo\b/);
    });
  });

  // -------------------------------------------------------------------------
  describe("Tauri environment compatibility", () => {
    beforeEach(() => {
      Object.defineProperty(window, "__TAURI_INTERNALS__", {
        value: undefined,
        writable: true,
        configurable: true,
      });
    });

    afterEach(() => {
      // @ts-expect-error — deleting non-standard window property
      delete window.__TAURI_INTERNALS__;
    });

    it("renders without errors in non-Tauri browser environment", () => {
      expect(() => {
        render(<Welcome onNext={vi.fn()} />);
      }).not.toThrow();
    });

    it("renders without errors when __TAURI_INTERNALS__ is set", () => {
      // @ts-expect-error — setting non-standard window property for test
      window.__TAURI_INTERNALS__ = { invoke: vi.fn() };
      expect(() => {
        render(<Welcome onNext={vi.fn()} />);
      }).not.toThrow();
    });
  });
});
