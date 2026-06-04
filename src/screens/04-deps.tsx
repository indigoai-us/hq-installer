// 04-deps.tsx — US-002
// Non-interactive dependency install screen.
//
// Runs all required deps automatically on mount via runDepsInstall().
// Optional deps (Homebrew, git, gh, claude-code) are silently skipped.
// A failed required dep surfaces an error + retry; missing/failed optional
// deps never block progress.

import { useEffect, useState } from "react";
import { getWizardState } from "@/lib/wizard-state";
import { getInstallerVersion, recordDependencies, recordStepOk } from "@/lib/install-manifest";
import { DEPS, runDepsInstall } from "@/lib/deps-install";
import type { DepInstallResult } from "@/lib/deps-install";

// ---------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------

async function snapshotResults(results: DepInstallResult[]): Promise<void> {
  const installPath = getWizardState().installPath;
  if (!installPath) return;
  try {
    const installerVersion = await getInstallerVersion();
    const snapshot: Record<
      string,
      { status: "pending" | "running" | "ok" | "failed" | "skipped"; error?: string }
    > = {};
    for (const r of results) {
      snapshot[r.id] = {
        status: r.status === "ok" ? "ok" : r.status === "failed" ? "failed" : "skipped",
        error: r.error,
      };
    }
    await recordDependencies(installPath, installerVersion, snapshot);
  } catch {
    /* non-fatal */
  }
}

// ---------------------------------------------------------------------------
// Per-dep runtime state for the progress view
// ---------------------------------------------------------------------------

type RowStatus = "pending" | "running" | "ok" | "skipped" | "failed";

interface RowState {
  id: string;
  label: string;
  optional: boolean;
  status: RowStatus;
  progressLines: string[];
  error?: string;
}

function buildInitialRows(): RowState[] {
  return DEPS.map((d) => ({
    id: d.id,
    label: d.label,
    optional: !!d.optional,
    status: "pending" as RowStatus,
    progressLines: [],
  }));
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface DepsInstallProps {
  onNext?: () => void;
}

export function DepsInstall({ onNext }: DepsInstallProps) {
  const [rows, setRows] = useState<RowState[]>(buildInitialRows);
  const [failed, setFailed] = useState(false);
  const [running, setRunning] = useState(false);

  function patchRow(id: string, patch: Partial<RowState>) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  function appendLine(id: string, line: string) {
    setRows((prev) =>
      prev.map((r) =>
        r.id === id ? { ...r, progressLines: [...r.progressLines, line] } : r,
      ),
    );
  }

  async function startInstall() {
    setFailed(false);
    setRunning(true);

    // Mark optional deps as skipped immediately so the UI is clear.
    for (const dep of DEPS) {
      if (dep.optional) {
        patchRow(dep.id, { status: "skipped" });
      }
    }

    // Track which dep is currently running so we can mark it in the UI.
    let currentId: string | null = null;

    const summary = await runDepsInstall((depId, line) => {
      if (depId !== currentId) {
        // Dep changed — mark new dep as running, previous stays wherever it was.
        if (currentId) {
          // Let the result loop handle final status for previous dep.
        }
        currentId = depId;
        patchRow(depId, { status: "running" });
      }
      appendLine(depId, line);
    });

    // Apply final statuses from summary.
    for (const result of summary.results) {
      const status: RowStatus =
        result.status === "ok"
          ? "ok"
          : result.status === "skipped"
            ? "skipped"
            : "failed";
      patchRow(result.id, { status, error: result.error });
    }

    setRunning(false);

    void snapshotResults(summary.results);

    if (summary.allRequiredOk) {
      const installPath = getWizardState().installPath;
      if (installPath) {
        try {
          const installerVersion = await getInstallerVersion();
          await recordStepOk(installPath, installerVersion, "prerequisites");
        } catch {
          /* non-fatal */
        }
      }
      onNext?.();
    } else {
      setFailed(true);
    }
  }

  useEffect(() => {
    void startInstall();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const requiredRows = rows.filter((r) => !r.optional);
  const failedRows = requiredRows.filter((r) => r.status === "failed");

  return (
    <div className="flex flex-col gap-6 max-w-lg">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-medium text-white">Installing dependencies</h1>
        <p className="text-sm font-light text-zinc-400">
          Required tools install automatically. Optional tools are skipped.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        {rows.map((row) => (
          <DepProgressRow key={row.id} row={row} />
        ))}
      </div>

      {failed && failedRows.length > 0 && (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-red-400">
            {failedRows.length === 1
              ? `${failedRows[0].label} failed to install.`
              : `${failedRows.length} required tools failed to install.`}{" "}
            Check your connection and try again.
          </p>
          <button
            type="button"
            disabled={running}
            onClick={() => void startInstall()}
            className="w-fit px-6 py-2.5 rounded-full text-sm font-medium bg-white text-black hover:bg-zinc-100 transition-colors disabled:opacity-50"
          >
            Retry
          </button>
        </div>
      )}

      {running && (
        <p className="text-xs text-zinc-500 hq-text-shimmer">Installing…</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DepProgressRow
// ---------------------------------------------------------------------------

interface DepProgressRowProps {
  row: RowState;
}

function DepProgressRow({ row }: DepProgressRowProps) {
  return (
    <div
      className={`flex flex-col gap-2 bg-white/5 border border-white/10 rounded-xl px-4 py-3 transition-opacity duration-300 ${
        row.status === "skipped" ? "opacity-40" : "opacity-100"
      }`}
      data-dep={row.id}
      data-status={row.status}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col">
          <span className="text-sm font-medium text-zinc-200">
            {row.label}
            {row.optional && (
              <span className="ml-2 text-[10px] uppercase tracking-wider text-zinc-500 font-normal">
                Optional
              </span>
            )}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {row.status === "pending" && (
            <span className="text-xs text-zinc-600">Pending</span>
          )}
          {row.status === "running" && (
            <span className="text-xs text-zinc-400 hq-text-shimmer">Installing…</span>
          )}
          {row.status === "ok" && (
            <span className="text-xs text-green-400 animate-in fade-in-0 duration-500">
              Installed
            </span>
          )}
          {row.status === "skipped" && (
            <span className="text-xs text-zinc-600">Skipped</span>
          )}
          {row.status === "failed" && (
            <span className="text-xs text-red-400">Failed</span>
          )}
        </div>
      </div>

      {row.progressLines.length > 0 && (
        <div className="text-xs font-mono text-zinc-500 bg-black/20 rounded-lg px-3 py-2 max-h-32 overflow-y-auto">
          {row.progressLines.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}

      {row.status === "failed" && row.error && (
        <p className="text-xs text-zinc-400">{row.error}</p>
      )}
    </div>
  );
}
