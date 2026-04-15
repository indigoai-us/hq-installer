/**
 * Success route (US-009) — the final screen of the installer.
 *
 * Shows a summary of what was installed and gives the user three ways
 * to start using HQ:
 *   1. Primary CTA "Open in Claude Code" → launches `claude` in the HQ dir
 *   2. Secondary CTA "Reveal in Finder/Explorer" → opens the HQ dir in
 *      the system file manager
 *   3. Tertiary link "Read the USER-GUIDE" → opens the guide URL in the
 *      system browser
 *
 * On first mount, we:
 *   - fire the `install.completed` analytics event with anonymous id +
 *     duration_seconds
 *   - render a confetti overlay that auto-dismisses when the animation
 *     finishes
 *
 * If `claude` isn't on PATH (LaunchErrorKind.NotFound), we fall back to
 * showing a copyable `cd /path/to/hq && claude` command string instead
 * of a raw error — keeps the user moving forward even if dep detection
 * lied about Claude Code being installed.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { open as openShellPath } from "@tauri-apps/plugin-shell";
import {
  launchClaudeCode,
  revealInFileManager,
  type CheckResult,
  type LaunchOutcome,
} from "@/lib/tauri-invoke";
import { trackEvent } from "@/lib/analytics";
import ConfettiOverlay from "@/routes/Success/ConfettiOverlay";
import type { LocationResult } from "@/routes/Location";

const USER_GUIDE_URL =
  "https://github.com/indigoai-us/hq/blob/main/knowledge/public/hq-core/USER-GUIDE.md";

interface SuccessRouteProps {
  location: LocationResult;
  finalDeps: readonly CheckResult[];
  /** Seconds elapsed since the installer launched — used for analytics. */
  durationSeconds: number;
  /** Platform hint so the Reveal button label matches the OS. */
  platform?: "macos" | "windows" | "linux";
}

type LaunchState =
  | { name: "idle" }
  | { name: "launched" }
  | { name: "fallback"; cmd: string; message: string }
  | { name: "error"; message: string };

