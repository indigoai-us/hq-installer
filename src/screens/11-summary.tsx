// 11-summary.tsx — US-018 + US-019
// Final summary screen — shows what was installed and routes the user into
// Claude. Primary CTA prefers the Claude desktop app (install if missing,
// update if too old, open via deep link if ready). Secondary CTA keeps the
// existing Terminal path, now with `--prefill '/setup'` on the `claude` CLI
// so both paths land the user one keystroke away from running setup.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { pingSuccess } from "../lib/telemetry";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DesktopStatus =
  | { status: "ready"; version: string }
  | { status: "not-installed" }
  | { status: "version-too-old"; version: string; required: string };

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

const POLL_INTERVAL_MS = 2000;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Summary({ wizardState, onLaunch }: SummaryProps) {
  const [desktop, setDesktop] = useState<DesktopStatus | null>(null);
  const [launching, setLaunching] = useState<"desktop" | "terminal" | null>(null);
  const [desktopError, setDesktopError] = useState<string | null>(null);
  const [terminalError, setTerminalError] = useState<string | null>(null);

  // ── Telemetry ping on mount ─────────────────────────────────────────────
  useEffect(() => {
    if (wizardState.telemetryEnabled) {
      pingSuccess().catch(() => {});
    }
  }, [wizardState.telemetryEnabled]);

  // ── Detect + poll Claude desktop ────────────────────────────────────────
  const detect = useCallback(async () => {
    try {
      const result = await invoke<DesktopStatus>("detect_claude_desktop");
      setDesktop(result);
      return result;
    } catch {
      // Treat detection failure as not-installed so the user can still
      // reach the download flow rather than being stuck on a blank CTA.
      const fallback: DesktopStatus = { status: "not-installed" };
      setDesktop(fallback);
      return fallback;
    }
  }, []);

  useEffect(() => {
    detect();
  }, [detect]);

  // Poll every 2s while the user isn't on `ready` yet — covers the
  // download → install → return-to-installer loop without requiring the
  // user to manually refresh after they finish the DMG.
  const pollHandle = useRef<number | null>(null);
  useEffect(() => {
    if (desktop && desktop.status === "ready") {
      if (pollHandle.current !== null) {
        clearInterval(pollHandle.current);
        pollHandle.current = null;
      }
      return;
    }
    if (pollHandle.current !== null) return;
    pollHandle.current = window.setInterval(detect, POLL_INTERVAL_MS);
    return () => {
      if (pollHandle.current !== null) {
        clearInterval(pollHandle.current);
        pollHandle.current = null;
      }
    };
  }, [desktop, detect]);

  // ── Handlers ────────────────────────────────────────────────────────────
  async function handleDesktop() {
    setDesktopError(null);
    if (!desktop) return;
    if (!wizardState.installPath && desktop.status === "ready") return;

    if (desktop.status === "ready" && wizardState.installPath) {
      setLaunching("desktop");
      try {
        await invoke("launch_claude_desktop", { path: wizardState.installPath });
      } catch (err) {
        setDesktopError(
          `Couldn't open Claude: ${err instanceof Error ? err.message : String(err)}`
        );
        setLaunching(null);
        return;
      }
      setLaunching(null);
      onLaunch?.();
      return;
    }

    // not-installed OR version-too-old → send the user to the DMG URL.
    setLaunching("desktop");
    try {
      await invoke("open_claude_download");
    } catch (err) {
      setDesktopError(
        `Couldn't open the download page: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
    setLaunching(null);
  }

  async function handleTerminal() {
    setTerminalError(null);
    if (!wizardState.installPath) return;
    setLaunching("terminal");
    try {
      await invoke("launch_claude_code", { path: wizardState.installPath });
    } catch (err) {
      setTerminalError(
        `Couldn't open Terminal: ${err instanceof Error ? err.message : String(err)}`
      );
      setLaunching(null);
      return;
    }
    setLaunching(null);
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

      {/* Launch actions */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-3">
          <DesktopCta
            desktop={desktop}
            launching={launching === "desktop"}
            onClick={handleDesktop}
          />
          <InstructionCard />
          {desktopError && <ErrorBanner message={desktopError} />}

          <button
            type="button"
            onClick={handleTerminal}
            disabled={launching !== null}
            className="self-start text-xs text-zinc-500 hover:text-zinc-300 underline underline-offset-4 decoration-zinc-700 hover:decoration-zinc-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {launching === "terminal" ? "Opening Terminal…" : "Or open in Terminal"}
          </button>
          {terminalError && <ErrorBanner message={terminalError} />}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DesktopCta — renders the primary button based on detection status.
// ---------------------------------------------------------------------------

function DesktopCta({
  desktop,
  launching,
  onClick,
}: {
  desktop: DesktopStatus | null;
  launching: boolean;
  onClick: () => void;
}) {
  const baseBtn =
    "px-6 py-2.5 rounded-full text-sm font-medium bg-white text-black hover:bg-zinc-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed";

  // Detection hasn't returned yet — render a placeholder so the screen
  // doesn't jump height when the status resolves.
  if (!desktop) {
    return (
      <button type="button" disabled className={baseBtn}>
        Checking Claude…
      </button>
    );
  }

  if (desktop.status === "ready") {
    return (
      <div className="flex flex-col gap-1.5">
        <button
          type="button"
          onClick={onClick}
          disabled={launching}
          className={`${baseBtn} self-start`}
        >
          {launching ? "Opening…" : "Open HQ in Claude"}
        </button>
        <p className="text-xs text-zinc-500">
          Claude for Desktop · v{desktop.version}
        </p>
      </div>
    );
  }

  if (desktop.status === "version-too-old") {
    return (
      <div className="flex flex-col gap-1.5">
        <button
          type="button"
          onClick={onClick}
          disabled={launching}
          className={`${baseBtn} self-start`}
        >
          {launching ? "Opening download…" : "Update Claude"}
        </button>
        <p className="text-xs text-zinc-500">
          Installed: v{desktop.version} · Required: v{desktop.required}
        </p>
      </div>
    );
  }

  // not-installed
  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={onClick}
        disabled={launching}
        className={`${baseBtn} self-start`}
      >
        {launching ? "Opening download…" : "Download Claude"}
      </button>
      <p className="text-xs text-zinc-500">
        After installing, return here — we'll detect Claude automatically.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// InstructionCard — tells the user what to type once Claude opens.
// ---------------------------------------------------------------------------

function InstructionCard() {
  return (
    <div className="bg-white/5 border border-white/10 rounded-xl px-3 py-2.5">
      <p className="text-xs text-zinc-400">
        Once Claude opens, type{" "}
        <code className="font-mono text-zinc-200 bg-white/10 rounded px-1 py-0.5">
          /setup
        </code>{" "}
        to begin.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ErrorBanner
// ---------------------------------------------------------------------------

function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="text-xs text-red-400 bg-red-400/10 border border-red-400/20 rounded-xl px-3 py-2"
    >
      {message}
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
