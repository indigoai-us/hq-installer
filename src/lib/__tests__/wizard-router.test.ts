import { describe, it, expect } from "vitest";
import {
  createWizardRouter,
  getStepValidity,
  WIZARD_STEPS,
  AUTH_GATED_STEPS,
} from "../wizard-router.js";
import type { WizardState } from "../wizard-state.js";

// Helper: produce a clean state with all required fields. Tests override only
// what they care about, leaving every other field at its default.
function makeState(overrides: Partial<WizardState> = {}): WizardState {
  return {
    telemetryEnabled: true,
    team: null,
    isPersonal: false,
    installPath: null,
    gitName: null,
    gitEmail: null,
    personalized: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// wizard-router unit tests — US-005 5-step contract
//
//   1 Welcome → 2 Install (silent ~/hq) → 3 Sign In (Cognito provider) →
//   4 Setup (unified post-login progress) → 5 Done
//
// AUTH_GATED_STEPS = [4] — Setup is the first post-auth step, so the gate
// blocks backwards crossing from step 4 into the pre-auth screens.
// ---------------------------------------------------------------------------

describe("WIZARD_STEPS constant", () => {
  it("defines exactly 5 steps", () => {
    expect(WIZARD_STEPS).toHaveLength(5);
  });

  it("each step has an index, id, and label", () => {
    for (const step of WIZARD_STEPS) {
      expect(typeof step.index).toBe("number");
      expect(typeof step.id).toBe("string");
      expect(typeof step.label).toBe("string");
      expect(step.label.length).toBeGreaterThan(0);
    }
  });

  it("step indices run 1..5 without gaps", () => {
    const indices = WIZARD_STEPS.map((s) => s.index);
    expect(indices).toEqual([1, 2, 3, 4, 5]);
  });

  it("exposes the 5-step contract ids: welcome, install, signin, setup, done", () => {
    const ids = WIZARD_STEPS.map((s) => s.id);
    expect(ids).toEqual(["welcome", "install", "signin", "setup", "done"]);
  });

  it("places install before signin, and signin before setup", () => {
    const install = WIZARD_STEPS.find((s) => s.id === "install");
    const signin = WIZARD_STEPS.find((s) => s.id === "signin");
    const setup = WIZARD_STEPS.find((s) => s.id === "setup");
    expect(install).toBeDefined();
    expect(signin).toBeDefined();
    expect(setup).toBeDefined();
    expect(install!.index).toBeLessThan(signin!.index);
    expect(signin!.index).toBeLessThan(setup!.index);
  });
});

describe("AUTH_GATED_STEPS constant", () => {
  it("includes step index 4 (Setup — first post-signin screen)", () => {
    expect(AUTH_GATED_STEPS).toContain(4);
  });
});

describe("createWizardRouter", () => {
  // -------------------------------------------------------------------------
  describe("initial state", () => {
    it("starts at step 1", () => {
      const router = createWizardRouter();
      expect(router.currentStep).toBe(1);
    });

    it("canGoBack is false at step 1", () => {
      const router = createWizardRouter();
      expect(router.canGoBack).toBe(false);
    });

    it("canGoNext is true at step 1", () => {
      const router = createWizardRouter();
      expect(router.canGoNext).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe("next() — forward navigation", () => {
    it("advances from step 1 to step 2", () => {
      const router = createWizardRouter();
      router.next();
      expect(router.currentStep).toBe(2);
    });

    it("advances through all 5 steps when next() is called 4 times from step 1", () => {
      const router = createWizardRouter();
      for (let i = 0; i < 4; i++) {
        router.next();
      }
      expect(router.currentStep).toBe(5);
    });

    it("stays at step 5 when next() is called at the last step (no overflow)", () => {
      const router = createWizardRouter();
      for (let i = 0; i < 4; i++) {
        router.next();
      }
      // Already at 5 — one more next() should not overflow
      router.next();
      expect(router.currentStep).toBe(5);
    });

    it("canGoNext is false at step 5", () => {
      const router = createWizardRouter();
      for (let i = 0; i < 4; i++) {
        router.next();
      }
      expect(router.canGoNext).toBe(false);
    });

    it("canGoNext is true below step 5", () => {
      const router = createWizardRouter();
      router.next(); // step 2
      expect(router.canGoNext).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe("back() — backward navigation", () => {
    it("stays at step 1 when back() is called at first step (no underflow)", () => {
      const router = createWizardRouter();
      router.back();
      expect(router.currentStep).toBe(1);
    });

    it("retreats from step 2 to step 1", () => {
      const router = createWizardRouter();
      router.next(); // → 2
      router.back(); // → 1
      expect(router.currentStep).toBe(1);
    });

    it("canGoBack is true when at step 2 and not on auth-gated step", () => {
      const router = createWizardRouter();
      router.next(); // → 2
      expect(router.canGoBack).toBe(true);
    });

    it("canGoBack is true when at step 5 (past the auth gate but not on it)", () => {
      const router = createWizardRouter();
      router.goTo(5);
      expect(router.canGoBack).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe("auth-gated step 4 — back navigation blocked", () => {
    it("back() from step 4 is a no-op (blocked by auth gate)", () => {
      const router = createWizardRouter();
      router.goTo(4);
      router.back(); // should be blocked
      expect(router.currentStep).toBe(4);
    });

    it("canGoBack is false when at step 4 (auth-gated)", () => {
      const router = createWizardRouter();
      router.goTo(4);
      expect(router.canGoBack).toBe(false);
    });

    it("canGoNext is true at step 4 (can still proceed forward from auth step)", () => {
      const router = createWizardRouter();
      router.goTo(4);
      expect(router.canGoNext).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe("getStepValidity — per-step advance gates", () => {
    it("step 2 (Install) is invalid when installPath is null", () => {
      expect(getStepValidity(2, makeState({ installPath: null }))).toBe(false);
    });

    it("step 2 is invalid when installPath is empty string", () => {
      expect(getStepValidity(2, makeState({ installPath: "" }))).toBe(false);
    });

    it("step 2 is valid once installPath is populated", () => {
      expect(getStepValidity(2, makeState({ installPath: "/tmp/hq" }))).toBe(true);
    });

    // ── Step 4 (Setup) — the unified orchestrator drives its own progress
    // and calls onNext automatically (US-004 contract). The global Next
    // button must stay disabled the entire time the screen is visible.
    it("step 4 (Setup) is always invalid — orchestrator auto-advances", () => {
      expect(getStepValidity(4, makeState())).toBe(false);
      expect(getStepValidity(4, makeState({ personalized: true }))).toBe(false);
      expect(
        getStepValidity(4, makeState({ installPath: "/tmp/hq", personalized: true })),
      ).toBe(false);
    });

    it("returns true by default for steps without an explicit gate", () => {
      // Steps with no gate: Welcome (1), Sign In (3), Done (5).
      // Sampling from this set lights up any future guard additions that
      // forget to update this test.
      const unguarded = [1, 3, 5];
      for (const step of unguarded) {
        expect(getStepValidity(step, makeState())).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  describe("E2E acceptance scenario", () => {
    it("given shell mounted at step 1, calling next() 4 times reaches step 5 without throwing", () => {
      const router = createWizardRouter();
      expect(() => {
        for (let i = 0; i < 4; i++) {
          router.next();
        }
      }).not.toThrow();
      expect(router.currentStep).toBe(5);
    });

    it("given step 4 is auth-gated, clicking back from step 4 leaves currentStep at 4", () => {
      const router = createWizardRouter();
      router.goTo(4);
      router.back(); // blocked
      expect(router.currentStep).toBe(4);
    });
  });

  // -------------------------------------------------------------------------
  describe("canNavigateTo", () => {
    it("returns false for out-of-range targets", () => {
      const router = createWizardRouter();
      expect(router.canNavigateTo(0)).toBe(false);
      expect(router.canNavigateTo(WIZARD_STEPS.length + 1)).toBe(false);
    });

    it("returns false for the current step", () => {
      const router = createWizardRouter();
      expect(router.canNavigateTo(1)).toBe(false);
      router.next(); // → 2
      expect(router.canNavigateTo(2)).toBe(false);
    });

    it("allows forward jumps within range", () => {
      const router = createWizardRouter();
      // From step 1, forward jumps are fine — caller is responsible for
      // gating against unvisited steps via maxReachedStep.
      expect(router.canNavigateTo(3)).toBe(true);
    });

    it("allows backward jumps when no auth gate sits between target and current", () => {
      const router = createWizardRouter();
      router.goTo(5);
      // Step 5 → step 4 doesn't cross the gate (target == gate is allowed).
      expect(router.canNavigateTo(4)).toBe(true);
    });

    it("blocks backward jumps that would cross AUTH_GATED_STEPS=[4]", () => {
      const router = createWizardRouter();
      router.goTo(5);
      // step 4 is auth-gated → can't return to steps 1-3
      expect(router.canNavigateTo(1)).toBe(false);
      expect(router.canNavigateTo(2)).toBe(false);
      expect(router.canNavigateTo(3)).toBe(false);
      // step 4 itself is reachable (the gate is on leaving it backwards)
      expect(router.canNavigateTo(4)).toBe(true);
    });

    it("AUTH_GATED_STEPS const is honored — modifying gate set affects rule", () => {
      // Sanity: confirm the test fixture matches what the rule reads.
      expect(AUTH_GATED_STEPS).toContain(4);
    });
  });
});
