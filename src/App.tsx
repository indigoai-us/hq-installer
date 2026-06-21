import { useEffect, useState } from "react";
import { createWizardRouter, WIZARD_STEPS } from "@/lib/wizard-router";
import { pingStep } from "@/lib/telemetry";
import { WizardShell } from "@/components/WizardShell";
import { ScreenSwitcher } from "@/components/ScreenSwitcher";
import {
  getWizardState,
  setTelemetryEnabled,
  subscribeWizardState,
} from "@/lib/wizard-state";
import { Welcome } from "@/screens/01-welcome";
import { CognitoAuth } from "@/screens/02-cognito-auth";
import { DirectoryPicker } from "@/screens/06-directory";
import { SetupProgress } from "@/screens/setup-progress";
import { Summary } from "@/screens/11-summary";

function App() {
  const [router] = useState(() => createWizardRouter());
  const [, forceRender] = useState(0);
  // High-water mark of steps the user has actually reached. Lets the sidebar
  // disable forward jumps to never-visited steps without preventing back-jumps
  // to ones already completed.
  const [maxReachedStep, setMaxReachedStep] = useState(1);

  useEffect(
    () => subscribeWizardState(() => forceRender((n) => n + 1)),
    [],
  );

  // Delegated click feedback: any primary white button gets a single-shot
  // shimmer sweep so the click feels registered even when the handler is
  // async or navigates away. Keyed on the existing bg-white + text-black
  // class pair so we don't need to touch 24 call sites individually.
  useEffect(() => {
    const CLASS = "hq-shimmer";
    const DURATION_MS = 700;
    function onClick(e: MouseEvent) {
      const target = e.target;
      if (!(target instanceof Element)) return;
      const btn = target.closest("button");
      if (!btn || btn.disabled) return;
      if (
        !btn.classList.contains("bg-white") ||
        !btn.classList.contains("text-black")
      ) {
        return;
      }
      if (btn.classList.contains(CLASS)) return;
      btn.classList.add(CLASS);
      window.setTimeout(() => btn.classList.remove(CLASS), DURATION_MS);
    }
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  function handleNext() {
    router.next();
    setMaxReachedStep((m) => Math.max(m, router.currentStep));
    forceRender((n) => n + 1);
  }

  function handleStepClick(step: number) {
    if (!router.canNavigateTo(step)) return;
    if (step > maxReachedStep) return;
    router.goTo(step);
    forceRender((n) => n + 1);
  }

  function handleLaunch() {
    // No-op for now — invoked from Summary screen
  }

  const wizardState = getWizardState();
  const { currentStep } = router;

  // Step-funnel telemetry: one ping per step as it's reached. Anonymous by an
  // install-session id until sign-in, after which the personUid rides along and
  // the server stitches the session to the person. Gated on telemetry opt-in;
  // fully fire-and-forget so it never blocks the wizard.
  useEffect(() => {
    if (!getWizardState().telemetryEnabled) return;
    const step = WIZARD_STEPS.find((s) => s.index === currentStep);
    if (!step) return;
    void pingStep({
      step: step.id,
      personUid: getWizardState().team?.personUid,
      version: __APP_VERSION__,
    });
  }, [currentStep]);

  // 5-step flow (US-005):
  //   1 Welcome → 2 Install (silent ~/hq) → 3 Sign In (Cognito provider) →
  //   4 Setup (unified post-login progress) → 5 Done
  function renderStep() {
    switch (currentStep) {
      case 1:
        return (
          <Welcome
            onNext={handleNext}
            telemetryEnabled={wizardState.telemetryEnabled}
            onTelemetryChange={(enabled) => {
              setTelemetryEnabled(enabled);
              forceRender((n) => n + 1);
            }}
          />
        );
      case 2:
        return <DirectoryPicker onNext={handleNext} />;
      case 3:
        return <CognitoAuth onNext={handleNext} />;
      case 4:
        return (
          <SetupProgress
            installPath={wizardState.installPath ?? ""}
            onNext={handleNext}
          />
        );
      case 5:
        return <Summary wizardState={wizardState} onLaunch={handleLaunch} />;
      default:
        return null;
    }
  }

  return (
    <div className="min-h-screen bg-zinc-950">
      <WizardShell
        currentStep={currentStep}
        maxReachedStep={maxReachedStep}
        canNavigateTo={(step) => router.canNavigateTo(step) && step <= maxReachedStep}
        onStepClick={handleStepClick}
      >
        <ScreenSwitcher stepKey={currentStep}>{renderStep()}</ScreenSwitcher>
      </WizardShell>
    </div>
  );
}

export default App;
