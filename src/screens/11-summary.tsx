// 11-summary.tsx — US-018 (revised 2026-04-29)
// Final summary screen — Claude Desktop is the recommended way to open HQ;
// Claude Code (Terminal) is offered as a secondary text link.
//
// Branching:
//   - Claude Desktop installed → "Launch Claude Desktop" + post-launch
//     instructions to point Claude Code at the HQ folder.
//   - Not installed             → CTA to download from claude.ai/download +
//     same instructions for after install.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { pingSuccess } from "../lib/telemetry";
import {
  getInstallerVersion,
  recordInstallComplete,
} from "../lib/install-manifest";

/** Anthropic-canonical install/quickstart page for Claude Desktop's Claude
 *  Code panel — has the download link AND the local-filesystem walkthrough,
 *  so a single URL serves both "I don't have Claude Desktop" and "I have it
 *  but I'm not sure how to point Claude Code at a folder" cases. */
const CLAUDE_DESKTOP_QUICKSTART_URL =
  "https://code.claude.com/docs/en/desktop-quickstart";

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
  // null while we're still probing — render a neutral placeholder until known.
  const [desktopInstalled, setDesktopInstalled] = useState<boolean | null>(null);

  // ── Telemetry + manifest finalize + Claude-installed probe on mount ─────
  useEffect(() => {
    if (wizardState.telemetryEnabled) {
      pingSuccess().catch(() => {});
    }
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
    // Probe whether Claude Desktop is installed so we can render the right
    // CTA. Default to "not installed" on probe failure — the download link is
    // a safe fallback if the check itself errors.
    (async () => {
      try {
        const present = await invoke<boolean>("claude_desktop_installed");
        setDesktopInstalled(present);
      } catch {
        setDesktopInstalled(false);
      }
    })();
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
      // If the failure is because Claude Desktop isn't installed, flip the
      // UI to the download CTA so the user has a clear next step.
      if (/Unable to find application/i.test(msg)) {
        setDesktopInstalled(false);
      }
    } finally {
      setLaunchingDesktop(false);
    }
    onLaunch?.();
  }

  async function handleDownloadClaude() {
    setLaunchError(null);
    try {
      await openExternal(CLAUDE_DESKTOP_QUICKSTART_URL);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLaunchError(`Couldn't open download page: ${msg}`);
    }
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
            Open <span className="font-medium">Claude Code</span>, choose the
            local filesystem, and select your HQ folder:
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

        {/* Action — branches on whether Claude Desktop is on disk. */}
        {desktopInstalled === true && (
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={handleLaunchDesktop}
              disabled={launchingDesktop}
              className="self-start px-6 py-2.5 rounded-full text-sm font-medium bg-white text-black hover:bg-zinc-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {launchingDesktop ? "Opening…" : "Launch Claude Desktop"}
            </button>
            {/* Discreet quickstart link — surfaces the docs page even when
                Claude Desktop is already installed, so users sharing the
                machine (or this URL) always have a path to "what do I do
                next?". */}
            <p className="text-xs text-zinc-500">
              Need help?{" "}
              <button
                type="button"
                onClick={handleDownloadClaude}
                className="underline underline-offset-2 text-zinc-400 hover:text-white transition-colors"
              >
                Claude Desktop quickstart
              </button>
            </p>
          </div>
        )}

        {desktopInstalled === false && (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-zinc-400">
              Don't have Claude Desktop yet?
            </p>
            <button
              type="button"
              onClick={handleDownloadClaude}
              className="self-start px-6 py-2.5 rounded-full text-sm font-medium bg-white text-black hover:bg-zinc-100 transition-colors"
            >
              Download Claude Desktop
            </button>
          </div>
        )}

        {desktopInstalled === null && (
          <div className="self-start px-6 py-2.5 rounded-full text-sm font-medium bg-white/10 text-zinc-500">
            Checking for Claude Desktop…
          </div>
        )}
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
