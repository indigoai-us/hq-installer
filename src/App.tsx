import { useEffect, useState } from "react";
import { createWizardRouter } from "@/lib/wizard-router";
import { WizardShell } from "@/components/WizardShell";
import { ScreenSwitcher } from "@/components/ScreenSwitcher";
import {
  getWizardState,
  setTelemetryEnabled,
  subscribeWizardState,
} from "@/lib/wizard-state";
import { Welcome } from "@/screens/01-welcome";
import { CognitoAuth } from "@/screens/02-cognito-auth";
import { TeamSetup } from "@/screens/03-team";
import { DepsInstall } from "@/screens/04-deps";
// 05-github-walkthrough removed from default flow (US-006)
import { DirectoryPicker } from "@/screens/06-directory";
import { TemplateFetch } from "@/screens/07-template";
import { GitInit } from "@/screens/08-git-init";
import { SyncScreen } from "@/screens/08b-sync";
import { Personalize } from "@/screens/09-personalize";
import { QmdIndexing } from "@/screens/10-indexing";
import { InstallMenubarStep } from "@/components/InstallMenubarStep";
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

  // Screen flow (US-006 + US-013):
  //   1 Welcome → 2 Cognito Auth → 3 Company Detect → 4 Deps →
  //   5 Directory → 6 Template → 7 Git Init → 8 Sync →
  //   9 Personalize → 10 Indexing → 11 HQ Sync → 12 Summary
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
        return <CognitoAuth onNext={handleNext} />;
      case 3:
        return (
          <TeamSetup
            onNext={handleNext}
            onSignOutAndRetry={() => {
              router.goTo(2);
              // Reset high-water mark — auth sign-out invalidates progress past auth.
              setMaxReachedStep(2);
              forceRender((n) => n + 1);
            }}
          />
        );
      case 4:
        return <DepsInstall onNext={handleNext} />;
      case 5:
        return <DirectoryPicker onNext={handleNext} />;
      case 6:
        return (
          <TemplateFetch
            targetDir={wizardState.installPath ?? ""}
            onNext={handleNext}
          />
        );
      case 7:
        return (
          <GitInit
            installPath={wizardState.installPath ?? ""}
            onNext={handleNext}
          />
        );
      case 8:
        return <SyncScreen onNext={handleNext} />;
      case 9:
        return (
          <Personalize
            installPath={wizardState.installPath ?? ""}
            onNext={handleNext}
          />
        );
      case 10:
        return (
          <QmdIndexing
            installPath={wizardState.installPath ?? ""}
            onNext={handleNext}
          />
        );
      case 11:
        return <InstallMenubarStep onNext={handleNext} />;
      case 12:
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
