// 10-indexing.tsx — Verify screen
// Registers this HQ folder with qmd's collection registry and writes a marker
// telling hq-sync to generate embeddings in the background.
//
// Steps (auto-start on mount):
//   qmd collection add . --name <slug>     (fresh install, blocking, fast)
//     ↳ on "already exists" stderr, fall back to:
//   qmd update --name <slug>               (re-index in place)
//
// On success, we write {installPath}/.hq-embeddings-pending.json (or
// ~/.hq/embeddings-pending.json as a fallback) so the hq-sync menubar app
// picks up the pending job on next launch. Embeddings themselves are
// generated from sync, not here — keeps the installer fast and makes
// semantic indexing visible in the tray.
//
// The slug is derived from the basename of installPath — e.g.
// "/Users/stefanjohnson/hq" → "hq".

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  writeTextFile,
  mkdir,
  BaseDirectory,
} from "@tauri-apps/plugin-fs";

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

const STEP_LABELS = ["Register HQ with semantic search"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive the qmd collection name from an install path. qmd 2.x requires a
 * named collection (registered under ~/.config/qmd/index.yml) so we use the
 * basename as a stable identifier — e.g. "/Users/jane/hq" → "hq",
 * "/Users/jane/hq3" → "hq3". Falls back to "hq" for degenerate paths.
 */
function collectionSlug(installPath: string): string {
  return installPath.split("/").filter(Boolean).pop() || "hq";
}

/**
 * Write the embeddings-pending marker so hq-sync knows to run `qmd embed`
 * on next launch. Primary target is `{installPath}/.hq-embeddings-pending.json`;
 * if `installPath` is not a usable absolute path (empty, relative, or the
 * write fails for any reason), fall back to `~/.hq/embeddings-pending.json`.
 * Sync checks both locations.
 */
async function writePendingMarker(installPath: string): Promise<void> {
  const payload = JSON.stringify(
    { requestedAt: new Date().toISOString(), reason: "post-install" },
    null,
    2
  );

  const hasAbsoluteInstallPath =
    typeof installPath === "string" && installPath.startsWith("/");

  if (hasAbsoluteInstallPath) {
    const primary = `${installPath.replace(/\/+$/, "")}/.hq-embeddings-pending.json`;
    try {
      await writeTextFile(primary, payload);
      return;
    } catch {
      // Fall through to the home-directory fallback.
    }
  }

  // Fallback: ~/.hq/embeddings-pending.json (ensure the directory exists).
  try {
    await mkdir(".hq", { baseDir: BaseDirectory.Home, recursive: true });
  } catch {
    // mkdir is idempotent; ignore "already exists" and let the write fail loudly
    // if something more serious is wrong.
  }
  await writeTextFile(".hq/embeddings-pending.json", payload, {
    baseDir: BaseDirectory.Home,
  });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function QmdIndexing({ installPath, onNext }: QmdIndexingProps) {
  const [steps, setSteps] = useState<StepState[]>([makeStep()]);
  const [running, setRunning] = useState(false);
  const [failedStep, setFailedStep] = useState<number | null>(null);

  // Prevent double-starts in strict mode.
  const startedRef = useRef(false);

  // Listeners registered during a run — tracked so we can clean them up.
  const unlistenRefs = useRef<Array<(() => void) | undefined>>([]);

  // Handle of the currently-spawned child for step 0 (index), so it can be
  // cancelled on unmount.
  const activeHandleRef = useRef<string | null>(null);

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
  //
  // `stderrBuf`, when provided, is appended with each raw stderr line during
  // the run. Callers use this to detect benign, recoverable errors (e.g.
  // "Collection 'hq' already exists") and retry with a different subcommand
  // without surfacing the first attempt's failure to the user.
  async function runQmd(
    stepIdx: number,
    args: string[],
    stderrBuf?: string[]
  ): Promise<boolean> {
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

    // Track the live handle so a mid-run Skip can SIGTERM the child.
    activeHandleRef.current = handle;

    // Listen for stdout lines.
    const stdoutUnlisten = await listen(
      `process://${handle}/stdout`,
      (event: { payload: unknown }) => {
        const payload = event.payload as { line: string };
        appendLog(stepIdx, payload.line ?? "");
      }
    );

    // Internal stderr buffer for ABI-mismatch detection; populated on every
    // invocation regardless of whether the caller passes stderrBuf.
    const stderrLines: string[] = [];

    // Listen for stderr — qmd (via node-llama-cpp) writes progress and
    // diagnostic lines here, e.g. "no GPU acceleration, running on CPU"
    // or model-resolution failures. Mirror into the caller-provided buffer
    // when present so known-benign errors (e.g. "already exists") can be
    // detected after the process exits.
    const stderrUnlisten = await listen(
      `process://${handle}/stderr`,
      (event: { payload: unknown }) => {
        const payload = event.payload as { line: string };
        const line = payload.line ?? "";
        appendLog(stepIdx, `[stderr] ${line}`);
        stderrLines.push(line);
        if (stderrBuf) stderrBuf.push(line);
      }
    );

    // Wait for the exit event via a regular (non-async) Promise executor.
    return new Promise<boolean>((resolve) => {
      listen(
        `process://${handle}/exit`,
        (event: { payload: unknown }) => {
          const payload = event.payload as { code: number | null; success: boolean };
          // Clear active handle first so a late Skip click doesn't signal a
          // dead pid (cancel_process is a no-op on unregistered handles, but
          // this keeps the UI state truthful).
          if (activeHandleRef.current === handle) {
            activeHandleRef.current = null;
          }
          if (payload.success) {
            patchStep(stepIdx, { status: "done" });
            resolve(true);
          } else {
            // Detect Node ABI mismatch (better-sqlite3 compiled for a different
            // Node version) and surface a targeted remediation hint instead of
            // a cryptic exit-code message. Covers non-nvm installs where the
            // PATH-prepend fix in process.rs cannot help.
            const isAbiMismatch = stderrLines.some(
              (l) =>
                l.includes("ERR_DLOPEN_FAILED") ||
                l.includes("NODE_MODULE_VERSION")
            );
            const msg = isAbiMismatch
              ? "Node ABI mismatch: qmd was compiled for a different Node version. Fix: reinstall qmd under your current Node — npm i -g @tobilu/qmd"
              : `Process exited with code ${payload.code ?? -1}`;
            patchStep(stepIdx, { status: "error", errorMsg: msg });
            setFailedStep(stepIdx);
            resolve(false);
          }
          // Clean up stream listeners immediately; exit listener self-cleans below.
          (stdoutUnlisten as () => void)();
          (stderrUnlisten as () => void)();
        }
      ).then((exitUnlisten) => {
        unlistenRefs.current.push(
          stdoutUnlisten as () => void,
          stderrUnlisten as () => void,
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

      // ── Step 0: qmd collection add (fall back to update on re-runs) ─────────
      // qmd 2.x split the old `qmd index .` into two commands:
      //   - `qmd collection add <path> --name <slug>` creates + indexes a new
      //     collection. This is the right call for a fresh HQ install.
      //   - `qmd update --name <slug>` re-indexes an existing collection.
      //
      // We optimistically try `collection add` first (most installs are fresh).
      // If the collection already exists — detected via the "already exists"
      // substring in stderr — we silently retry as `update` so re-runs of the
      // installer (or a reinstall over an existing HQ) don't fail this step.
      if (startIdx <= 0) {
        patchStep(0, { status: "running" });
        const slug = collectionSlug(installPath);
        const stderrBuf: string[] = [];
        let ok = await runQmd(
          0,
          ["collection", "add", ".", "--name", slug],
          stderrBuf
        );
        if (
          !ok &&
          stderrBuf.some((line) => line.toLowerCase().includes("already exists"))
        ) {
          // Benign — collection already registered from a prior install.
          // Clear the error state from the failed `add` attempt and re-run
          // as `update` to reindex in place.
          appendLog(
            0,
            `[info] Collection "${slug}" already exists — re-indexing via 'qmd update'`
          );
          patchStep(0, { status: "running", errorMsg: null });
          setFailedStep(null);
          ok = await runQmd(0, ["update", "--name", slug]);
        }
        if (!ok) {
          setRunning(false);
          return;
        }
      }

      // Write the pending-embeddings marker so hq-sync picks up the job on
      // next launch. Non-fatal: if both primary and fallback writes fail,
      // log into the step's panel but still let the user continue — they can
      // always re-trigger embeddings manually from sync Settings.
      try {
        await writePendingMarker(installPath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        appendLog(0, `[warn] Could not write embeddings marker: ${msg}`);
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

  const canContinue = steps[0].status === "done";

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="flex flex-col gap-6 max-w-lg">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-medium text-white">Indexing HQ</h1>
        <p className="text-sm font-light text-zinc-400">
          HQ registered. Embeddings will generate in the background from your menubar.
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

        {canContinue && (
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
            <span className="text-xs text-zinc-400 hq-text-shimmer">Running…</span>
          )}
          {step.status === "done" && (
            <span data-status="done" className="text-xs text-green-400">
              Done
            </span>
          )}
          {step.status === "error" && (
            <span className="text-xs text-red-400">Failed</span>
          )}

          {/* Log toggle visible once the step has started — critical for
              error debugging when stdout is empty but stderr has the reason. */}
          {step.status !== "idle" && (
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

      {step.expanded && (
        <div
          data-log-panel
          className="text-xs font-mono text-zinc-500 bg-black/20 rounded-lg px-3 py-2 max-h-32 overflow-y-auto"
        >
          {step.logLines.length === 0 ? (
            <div className="text-zinc-600 italic">(no output)</div>
          ) : (
            step.logLines.map((line, i) => <div key={i}>{line}</div>)
          )}
        </div>
      )}

      {step.status === "error" && step.errorMsg && (
        <p className="text-xs text-red-400">{step.errorMsg}</p>
      )}
    </div>
  );
}
