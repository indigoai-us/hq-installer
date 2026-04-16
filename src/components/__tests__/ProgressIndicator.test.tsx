import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { ProgressIndicator } from "../ProgressIndicator.js";

// ---------------------------------------------------------------------------
// ProgressIndicator component tests (US-012)
//
// These tests are written BEFORE the implementation exists.
// They will fail until ProgressIndicator.tsx is created.
// ---------------------------------------------------------------------------

// Step labels are defined here as the source of truth for the test assertions.
// The implementation must render labels that match these strings.
const STEP_LABELS = [
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

describe("ProgressIndicator", () => {
  // -------------------------------------------------------------------------
  describe("step count", () => {
    it("renders exactly 11 step entries", () => {
      render(<ProgressIndicator currentStep={1} />);
      // Each step should have a visible step number (1..11)
      for (let i = 1; i <= 11; i++) {
        expect(screen.getByText(String(i))).toBeTruthy();
      }
    });
  });

  // -------------------------------------------------------------------------
  describe("step labels", () => {
    it("displays all step labels", () => {
      render(<ProgressIndicator currentStep={1} />);
      for (const label of STEP_LABELS) {
        expect(screen.getByText(label)).toBeTruthy();
      }
    });
  });

  // -------------------------------------------------------------------------
  describe("current step highlighting", () => {
    it("highlights the current step (step 1 by default)", () => {
      render(<ProgressIndicator currentStep={1} />);
      // The active step element should have aria-current="step" per ARIA spec
      const activeEl = screen.getByRole("listitem", { current: "step" });
      expect(activeEl).toBeTruthy();
    });

    it("highlights step 5 when currentStep=5", () => {
      render(<ProgressIndicator currentStep={5} />);
      const activeEl = screen.getByRole("listitem", { current: "step" });
      // The active item should contain the label for step 5
      expect(activeEl.textContent).toContain(STEP_LABELS[4]); // 0-indexed
    });

    it("highlights step 11 when currentStep=11", () => {
      render(<ProgressIndicator currentStep={11} />);
      const activeEl = screen.getByRole("listitem", { current: "step" });
      expect(activeEl.textContent).toContain(STEP_LABELS[10]);
    });

    it("marks exactly one step as current", () => {
      render(<ProgressIndicator currentStep={3} />);
      const currentItems = screen
        .getAllByRole("listitem")
        .filter((el) => el.getAttribute("aria-current") === "step");
      expect(currentItems).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  describe("monochrome / zinc theme — no color accents", () => {
    it("renders without purple class names anywhere in the DOM", () => {
      const { container } = render(<ProgressIndicator currentStep={1} />);
      expect(container.innerHTML).not.toMatch(/\bpurple\b/);
    });

    it("renders without indigo class names anywhere in the DOM", () => {
      const { container } = render(<ProgressIndicator currentStep={1} />);
      expect(container.innerHTML).not.toMatch(/\bindigo\b/);
    });

    it("renders without blue class names anywhere in the DOM", () => {
      const { container } = render(<ProgressIndicator currentStep={1} />);
      expect(container.innerHTML).not.toMatch(/\bblue\b/);
    });
  });
});
