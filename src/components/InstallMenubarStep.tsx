// InstallMenubarStep.tsx — US-013
// Post-onboarding menubar app installation step.
//
// Behavior:
//   - On mount: auto-invokes install_menubar_app Tauri command
//   - Listens to "menubar-install://progress" events for live phase/percent updates
//   - Phases: "Fetching latest release..." → "Downloading DMG..." →
//             "Mounting disk image..." → "Installing app..." → "Done"
//   - On success: shows checkmark, install path, optional "Launch now" toggle,
//     and a Continue button that optionally calls launch_menubar_app first
//   - On failure: shows error message, manual download link, and Skip button

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type StepStatus = "idle" | "running" | "done" | "error";

interface InstallState {
  status: StepStatus;
  phase: string;
  percent: number;
  message: string;
  errorMsg: string | null;
  appPath: string | null;
}

// Payload emitted by the Rust side on "menubar-install://progress"
interface ProgressPayload {
  phase?: string;
  percent?: number;
  message?: string;
  done?: boolean;
  error?: string;
  app_path?: string;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface InstallMenubarStepProps {
  onNext?: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function InstallMenubarStep({ onNext }: InstallMenubarStepProps) {
  const [state, setState] = useState<InstallState>({
    status: "idle",
    phase: "Fetching latest release...",
    percent: 0,
    message: "",
    errorMsg: null,
    appPath: null,
  });

  const [launchNow, setLaunchNow] = useState(true);
  const [continuing, setContinuing] = useState(false);

  // Prevent double-start in React strict mode
  const startedRef = useRef(false);
  const unlistenRef = useRef<(() => void) | undefined>(undefined);

  // ---------------------------------------------------------------------------
  // Install runner
  // ---------------------------------------------------------------------------

  const startInstall = useCallback(async () => {
    setState({
      status: "running",
      phase: "Fetching latest release...",
      percent: 0,
      message: "",
      errorMsg: null,
      appPath: null,
    });

    // Register progress listener before invoking so we catch early events
    const unlisten = await listen<ProgressPayload>(
      "menubar-install://progress",
      (event) => {
        const p = event.payload;
        setState((prev) => {
          if (p.error) {
            return {
              ...prev,
              status: "error",
              errorMsg: p.error,
              message: p.message ?? prev.message,
            };
          }
          if (p.done) {
            return {
              ...prev,
              status: "done",
              percent: 100,
              phase: "Done",
              message: p.message ?? prev.message,
              appPath: p.app_path ?? prev.appPath,
            };
          }
          return {
            ...prev,
            phase: p.phase ?? prev.phase,
            percent: p.percent ?? prev.percent,
            message: p.message ?? prev.message,
          };
        });
      }
    );

    unlistenRef.current = unlisten as () => void;

    try {
      const result = await invoke<{
        success: boolean;
        appPath: string | null;
        error: string | null;
      }>("install_menubar_app");
      // Use the invoke return value to set final state
      setState((prev) => {
        if (prev.status === "running" || prev.status === "idle") {
          if (result.success) {
            return {
              ...prev,
              status: "done",
              percent: 100,
              phase: "Done",
              appPath: result.appPath ?? prev.appPath,
            };
          }
          return {
            ...prev,
            status: "error",
            errorMsg: result.error ?? "Installation failed",
          };
        }
        return prev;
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setState((prev) => {
        if (prev.status !== "done") {
          return { ...prev, status: "error", errorMsg: msg };
        }
        return prev;
      });
    } finally {
      (unlistenRef.current as (() => void) | undefined)?.();
      unlistenRef.current = undefined;
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Auto-start on mount
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    startInstall();

    return () => {
      unlistenRef.current?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------------------
  // Continue handler
  // ---------------------------------------------------------------------------

  async function handleContinue() {
    setContinuing(true);
    if (launchNow) {
      try {
        await invoke("launch_menubar_app");
      } catch {
        // Non-fatal — continue regardless
      }
    }
    setContinuing(false);
    onNext?.();
  }

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------

  const isDone = state.status === "done";
  const isError = state.status === "error";
  const isRunning = state.status === "running" || state.status === "idle";

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="flex flex-col gap-6 max-w-lg">
      {/* Header */}
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-medium text-white">Install HQ Sync</h1>
        <p className="text-sm font-light text-zinc-400">
          HQ Sync keeps your workspace in sync from the menu bar — no terminal
          required.
        </p>
      </div>

      {/* Progress card */}
      <div className="flex flex-col gap-3 bg-white/5 border border-white/10 rounded-xl px-4 py-4">
        {/* Phase row */}
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium text-zinc-200">
            {isDone ? "HQ Sync" : state.phase}
          </span>

          <div className="flex items-center gap-2">
            {isRunning && (
              <span className="text-xs text-zinc-400">Installing…</span>
            )}
            {isDone && (
              <span className="text-xs text-green-400">Installed</span>
            )}
            {isError && (
              <span className="text-xs text-red-400">Failed</span>
            )}
          </div>
        </div>

        {/* Progress bar — visible while running */}
        {isRunning && (
          <div className="h-1 rounded-full bg-white/20 overflow-hidden">
            <div
              className="h-full rounded-full bg-white transition-all duration-300 ease-out"
              style={{ width: `${Math.max(4, state.percent)}%` }}
            />
          </div>
        )}

        {/* Success state */}
        {isDone && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              {/* Checkmark icon */}
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                aria-hidden="true"
              >
                <circle cx="8" cy="8" r="7" fill="rgba(74,222,128,0.15)" />
                <path
                  d="M5 8l2 2 4-4"
                  stroke="#4ade80"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span className="text-sm text-zinc-300">
                HQ Sync has been installed
                {state.appPath ? (
                  <> to{" "}<span className="font-mono text-xs text-zinc-400">{state.appPath}</span></>
                ) : (
                  " to /Applications"
                )}
              </span>
            </div>

            {/* Launch toggle */}
            <label className="flex items-center gap-3 cursor-pointer select-none group">
              <button
                type="button"
                role="switch"
                aria-checked={launchNow}
                onClick={() => setLaunchNow((v) => !v)}
                className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border transition-colors focus:outline-none ${
                  launchNow
                    ? "bg-white border-white"
                    : "bg-white/10 border-white/20"
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-4 w-4 rounded-full shadow transition-transform mt-0.5 ${
                    launchNow
                      ? "translate-x-4 bg-zinc-950"
                      : "translate-x-0.5 bg-zinc-400"
                  }`}
                />
              </button>
              <span className="text-sm text-zinc-300 group-hover:text-white transition-colors">
                Launch HQ Sync now
              </span>
            </label>
          </div>
        )}

        {/* Error state */}
        {isError && state.errorMsg && (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-red-400 break-all">{state.errorMsg}</p>
          </div>
        )}
      </div>

      {/* Action buttons */}
      <div className="flex items-center gap-3">
        {/* Done → Continue */}
        {isDone && (
          <button
            type="button"
            onClick={handleContinue}
            disabled={continuing}
            className="px-6 py-2.5 rounded-full text-sm font-medium bg-white text-black hover:bg-zinc-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {continuing ? "Launching…" : "Continue"}
          </button>
        )}

        {/* Error → Retry + manual download + Skip */}
        {isError && (
          <>
            <button
              type="button"
              onClick={() => {
                startInstall();
              }}
              className="px-6 py-2.5 rounded-full text-sm font-medium bg-white text-black hover:bg-zinc-100 transition-colors"
            >
              Retry
            </button>
            <a
              href="https://github.com/indigoai-us/hq-sync/releases/latest/download/HQ-Sync_universal.dmg"
              target="_blank"
              rel="noreferrer"
              className="px-6 py-2.5 rounded-full text-sm font-medium bg-white/10 text-zinc-300 hover:bg-white/20 transition-colors"
            >
              Download manually
            </a>
            <button
              type="button"
              onClick={onNext}
              className="px-6 py-2.5 rounded-full text-sm font-medium border border-white/20 text-white hover:bg-white/5 transition-colors"
            >
              Skip
            </button>
          </>
        )}
      </div>
    </div>
  );
}
