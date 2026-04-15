import { useState } from "react";
import { createWizardRouter } from "@/lib/wizard-router";
import { WizardShell } from "@/components/WizardShell";
import { Button } from "@/components/ui/button";

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

  return (
    <div className="min-h-screen bg-zinc-950">
      <WizardShell
        currentStep={router.currentStep}
        onNext={handleNext}
        onBack={handleBack}
        canGoBack={router.canGoBack}
        canGoNext={router.canGoNext}
      >
        {/* Placeholder step content — screens added in US-013+ */}
        <div className="text-center space-y-6">
          <h1 className="text-2xl font-light text-zinc-200">HQ Installer</h1>
          <p className="text-sm text-zinc-500">Setting up your workspace...</p>
          <div className="flex gap-3 justify-center">
            <Button>Get Started</Button>
            <Button variant="secondary">Learn More</Button>
          </div>
        </div>
      </WizardShell>
    </div>
  );
}

export default App;
