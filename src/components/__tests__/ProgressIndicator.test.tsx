import { fireEvent, render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ProgressIndicator } from "../ProgressIndicator.js";

// ---------------------------------------------------------------------------
// ProgressIndicator component tests — US-005 5-step contract
//
// The indicator derives its rows from WIZARD_STEPS, so this suite simply
// pins the 5-step labels and click semantics for the welcome → install →
// signin → setup → done flow. The auth gate at step 4 (Setup) is what the
// "locked glyph" cases exercise.
// ---------------------------------------------------------------------------

const STEP_LABELS = ["Welcome", "Install", "Sign In", "Setup", "Done"];
const TOTAL_STEPS = STEP_LABELS.length;

describe("ProgressIndicator", () => {
  // -------------------------------------------------------------------------
  describe("step count", () => {
    it("renders exactly 5 step entries", () => {
      render(<ProgressIndicator currentStep={1} />);
      for (let i = 1; i <= TOTAL_STEPS; i++) {
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
      const activeEl = screen.getByRole("listitem", { current: "step" });
      expect(activeEl).toBeTruthy();
    });

    it("highlights step 3 (Sign In) when currentStep=3", () => {
      render(<ProgressIndicator currentStep={3} />);
      const activeEl = screen.getByRole("listitem", { current: "step" });
      expect(activeEl.textContent).toContain(STEP_LABELS[2]); // "Sign In"
    });

    it("highlights step 5 (Done) when currentStep=5", () => {
      render(<ProgressIndicator currentStep={5} />);
      const activeEl = screen.getByRole("listitem", { current: "step" });
      expect(activeEl.textContent).toContain(STEP_LABELS[4]); // "Done"
    });

    it("marks exactly one step as current", () => {
      render(<ProgressIndicator currentStep={2} />);
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
      render(<ProgressIndicator currentStep={3} maxReachedStep={3} />);
      expect(screen.queryAllByRole("button")).toHaveLength(0);
    });

    it("renders buttons only for visited, non-current, navigable steps", () => {
      const onStepClick = vi.fn();
      // currentStep=3, maxReached=3, all visited steps (1-2) navigable.
      render(
        <ProgressIndicator
          currentStep={3}
          maxReachedStep={3}
          canNavigateTo={() => true}
          onStepClick={onStepClick}
        />,
      );
      // Steps 1-2 are buttons; step 3 (current) is not; steps 4-5 (unvisited) are not.
      expect(screen.getAllByRole("button")).toHaveLength(2);
    });

    it("does not render a button for the current step", () => {
      const onStepClick = vi.fn();
      render(
        <ProgressIndicator
          currentStep={2}
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
      // Click "Sign In" (step 3 in the 5-step flow)
      fireEvent.click(screen.getByRole("button", { name: /Sign In/i }));
      expect(onStepClick).toHaveBeenCalledWith(3);
    });

    it("respects canNavigateTo — blocked steps render as inert <div>, not <button>", () => {
      const onStepClick = vi.fn();
      // Block step 1 explicitly
      render(
        <ProgressIndicator
          currentStep={3}
          maxReachedStep={3}
          canNavigateTo={(s) => s !== 1}
          onStepClick={onStepClick}
        />,
      );
      // Step 1 should not be a button
      expect(screen.queryByRole("button", { name: /Welcome/i })).toBeNull();
      // Install (step 2) should be a button
      expect(screen.queryByRole("button", { name: /Install/i })).not.toBeNull();
    });

    it("does not render buttons for unvisited steps (above maxReachedStep)", () => {
      const onStepClick = vi.fn();
      render(
        <ProgressIndicator
          currentStep={2}
          maxReachedStep={2}
          canNavigateTo={() => true}
          onStepClick={onStepClick}
        />,
      );
      // Visited & navigable: step 1 (step 2 is current). Steps 3-5 are unvisited.
      expect(screen.getAllByRole("button")).toHaveLength(1);
      expect(screen.queryByRole("button", { name: /Sign In/i })).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe("visual state affordances", () => {
    it("renders a locked glyph for past steps behind an auth gate", () => {
      // currentStep=4 (Setup), past steps (1-3) are visited but blocked by
      // canNavigateTo — mirrors what happens once the user crosses
      // AUTH_GATED_STEPS=[4].
      render(
        <ProgressIndicator
          currentStep={4}
          maxReachedStep={4}
          canNavigateTo={() => false}
          onStepClick={vi.fn()}
        />,
      );
      const locks = screen.getAllByRole("img", { name: /locked/i });
      // Steps 1-3 are past-and-gated = 3 locks. Current & unvisited never
      // show a lock.
      expect(locks).toHaveLength(3);
    });

    it("does not render a locked glyph when nav context is absent", () => {
      // Back-compat render without onStepClick/canNavigateTo — no lock noise.
      render(<ProgressIndicator currentStep={4} maxReachedStep={4} />);
      expect(screen.queryAllByRole("img", { name: /locked/i })).toHaveLength(0);
    });

    it("marks gated past items with aria-disabled='true'", () => {
      render(
        <ProgressIndicator
          currentStep={4}
          maxReachedStep={4}
          canNavigateTo={() => false}
          onStepClick={vi.fn()}
        />,
      );
      const disabled = screen
        .getAllByRole("listitem")
        .filter((li) => li.querySelector("[aria-disabled='true']"));
      expect(disabled).toHaveLength(3); // steps 1-3
    });
  });
});
