// 11-summary.tsx — US-018
// Final summary screen — shows what was installed and launches Claude Code.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { pingSuccess } from "../lib/telemetry";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface SummaryProps {
  wizardState: {
    installPath: string | null;
    team: { name: string; slug: string } | null;
    isPersonal?: boolean;
    gitEmail: string | null;
    telemetryEnabled: boolean;
  };
  onLaunch?: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Summary({ wizardState, onLaunch }: SummaryProps) {
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);

  // ── Telemetry ping on mount ─────────────────────────────────────────────
  useEffect(() => {
    if (wizardState.telemetryEnabled) {
      pingSuccess().catch(() => {});
    }
  }, [wizardState.telemetryEnabled]);

  // ── Launch handler ──────────────────────────────────────────────────────
  // Previously errors here were silently swallowed with .catch(() => {}),
  // so when the backing Rust command didn't exist the button appeared to do
  // nothing. Now we surface the error and still invoke onLaunch so the
  // parent wizard can respond (e.g. close the installer) either way.
  async function handleLaunch() {
    setLaunchError(null);
    if (wizardState.installPath) {
      setLaunching(true);
      try {
        await invoke("launch_claude_code", { path: wizardState.installPath });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setLaunchError(`Couldn't open Terminal: ${msg}`);
        setLaunching(false);
        return;
      }
      setLaunching(false);
    }
    onLaunch?.();
  }

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-6 max-w-lg">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-medium text-white">HQ is ready</h1>
        <p className="text-sm font-light text-zinc-400">
          Your personal operating system has been installed, synced, and indexed.
        </p>
      </div>

      {/* Summary card */}
      <div className="flex flex-col gap-4 bg-white/5 border border-white/10 rounded-xl px-4 py-4">
        <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider">
          Installation summary
        </p>

        <div className="flex flex-col gap-3">
          <SummaryRow
            label="Install path"
            value={wizardState.installPath ?? "—"}
            mono
          />
          {wizardState.isPersonal && !wizardState.team ? (
            <SummaryRow
              label="Mode"
              value="Personal HQ (no company)"
            />
          ) : (
            <>
              <SummaryRow
                label="Team name"
                value={wizardState.team?.name ?? "—"}
              />
              <SummaryRow
                label="Team slug"
                value={wizardState.team?.slug ?? "—"}
                mono
              />
            </>
          )}
          <SummaryRow
            label="Email"
            value={wizardState.gitEmail ?? "—"}
          />
        </div>
      </div>

      {/* Sync next steps */}
      <div className="bg-white/5 border border-white/10 rounded-xl px-4 py-3">
        <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2">
          Keep in sync
        </p>
        <p className="text-xs text-zinc-500">
          HQ will keep your workspace in sync with the cloud automatically — no
          extra commands needed.
        </p>
      </div>

      {/* Launch button */}
      <div className="flex flex-col gap-3">
        <div className="flex gap-3">
          <button
            type="button"
            onClick={handleLaunch}
            disabled={launching}
            className="px-6 py-2.5 rounded-full text-sm font-medium bg-white text-black hover:bg-zinc-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {launching ? "Opening…" : "Open HQ in Claude Code"}
          </button>
        </div>
        {launchError && (
          <div
            role="alert"
            className="text-xs text-red-400 bg-red-400/10 border border-red-400/20 rounded-xl px-3 py-2"
          >
            {launchError}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SummaryRow
// ---------------------------------------------------------------------------

interface SummaryRowProps {
  label: string;
  value: string;
  mono?: boolean;
}

function SummaryRow({ label, value, mono = false }: SummaryRowProps) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-zinc-500">{label}</span>
      <span
        className={`text-sm text-zinc-200 break-all ${mono ? "font-mono" : ""}`}
      >
        {value}
      </span>
    </div>
  );
}
