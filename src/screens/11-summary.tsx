// 11-summary.tsx — US-018 (revised 2026-04-29)
// Final summary screen — supported AI coding tools gate the launch CTA.
// Claude Desktop is preferred when present; otherwise Claude Code (Terminal)
// is offered as the launch path.
//
// Branching:
//   - Any supported AI tool installed → launch CTA.
//   - None installed                  → download Claude + subscription note,
//     polling until a tool appears.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { WizardFooterSlot } from "@/components/WizardFooter";
import { pingSuccess } from "../lib/telemetry";
import {
  getInstallerVersion,
  readManifest,
  recordInstallComplete,
  type FailureRecord,
} from "../lib/install-manifest";
import {
  readInstallerImportBreadcrumb,
  type InstallerImportBreadcrumb,
} from "../lib/import-existing";

/** Anthropic-canonical install/quickstart page for Claude Desktop's Claude
 *  Code panel — has the download link AND the local-filesystem walkthrough,
 *  so a single URL serves both "I don't have Claude Desktop" and "I have it
 *  but I'm not sure how to point Claude Code at a folder" cases. */
const CLAUDE_DESKTOP_QUICKSTART_URL =
  "https://code.claude.com/docs/en/desktop-quickstart";

const AI_TOOLS_POLL_MS = 3000;

interface AiTools {
  claude_cli: boolean;
  claude_desktop: boolean;
  codex_cli: boolean;
  codex_desktop: boolean;
  grok_cli: boolean;
  any: boolean;
}