const SuccessRoute = ({
  location,
  finalDeps,
  durationSeconds,
  platform = "macos",
}: SuccessRouteProps) => {
  const [launchState, setLaunchState] = useState<LaunchState>({
    name: "idle",
  });
  const [showConfetti, setShowConfetti] = useState(true);

  // Installed vs missing dep summary for the summary list.
  const depsSummary = useMemo(() => {
    const installed = finalDeps.filter((d) => d.installed).map((d) => d.dep_id);
    const missing = finalDeps.filter((d) => !d.installed).map((d) => d.dep_id);
    return { installed, missing };
  }, [finalDeps]);

  // Fire install.completed on first mount. The empty dep array is
  // intentional — we only want this once per mount, not per prop change.
  useEffect(() => {
    trackEvent("install.completed", {
      target_dir: location.target_dir,
      mode: location.mode,
      deps_installed: depsSummary.installed.length,
      deps_missing: depsSummary.missing.length,
      duration_seconds: durationSeconds,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleOpenClaude = useCallback(async () => {
    const outcome: LaunchOutcome = await launchClaudeCode(location.target_dir);
    if (outcome.result === "spawned") {
      setLaunchState({ name: "launched" });
      return;
    }
    if (outcome.kind === "not-found") {
      setLaunchState({
        name: "fallback",
        cmd: `cd "${location.target_dir}" && claude`,
        message: outcome.message,
      });
      return;
    }
    setLaunchState({ name: "error", message: outcome.message });
  }, [location.target_dir]);

  const handleRevealInFinder = useCallback(async () => {
    const outcome = await revealInFileManager(location.target_dir);
    if (outcome.result === "err") {
      setLaunchState({ name: "error", message: outcome.message });
    }
  }, [location.target_dir]);

  const handleOpenGuide = useCallback(async () => {
    try {
      await openShellPath(USER_GUIDE_URL);
    } catch {
      // shell plugin failures are silent — the URL is visible in the link.
    }
  }, []);

  const handleCopyFallback = useCallback(async () => {
    if (launchState.name !== "fallback") return;
    try {
      await navigator.clipboard?.writeText(launchState.cmd);
    } catch {
      // Clipboard unavailable — the cmd is visible on-screen.
    }
  }, [launchState]);

  const revealLabel =
    platform === "windows"
      ? "Show in Explorer"
      : platform === "linux"
      ? "Open in file manager"
      : "Reveal in Finder";

  return (
    <main
      className="min-h-screen flex flex-col px-6 py-8"
      style={{ backgroundColor: "var(--retro-bg-0)" }}
      data-testid="success-route"
      data-launch-state={launchState.name}
    >
      {showConfetti && (
        <ConfettiOverlay onDone={() => setShowConfetti(false)} />
      )}

      <header className="max-w-3xl w-full mx-auto mb-6 flex flex-col gap-2">
        <h1 className="retro-heading-block text-3xl" data-testid="success-heading">
          HQ is ready
        </h1>
        <p className="font-mono text-xs text-zinc-500 tracking-wider uppercase">
          installed in {durationSeconds}s
        </p>
      </header>

      <section
        className="max-w-3xl w-full mx-auto mb-8 flex flex-col gap-3 retro-panel p-5"
        data-testid="success-summary"
      >
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 font-mono text-xs">
          <dt className="text-zinc-500 uppercase tracking-widest">Location</dt>
          <dd data-testid="summary-location">
            <code>{location.target_dir}</code>
          </dd>
          <dt className="text-zinc-500 uppercase tracking-widest">Mode</dt>
          <dd data-testid="summary-mode">
            {location.mode === "scaffold"
              ? `fresh (${location.detail})`
              : `cloned from ${location.detail}`}
          </dd>
          <dt className="text-zinc-500 uppercase tracking-widest">
            Deps installed
          </dt>
          <dd data-testid="summary-deps-count">
            {depsSummary.installed.length} / {finalDeps.length}
          </dd>
          {depsSummary.missing.length > 0 && (
            <>
              <dt className="text-zinc-500 uppercase tracking-widest">
                Missing
              </dt>
              <dd
                className="text-amber-400"
                data-testid="summary-deps-missing"
              >
                {depsSummary.missing.join(", ")}
              </dd>
            </>
          )}
        </dl>
      </section>

      <section className="max-w-3xl w-full mx-auto flex flex-col gap-3 mb-6">
        <div className="flex gap-3">
          <button
            type="button"
            className="retro-cta-primary"
            onClick={handleOpenClaude}
            data-testid="success-open-claude"
          >
            Open in Claude Code
          </button>
          <button
            type="button"
            className="retro-cta-primary retro-cta-primary--secondary"
            onClick={handleRevealInFinder}
            data-testid="success-reveal"
          >
            {revealLabel}
          </button>
        </div>

        {launchState.name === "launched" && (
          <p
            className="font-mono text-xs text-emerald-400"
            data-testid="success-launched"
          >
            Claude Code is running. You can close this window.
          </p>
        )}

        {launchState.name === "fallback" && (
          <div
            className="retro-panel p-4 flex flex-col gap-2"
            data-testid="success-fallback"
          >
            <p className="font-mono text-xs text-amber-400">
              {launchState.message}
            </p>
            <p className="font-mono text-xs text-zinc-300">
              Run this in your terminal to start Claude Code:
            </p>
            <div className="flex gap-2 items-center">
              <code
                className="flex-1 retro-codebox"
                data-testid="success-fallback-cmd"
              >
                {launchState.cmd}
              </code>
              <button
                type="button"
                className="retro-cta-secondary"
                onClick={handleCopyFallback}
                data-testid="success-fallback-copy"
              >
                Copy
              </button>
            </div>
          </div>
        )}

        {launchState.name === "error" && (
          <p
            className="font-mono text-xs text-rose-400"
            data-testid="success-error"
          >
            {launchState.message}
          </p>
        )}

        <button
          type="button"
          className="retro-text-link self-start text-xs"
          onClick={handleOpenGuide}
          data-testid="success-open-guide"
        >
          Read the USER-GUIDE →
        </button>
      </section>
    </main>
  );
};

export default SuccessRoute;
