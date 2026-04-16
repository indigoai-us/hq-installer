import { describe, it, expect } from "vitest";
import { createWizardRouter, WIZARD_STEPS, AUTH_GATED_STEPS } from "../wizard-router.js";

// ---------------------------------------------------------------------------
// wizard-router unit tests (US-012)
//
// These tests are intentionally written BEFORE the implementation exists.
// They will fail until wizard-router.ts is created.
// ---------------------------------------------------------------------------

describe("WIZARD_STEPS constant", () => {
  it("defines exactly 11 steps", () => {
    expect(WIZARD_STEPS).toHaveLength(11);
  });

  it("each step has an index, id, and label", () => {
    for (const step of WIZARD_STEPS) {
      expect(typeof step.index).toBe("number");
      expect(typeof step.id).toBe("string");
      expect(typeof step.label).toBe("string");
      expect(step.label.length).toBeGreaterThan(0);
    }
  });

  it("step indices run 1..11 without gaps", () => {
    const indices = WIZARD_STEPS.map((s) => s.index);
    expect(indices).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
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

    it("advances through all 11 steps when next() is called 10 times from step 1", () => {
      const router = createWizardRouter();
      for (let i = 0; i < 10; i++) {
        router.next();
      }
      expect(router.currentStep).toBe(11);
    });

    it("stays at step 11 when next() is called at the last step (no overflow)", () => {
      const router = createWizardRouter();
      for (let i = 0; i < 10; i++) {
        router.next();
      }
      // Already at 11 — one more next() should not overflow
      router.next();
      expect(router.currentStep).toBe(11);
    });

    it("canGoNext is false at step 11", () => {
      const router = createWizardRouter();
      for (let i = 0; i < 10; i++) {
        router.next();
      }
      expect(router.canGoNext).toBe(false);
    });

    it("canGoNext is true below step 11", () => {
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
  describe("E2E acceptance scenario", () => {
    it("given shell mounted at step 1, calling next() 10 times reaches step 11 without throwing", () => {
      const router = createWizardRouter();
      expect(() => {
        for (let i = 0; i < 10; i++) {
          router.next();
        }
      }).not.toThrow();
      expect(router.currentStep).toBe(11);
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
