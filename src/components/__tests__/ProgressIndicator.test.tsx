import { fireEvent, render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
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
  "Sign In",
  "Company",
  "Prerequisites",
  "Install",
  "Templates",
  "Workspace",
  "Sync",
  "Personalize",
  "Verify",
  "HQ Sync",
  "Done",
];

describe("ProgressIndicator", () => {
  // -------------------------------------------------------------------------
  describe("step count", () => {
    it("renders exactly 12 step entries", () => {
      render(<ProgressIndicator currentStep={1} />);
      // Each step should have a visible step number (1..12)
      for (let i = 1; i <= 12; i++) {
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

    it("highlights step 12 when currentStep=12", () => {
      render(<ProgressIndicator currentStep={12} />);
      const activeEl = screen.getByRole("listitem", { current: "step" });
      expect(activeEl.textContent).toContain(STEP_LABELS[11]);
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

  // -------------------------------------------------------------------------
  describe("clickable navigation", () => {
    it("renders no buttons when onStepClick is not provided (back-compat)", () => {
      render(<ProgressIndicator currentStep={5} maxReachedStep={5} />);
      expect(screen.queryAllByRole("button")).toHaveLength(0);
    });

    it("renders buttons only for visited, non-current, navigable steps", () => {
      const onStepClick = vi.fn();
      // currentStep=5, maxReached=5, all visited steps (1-4) navigable.
      render(
        <ProgressIndicator
          currentStep={5}
          maxReachedStep={5}
          canNavigateTo={() => true}
          onStepClick={onStepClick}
        />,
      );
      // Steps 1-4 are buttons; step 5 (current) is not; steps 6-12 (unvisited) are not.
      expect(screen.getAllByRole("button")).toHaveLength(4);
    });

    it("does not render a button for the current step", () => {
      const onStepClick = vi.fn();
      render(
        <ProgressIndicator
          currentStep={3}
          maxReachedStep={5}
          canNavigateTo={() => true}
          onStepClick={onStepClick}
        />,
      );
      const currentEl = screen.getByRole("listitem", { current: "step" });
      expect(currentEl.querySelector("button")).toBeNull();
    });

    it("calls onStepClick with the step index when a step button is clicked", () => {
      const onStepClick = vi.fn();
      render(
        <ProgressIndicator
          currentStep={5}
          maxReachedStep={5}
          canNavigateTo={() => true}
          onStepClick={onStepClick}
        />,
      );
      // Click "Sign In" (step 2)
      fireEvent.click(screen.getByRole("button", { name: /Sign In/i }));
      expect(onStepClick).toHaveBeenCalledWith(2);
    });

    it("respects canNavigateTo — blocked steps render as inert <div>, not <button>", () => {
      const onStepClick = vi.fn();
      // Block step 1 explicitly
      render(
        <ProgressIndicator
          currentStep={5}
          maxReachedStep={5}
          canNavigateTo={(s) => s !== 1}
          onStepClick={onStepClick}
        />,
      );
      // Step 1 should not be a button
      expect(screen.queryByRole("button", { name: /Welcome/i })).toBeNull();
      // Step 2 should be a button
      expect(screen.queryByRole("button", { name: /Sign In/i })).not.toBeNull();
    });

    it("does not render buttons for unvisited steps (above maxReachedStep)", () => {
      const onStepClick = vi.fn();
      render(
        <ProgressIndicator
          currentStep={3}
          maxReachedStep={3}
          canNavigateTo={() => true}
          onStepClick={onStepClick}
        />,
      );
      // Visited & navigable: 1, 2 (step 3 is current). Steps 4-12 are unvisited.
      expect(screen.getAllByRole("button")).toHaveLength(2);
      expect(screen.queryByRole("button", { name: /Templates/i })).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe("visual state affordances", () => {
    it("renders a locked glyph for past steps behind an auth gate", () => {
      // currentStep=5, all past steps (1-4) are visited but blocked by canNavigateTo —
      // mirrors what happens once the user crosses AUTH_GATED_STEPS.
      render(
        <ProgressIndicator
          currentStep={5}
          maxReachedStep={5}
          canNavigateTo={() => false}
          onStepClick={vi.fn()}
        />,
      );
      const locks = screen.getAllByRole("img", { name: /locked/i });
      // Steps 1-4 are past-and-gated = 4 locks. Current & unvisited never
      // show a lock.
      expect(locks).toHaveLength(4);
    });

    it("does not render a locked glyph when nav context is absent", () => {
      // Back-compat render without onStepClick/canNavigateTo — no lock noise.
      render(<ProgressIndicator currentStep={5} maxReachedStep={5} />);
      expect(screen.queryAllByRole("img", { name: /locked/i })).toHaveLength(0);
    });

    it("marks gated past items with aria-disabled='true'", () => {
      render(
        <ProgressIndicator
          currentStep={5}
          maxReachedStep={5}
          canNavigateTo={() => false}
          onStepClick={vi.fn()}
        />,
      );
      const disabled = screen
        .getAllByRole("listitem")
        .filter((li) =>
          li.querySelector("[aria-disabled='true']"),
        );
      expect(disabled).toHaveLength(4); // steps 1-4
    });
  });
});
