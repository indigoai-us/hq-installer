/**
 * Install wizard state machine.
 *
 * The wizard walks a queue of missing deps one at a time. For each dep:
 *   1. Subscribe to Tauri events on `dep-install:<dep-id>`.
 *   2. Invoke `install_dep(depId)`.
 *   3. Route `RunEvent` payloads into the log stream.
 *   4. When the event payload is `Exit { code }`:
 *        - code === 0 → `done`, advance queue
 *        - code !== 0 → `failed`, halt queue until user retries or skips
 *      (When the outcome is `manual`, the dep isn't auto-installable — flag
 *      with `failed` + `outcome: 'manual'` so the UI can show the modal.)
 *   5. After all deps resolve successfully, re-run `check_deps` and compare
 *      against required ids to confirm.
 *
 * The state is represented as a plain object so it can be driven either by
 * a `useReducer` in the Install route or by a unit test's dispatcher. This
 * module exports:
 *   - `InstallState` — immutable snapshot type
 *   - `InstallEvent` — union of every action the reducer accepts
 *   - `installReducer` — pure reducer: (state, event) → state
 *   - `initialInstallState(queue)` — factory
 *
 * The only thing missing from this file is the side-effecting glue
 * (invoke, listen) — that lives in the `Install/index.tsx` component.
 */

import type { DepId, InstallOutcome } from "@/lib/tauri-invoke";

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export type DepInstallStatus =
  | "pending"
  | "installing"
  | "done"
  | "failed"
  | "skipped";

export interface LogEntry {
  /** Sequence number — monotonic, used as React key. */
  seq: number;
  /** Dep the line came from (null for system/informational lines). */
  depId: DepId | null;
  /** Classification of the line for styling. */
  kind: "stdout" | "stderr" | "system" | "error";
  /** The actual log text. */
  text: string;
  /** Absolute timestamp (ms since epoch). */
  ts: number;
}

export interface DepError {
  depId: DepId;
  message: string;
  /** Whether the runner reported this as a manual-only dep. */
  manual: boolean;
  /** Exit code if the command actually ran. */
  exitCode: number | null;
}

export interface InstallState {
  /** The ordered list of deps to install. Frozen after init. */
  queue: readonly DepId[];
  /** Status keyed by dep id. Unknown ids are treated as "pending". */
  status: Record<string, DepInstallStatus>;
  /** Dep currently running (or null between steps / after completion). */
  currentDepId: DepId | null;
  /** Append-only log stream. */
  logs: LogEntry[];
  /** Monotonic seq counter for new log entries. */
  nextSeq: number;
  /** Error for the most recently failed dep, if any. */
  error: DepError | null;
  /** True once every dep in the queue has reached a terminal state. */
  completed: boolean;
}

/** Actions the reducer accepts. */
export type InstallEvent =
  | { type: "start"; depId: DepId }
  | { type: "log-stdout"; depId: DepId; line: string }
  | { type: "log-stderr"; depId: DepId; line: string }
  | { type: "log-system"; text: string; depId?: DepId }
  | { type: "finish"; depId: DepId; outcome: InstallOutcome }
  | { type: "retry"; depId: DepId }
  | { type: "skip"; depId: DepId }
  | { type: "complete" };

// ──────────────────────────────────────────────────────────────────────────
// Factory + reducer
// ──────────────────────────────────────────────────────────────────────────

export function initialInstallState(queue: readonly DepId[]): InstallState {
  const status: Record<string, DepInstallStatus> = {};
  for (const id of queue) status[id] = "pending";
  return {
    queue,
    status,
    currentDepId: null,
    logs: [],
    nextSeq: 0,
    error: null,
    completed: queue.length === 0,
  };
}

function appendLog(state: InstallState, entry: Omit<LogEntry, "seq">): InstallState {
  return {
    ...state,
    logs: [...state.logs, { ...entry, seq: state.nextSeq }],
    nextSeq: state.nextSeq + 1,
  };
}

