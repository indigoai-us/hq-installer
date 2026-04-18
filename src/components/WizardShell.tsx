// WizardShell.tsx — US-012
// Full-page wizard overlay — zinc monochrome, Tauri-aware

import React from "react";
import { ProgressIndicator } from "./ProgressIndicator";

function isTauri(): boolean {
  // Use truthiness check — `in` operator returns true even when the value is undefined,
  // which incorrectly classifies a browser env where code defines the property as undefined.
  // __TAURI_INTERNALS__ is the Tauri 2 global; __TAURI__ was Tauri 1 (do not use).
  return typeof window !== "undefined" && !!(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

interface WizardShellProps {
  children: React.ReactNode;
  currentStep: number;
  onNext?: () => void;
  onBack?: () => void;
  canGoBack?: boolean;
  canGoNext?: boolean;
}

export function WizardShell({
  children,
  currentStep,
  onNext,
  onBack,
  canGoBack = false,
  canGoNext = true,
}: WizardShellProps) {
  const inTauri = isTauri();

  return (
    <div className="fixed inset-0 z-50">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/70 backdrop-blur-[24px]" />

      {/* Titlebar drag strip — ONLY element with data-tauri-drag-region */}
      <div
        data-testid="titlebar"
        role="banner"
        data-tauri-drag-region
        className={`relative z-10 w-full bg-zinc-950/80 ${inTauri ? "h-10" : "h-8"}`}
      />

      {/* Main panel */}
      <div className="relative z-10 flex h-[calc(100%-2rem)] w-full">
        {/* Sidebar — progress indicator */}
        <aside className="w-48 shrink-0 bg-zinc-950/60 p-6 flex flex-col">
          <ProgressIndicator currentStep={currentStep} />
        </aside>

        {/* Content area */}
        <main className="flex-1 flex flex-col bg-zinc-900/40 overflow-hidden">
          {/* Step content */}
          <div className="flex-1 overflow-auto p-8">{children}</div>

          {/* Navigation buttons */}
          {(onBack !== undefined || onNext !== undefined) && (
            <div className="flex items-center justify-between px-8 py-4 border-t border-white/5">
              <button
                type="button"
                onClick={onBack}
                disabled={!canGoBack}
                className="px-5 py-2 rounded-full text-sm font-medium bg-white/5 border border-white/10 text-zinc-400 disabled:opacity-30"
              >
                Back
              </button>
              <button
                type="button"
                onClick={onNext}
                disabled={!canGoNext}
                className="px-5 py-2 rounded-full text-sm font-medium bg-white text-black disabled:opacity-30"
              >
                Next
              </button>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
