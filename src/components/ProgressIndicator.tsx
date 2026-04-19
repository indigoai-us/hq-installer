// ProgressIndicator.tsx — US-012
// Step progress sidebar indicator — zinc monochrome only.
// Doubles as the wizard navigation: completed/visited steps render as
// buttons that jump back to that step (subject to AUTH_GATED_STEPS).

import { WIZARD_STEPS } from "@/lib/wizard-router";

interface ProgressIndicatorProps {
  currentStep: number; // 1-based
  /** High-water mark of steps the user has reached. Steps with index above
   *  this are not clickable even if `canNavigateTo` would allow it. */
  maxReachedStep?: number;
  /** Predicate: is this step reachable from currentStep right now?
   *  Defaults to "no step is clickable" — preserves the pre-clickable
   *  rendering for tests/callers that don't pass nav handlers. */
  canNavigateTo?: (step: number) => boolean;
  onStepClick?: (step: number) => void;
}

export function ProgressIndicator({
  currentStep,
  maxReachedStep,
  canNavigateTo,
  onStepClick,
}: ProgressIndicatorProps) {
  const reachedCap = maxReachedStep ?? currentStep;

  return (
    <ol className="flex flex-col gap-1 w-40">
      {WIZARD_STEPS.map((step) => {
        const isCurrent = step.index === currentStep;
        const isPast = step.index < currentStep;
        const isVisited = step.index <= reachedCap;
        const clickable =
          !!onStepClick &&
          isVisited &&
          !isCurrent &&
          (canNavigateTo?.(step.index) ?? false);

        let textColor: string;
        if (isCurrent) {
          textColor = "text-white";
        } else if (isPast) {
          textColor = "text-zinc-400";
        } else {
          textColor = "text-zinc-600";
        }

        const rowClass = `flex items-center gap-2 text-xs font-light ${textColor}`;
        const interactive =
          "w-full text-left rounded-md px-1 -mx-1 hover:bg-white/5 hover:text-white transition-colors cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-white/20";
        const inert = "px-1 -mx-1";

        const content = (
          <>
            <span className="w-4 text-right shrink-0">{step.index}</span>
            <span>{step.label}</span>
          </>
        );

        return (
          <li
            key={step.id}
            role="listitem"
            aria-current={isCurrent ? "step" : undefined}
          >
            {clickable ? (
              <button
                type="button"
                onClick={() => onStepClick?.(step.index)}
                className={`${rowClass} ${interactive}`}
              >
                {content}
              </button>
            ) : (
              <div className={`${rowClass} ${inert}`}>{content}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
