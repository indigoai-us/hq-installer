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
        const navProvided = !!onStepClick && !!canNavigateTo;
        const clickable =
          !!onStepClick &&
          isVisited &&
          !isCurrent &&
          (canNavigateTo?.(step.index) ?? false);
        // A past step is "gated" only when navigation is wired up AND the
        // router says we can't reach it. Without nav context, we stay silent
        // (no lock icons in back-compat renders).
        const isGatedPast =
          navProvided && isPast && !canNavigateTo!(step.index);

        let textColor: string;
        let fontWeight = "font-light";
        if (isCurrent) {
          textColor = "text-white";
          fontWeight = "font-medium";
        } else if (isGatedPast) {
          textColor = "text-zinc-600";
        } else if (isPast) {
          textColor = "text-zinc-300";
        } else {
          textColor = "text-zinc-600";
        }

        // Accent bar for the current step; reserved gutter (border-transparent)
        // for all others so labels stay aligned.
        const accent = isCurrent
          ? "border-l-2 border-white pl-2"
          : "border-l-2 border-transparent pl-2";
        const rowClass = `flex items-center gap-2 text-xs ${fontWeight} ${textColor} ${accent}`;
        const interactive =
          "w-full text-left rounded-md pr-1 hover:bg-white/5 hover:text-white transition-colors cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-white/20";
        const inert = "pr-1";

        const content = (
          <>
            <span className="w-4 text-right shrink-0 tabular-nums">
              {step.index}
            </span>
            <span className="flex-1">{step.label}</span>
            {isPast && !isGatedPast && (
              <svg
                aria-hidden="true"
                viewBox="0 0 12 12"
                className="w-3 h-3 shrink-0 opacity-70"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="2.5,6.5 5,9 9.5,3.5" />
              </svg>
            )}
            {isGatedPast && (
              <svg
                aria-label="locked"
                role="img"
                viewBox="0 0 12 12"
                className="w-3 h-3 shrink-0 opacity-70"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="2.5" y="6" width="7" height="4.5" rx="0.75" />
                <path d="M4 6 V4.25 a2 2 0 0 1 4 0 V6" />
              </svg>
            )}
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
              <div
                className={`${rowClass} ${inert}`}
                aria-disabled={isGatedPast ? "true" : undefined}
              >
                {content}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
