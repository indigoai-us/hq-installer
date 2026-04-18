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
// These tests are intentionally written BEFORE the implementation exists.
// They will fail until wizard-router.ts is created.
// ---------------------------------------------------------------------------

describe("WIZARD_STEPS constant", () => {
  it("defines exactly 12 steps", () => {
    expect(WIZARD_STEPS).toHaveLength(12);
  });

  it("each step has an index, id, and label", () => {
    for (const step of WIZARD_STEPS) {
      expect(typeof step.index).toBe("number");
      expect(typeof step.id).toBe("string");
      expect(typeof step.label).toBe("string");
      expect(step.label.length).toBeGreaterThan(0);
    }
  });

  it("step indices run 1..12 without gaps", () => {
    const indices = WIZARD_STEPS.map((s) => s.index);
    expect(indices).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
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

    it("advances through all 12 steps when next() is called 11 times from step 1", () => {
      const router = createWizardRouter();
      for (let i = 0; i < 11; i++) {
        router.next();
      }
      expect(router.currentStep).toBe(12);
    });

    it("stays at step 12 when next() is called at the last step (no overflow)", () => {
      const router = createWizardRouter();
      for (let i = 0; i < 11; i++) {
        router.next();
      }
      // Already at 12 — one more next() should not overflow
      router.next();
      expect(router.currentStep).toBe(12);
    });

    it("canGoNext is false at step 12", () => {
      const router = createWizardRouter();
      for (let i = 0; i < 11; i++) {
        router.next();
      }
      expect(router.canGoNext).toBe(false);
    });

    it("canGoNext is true below step 12", () => {
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
      router.next(); // 3
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
    it("step 5 (DirectoryPicker) is invalid when installPath is null", () => {
      expect(getStepValidity(5, makeState({ installPath: null }))).toBe(false);
    });

    it("step 5 is invalid when installPath is empty string", () => {
      expect(getStepValidity(5, makeState({ installPath: "" }))).toBe(false);
    });

    it("step 5 is valid once installPath is populated", () => {
      expect(getStepValidity(5, makeState({ installPath: "/tmp/hq" }))).toBe(true);
    });

    // ── Step 9 (Personalize) — the bypass bug this whole block exists to prevent.
    //
    // Symptom before fix: global Next button was always enabled, letting the
    // user walk past the Personalize screen without ever clicking Submit.
    // Result: no profile.md, no voice-style.md, no companies/{slug}/ scaffolded.
    it("step 9 (Personalize) is invalid by default (personalized=false)", () => {
      expect(getStepValidity(9, makeState())).toBe(false);
    });

    it("step 9 is valid once personalize() has succeeded (personalized=true)", () => {
      expect(getStepValidity(9, makeState({ personalized: true }))).toBe(true);
    });

    it("returns true by default for steps without an explicit gate", () => {
      // Sample from the unguarded step set so any future guard additions that
      // forget to update this test light up rather than silently passing.
      const unguarded = [1, 2, 3, 4, 6, 7, 8, 10, 12];
      for (const step of unguarded) {
        expect(getStepValidity(step, makeState())).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  describe("E2E acceptance scenario", () => {
    it("given shell mounted at step 1, calling next() 11 times reaches step 12 without throwing", () => {
      const router = createWizardRouter();
      expect(() => {
        for (let i = 0; i < 11; i++) {
          router.next();
        }
      }).not.toThrow();
      expect(router.currentStep).toBe(12);
    });

    it("given step 3 is auth-gated, clicking back from step 3 leaves currentStep at 3", () => {
      const router = createWizardRouter();
      router.next(); // → 2
      router.next(); // → 3 (auth-gated)
      router.back(); // blocked
      expect(router.currentStep).toBe(3);
    });
  });
});
