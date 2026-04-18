// ProgressIndicator.tsx — US-012
// Step progress sidebar indicator — zinc monochrome only

import { WIZARD_STEPS } from "@/lib/wizard-router";

interface ProgressIndicatorProps {
  currentStep: number; // 1-based
}

export function ProgressIndicator({ currentStep }: ProgressIndicatorProps) {
  return (
    <ol className="flex flex-col gap-1 w-40">
      {WIZARD_STEPS.map((step) => {
        const isCurrent = step.index === currentStep;
        const isPast = step.index < currentStep;

        let textColor: string;
        if (isCurrent) {
          textColor = "text-white";
        } else if (isPast) {
          textColor = "text-zinc-400";
        } else {
          textColor = "text-zinc-600";
        }

        return (
          <li
            key={step.id}
            role="listitem"
            aria-current={isCurrent ? "step" : undefined}
            className={`flex items-center gap-2 text-xs font-light ${textColor}`}
          >
            <span className="w-4 text-right shrink-0">{step.index}</span>
            <span>{step.label}</span>
          </li>
        );
      })}
    </ol>
  );
}
