import { useState } from "react";
import { createWizardRouter } from "@/lib/wizard-router";
import { WizardShell } from "@/components/WizardShell";
import { getWizardState, setTelemetryEnabled } from "@/lib/wizard-state";
import { Welcome } from "@/screens/01-welcome";
import { CognitoAuth } from "@/screens/02-cognito-auth";
import { TeamSetup } from "@/screens/03-team";
import { DepsInstall } from "@/screens/04-deps";
import { GithubWalkthrough } from "@/screens/05-github-walkthrough";
import { DirectoryPicker } from "@/screens/06-directory";
import { TemplateFetch } from "@/screens/07-template";
import { GitInit } from "@/screens/08-git-init";
import { Personalize } from "@/screens/09-personalize";
import { QmdIndexing } from "@/screens/10-indexing";
import { Summary } from "@/screens/11-summary";

function App() {
  const [router] = useState(() => createWizardRouter());
  const [, forceRender] = useState(0);

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

  // Re-read wizard state on each render (not useState — singleton)
  const wizardState = getWizardState();
  const { currentStep } = router;

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
        return <TeamSetup onNext={handleNext} />;
      case 4:
        return <DepsInstall onNext={handleNext} />;
      case 5:
        return <GithubWalkthrough onNext={handleNext} />;
      case 6:
        return <DirectoryPicker onNext={handleNext} />;
      case 7:
        return (
          <TemplateFetch
            targetDir={wizardState.installPath ?? ""}
            onNext={handleNext}
          />
        );
      case 8:
        return (
          <GitInit
            installPath={wizardState.installPath ?? ""}
            onNext={handleNext}
          />
        );
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
        canGoNext={router.canGoNext}
      >
        {renderStep()}
      </WizardShell>
    </div>
  );
}

export default App;
