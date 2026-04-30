// 11-summary.tsx — US-018 (revised 2026-04-29)
// Final summary screen — Claude Desktop is the recommended way to open HQ;
// Claude Code (Terminal) is offered as a secondary text link.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { pingSuccess } from "../lib/telemetry";
import {
  getInstallerVersion,
  recordInstallComplete,
} from "../lib/install-manifest";

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
  const [launchingDesktop, setLaunchingDesktop] = useState(false);
  const [launchingCode, setLaunchingCode] = useState(false);
  const [pathCopied, setPathCopied] = useState(false);

  // ── Telemetry + manifest finalize on mount ──────────────────────────────
  useEffect(() => {
    if (wizardState.telemetryEnabled) {
      pingSuccess().catch(() => {});
    }
    // Mark the install complete in the manifest so agents reading the HQ tree
    // can distinguish a clean install from a partial one.
    if (wizardState.installPath) {
      (async () => {
        try {
          const v = await getInstallerVersion();
          await recordInstallComplete(wizardState.installPath as string, v);
        } catch {
          /* non-fatal */
        }
      })();
    }
  }, [wizardState.telemetryEnabled, wizardState.installPath]);

  // ── Handlers ────────────────────────────────────────────────────────────

  async function handleLaunchDesktop() {
    setLaunchError(null);
    setLaunchingDesktop(true);
    try {
      await invoke("launch_claude_desktop");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLaunchError(`Couldn't open Claude Desktop: ${msg}`);
    } finally {
      setLaunchingDesktop(false);
    }
    onLaunch?.();
  }

  async function handleLaunchClaudeCode() {
    if (!wizardState.installPath) return;
    setLaunchError(null);
    setLaunchingCode(true);
    try {
      await invoke("launch_claude_code", { path: wizardState.installPath });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLaunchError(`Couldn't open Terminal: ${msg}`);
    } finally {
      setLaunchingCode(false);
    }
    onLaunch?.();
  }

  async function handleCopyPath() {
    if (!wizardState.installPath) return;
    try {
      // Web Clipboard API works inside Tauri's webview without a plugin.
      await navigator.clipboard.writeText(wizardState.installPath);
      setPathCopied(true);
      window.setTimeout(() => setPathCopied(false), 1500);
    } catch {
      /* clipboard write failures are silent — the path is still on screen */
    }
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
            <SummaryRow label="Mode" value="Personal HQ (no company)" />
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
          <SummaryRow label="Email" value={wizardState.gitEmail ?? "—"} />
        </div>
      </div>

      {/* Open in Claude Desktop — primary CTA */}
      <div className="flex flex-col gap-3 bg-white/5 border border-white/10 rounded-xl px-4 py-4">
        <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider">
          Open in Claude Desktop
        </p>
        <ol className="flex flex-col gap-2 text-sm text-zinc-300 list-decimal list-inside">
          <li>Launch Claude Desktop.</li>
          <li>
            Open <span className="font-medium">Settings → Connectors</span> and
            add the HQ folder.
          </li>
          <li>
            When asked for the path, paste:
            <div className="mt-2 flex items-center gap-2 bg-black/30 border border-white/10 rounded-lg px-3 py-2">
              <span className="text-xs font-mono text-zinc-200 break-all flex-1">
                {wizardState.installPath ?? "—"}
              </span>
              <button
                type="button"
                onClick={handleCopyPath}
                disabled={!wizardState.installPath}
                className="text-xs px-2 py-1 rounded-md bg-white/10 text-zinc-200 hover:bg-white/20 transition-colors disabled:opacity-40"
              >
                {pathCopied ? "Copied" : "Copy"}
              </button>
            </div>
          </li>
        </ol>
        <button
          type="button"
          onClick={handleLaunchDesktop}
          disabled={launchingDesktop}
          className="self-start px-6 py-2.5 rounded-full text-sm font-medium bg-white text-black hover:bg-zinc-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {launchingDesktop ? "Opening…" : "Launch Claude Desktop"}
        </button>
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

      {/* Secondary: Claude Code in Terminal — text link */}
      <div className="flex flex-col gap-2">
        <p className="text-xs text-zinc-500">
          Prefer the terminal?{" "}
          <button
            type="button"
            onClick={handleLaunchClaudeCode}
            disabled={launchingCode || !wizardState.installPath}
            className="underline underline-offset-2 text-zinc-300 hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {launchingCode ? "Opening…" : "Open Claude Code in Terminal"}
          </button>
        </p>

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
