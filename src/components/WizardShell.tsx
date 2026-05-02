// WizardShell.tsx — US-012
// Full-page wizard overlay — zinc monochrome, Tauri-aware.
// Navigation lives in the sidebar (clickable ProgressIndicator items);
// there is no bottom Back/Next bar — each screen owns its own forward CTA.

import React, { useCallback } from "react";
import { ProgressIndicator } from "./ProgressIndicator";
import { WizardFooterProvider } from "./WizardFooter";
import { useFooterRef } from "./wizard-footer-context";

function isTauri(): boolean {
  // Use truthiness check — `in` operator returns true even when the value is undefined,
  // which incorrectly classifies a browser env where code defines the property as undefined.
  // __TAURI_INTERNALS__ is the Tauri 2 global; __TAURI__ was Tauri 1 (do not use).
  return typeof window !== "undefined" && !!(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

interface WizardShellProps {
  children: React.ReactNode;
  currentStep: number;
  maxReachedStep?: number;
  canNavigateTo?: (step: number) => boolean;
  onStepClick?: (step: number) => void;
}

export function WizardShell({
  children,
  currentStep,
  maxReachedStep,
  canNavigateTo,
  onStepClick,
}: WizardShellProps) {
  const inTauri = isTauri();

  return (
    <WizardFooterProvider>
      <WizardShellInner
        currentStep={currentStep}
        maxReachedStep={maxReachedStep}
        canNavigateTo={canNavigateTo}
        onStepClick={onStepClick}
        inTauri={inTauri}
      >
        {children}
      </WizardShellInner>
    </WizardFooterProvider>
  );
}

function WizardShellInner({
  children,
  currentStep,
  maxReachedStep,
  canNavigateTo,
  onStepClick,
  inTauri,
}: WizardShellProps & { inTauri: boolean }) {
  const { setFooterRef } = useFooterRef();
  const footerCallbackRef = useCallback(
    (el: HTMLDivElement | null) => setFooterRef(el),
    [setFooterRef],
  );

  return (
    <div className="fixed inset-0 z-50">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/70 backdrop-blur-[24px]" />

      {/* Titlebar + body stacked vertically. Using flex-col + flex-1 instead of
          calc(100% - 2rem) avoids the bug where titlebar h-10 (40px) didn't
          match the subtracted 2rem (32px) in Tauri, clipping the footer by 8px. */}
      <div className="relative z-10 flex flex-col w-full h-full">
        {/* Titlebar drag strip — ONLY element with data-tauri-drag-region */}
        <div
          data-testid="titlebar"
          role="banner"
          data-tauri-drag-region
          className={`shrink-0 w-full bg-zinc-950/80 ${inTauri ? "h-10" : "h-8"}`}
        />

        {/* Body — sidebar + content/footer */}
        <div className="flex-1 flex w-full overflow-hidden">
          {/* Sidebar — progress indicator doubles as nav */}
          <aside className="w-48 shrink-0 bg-zinc-950/60 p-6 flex flex-col">
            <ProgressIndicator
              currentStep={currentStep}
              maxReachedStep={maxReachedStep}
              canNavigateTo={canNavigateTo}
              onStepClick={onStepClick}
            />
          </aside>

          {/* Content area with overlay footer.
              `relative` establishes the positioning context for the absolute
              footer below. */}
          <main className="flex-1 relative bg-zinc-900/40 overflow-hidden">
            {/* Scroll container fills main; pb-24 reserves runway so the last
                bit of content can scroll past the footer-overlay area into
                view rather than being permanently hidden behind the footer. */}
            <div className="absolute inset-0 overflow-auto p-8 pb-24">
              <div className="mx-auto w-full max-w-3xl">{children}</div>
            </div>

            {/* Glass-overlay footer — absolutely positioned over the bottom of
                the scroll container so backdrop-blur-xl actually has scrolling
                content to blur (in flex-sibling form there's nothing behind
                it, making the blur visually inert — verified via VM screenshot
                in the prior iteration). Screens portal their CTA here via
                WizardFooterSlot. */}
            <div
              ref={footerCallbackRef}
              className="absolute bottom-0 left-0 right-0 bg-white/[0.05] backdrop-blur-xl px-8 py-5 flex items-center justify-end gap-3 empty:hidden"
            />
          </main>
        </div>
      </div>
    </div>
  );
}
