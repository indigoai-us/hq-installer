// wizard-router.ts — US-006
// Wizard navigation state machine.
//
// Screen flow (web-onboarding handoff):
//   01 Welcome → 02 Cognito Auth → 03 Company Detect → 04 Deps →
//   05 Directory → 06 Template → 07 Git Init → 08 Sync →
//   09 Personalize → 10 Indexing → 11 Summary
//
// Screen 05-github-walkthrough removed from default flow (GitHub auth
// happens in web onboarding, not installer). File kept for future use.

import type { WizardState } from "./wizard-state";

export interface WizardStep {
  index: number;
  id: string;
  label: string;
}

export const WIZARD_STEPS: WizardStep[] = [
  { index: 1, id: "welcome", label: "Welcome" },
  { index: 2, id: "cognito-auth", label: "Sign In" },
  { index: 3, id: "company-detect", label: "Company" },
  { index: 4, id: "prerequisites", label: "Prerequisites" },
  { index: 5, id: "install", label: "Install" },
  { index: 6, id: "templates", label: "Templates" },
  { index: 7, id: "workspace", label: "Workspace" },
  { index: 8, id: "sync", label: "Sync" },
  { index: 9, id: "personalize", label: "Personalize" },
  { index: 10, id: "verify", label: "Verify" },
  { index: 11, id: "done", label: "Done" },
];

/** Step indices (1-based) where back navigation is blocked */
export const AUTH_GATED_STEPS: number[] = [3];

/**
 * Per-step "is the user allowed to advance" check.
 */
export function getStepValidity(
  step: number,
  state: Readonly<WizardState>,
): boolean {
  switch (step) {
    // Step 5 (DirectoryPicker): must have picked an install path.
    case 5:
      return state.installPath !== null && state.installPath.length > 0;
    default:
      return true;
  }
}

const TOTAL_STEPS = WIZARD_STEPS.length;

export interface WizardRouter {
  currentStep: number;
  next(): void;
  back(): void;
  canGoBack: boolean;
  canGoNext: boolean;
  goTo(step: number): void;
}

export function createWizardRouter(): WizardRouter {
  let current = 1;

  function isAuthGated(step: number): boolean {
    return AUTH_GATED_STEPS.includes(step);
  }

  const router: WizardRouter = {
    get currentStep() {
      return current;
    },

    next() {
      if (current < TOTAL_STEPS) {
        current += 1;
      }
    },

    back() {
      if (current <= 1) return;
      if (isAuthGated(current)) return;
      current -= 1;
    },

    get canGoBack() {
      return current > 1 && !isAuthGated(current);
    },

    get canGoNext() {
      return current < TOTAL_STEPS;
    },

    goTo(step: number) {
      if (step >= 1 && step <= TOTAL_STEPS) {
        current = step;
      }
    },
  };

  return router;
}
