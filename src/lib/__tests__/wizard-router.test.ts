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
// wizard-router unit tests (US-012)
//
// Updated after removal of old Step 3 (company-detect) and old Step 8 (S3
// sync). New flow is 10 steps; AUTH_GATED_STEPS still = [3] — the first
// post-auth step is now Prerequisites (was Company Detect), so the
// semantics of the gate are preserved.
// ---------------------------------------------------------------------------

describe("WIZARD_STEPS constant", () => {
  it("defines exactly 10 steps", () => {
    expect(WIZARD_STEPS).toHaveLength(10);
  });

  it("each step has an index, id, and label", () => {
    for (const step of WIZARD_STEPS) {
      expect(typeof step.index).toBe("number");
      expect(typeof step.id).toBe("string");
      expect(typeof step.label).toBe("string");
      expect(step.label.length).toBeGreaterThan(0);
    }
  });

  it("step indices run 1..10 without gaps", () => {
    const indices = WIZARD_STEPS.map((s) => s.index);
    expect(indices).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});

describe("AUTH_GATED_STEPS constant", () => {
  it("includes step index 3", () => {
    expect(AUTH_GATED_STEPS).toContain(3);
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

    it("advances through all 10 steps when next() is called 9 times from step 1", () => {
      const router = createWizardRouter();
      for (let i = 0; i < 9; i++) {
        router.next();
      }
      expect(router.currentStep).toBe(10);
    });

    it("stays at step 10 when next() is called at the last step (no overflow)", () => {
      const router = createWizardRouter();
      for (let i = 0; i < 9; i++) {
        router.next();
      }
      // Already at 10 — one more next() should not overflow
      router.next();
      expect(router.currentStep).toBe(10);
    });

    it("canGoNext is false at step 10", () => {
      const router = createWizardRouter();
      for (let i = 0; i < 9; i++) {
        router.next();
      }
      expect(router.canGoNext).toBe(false);
    });

    it("canGoNext is true below step 10", () => {
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

    it("canGoBack is true when at step 4 (not auth-gated)", () => {
      const router = createWizardRouter();
      router.next(); // 2
      router.next(); // 3 (auth-gated)
      router.next(); // 4
      expect(router.canGoBack).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe("auth-gated step 3 — back navigation blocked", () => {
    it("back() from step 3 is a no-op (blocked by auth gate)", () => {
      const router = createWizardRouter();
      router.next(); // → 2
      router.next(); // → 3
      router.back(); // should be blocked
      expect(router.currentStep).toBe(3);
    });

    it("canGoBack is false when at step 3 (auth-gated)", () => {
      const router = createWizardRouter();
      router.next(); // → 2
      router.next(); // → 3
      expect(router.canGoBack).toBe(false);
    });

    it("canGoNext is true at step 3 (can still proceed forward from auth step)", () => {
      const router = createWizardRouter();
      router.next(); // → 2
      router.next(); // → 3
      expect(router.canGoNext).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe("getStepValidity — per-step advance gates", () => {
    it("step 4 (DirectoryPicker) is invalid when installPath is null", () => {
      expect(getStepValidity(4, makeState({ installPath: null }))).toBe(false);
    });

    it("step 4 is invalid when installPath is empty string", () => {
      expect(getStepValidity(4, makeState({ installPath: "" }))).toBe(false);
    });

    it("step 4 is valid once installPath is populated", () => {
      expect(getStepValidity(4, makeState({ installPath: "/tmp/hq" }))).toBe(true);
    });

    // ── Step 7 (Personalize) — the bypass bug this whole block exists to prevent.
    //
    // Symptom before fix: global Next button was always enabled, letting the
    // user walk past the Personalize screen without ever clicking Submit.
    // Result: no profile.md, no voice-style.md, no companies/{slug}/ scaffolded.
    it("step 7 (Personalize) is invalid by default (personalized=false)", () => {
      expect(getStepValidity(7, makeState())).toBe(false);
    });

    it("step 7 is valid once personalize() has succeeded (personalized=true)", () => {
      expect(getStepValidity(7, makeState({ personalized: true }))).toBe(true);
    });

    // ── Step 9 (HQ Sync / InstallMenubarStep) — component drives its own
    // Continue/Skip buttons, so the global Next is always disabled.
    it("step 9 (HQ Sync) is always invalid — internal controls only", () => {
      expect(getStepValidity(9, makeState())).toBe(false);
      expect(getStepValidity(9, makeState({ personalized: true }))).toBe(false);
    });

    it("returns true by default for steps without an explicit gate", () => {
      // Sample from the unguarded step set so any future guard additions that
      // forget to update this test light up rather than silently passing.
      const unguarded = [1, 2, 3, 5, 6, 8, 10];
      for (const step of unguarded) {
        expect(getStepValidity(step, makeState())).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  describe("E2E acceptance scenario", () => {
    it("given shell mounted at step 1, calling next() 9 times reaches step 10 without throwing", () => {
      const router = createWizardRouter();
      expect(() => {
        for (let i = 0; i < 9; i++) {
          router.next();
        }
      }).not.toThrow();
      expect(router.currentStep).toBe(10);
    });

    it("given step 3 is auth-gated, clicking back from step 3 leaves currentStep at 3", () => {
      const router = createWizardRouter();
      router.next(); // → 2
      router.next(); // → 3 (auth-gated)
      router.back(); // blocked
      expect(router.currentStep).toBe(3);
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
      expect(router.canNavigateTo(5)).toBe(true);
    });

    it("allows backward jumps when no auth gate sits between target and current", () => {
      const router = createWizardRouter();
      router.goTo(7);
      expect(router.canNavigateTo(4)).toBe(true);
      expect(router.canNavigateTo(6)).toBe(true);
    });

    it("blocks backward jumps that would cross AUTH_GATED_STEPS=[3]", () => {
      const router = createWizardRouter();
      router.goTo(7);
      // step 3 is auth-gated → can't return to step 1 or 2
      expect(router.canNavigateTo(1)).toBe(false);
      expect(router.canNavigateTo(2)).toBe(false);
      // step 3 itself is reachable (the gate is on leaving it backwards)
      expect(router.canNavigateTo(3)).toBe(true);
    });

    it("AUTH_GATED_STEPS const is honored — modifying gate set affects rule", () => {
      // Sanity: confirm the test fixture matches what the rule reads.
      expect(AUTH_GATED_STEPS).toContain(3);
    });
  });
});
