// 08-git-init.tsx — US-016
// Git init + kernel integrity screen.
//
// Steps:
//   1. git_init(installPath, name, email)  → commit SHA
//   2. spawn_process compute-checksums.sh
//   3. spawn_process core-integrity.sh

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { exists } from "@tauri-apps/plugin-fs";

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

export interface GitInitProps {
  installPath: string;
  onNext?: () => void;
}

// ---------------------------------------------------------------------------
// Step descriptors (static labels)
// ---------------------------------------------------------------------------

const STEP_LABELS = [
  "Initialise local git",
  "Compute checksums",
  "Verify kernel integrity",
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function GitInit({ installPath, onNext }: GitInitProps) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [probing, setProbing] = useState(true);

  const [steps, setSteps] = useState<StepState[]>([
    makeStep(),
    makeStep(),
    makeStep(),
  ]);
  const [running, setRunning] = useState(false);
  const [failedStep, setFailedStep] = useState<number | null>(null);

  // Listeners registered during a run — tracked so we can clean them up.
  const unlistenRefs = useRef<Array<(() => void) | undefined>>([]);

  // ---------------------------------------------------------------------------
  // Mount: probe git user
  // ---------------------------------------------------------------------------

  useEffect(() => {
    invoke<{ name?: string | null; email?: string | null } | null>(
      "git_probe_user"
    )
      .then((user) => {
        if (user) {
          if (user.name) setName(user.name);
          if (user.email) setEmail(user.email);
        }
      })
      .catch(() => {
        // Ignore — user can fill in manually.
      })
      .finally(() => setProbing(false));
  }, []);

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
  // Run steps sequentially
  // ---------------------------------------------------------------------------

  async function runFromStep(startIdx: number) {
    setRunning(true);
    setFailedStep(null);

    // Reset steps from startIdx onward.
    setSteps((prev) =>
      prev.map((s, i) => (i >= startIdx ? makeStep() : s))
    );

    // Clean up any previous listeners.
    for (const u of unlistenRefs.current) u?.();
    unlistenRefs.current = [];

    // ── Step 0: git_init ────────────────────────────────────────────────────
    if (startIdx <= 0) {
      patchStep(0, { status: "running" });
      try {
        const sha = await invoke<string>("git_init", {
          path: installPath,
          name,
          email,
        });
        appendLog(0, `Initialised repository (${sha.slice(0, 7)})`);
        patchStep(0, { status: "done" });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        patchStep(0, { status: "error", errorMsg: msg });
        setFailedStep(0);
        setRunning(false);
        return;
      }
    }

    // ── Step 1: compute-checksums.sh ────────────────────────────────────────
    if (startIdx <= 1) {
      patchStep(1, { status: "running" });
      const ok = await runScript(1, `${installPath}/scripts/compute-checksums.sh`);
      if (!ok) {
        setRunning(false);
        return;
      }
    }

    // ── Step 2: core-integrity.sh ───────────────────────────────────────────
    // v11.2.0 of the HQ template rebuilt from a strict allowlist and dropped
    // core-integrity.sh. Skip the step (rather than fail) when the script
    // isn't present so installs against newer templates don't wedge here.
    if (startIdx <= 2) {
      const scriptPath = `${installPath}/scripts/core-integrity.sh`;
      const scriptExists = await exists(scriptPath).catch(() => false);
      if (!scriptExists) {
        patchStep(2, {
          status: "done",
          logLines: [
            "Skipped — core-integrity.sh not present in this template.",
          ],
        });
      } else {
        patchStep(2, { status: "running" });
        const ok = await runScript(2, scriptPath);
        if (!ok) {
          setRunning(false);
          return;
        }
      }
    }

    setRunning(false);
  }

  // Spawn a shell script and wait for its exit event.
  // Returns true on success, false on failure (also patches step state).
  async function runScript(stepIdx: number, scriptPath: string): Promise<boolean> {
    // Spawn the process first (before creating the promise) to avoid
    // the no-async-promise-executor lint error.
    let handle: string;
    try {
      // `bash <path>` reads the file as a script (no +x bit required).
      // Using `bash -c <path>` treats the path as a command and fails with
      // exit code 126 if the file isn't executable — which it won't be if the
      // tar extraction missed the mode bit. Reading as a script is strictly
      // more permissive and matches how `./install.sh` style launchers work.
      handle = await invoke<string>("spawn_process", {
        args: {
          cmd: "bash",
          args: [scriptPath],
          cwd: installPath,
        },
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

    // Listen for stderr lines — tag them so they stand out in the log panel.
    // Stderr is where shell script failures (bad path, missing binary,
    // permission denied) surface their real reason.
    const stderrUnlisten = await listen(
      `process://${handle}/stderr`,
      (event: { payload: unknown }) => {
        const payload = event.payload as { line: string };
        appendLog(stepIdx, `[stderr] ${payload.line ?? ""}`);
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
  // Derived
  // ---------------------------------------------------------------------------

  const canRun = name.trim().length > 0 && email.trim().length > 0 && !running;
  const allDone = steps.every((s) => s.status === "done");

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="flex flex-col gap-4 max-w-lg">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-medium text-white">Git setup &amp; integrity check</h1>
        <p className="text-sm font-light text-zinc-400">
          Initialise the HQ repository and verify kernel integrity.
        </p>
      </div>

      {/* Git identity fields */}
      <div className="flex flex-col gap-3 bg-white/5 border border-white/10 rounded-xl px-4 py-3">
        <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider">
          Git identity
        </p>

        {probing ? (
          <p className="text-xs text-zinc-500">Loading git config…</p>
        ) : (
          <div className="flex flex-col gap-2.5">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-zinc-400">Name</span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your Name"
                aria-label="Name"
                className="bg-black/30 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-white/30"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-zinc-400">Email</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                aria-label="Email"
                className="bg-black/30 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-white/30"
              />
            </label>
          </div>
        )}
      </div>

      {/* Steps */}
      <div className="flex flex-col gap-2">
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
        {!running && !allDone && failedStep === null && (
          <button
            type="button"
            onClick={() => runFromStep(0)}
            disabled={!canRun}
            className="px-6 py-2.5 rounded-full text-sm font-medium bg-white text-black hover:bg-zinc-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Run setup
          </button>
        )}

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
    <div className="flex flex-col gap-2 bg-white/5 border border-white/10 rounded-xl px-4 py-2">
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
            <span
              data-status="done"
              className="text-xs text-green-400"
            >
              Done
            </span>
          )}
          {step.status === "error" && (
            <span className="text-xs text-red-400">Failed</span>
          )}

          {/* Log toggle is visible once the step has started (running/done/error),
              not only when there's output — empty stdout on a failing step is
              exactly the case where users need a visible panel to see stderr. */}
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
