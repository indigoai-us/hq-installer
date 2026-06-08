// wizard-router.ts — US-005
// Wizard navigation state machine — collapsed 5-step flow.
//
// Screen flow:
//   01 Welcome → 02 Install (silent ~/hq) → 03 Sign In (Cognito provider) →
//   04 Setup (unified post-login progress orchestrator) → 05 Done
//
// Old install-then-templates-then-prereqs-then-login-then-everything ordering
// is gone — every install phase now sits behind the single Setup progress
// bar (see screens/setup-progress.tsx) and the user only sees one explicit
// input (provider sign-in at step 3).

import type { WizardState } from "./wizard-state";

export interface WizardStep {
  index: number;
  id: string;
  label: string;
}

export const WIZARD_STEPS: WizardStep[] = [
  { index: 1, id: "welcome", label: "Welcome" },
  { index: 2, id: "install", label: "Install" },
  { index: 3, id: "signin", label: "Sign In" },
  { index: 4, id: "setup", label: "Setup" },
  { index: 5, id: "done", label: "Done" },
];

/** Step indices (1-based) where back navigation is blocked.
 *  Step 4 (Setup) is the first screen past Cognito auth — crossing it
 *  backwards would drop the user behind the auth gate and surface a re-login
 *  prompt they've already handled. */
export const AUTH_GATED_STEPS: number[] = [4];

/**
 * Per-step "is the user allowed to advance" check.
 *
 * Gates the GLOBAL Next button rendered by WizardShell. Without it,
 * users could walk past a screen before its internal side-effect handler
 * has run, producing a half-built install.
 */
export function getStepValidity(
  step: number,
  state: Readonly<WizardState>,
): boolean {
  switch (step) {
    // Step 2 (Install): the silent ~/hq installer (DirectoryPicker) sets
    // installPath as soon as the Rust resolve_hq_path command returns.
    // Until then the global Next must stay disabled — the screen also
    // self-advances on success, so this gate mostly defends against a
    // user clicking Next during the spinner.
    case 2:
      return state.installPath !== null && state.installPath.length > 0;
    // Step 4 (Setup): the unified orchestrator runs every install phase
    // behind its single progress bar and calls onNext automatically when
    // every stage settles. There is no manual advance — the global Next
    // button stays disabled the whole time (US-004 contract).
    case 4:
      return false;
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
  /**
   * True if the user can jump directly to `target` from the current step.
   * Used by the sidebar progress indicator to decide which steps are
   * clickable. Mirrors `back()`'s auth-gate rule: you cannot cross an
   * AUTH_GATED_STEPS boundary backwards. Forward jumps to unvisited steps
   * are blocked by the caller (it owns `maxReachedStep`); this method only
   * enforces the auth-gate invariant.
   */
  canNavigateTo(target: number): boolean;
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

    canNavigateTo(target: number) {
      if (target < 1 || target > TOTAL_STEPS) return false;
      if (target === current) return false;
      // Block backward navigation that would cross an auth-gated step.
      // An auth gate at step G means: once on or past G, you cannot return
      // to anything before G. Equivalent rule for sidebar jumps: target is
      // unreachable if any G in AUTH_GATED_STEPS satisfies target < G <= current.
      if (target < current) {
        for (const gate of AUTH_GATED_STEPS) {
          if (target < gate && gate <= current) return false;
        }
      }
      return true;
    },
  };

  return router;
}
