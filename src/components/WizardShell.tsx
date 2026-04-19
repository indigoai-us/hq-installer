// WizardShell.tsx — US-012
// Full-page wizard overlay — zinc monochrome, Tauri-aware.
// Navigation lives in the sidebar (clickable ProgressIndicator items);
// there is no bottom Back/Next bar — each screen owns its own forward CTA.

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
        {/* Sidebar — progress indicator doubles as nav */}
        <aside className="w-48 shrink-0 bg-zinc-950/60 p-6 flex flex-col">
          <ProgressIndicator
            currentStep={currentStep}
            maxReachedStep={maxReachedStep}
            canNavigateTo={canNavigateTo}
            onStepClick={onStepClick}
          />
        </aside>

        {/* Content area — screens own their own forward CTA */}
        <main className="flex-1 flex flex-col bg-zinc-900/40 overflow-hidden">
          <div className="flex-1 overflow-auto p-8">{children}</div>
        </main>
      </div>
    </div>
  );
}
