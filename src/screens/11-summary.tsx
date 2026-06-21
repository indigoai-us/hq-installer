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
import { invokeWithTimeout } from "@/lib/invoke-timeout";
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
const AI_TOOLS_TIMEOUT_MS = 10_000;

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
  const [commandCopied, setCommandCopied] = useState(false);
  const [importPromptCopied, setImportPromptCopied] = useState(false);
  const [revealingFolder, setRevealingFolder] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);
  const [detectionFailed, setDetectionFailed] = useState(false);
  const [resolvedInstallPath, setResolvedInstallPath] = useState<string | null>(
    wizardState.installPath,
  );
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
      const tools = await invokeWithTimeout<AiTools>(
        "check_ai_tools",
        undefined,
        AI_TOOLS_TIMEOUT_MS,
      );
      if (detectorMountedRef.current) {
        setDetectionFailed(false);
        setAiTools(tools);
      }
    } catch {
      if (detectorMountedRef.current) {
        setDetectionFailed(true);
        setAiTools(NO_AI_TOOLS);
      }
    } finally {
      detectorProbeInFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (wizardState.installPath) {
      setResolvedInstallPath(wizardState.installPath);
      return;
    }

    let cancelled = false;
    (async () => {
      let fallbackPath = "~/hq";
      try {
        const home = await invoke<string>("home_dir");
        fallbackPath = `${home.replace(/[\\/]+$/, "")}/hq`;
        const v = await getInstallerVersion();
        const manifest = await readManifest(fallbackPath, v);
        if (!cancelled) {
          setResolvedInstallPath(manifest.installPath || fallbackPath);
        }
      } catch {
        if (!cancelled) {
          setResolvedInstallPath(fallbackPath);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [wizardState.installPath]);

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
      if (resolvedInstallPath) params.set("folder", resolvedInstallPath);
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
    if (!resolvedInstallPath) return;
    setLaunchError(null);
    setLaunchingCode(true);
    try {
      await invoke("launch_claude_code", { path: resolvedInstallPath });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLaunchError(`Couldn't open Terminal: ${msg}`);
    } finally {
      setLaunchingCode(false);
    }
    onLaunch?.();
  }

  async function handleCopyPath() {
    if (!resolvedInstallPath) return;
    await copyText(resolvedInstallPath, setPathCopied);
  }

  async function handleCopyCommand() {
    const command = openCommandFor(resolvedInstallPath, aiTools);
    await copyText(command, setCommandCopied);
  }

  async function handleRevealFolder() {
    const path = resolvedInstallPath ?? "~/hq";
    setRevealError(null);
    setRevealingFolder(true);
    try {
      await invoke("reveal_folder", { path });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setRevealError(`Couldn't reveal HQ folder: ${msg}`);
    } finally {
      setRevealingFolder(false);
    }
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
  const claudeCliAvailable = aiTools?.claude_cli === true;
  const primaryCliTool = primaryCli(aiTools);
  const nonClaudeToolName = primaryNonClaudeToolName(aiTools);
  const manualCommand = openCommandFor(resolvedInstallPath, aiTools);
  const displayInstallPath = resolvedInstallPath ?? "~/hq";

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
            value={displayInstallPath}
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

        <div className="flex flex-col gap-3 rounded-lg border border-white/10 bg-black/30 px-3 py-3">
          <div className="flex flex-col gap-1">
            <p className="text-xs text-zinc-500">HQ folder</p>
            <p className="select-all text-xs font-mono text-zinc-200 break-all">
              {displayInstallPath}
            </p>
            {!wizardState.installPath && (
              <p className="text-xs text-zinc-500">
                The saved install path was not available, so this screen is
                using the default HQ folder.
              </p>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <p className="text-xs text-zinc-500">Ready-to-run command</p>
            <p className="select-all text-xs font-mono text-zinc-200 break-all">
              {manualCommand}
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={handleCopyCommand}
                className="text-xs px-3 py-1.5 rounded-full bg-white/10 text-zinc-100 hover:bg-white/20 transition-colors"
              >
                {commandCopied ? "Copied" : "Copy command"}
              </button>
              <button
                type="button"
                onClick={handleRevealFolder}
                disabled={revealingFolder}
                className="text-xs px-3 py-1.5 rounded-full bg-white/10 text-zinc-100 hover:bg-white/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {revealingFolder ? "Revealing…" : "Reveal in Finder"}
              </button>
            </div>
          </div>
        </div>

        {aiTools?.any === false && (
          <p className="text-sm text-zinc-300">
            {detectionFailed
              ? "We couldn't verify installed AI tools. Use the folder and command above to open HQ manually."
              : "No supported AI tool detected. Use the folder and command above, or download Claude below."}
          </p>
        )}

        {aiTools === null && (
          <p className="text-sm text-zinc-300">
            Checking for a supported AI coding tool. The manual path above is
            ready if detection takes too long.
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
                  {displayInstallPath}
                </span>
                <button
                  type="button"
                  onClick={handleCopyPath}
                  disabled={!resolvedInstallPath}
                  className="text-xs px-2 py-1 rounded-md bg-white/10 text-zinc-200 hover:bg-white/20 transition-colors disabled:opacity-40"
                >
                  {pathCopied ? "Copied" : "Copy"}
                </button>
              </div>
            </li>
          </ol>
        )}

        {aiToolsDetected && !claudeDesktopAvailable && claudeCliAvailable && (
          <div className="flex flex-col gap-2 text-sm text-zinc-300">
            <p>Open Claude Code in Terminal from your HQ folder:</p>
            <div className="flex items-center gap-2 bg-black/30 border border-white/10 rounded-lg px-3 py-2">
              <span className="text-xs font-mono text-zinc-200 break-all flex-1">
                {displayInstallPath}
              </span>
              <button
                type="button"
                onClick={handleCopyPath}
                disabled={!resolvedInstallPath}
                className="text-xs px-2 py-1 rounded-md bg-white/10 text-zinc-200 hover:bg-white/20 transition-colors disabled:opacity-40"
              >
                {pathCopied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
        )}

        {aiToolsDetected && !claudeDesktopAvailable && !claudeCliAvailable && (
          <p className="text-sm text-zinc-300">
            {nonClaudeToolName
              ? `${nonClaudeToolName} is installed. Copy the command above and run it in Terminal from your HQ folder.`
              : "A supported AI tool is installed. Use the folder and command above to open HQ."}
          </p>
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
            disabled={launchingCode || !resolvedInstallPath}
            className="underline underline-offset-2 text-zinc-300 hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {launchingCode ? "Opening…" : "Open Claude Code in Terminal"}
          </button>
        </p>
      )}

      {(launchError || revealError) && (
        <div
          role="alert"
          className="text-xs text-zinc-400 bg-white/5 border border-white/10 rounded-xl px-3 py-2"
        >
          {launchError ?? revealError}
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
          claudeCliAvailable ? (
            <button
              type="button"
              onClick={handleLaunchClaudeCode}
              disabled={launchingCode || !resolvedInstallPath}
              className="px-6 py-2.5 rounded-full text-sm font-medium bg-white text-black hover:bg-zinc-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {launchingCode ? "Opening…" : "Open Claude Code in Terminal"}
            </button>
          ) : (
            <button
              type="button"
              onClick={handleCopyCommand}
              className="px-6 py-2.5 rounded-full text-sm font-medium bg-white text-black hover:bg-zinc-100 transition-colors"
            >
              {commandCopied
                ? "Copied"
                : primaryCliTool
                  ? `Copy ${toolDisplayName(primaryCliTool)} command`
                  : "Copy command"}
            </button>
          )
        )}
        {aiTools?.any === false && (
          <div className="flex flex-col items-end gap-2">
            <button
              type="button"
              onClick={handleCopyCommand}
              className="px-6 py-2.5 rounded-full text-sm font-medium bg-white text-black hover:bg-zinc-100 transition-colors"
            >
              {commandCopied ? "Copied" : "Copy command"}
            </button>
            <button
              type="button"
              onClick={handleDownloadClaude}
              className="text-xs text-zinc-400 underline underline-offset-2 hover:text-white transition-colors"
            >
              Download Claude
            </button>
          </div>
        )}
        {aiTools === null && (
          <button
            type="button"
            onClick={handleCopyCommand}
            className="px-6 py-2.5 rounded-full text-sm font-medium bg-white text-black hover:bg-zinc-100 transition-colors"
          >
            {commandCopied ? "Copied" : "Copy command"}
          </button>
        )}
      </WizardFooterSlot>
    </div>
  );
}

function primaryCli(tools: AiTools | null): "claude" | "codex" | "grok" | null {
  if (!tools) return null;
  if (tools.claude_cli) return "claude";
  if (tools.codex_cli) return "codex";
  if (tools.grok_cli) return "grok";
  return null;
}

function primaryNonClaudeToolName(tools: AiTools | null): string | null {
  if (!tools) return null;
  if (tools.codex_cli) return "Codex CLI";
  if (tools.codex_desktop) return "Codex Desktop";
  if (tools.grok_cli) return "Grok CLI";
  return null;
}

function toolDisplayName(tool: "claude" | "codex" | "grok"): string {
  if (tool === "claude") return "Claude";
  if (tool === "codex") return "Codex";
  return "Grok";
}

function quoteForShell(value: string): string {
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

function openCommandFor(path: string | null, tools: AiTools | null): string {
  const installPath = path ?? "~/hq";
  const cli = primaryCli(tools);
  if (cli) {
    return `cd ${quoteForShell(installPath)} && ${cli}`;
  }
  return `open ${quoteForShell(installPath)}`;
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
