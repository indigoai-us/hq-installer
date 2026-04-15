// wizard-router.ts — US-012
// Wizard navigation state machine

export interface WizardStep {
  index: number;
  id: string;
  label: string;
}

export const WIZARD_STEPS: WizardStep[] = [
  { index: 1, id: "welcome", label: "Welcome" },
  { index: 2, id: "prerequisites", label: "Prerequisites" },
  { index: 3, id: "github", label: "GitHub" },
  { index: 4, id: "account", label: "Account" },
  { index: 5, id: "install", label: "Install" },
  { index: 6, id: "configure", label: "Configure" },
  { index: 7, id: "templates", label: "Templates" },
  { index: 8, id: "personalize", label: "Personalize" },
  { index: 9, id: "workspace", label: "Workspace" },
  { index: 10, id: "verify", label: "Verify" },
  { index: 11, id: "done", label: "Done" },
];

/** Step indices (1-based) where back navigation is blocked */
export const AUTH_GATED_STEPS: number[] = [3];

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
