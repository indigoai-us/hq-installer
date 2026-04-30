// wizard-router.ts — US-006
// Wizard navigation state machine.
//
// Screen flow (install-first, login-after — 2026-04-29):
//   01 Welcome → 02 Install (dir) → 03 Templates → 04 Cognito Auth →
//   05 Prerequisites → 06 Workspace (git init) → 07 Personalize →
//   08 Verify (indexing) → 09 HQ Sync (menubar) → 10 Done
//
// Files land in the chosen HQ folder before the user logs in, so an
// install-manifest exists on disk even if the user bails partway. Agents
// reading the HQ tree can then self-heal partial installs.
//
// Old step ordering (login first) is preserved in git history; AUTH_GATED_STEPS
// shifted from [3] to [5] to track the new Cognito position.

import type { WizardState } from "./wizard-state";

export interface WizardStep {
  index: number;
  id: string;
  label: string;
}

export const WIZARD_STEPS: WizardStep[] = [
  { index: 1, id: "welcome", label: "Welcome" },
  { index: 2, id: "install", label: "Install" },
  { index: 3, id: "templates", label: "Templates" },
  { index: 4, id: "cognito-auth", label: "Sign In" },
  { index: 5, id: "prerequisites", label: "Prerequisites" },
  { index: 6, id: "workspace", label: "Workspace" },
  { index: 7, id: "personalize", label: "Personalize" },
  { index: 8, id: "verify", label: "Verify" },
  { index: 9, id: "menubar", label: "HQ Sync" },
  { index: 10, id: "done", label: "Done" },
];

/** Step indices (1-based) where back navigation is blocked.
 *  Step 5 (Prerequisites) is the first screen past Cognito auth — crossing it
 *  backwards would drop the user behind the auth gate and surface a re-login
 *  prompt they've already handled. */
export const AUTH_GATED_STEPS: number[] = [5];

/**
 * Per-step "is the user allowed to advance" check.
 *
 * This gates the GLOBAL Next button rendered by WizardShell. Without it,
 * users can walk past a screen before its internal Submit handler has run,
 * producing a half-built install. Keep this in sync with any screen that
 * has side effects tied to its own Submit/Continue button.
 */
export function getStepValidity(
  step: number,
  state: Readonly<WizardState>,
): boolean {
  switch (step) {
    // Step 2 (DirectoryPicker): must have picked an install path.
    case 2:
      return state.installPath !== null && state.installPath.length > 0;
    // Step 7 (Personalize): Screen's Submit runs personalize() which writes
    // profile.md, voice-style.md, the starter project, and scaffolds
    // user-supplied companies. Bypassing it leaves the install missing all
    // of that. `state.personalized` is flipped to true by Screen 07's
    // handleSubmit on success.
    case 7:
      return state.personalized;
    // Step 9 (InstallMenubarStep): component drives its own Continue/Skip
    // buttons — block the global WizardShell Next button so users can't
    // bypass the install-in-progress state.
    case 9:
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
