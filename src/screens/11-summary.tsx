// 11-summary.tsx — US-018
// Final summary screen — shows what was installed and launches Claude Code.

import { useEffect } from "react";
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
  // ── Telemetry ping on mount ─────────────────────────────────────────────
  useEffect(() => {
    if (wizardState.telemetryEnabled) {
      pingSuccess().catch(() => {});
    }
  }, [wizardState.telemetryEnabled]);

  // ── Launch handler ──────────────────────────────────────────────────────
  async function handleLaunch() {
    if (wizardState.installPath) {
      await invoke("launch_claude_code", { path: wizardState.installPath }).catch(() => {});
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
          Use <code className="text-zinc-400">hq sync push</code> to upload local changes and{" "}
          <code className="text-zinc-400">hq sync pull</code> to fetch updates from the cloud.
        </p>
      </div>

      {/* Launch button */}
      <div className="flex gap-3">
        <button
          type="button"
          onClick={handleLaunch}
          className="px-6 py-2.5 rounded-full text-sm font-medium bg-white text-black hover:bg-zinc-100 transition-colors"
        >
          Open HQ in Claude Code
        </button>
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
