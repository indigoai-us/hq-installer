import { useEffect, useState } from "react";
import { createWizardRouter, getStepValidity } from "@/lib/wizard-router";
import { WizardShell } from "@/components/WizardShell";
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
import { Summary } from "@/screens/11-summary";

function App() {
  const [router] = useState(() => createWizardRouter());
  const [, forceRender] = useState(0);

  useEffect(
    () => subscribeWizardState(() => forceRender((n) => n + 1)),
    [],
  );

  function handleNext() {
    router.next();
    forceRender((n) => n + 1);
  }

  function handleBack() {
    router.back();
    forceRender((n) => n + 1);
  }

  function handleLaunch() {
    // No-op for now — invoked from Summary screen
  }

  const wizardState = getWizardState();
  const { currentStep } = router;
  const canGoNext = router.canGoNext && getStepValidity(currentStep, wizardState);

  // Screen flow (US-006):
  //   1 Welcome → 2 Cognito Auth → 3 Company Detect → 4 Deps →
  //   5 Directory → 6 Template → 7 Git Init → 8 Sync →
  //   9 Personalize → 10 Indexing → 11 Summary
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
        return <Summary wizardState={wizardState} onLaunch={handleLaunch} />;
      default:
        return null;
    }
  }

  return (
    <div className="min-h-screen bg-zinc-950">
      <WizardShell
        currentStep={currentStep}
        onNext={handleNext}
        onBack={handleBack}
        canGoBack={router.canGoBack}
        canGoNext={canGoNext}
      >
        {renderStep()}
      </WizardShell>
    </div>
  );
}

export default App;
