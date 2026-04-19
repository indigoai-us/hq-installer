// 01-welcome.tsx — US-013
// Welcome screen — product identity, wizard overview, telemetry opt-in

import React, { useState } from "react";

interface WelcomeScreenProps {
  onNext?: () => void;
  telemetryEnabled?: boolean;
  onTelemetryChange?: (enabled: boolean) => void;
}

export function Welcome({
  onNext,
  telemetryEnabled,
  onTelemetryChange,
}: WelcomeScreenProps) {
  const [localTelemetry, setLocalTelemetry] = useState(
    telemetryEnabled !== undefined ? telemetryEnabled : true
  );

  const isControlled = telemetryEnabled !== undefined;
  const telemetryChecked = isControlled ? telemetryEnabled : localTelemetry;

  function handleTelemetryChange(e: React.ChangeEvent<HTMLInputElement>) {
    const next = e.target.checked;
    if (!isControlled) {
      setLocalTelemetry(next);
    }
    onTelemetryChange?.(next);
  }

  return (
    <div className="flex flex-col gap-8 max-w-xl">
      {/* Product identity */}
      <div className="flex flex-col gap-3">
        <h1 className="text-3xl font-medium text-white">Set up HQ</h1>
        <p className="font-light text-zinc-300 leading-relaxed">
          Open-source AI dev team for Claude Code. 45 AI workers, 60+ skills,
          and an orchestrator that ships code autonomously.
        </p>
        <p className="font-light text-zinc-400 text-sm">
          Run <code className="font-mono text-zinc-200">npx create-hq</code> to get started
        </p>
      </div>

      {/* Telemetry opt-in */}
      <label className="flex items-center gap-3 cursor-pointer select-none group">
        <span className="relative inline-flex items-center justify-center w-4 h-4 shrink-0">
          <input
            type="checkbox"
            checked={telemetryChecked}
            onChange={handleTelemetryChange}
            className="peer appearance-none w-4 h-4 rounded-[3px] border border-white/25 bg-white/5 group-hover:border-white/40 checked:bg-white checked:border-white transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-white/30"
          />
          <svg
            aria-hidden="true"
            viewBox="0 0 12 12"
            className="pointer-events-none absolute w-3 h-3 opacity-0 peer-checked:opacity-100 text-black transition-opacity"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.25"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="2.5,6.5 5,9 9.5,3.5" />
          </svg>
        </span>
        <span className="font-light text-zinc-300 text-sm">
          Help improve HQ by sharing anonymous usage telemetry
        </span>
      </label>

      {/* Primary action */}
      <div>
        <button
          type="button"
          onClick={onNext}
          className="px-6 py-2.5 rounded-full text-sm font-medium bg-white text-black hover:bg-zinc-100 transition-colors"
        >
          Get Started
        </button>
      </div>
    </div>
  );
}