const NO_AI_TOOLS: AiTools = {
  claude_cli: false,
  claude_desktop: false,
  codex_cli: false,
  codex_desktop: false,
  grok_cli: false,
  any: false,
};

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
  const [importPromptCopied, setImportPromptCopied] = useState(false);
  const [installerImport, setInstallerImport] =
    useState<InstallerImportBreadcrumb | null>(null);
  const [setupFailures, setSetupFailures] = useState<FailureRecord[]>([]);
  const detectorMountedRef = useRef(false);
  const detectorProbeInFlightRef = useRef(false);
  // null while we're still probing — render a neutral placeholder until known.
  const [aiTools, setAiTools] = useState<AiTools | null>(null);

  const probeAiTools = useCallback(async () => {
    if (detectorProbeInFlightRef.current) return;
    detectorProbeInFlightRef.current = true;
    try {
      const tools = await invoke<AiTools>("check_ai_tools");
      if (detectorMountedRef.current) {
        setAiTools(tools);
      }
    } catch {
      if (detectorMountedRef.current) {
        setAiTools(NO_AI_TOOLS);
      }
    } finally {
      detectorProbeInFlightRef.current = false;
    }
  }, []);

  // ── Telemetry + manifest finalize on mount ──────────────────────────────
  useEffect(() => {
    if (wizardState.installPath) {
      (async () => {
        try {
          const v = await getInstallerVersion();
          if (wizardState.telemetryEnabled) {
            pingSuccess(v).catch(() => {});
          }
          await recordInstallComplete(wizardState.installPath as string, v);
          const manifest = await readManifest(wizardState.installPath as string, v);
          setSetupFailures(manifest.failures);
        } catch {
          /* non-fatal */
        }
        try {
          const breadcrumb = await readInstallerImportBreadcrumb(
            wizardState.installPath as string,
          );
          setInstallerImport(breadcrumb);
        } catch {
          setInstallerImport(null);
        }
      })();
    } else if (wizardState.telemetryEnabled) {
      getInstallerVersion()
        .then((v) => pingSuccess(v))
        .catch(() => {});
      setInstallerImport(null);
      setSetupFailures([]);
    } else {
      setInstallerImport(null);
      setSetupFailures([]);
    }
  }, [wizardState.telemetryEnabled, wizardState.installPath]);

  // ── Supported AI tool detection + polling while absent ──────────────────
  useEffect(() => {
    detectorMountedRef.current = true;
    void probeAiTools();
    return () => {
      detectorMountedRef.current = false;
    };
  }, [probeAiTools]);

  useEffect(() => {
    if (aiTools?.any !== false) return;
    const intervalId = window.setInterval(() => {
      void probeAiTools();
    }, AI_TOOLS_POLL_MS);
    return () => window.clearInterval(intervalId);
  }, [aiTools?.any, probeAiTools]);

  // ── Handlers ────────────────────────────────────────────────────────────

  async function handleLaunchDesktop() {
    setLaunchError(null);
    setLaunchingDesktop(true);
    try {
      // Deep-link straight into a new Claude Code session pointed at the
      // freshly-installed HQ folder, with `/setup` prefilled so the user
      // lands in the onboarding flow instead of an empty prompt. Claude
      // Desktop is the registered handler for `claude://` on macOS.
      const params = new URLSearchParams({ q: "/setup" });
      if (wizardState.installPath) params.set("folder", wizardState.installPath);
      const url = `claude://code/new?${params.toString()}`;
      await invoke("open_claude_code_link", { url });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLaunchError(`Couldn't open Claude Desktop: ${msg}`);
      // If the failure is because Claude Desktop isn't installed, flip the
      // UI to the download CTA so the user has a clear next step.
      if (/Unable to find application/i.test(msg)) {
        setAiTools((previous) => {
          const base = previous ?? NO_AI_TOOLS;
          const next = { ...base, claude_desktop: false };
          return {
            ...next,
            any:
              next.claude_cli ||
              next.codex_cli ||
              next.codex_desktop ||
              next.grok_cli,
          };
        });
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
    await copyText(wizardState.installPath, setPathCopied);
  }

  async function handleCopyImportPrompt() {
    await copyText("/import-claude", setImportPromptCopied);
  }

  async function copyText(
    text: string,
    setCopied: (value: boolean) => void,
  ) {
    try {
      // Web Clipboard API works inside Tauri's webview without a plugin.
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard write failures are silent — the value is still on screen */
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────
  const showClaudeImportCard =
    typeof installerImport?.totalClaudeArtifacts === "number" &&
    installerImport.totalClaudeArtifacts > 0;
  const aiToolsDetected = aiTools?.any === true;
  const claudeDesktopAvailable = aiTools?.claude_desktop === true;

  return (
    <div className="flex flex-col gap-6 max-w-lg">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-medium text-white">HQ is ready</h1>
        <p className="text-sm font-light text-zinc-400">
          Your workspace is installed and synced — open it with a supported AI
          coding tool to get started.
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

      {setupFailures.length > 0 && (
        <div className="flex flex-col gap-3 bg-white/5 border border-white/10 rounded-xl px-4 py-4">
          <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider">
            Needs attention
          </p>
          <p className="text-sm text-zinc-300">
            Setup reached Done, but a few steps need another pass. Open HQ and
            the assistant can finish them from inside your workspace.
          </p>
          <ul className="flex flex-col gap-1 text-xs text-zinc-500">
            {setupFailures.map((failure, index) => (
              <li key={`${failure.stage}-${failure.ts}-${index}`}>
                <span className="text-zinc-300">{failure.stage}</span>:{" "}
                {failure.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Open HQ — primary CTA */}
      <div className="flex flex-col gap-3 bg-white/5 border border-white/10 rounded-xl px-4 py-4">
        <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider">
          Open HQ
        </p>

        {aiTools === null && (
          <p className="text-sm text-zinc-300">
            Checking for a supported AI coding tool…
          </p>
        )}

        {aiTools?.any === false && (
          <p className="text-sm text-zinc-300">
            No supported AI tool detected. Download Claude below; this screen
            will update automatically after a tool is installed.
          </p>
        )}

        {aiToolsDetected && claudeDesktopAvailable && (
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
        )}

        {aiToolsDetected && !claudeDesktopAvailable && (
          <div className="flex flex-col gap-2 text-sm text-zinc-300">
            <p>Open Claude Code in Terminal from your HQ folder:</p>
            <div className="flex items-center gap-2 bg-black/30 border border-white/10 rounded-lg px-3 py-2">
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
          </div>
        )}

        {claudeDesktopAvailable && (
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

      {showClaudeImportCard && installerImport && (
        <div className="flex flex-col gap-3 bg-white/5 border border-white/10 rounded-xl px-4 py-4">
          <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider">
            Finish importing your Claude setup
          </p>
          <p className="text-sm text-zinc-300">
            We found {installerImport.totalClaudeArtifacts} Claude artifact
            {installerImport.totalClaudeArtifacts === 1 ? "" : "s"}.{" "}
            {installerImport.codexApplied
              ? "Codex parity was applied automatically."
              : "Codex parity could not be applied automatically during install."}
          </p>
          <div className="flex items-center gap-2 bg-black/30 border border-white/10 rounded-lg px-3 py-2">
            <span className="text-xs font-mono text-zinc-200 break-all flex-1">
              /import-claude
            </span>
            <button
              type="button"
              onClick={handleCopyImportPrompt}
              className="text-xs px-2 py-1 rounded-md bg-white/10 text-zinc-200 hover:bg-white/20 transition-colors"
            >
              {importPromptCopied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="text-xs text-zinc-500">
            Run this in Claude Code inside your HQ folder to bring over
            commands, skills, hooks, and policies, then infer the rest of the
            Claude setup from the redacted scan.
          </p>
        </div>
      )}

      {aiToolsDetected && claudeDesktopAvailable && (
        /* Secondary: Claude Code in Terminal — text link */
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
      )}

      {launchError && (
        <div
          role="alert"
          className="text-xs text-zinc-400 bg-white/5 border border-white/10 rounded-xl px-3 py-2"
        >
          {launchError}
        </div>
      )}

      <WizardFooterSlot>
        {aiToolsDetected && claudeDesktopAvailable && (
          <button
            type="button"
            onClick={handleLaunchDesktop}
            disabled={launchingDesktop}
            className="px-6 py-2.5 rounded-full text-sm font-medium bg-white text-black hover:bg-zinc-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {launchingDesktop ? "Opening…" : "Launch Claude Desktop"}
          </button>
        )}
        {aiToolsDetected && !claudeDesktopAvailable && (
          <button
            type="button"
            onClick={handleLaunchClaudeCode}
            disabled={launchingCode || !wizardState.installPath}
            className="px-6 py-2.5 rounded-full text-sm font-medium bg-white text-black hover:bg-zinc-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {launchingCode ? "Opening…" : "Open Claude Code in Terminal"}
          </button>
        )}
        {aiTools?.any === false && (
          <div className="flex flex-col items-end gap-2">
            <button
              type="button"
              onClick={handleDownloadClaude}
              className="px-6 py-2.5 rounded-full text-sm font-medium bg-white text-black hover:bg-zinc-100 transition-colors"
            >
              Download Claude
            </button>
            <p className="text-xs text-zinc-400">
              A Claude subscription is required to use HQ.
            </p>
          </div>
        )}
        {aiTools === null && (
          <div className="px-6 py-2.5 rounded-full text-sm font-medium bg-white/10 text-zinc-500">
            Checking…
          </div>
        )}
      </WizardFooterSlot>
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
