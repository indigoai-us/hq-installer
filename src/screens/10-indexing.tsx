// 10-indexing.tsx — US-018
// qmd indexing screen — runs `qmd index .` then `qmd embed` with live progress.
//
// Steps (auto-start on mount, sequential):
//   1. qmd index .
//   2. qmd embed

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type StepStatus = "idle" | "running" | "done" | "error";

interface StepState {
  status: StepStatus;
  logLines: string[];
  errorMsg: string | null;
  expanded: boolean;
}

function makeStep(): StepState {
  return { status: "idle", logLines: [], errorMsg: null, expanded: false };
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface QmdIndexingProps {
  installPath: string;
  onNext?: () => void;
}

// ---------------------------------------------------------------------------
// Step descriptors (static labels)
// ---------------------------------------------------------------------------

const STEP_LABELS = [
  "Index HQ knowledge base",
  "Generate semantic embeddings",
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function QmdIndexing({ installPath, onNext }: QmdIndexingProps) {
  const [steps, setSteps] = useState<StepState[]>([makeStep(), makeStep()]);
  const [running, setRunning] = useState(false);
  const [failedStep, setFailedStep] = useState<number | null>(null);

  // Prevent double-starts in strict mode.
  const startedRef = useRef(false);

  // Listeners registered during a run — tracked so we can clean them up.
  const unlistenRefs = useRef<Array<(() => void) | undefined>>([]);

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function patchStep(idx: number, patch: Partial<StepState>) {
    setSteps((prev) =>
      prev.map((s, i) => (i === idx ? { ...s, ...patch } : s))
    );
  }

  function appendLog(idx: number, line: string) {
    setSteps((prev) =>
      prev.map((s, i) =>
        i === idx ? { ...s, logLines: [...s.logLines, line] } : s
      )
    );
  }

  function toggleExpanded(idx: number) {
    setSteps((prev) =>
      prev.map((s, i) => (i === idx ? { ...s, expanded: !s.expanded } : s))
    );
  }

  // ---------------------------------------------------------------------------
  // Process runner
  // ---------------------------------------------------------------------------

  // Spawn a qmd command and wait for its exit event.
  // Returns true on success, false on failure.
  async function runQmd(stepIdx: number, args: string[]): Promise<boolean> {
    let handle: string;
    try {
      handle = await invoke<string>("spawn_process", {
        args: { cmd: "qmd", args, cwd: installPath },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      patchStep(stepIdx, { status: "error", errorMsg: msg });
      setFailedStep(stepIdx);
      return false;
    }

    // Listen for stdout lines.
    const stdoutUnlisten = await listen(
      `process://${handle}/stdout`,
      (event: { payload: unknown }) => {
        const payload = event.payload as { line: string };
        appendLog(stepIdx, payload.line ?? "");
      }
    );

    // Wait for the exit event via a regular (non-async) Promise executor.
    return new Promise<boolean>((resolve) => {
      listen(
        `process://${handle}/exit`,
        (event: { payload: unknown }) => {
          const payload = event.payload as { code: number | null; success: boolean };
          if (payload.success) {
            patchStep(stepIdx, { status: "done" });
            resolve(true);
          } else {
            const msg = `Process exited with code ${payload.code ?? -1}`;
            patchStep(stepIdx, { status: "error", errorMsg: msg });
            setFailedStep(stepIdx);
            resolve(false);
          }
          // Clean up stdout listener immediately; exit listener self-cleans below.
          (stdoutUnlisten as () => void)();
        }
      ).then((exitUnlisten) => {
        unlistenRefs.current.push(
          stdoutUnlisten as () => void,
          exitUnlisten as () => void
        );
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Run steps sequentially
  // ---------------------------------------------------------------------------

  const runFromStep = useCallback(
    async (startIdx: number) => {
      setRunning(true);
      setFailedStep(null);

      // Reset steps from startIdx onward.
      setSteps((prev) =>
        prev.map((s, i) => (i >= startIdx ? makeStep() : s))
      );

      // Clean up any previous listeners.
      for (const u of unlistenRefs.current) u?.();
      unlistenRefs.current = [];

      // ── Step 0: qmd index . ─────────────────────────────────────────────────
      if (startIdx <= 0) {
        patchStep(0, { status: "running" });
        const ok = await runQmd(0, ["index", "."]);
        if (!ok) {
          setRunning(false);
          return;
        }
      }

      // ── Step 1: qmd embed ───────────────────────────────────────────────────
      if (startIdx <= 1) {
        patchStep(1, { status: "running" });
        const ok = await runQmd(1, ["embed"]);
        if (!ok) {
          setRunning(false);
          return;
        }
      }

      setRunning(false);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [installPath]
  );

  // ---------------------------------------------------------------------------
  // Auto-start on mount
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    runFromStep(0);

    return () => {
      for (const u of unlistenRefs.current) u?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------------------
  // Derived
  // ---------------------------------------------------------------------------

  const allDone = steps.every((s) => s.status === "done");

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="flex flex-col gap-6 max-w-lg">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-medium text-white">Indexing HQ</h1>
        <p className="text-sm font-light text-zinc-400">
          Building the knowledge index so Claude Code can search your HQ instantly.
        </p>
      </div>

      {/* Steps */}
      <div className="flex flex-col gap-3">
        {steps.map((step, i) => (
          <StepRow
            key={i}
            label={STEP_LABELS[i]}
            step={step}
            onToggleExpanded={() => toggleExpanded(i)}
          />
        ))}
      </div>

      {/* Action buttons */}
      <div className="flex gap-3">
        {failedStep !== null && !running && (
          <>
            <button
              type="button"
              onClick={() => runFromStep(failedStep!)}
              className="px-6 py-2.5 rounded-full text-sm font-medium bg-white text-black hover:bg-zinc-100 transition-colors"
            >
              Retry
            </button>
            <button
              type="button"
              onClick={() => toggleExpanded(failedStep!)}
              className="px-6 py-2.5 rounded-full text-sm font-medium bg-white/10 text-zinc-300 hover:bg-white/20 transition-colors"
            >
              View log
            </button>
          </>
        )}

        {allDone && (
          <button
            type="button"
            onClick={onNext}
            className="px-6 py-2.5 rounded-full text-sm font-medium bg-white text-black hover:bg-zinc-100 transition-colors"
          >
            Continue
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// StepRow
// ---------------------------------------------------------------------------

interface StepRowProps {
  label: string;
  step: StepState;
  onToggleExpanded: () => void;
}

function StepRow({ label, step, onToggleExpanded }: StepRowProps) {
  return (
    <div className="flex flex-col gap-2 bg-white/5 border border-white/10 rounded-xl px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-zinc-200">{label}</span>

        <div className="flex items-center gap-2">
          {step.status === "idle" && (
            <span className="text-xs text-zinc-600">Waiting</span>
          )}
          {step.status === "running" && (
            <span className="text-xs text-zinc-400">Running…</span>
          )}
          {step.status === "done" && (
            <span data-status="done" className="text-xs text-green-400">
              Done
            </span>
          )}
          {step.status === "error" && (
            <span className="text-xs text-red-400">Failed</span>
          )}

          {step.logLines.length > 0 && (
            <button
              type="button"
              onClick={onToggleExpanded}
              className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              {step.expanded ? "Hide" : "Log"}
            </button>
          )}
        </div>
      </div>

      {step.expanded && step.logLines.length > 0 && (
        <div
          data-log-panel
          className="text-xs font-mono text-zinc-500 bg-black/20 rounded-lg px-3 py-2 max-h-32 overflow-y-auto"
        >
          {step.logLines.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}

      {step.status === "error" && step.errorMsg && (
        <p className="text-xs text-red-400">{step.errorMsg}</p>
      )}
    </div>
  );
}
