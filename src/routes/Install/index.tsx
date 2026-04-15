/**
 * Install wizard — executes the install plan computed by the Welcome
 * route's system scan.
 *
 * Responsibilities:
 *   - Walk the `missingDeps` queue one dep at a time
 *   - For each dep:
 *       1. Subscribe to Tauri events on `dep-install:<dep-id>`
 *       2. Dispatch `start`
 *       3. Invoke `install_dep(depId)`
 *       4. On each `RunEvent`, dispatch the matching reducer action
 *       5. Dispatch `finish` with the `InstallOutcome`
 *       6. Unsubscribe
 *   - If the finished dep was Node.js and the outcome was `manual`, open
 *     the manual-install modal instead of halting with an error row.
 *   - On failure, halt and wait for the user to click Retry or Skip.
 *   - When the queue drains cleanly, re-run `check_deps` and advance.
 *
 * The component intentionally accepts `initialMissing` as a prop so unit
 * tests can seed the wizard without touching the real `install_dep`.
 */

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { listen } from "@tauri-apps/api/event";
import DepInstallRow from "@/routes/Install/DepInstallRow";
import LiveLogPanel from "@/routes/Install/LiveLogPanel";
import NodeManualModal from "@/routes/Install/NodeManualModal";
import {
  completedCount,
  initialInstallState,
  installReducer,
  nextPendingDep,
  queueDrained,
  type DepError,
} from "@/lib/install-state";
import {
  installDep,
  checkDeps,
  type CheckResult,
  type DepId,
  type InstallOutcome,
} from "@/lib/tauri-invoke";

interface InstallRouteProps {
  /** The deps discovered as missing by the welcome scan. */
  initialMissing: readonly DepId[];
  /** Called when every dep has reached a terminal state (done or skipped). */
  onComplete?: (finalCheck: CheckResult[]) => void;
  /** When true, installs run sequentially without waiting for user gestures. */
  autoStart?: boolean;
}

// Narrow the payload shape emitted by the Rust `RunEvent` enum.
type RunEventPayload =
  | { type: "stdout"; line: string }
  | { type: "stderr"; line: string }
  | { type: "exit"; code: number | null }
  | { type: "error"; message: string };

const InstallRoute = ({
  initialMissing,
  onComplete,
  autoStart = true,
}: InstallRouteProps) => {
  const [state, dispatch] = useReducer(
    installReducer,
    initialMissing,
    initialInstallState,
  );

  const [showNodeModal, setShowNodeModal] = useState(false);
  const isMounted = useRef(true);

  useEffect(() => {
    return () => {
      isMounted.current = false;
    };
  }, []);

  // Drive the queue: whenever the current dep is null and there's a
  // pending dep in the queue (and autoStart is on), kick off the next one.
  const runNext = useCallback(async () => {
    const next = nextPendingDep(state);
    if (!next) {
      if (queueDrained(state) && !state.completed) {
        const finalCheck = await checkDeps().catch(() => [] as CheckResult[]);
        if (!isMounted.current) return;
        dispatch({ type: "complete" });
        onComplete?.(finalCheck);
      }
      return;
    }

    const channel = `dep-install:${next}`;
    let unlisten: UnlistenFn | null = null;
    try {
      unlisten = await listen<RunEventPayload>(channel, (evt) => {
        const payload = evt.payload;
        switch (payload.type) {
          case "stdout":
            dispatch({ type: "log-stdout", depId: next, line: payload.line });
            break;
          case "stderr":
            dispatch({ type: "log-stderr", depId: next, line: payload.line });
            break;
          case "error":
            dispatch({
              type: "log-system",
              depId: next,
              text: `runner error: ${payload.message}`,
            });
            break;
          case "exit":
            // handled via the InstallOutcome returned from `install_dep`
            break;
        }
      });
    } catch {
      // listen() can fail if we're running inside a non-tauri webview
      // (e.g. plain vitest + jsdom). We still want the queue to advance
      // via the mocked invoke, so continue without a listener.
    }

    dispatch({ type: "start", depId: next });

    let outcome: InstallOutcome;
    try {
      outcome = await installDep(next);
    } catch (err) {
      outcome = {
        result: "not-found",
        dep_id: next,
      };
      dispatch({
        type: "log-system",
        depId: next,
        text: `invoke error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    if (unlisten) {
      try {
        unlisten();
      } catch {
        /* already unsubscribed */
      }
    }

    if (!isMounted.current) return;
    dispatch({ type: "finish", depId: next, outcome });

    // Node.js → manual outcome triggers the modal.
    if (
      next === "node" &&
      outcome.result === "manual"
    ) {
      setShowNodeModal(true);
    }
  }, [onComplete, state]);

  useEffect(() => {
    if (!autoStart) return;
    if (state.currentDepId !== null) return; // already installing
    if (state.error) return; // halted — wait for user action
    if (queueDrained(state)) {
      // Drain to completion once — runNext() fires the final check_deps.
      if (!state.completed) {
        void runNext();
      }
      return;
    }
    void runNext();
  }, [autoStart, runNext, state]);

  const handleRetry = useCallback((depId: DepId) => {
    dispatch({ type: "retry", depId });
  }, []);

  const handleSkip = useCallback((depId: DepId) => {
    dispatch({ type: "skip", depId });
  }, []);

  const handleNodeRecheck = useCallback(() => {
    setShowNodeModal(false);
    if (state.error?.depId === "node") {
      dispatch({ type: "retry", depId: "node" });
    }
  }, [state.error]);

  const total = state.queue.length;
  const done = completedCount(state);
  const progressPct = total === 0 ? 100 : Math.round((done / total) * 100);

  return (
    <main
      className="min-h-screen flex flex-col px-6 py-8"
      style={{ backgroundColor: "var(--retro-bg-0)" }}
      data-testid="install-route"
      data-phase={state.completed ? "complete" : state.error ? "error" : "running"}
    >
      <header className="max-w-3xl w-full mx-auto mb-6 flex flex-col gap-2">
        <h1 className="retro-heading-block text-3xl">Installing HQ</h1>
        <p className="font-mono text-xs text-zinc-500 tracking-wider uppercase">
          {state.completed
            ? "all done"
            : state.error
            ? `error on ${state.error.depId}`
            : `running ${state.currentDepId ?? "…"}`}
        </p>
        <div
          className="retro-progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={done}
          data-testid="install-progress"
          data-pct={progressPct}
        >
          <div
            className="retro-progress-fill"
            style={{ width: `${progressPct}%` }}
          />
        </div>
        <p className="font-mono text-xs text-zinc-500">
          {done}/{total} deps complete
        </p>
      </header>

      <section
        className="max-w-3xl w-full mx-auto flex flex-col gap-[2px] mb-6"
        data-testid="install-row-list"
      >
        {state.queue.map((depId) => (
          <DepInstallRow
            key={depId}
            depId={depId}
            status={state.status[depId] ?? "pending"}
            onRetry={handleRetry}
            onSkip={handleSkip}
          />
        ))}
      </section>

      <section className="max-w-3xl w-full mx-auto">
        <LiveLogPanel logs={state.logs} />
      </section>

      <NodeManualModal
        open={showNodeModal}
        hint={state.error?.manual ? state.error.message : undefined}
        onClose={() => setShowNodeModal(false)}
        onRecheck={handleNodeRecheck}
      />
    </main>
  );
};

export default InstallRoute;

/** Exposed for tests that want to inspect the error shape separately. */
export type { DepError };