export function installReducer(
  state: InstallState,
  event: InstallEvent,
): InstallState {
  switch (event.type) {
    case "start": {
      const status = { ...state.status, [event.depId]: "installing" as const };
      const withLog = appendLog(state, {
        depId: event.depId,
        kind: "system",
        text: `▸ installing ${event.depId}…`,
        ts: Date.now(),
      });
      return {
        ...withLog,
        status,
        currentDepId: event.depId,
        error: null,
      };
    }
    case "log-stdout":
      return appendLog(state, {
        depId: event.depId,
        kind: "stdout",
        text: event.line,
        ts: Date.now(),
      });
    case "log-stderr":
      return appendLog(state, {
        depId: event.depId,
        kind: "stderr",
        text: event.line,
        ts: Date.now(),
      });
    case "log-system":
      return appendLog(state, {
        depId: event.depId ?? null,
        kind: "system",
        text: event.text,
        ts: Date.now(),
      });
    case "finish": {
      const outcome = event.outcome;
      if (outcome.result === "auto") {
        const ok = outcome.exit_code === 0;
        const newStatus: DepInstallStatus = ok ? "done" : "failed";
        const status = { ...state.status, [event.depId]: newStatus };
        const withLog = appendLog(state, {
          depId: event.depId,
          kind: ok ? "system" : "error",
          text: ok
            ? `✓ ${event.depId} installed successfully`
            : `✗ ${event.depId} failed (exit ${outcome.exit_code ?? "?"})`,
          ts: Date.now(),
        });
        return {
          ...withLog,
          status,
          currentDepId: null,
          error: ok
            ? null
            : {
                depId: event.depId,
                message: `Install command exited with code ${
                  outcome.exit_code ?? "unknown"
                }`,
                manual: false,
                exitCode: outcome.exit_code,
              },
        };
      }
      if (outcome.result === "manual") {
        const status = { ...state.status, [event.depId]: "failed" as const };
        const withLog = appendLog(state, {
          depId: event.depId,
          kind: "system",
          text: `⚠ ${event.depId} requires manual installation — ${outcome.hint}`,
          ts: Date.now(),
        });
        return {
          ...withLog,
          status,
          currentDepId: null,
          error: {
            depId: event.depId,
            message: outcome.hint,
            manual: true,
            exitCode: null,
          },
        };
      }
      // not-found
      const status = { ...state.status, [event.depId]: "failed" as const };
      const withLog = appendLog(state, {
        depId: event.depId,
        kind: "error",
        text: `✗ ${event.depId}: unknown dep id`,
        ts: Date.now(),
      });
      return {
        ...withLog,
        status,
        currentDepId: null,
        error: {
          depId: event.depId,
          message: "Unknown dep id",
          manual: false,
          exitCode: null,
        },
      };
    }
    case "retry": {
      const status = { ...state.status, [event.depId]: "pending" as const };
      return { ...state, status, error: null };
    }
    case "skip": {
      const status = { ...state.status, [event.depId]: "skipped" as const };
      const withLog = appendLog(state, {
        depId: event.depId,
        kind: "system",
        text: `↷ ${event.depId} skipped by user`,
        ts: Date.now(),
      });
      return { ...withLog, status, error: null, currentDepId: null };
    }
    case "complete": {
      return { ...state, completed: true, currentDepId: null };
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Derived selectors
// ──────────────────────────────────────────────────────────────────────────

/** Count of deps in a terminal state (done | failed | skipped). */
export function completedCount(state: InstallState): number {
  return state.queue.filter((id) => {
    const s = state.status[id];
    return s === "done" || s === "failed" || s === "skipped";
  }).length;
}

/** The next dep to install. Returns `null` if the queue is drained or a
 * failure is currently blocking progression. */
export function nextPendingDep(state: InstallState): DepId | null {
  if (state.error) return null;
  for (const id of state.queue) {
    if (state.status[id] === "pending") return id;
  }
  return null;
}

/** True when every dep has reached a terminal state. */
export function queueDrained(state: InstallState): boolean {
  return state.queue.every((id) => {
    const s = state.status[id];
    return s === "done" || s === "failed" || s === "skipped";
  });
}
