// setup-progress.tsx — US-004
// Unified post-login orchestrator. Sequences six stages behind a single
// progress bar with no intermediate input:
//
//   1. deps        — runDepsInstall() (core deps; optionals skipped)
//   2. git-init    — invoke("git_init") with identity from Google idToken
//   3. s3-sync     — listUserCompanies → setTeam/setIsPersonal → optional S3 pull
//   4. personalize — personalize() with detected team + name
//   5. indexing    — qmd collection add (writes embeddings-pending marker)
//   6. menubar     — install_menubar_app (HQ Sync tray app)
//
// Folds the standalone 08-git-init, 10-indexing, and InstallMenubarStep
// screens. Each stage outcome is journaled to the install-manifest so a
// later /setup can resume any failed stage. On any failure the cursor
// freezes — prior stages keep their `ok` status and the user gets a Retry
// that resumes from the failure point.
//
// Note: this screen is wired into the router in US-005; here we just build
// the component + tests so the orchestrator can be tested in isolation.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  BaseDirectory,
  mkdir,
  writeTextFile,
} from "@tauri-apps/plugin-fs";
import { runDepsInstall, type DepInstallResult } from "@/lib/deps-install";
import { syncFromS3, vendStsCredentials } from "@/lib/s3-sync";
import { personalize, type CompanySeed } from "@/lib/personalize-writer";
import { getCurrentUser } from "@/lib/cognito";
import { listUserCompanies } from "@/lib/vault-handoff";
import {
  getWizardState,
  setGitIdentity,
  setIsPersonal,
  setPersonalized,
  setTeam,
} from "@/lib/wizard-state";
import {
  getInstallerVersion,
  recordDependencies,
  recordStepFailure,
  recordStepOk,
  recordStepStart,
  type ItemStatus,
} from "@/lib/install-manifest";

// ---------------------------------------------------------------------------
// Stage model
// ---------------------------------------------------------------------------

export type StageId =
  | "deps"
  | "git-init"
  | "s3-sync"
  | "personalize"
  | "indexing"
  | "menubar";

type StageStatus = "pending" | "running" | "ok" | "failed" | "skipped";

interface StageState {
  id: StageId;
  label: string;
  status: StageStatus;
  error: string | null;
  logLines: string[];
  expanded: boolean;
}

const STAGE_LABELS: Record<StageId, string> = {
  deps: "Installing dependencies",
  "git-init": "Initialising workspace",
  "s3-sync": "Syncing your HQ",
  personalize: "Personalizing",
  indexing: "Registering for search",
  menubar: "Installing HQ Sync",
};

// Order is part of the contract — the progress bar maps directly to indices.
const STAGE_ORDER: readonly StageId[] = [
  "deps",
  "git-init",
  "s3-sync",
  "personalize",
  "indexing",
  "menubar",
] as const;

function buildInitialStages(): StageState[] {
  return STAGE_ORDER.map((id) => ({
    id,
    label: STAGE_LABELS[id],
    status: "pending",
    error: null,
    logLines: [],
    expanded: false,
  }));
}

// Coarse mapping from a StageStatus to the manifest's ItemStatus vocabulary.
function toItemStatus(s: StageStatus): ItemStatus {
  return s;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface SetupProgressProps {
  installPath: string;
  onNext?: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SetupProgress({ installPath, onNext }: SetupProgressProps) {
  const [stages, setStages] = useState<StageState[]>(buildInitialStages);
  const [failedStage, setFailedStage] = useState<StageId | null>(null);
  const [running, setRunning] = useState(false);
  const [allDone, setAllDone] = useState(false);

  // React strict-mode double-mount guard — without it the orchestrator would
  // run twice and double-install everything.
  const startedRef = useRef(false);

  // ── Stage state helpers ────────────────────────────────────────────────

  const patchStage = useCallback((id: StageId, patch: Partial<StageState>) => {
    setStages((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }, []);

  const appendLog = useCallback((id: StageId, line: string) => {
    setStages((prev) =>
      prev.map((s) =>
        s.id === id ? { ...s, logLines: [...s.logLines, line] } : s,
      ),
    );
  }, []);

  const toggleExpanded = useCallback((id: StageId) => {
    setStages((prev) =>
      prev.map((s) => (s.id === id ? { ...s, expanded: !s.expanded } : s)),
    );
  }, []);

  // ── Manifest helpers (best-effort — never throw) ───────────────────────

  async function journalStart(stage: StageId) {
    try {
      const ver = await getInstallerVersion();
      await recordStepStart(installPath, ver, stage);
    } catch {
      /* non-fatal */
    }
  }

  async function journalOk(stage: StageId) {
    try {
      const ver = await getInstallerVersion();
      await recordStepOk(installPath, ver, stage);
    } catch {
      /* non-fatal */
    }
  }

  async function journalFail(stage: StageId, msg: string) {
    try {
      const ver = await getInstallerVersion();
      await recordStepFailure(installPath, ver, stage, msg);
    } catch {
      /* non-fatal */
    }
  }

  // ── Stage 1: deps ──────────────────────────────────────────────────────

  async function runDeps(): Promise<boolean> {
    const summary = await runDepsInstall((_id, line) => appendLog("deps", line));

    try {
      const ver = await getInstallerVersion();
      const snapshot: Record<
        string,
        { status: ItemStatus; version?: string; error?: string }
      > = {};
      for (const r of summary.results as DepInstallResult[]) {
        snapshot[r.id] = {
          status: r.status === "ok" ? "ok" : r.status === "skipped" ? "skipped" : "failed",
          error: r.error,
        };
      }
      await recordDependencies(installPath, ver, snapshot);
    } catch {
      /* non-fatal */
    }

    if (!summary.allRequiredOk) {
      const failed = summary.results.filter(
        (r) => !r.optional && r.status === "failed",
      );
      const msg =
        failed.length === 1
          ? `${failed[0].label} failed to install: ${failed[0].error ?? "unknown error"}`
          : `${failed.length} required tools failed to install`;
      patchStage("deps", { error: msg });
      return false;
    }
    return true;
  }

  // ── Stage 2: git-init ──────────────────────────────────────────────────

  async function runGitInit(): Promise<boolean> {
    try {
      const user = await getCurrentUser();
      const name = user
        ? (user.name ??
            [user.givenName, user.familyName].filter(Boolean).join(" ").trim())
        : "";
      const email = user?.email ?? "";

      if (!name || !email) {
        patchStage("git-init", {
          error: "Cannot initialise git without a signed-in user identity.",
        });
        return false;
      }

      const sha = await invoke<string>("git_init", {
        path: installPath,
        name,
        email,
      });
      appendLog("git-init", `Initialised repository (${sha.slice(0, 7)})`);
      setGitIdentity(name, email);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      patchStage("git-init", { error: msg });
      return false;
    }
  }

  // ── Stage 3: s3-sync (also doubles as team-detection) ──────────────────
  //
  // listUserCompanies tells us whether the user is on a team (cloud bucket
  // to sync) or going personal. Sets wizard-state.team / isPersonal so the
  // later personalize stage doesn't re-fetch.

  async function runS3Sync(): Promise<boolean> {
    try {
      const user = await getCurrentUser();
      if (!user) {
        // No signed-in user — nothing to sync. Mark skipped and continue.
        appendLog("s3-sync", "No signed-in user — skipping.");
        patchStage("s3-sync", { status: "skipped" });
        return true;
      }

      let companies: Awaited<ReturnType<typeof listUserCompanies>> = [];
      try {
        companies = await listUserCompanies(user.tokens.accessToken);
      } catch (err) {
        // Company lookup failure is non-fatal: fall back to personal HQ so
        // the install still completes. Surface the reason in the log panel.
        const msg = err instanceof Error ? err.message : String(err);
        appendLog("s3-sync", `[warn] Company lookup failed: ${msg}`);
      }

      if (companies.length === 0) {
        setIsPersonal(true);
        appendLog("s3-sync", "No cloud company — running as Personal HQ.");
        patchStage("s3-sync", { status: "skipped" });
        return true;
      }

      const first = companies[0];
      setTeam({
        teamId: first.companyUid,
        companyId: first.companyUid,
        slug: first.companySlug,
        name: first.companyName,
        joinedViaInvite: false,
        bucketName: first.bucketName,
        role: first.role,
      });

      if (!first.bucketName) {
        appendLog("s3-sync", "Team has no S3 bucket — skipping sync.");
        patchStage("s3-sync", { status: "skipped" });
        return true;
      }

      const creds = await vendStsCredentials(
        user.tokens.accessToken,
        first.companyUid,
        first.bucketName,
      );
      const { fileCount } = await syncFromS3(
        creds,
        installPath,
        (p) => {
          appendLog(
            "s3-sync",
            `${p.downloadedFiles}/${p.totalFiles} ${p.currentFile}`,
          );
        },
        `companies/${first.companySlug}`,
      );
      appendLog("s3-sync", `Synced ${fileCount} files.`);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      patchStage("s3-sync", { error: msg });
      return false;
    }
  }

  // ── Stage 4: personalize ───────────────────────────────────────────────

  async function runPersonalize(): Promise<boolean> {
    try {
      const user = await getCurrentUser();
      const name = user
        ? (user.name ??
            [user.givenName, user.familyName].filter(Boolean).join(" ").trim())
        : "";

      // s3-sync already populated wizard-state.team / isPersonal — re-use it
      // here rather than re-calling listUserCompanies.
      const state = getWizardState();
      let companies: CompanySeed[] | undefined;
      if (state.team) {
        companies = [
          {
            name: state.team.name,
            cloud: true,
            cloudCompanyUid: state.team.companyId,
          },
        ];
      }

      await personalize({ name, companies }, installPath);
      setPersonalized(true);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      patchStage("personalize", { error: msg });
      return false;
    }
  }

  // ── Stage 5: indexing ──────────────────────────────────────────────────
  //
  // qmd collection add . --name <slug>, falling back to `qmd update` if the
  // collection already exists. Writes a pending-embeddings marker so HQ Sync
  // picks up indexing on next launch.

  async function spawnAndWait(
    stage: StageId,
    cmd: string,
    args: string[],
    cwd: string,
    stderrSink?: string[],
  ): Promise<boolean> {
    let handle: string;
    try {
      handle = await invoke<string>("spawn_process", {
        args: { cmd, args, cwd },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      patchStage(stage, { error: msg });
      return false;
    }

    const stdoutUnlisten = await listen(
      `process://${handle}/stdout`,
      (event: { payload: unknown }) => {
        const payload = event.payload as { line?: string };
        appendLog(stage, payload?.line ?? "");
      },
    );
    const stderrUnlisten = await listen(
      `process://${handle}/stderr`,
      (event: { payload: unknown }) => {
        const payload = event.payload as { line?: string };
        const line = payload?.line ?? "";
        appendLog(stage, `[stderr] ${line}`);
        stderrSink?.push(line);
      },
    );

    return new Promise<boolean>((resolve) => {
      listen(`process://${handle}/exit`, (event: { payload: unknown }) => {
        const payload = event.payload as {
          code: number | null;
          success: boolean;
        };
        (stdoutUnlisten as () => void)();
        (stderrUnlisten as () => void)();
        if (payload.success) {
          resolve(true);
        } else {
          patchStage(stage, {
            error: `Process exited with code ${payload.code ?? -1}`,
          });
          resolve(false);
        }
      });
    });
  }

  async function runIndexing(): Promise<boolean> {
    const slug = installPath.split("/").filter(Boolean).pop() || "hq";
    const stderrBuf: string[] = [];
    let ok = await spawnAndWait(
      "indexing",
      "qmd",
      ["collection", "add", ".", "--name", slug],
      installPath,
      stderrBuf,
    );
    if (
      !ok &&
      stderrBuf.some((l) => l.toLowerCase().includes("already exists"))
    ) {
      // Benign — re-index the existing collection.
      patchStage("indexing", { error: null });
      appendLog(
        "indexing",
        `[info] Collection "${slug}" already exists — re-indexing.`,
      );
      ok = await spawnAndWait(
        "indexing",
        "qmd",
        ["update", "--name", slug],
        installPath,
      );
    }
    if (!ok) return false;

    // Embeddings-pending marker — best-effort, never fails the stage.
    const payload = JSON.stringify({
      requestedAt: new Date().toISOString(),
      reason: "post-install",
    });
    try {
      await writeTextFile(
        `${installPath.replace(/\/+$/, "")}/.hq-embeddings-pending.json`,
        payload,
      );
    } catch {
      try {
        await mkdir(".hq", { baseDir: BaseDirectory.Home, recursive: true });
        await writeTextFile(".hq/embeddings-pending.json", payload, {
          baseDir: BaseDirectory.Home,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        appendLog("indexing", `[warn] Could not write embeddings marker: ${msg}`);
      }
    }
    return true;
  }

  // ── Stage 6: menubar (HQ Sync) ─────────────────────────────────────────

  async function runMenubar(): Promise<boolean> {
    const unlisten = await listen<{
      phase?: string;
      percent?: number;
      message?: string;
      done?: boolean;
      error?: string;
    }>("menubar-install://progress", (event) => {
      const p = event.payload;
      if (p.error) {
        appendLog("menubar", `[error] ${p.error}`);
        return;
      }
      const line = [
        p.phase,
        typeof p.percent === "number" ? `${p.percent}%` : null,
        p.message,
      ]
        .filter(Boolean)
        .join(" — ");
      if (line) appendLog("menubar", line);
    });

    try {
      const result = await invoke<{
        success: boolean;
        appPath: string | null;
        error: string | null;
      }>("install_menubar_app");
      if (result.success) {
        if (result.appPath) appendLog("menubar", `Installed at ${result.appPath}`);
        // Best-effort: launch HQ Sync immediately so the menu bar icon is
        // visible when the user reaches Done. Failure here never blocks.
        try {
          await invoke("launch_menubar_app");
        } catch {
          /* non-fatal */
        }
        return true;
      }
      patchStage("menubar", { error: result.error ?? "Installation failed" });
      return false;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      patchStage("menubar", { error: msg });
      return false;
    } finally {
      (unlisten as () => void)();
    }
  }

  // ── Stage dispatcher ───────────────────────────────────────────────────

  async function runStage(id: StageId): Promise<boolean> {
    patchStage(id, { status: "running", error: null });
    await journalStart(id);
    let ok = false;
    switch (id) {
      case "deps":
        ok = await runDeps();
        break;
      case "git-init":
        ok = await runGitInit();
        break;
      case "s3-sync":
        ok = await runS3Sync();
        break;
      case "personalize":
        ok = await runPersonalize();
        break;
      case "indexing":
        ok = await runIndexing();
        break;
      case "menubar":
        ok = await runMenubar();
        break;
    }
    if (ok) {
      // Stage runners may have explicitly set status to "skipped" — preserve
      // it; otherwise mark "ok".
      setStages((prev) =>
        prev.map((s) =>
          s.id === id && s.status !== "skipped"
            ? { ...s, status: "ok" }
            : s,
        ),
      );
      await journalOk(id);
    } else {
      patchStage(id, { status: "failed" });
      // Capture the error message from the stage state for the manifest.
      const msg =
        stages.find((s) => s.id === id)?.error ??
        "Stage failed (no detail recorded).";
      await journalFail(id, msg);
    }
    return ok;
  }

  // ── Orchestrator ───────────────────────────────────────────────────────

  const runFromStage = useCallback(
    async (startId: StageId) => {
      setRunning(true);
      setFailedStage(null);
      setAllDone(false);

      // Reset the failing stage onward; keep earlier stages' final status.
      const startIdx = STAGE_ORDER.indexOf(startId);
      setStages((prev) =>
        prev.map((s, i) =>
          i >= startIdx
            ? {
                ...s,
                status: "pending",
                error: null,
                logLines: [],
              }
            : s,
        ),
      );

      for (let i = startIdx; i < STAGE_ORDER.length; i += 1) {
        const id = STAGE_ORDER[i];
        const ok = await runStage(id);
        if (!ok) {
          setFailedStage(id);
          setRunning(false);
          return;
        }
      }
      setRunning(false);
      setAllDone(true);
      onNext?.();
    },
    // We intentionally only depend on installPath — onNext is captured fresh
    // each render via closure, and the inner helpers read from refs/setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [installPath],
  );

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void runFromStage("deps");
  }, [runFromStage]);

  // ── Derived progress ────────────────────────────────────────────────────
  //
  // Single progress bar: count stages that are settled (ok or skipped) as
  // complete. Failed stages don't advance the bar — the user sees the bar
  // freeze at the failure point, which makes the retry semantics obvious.

  const settledCount = stages.filter(
    (s) => s.status === "ok" || s.status === "skipped",
  ).length;
  const percent = Math.round((settledCount / STAGE_ORDER.length) * 100);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="flex flex-col gap-6 max-w-lg" data-testid="setup-progress">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-medium text-white">Setting up HQ</h1>
        <p className="text-sm font-light text-zinc-400">
          {allDone
            ? "All set. Continuing…"
            : failedStage
              ? "A step needs attention."
              : "This will only take a moment."}
        </p>
      </div>

      {/* Single progress bar — the whole point of US-004. */}
      <div
        className="flex flex-col gap-2"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        data-testid="overall-progress"
      >
        <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
          <div
            className="h-full rounded-full bg-white transition-all duration-300 ease-out"
            style={{ width: `${Math.max(2, percent)}%` }}
          />
        </div>
        <div className="flex items-center justify-between text-xs text-zinc-500">
          <span>
            {settledCount} / {STAGE_ORDER.length} steps
          </span>
          <span>{percent}%</span>
        </div>
      </div>

      {/* Per-stage rows — detail hidden by default, expandable. */}
      <div className="flex flex-col gap-2">
        {stages.map((stage) => (
          <StageRow
            key={stage.id}
            stage={stage}
            onToggleExpanded={() => toggleExpanded(stage.id)}
          />
        ))}
      </div>

      {/* Retry — appears only when a stage has failed and we're idle. The
          orchestrator never renders Next / Continue / Skip controls; the
          unified bar advances to Done automatically on success. */}
      {failedStage && !running && (
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => void runFromStage(failedStage)}
            className="px-6 py-2.5 rounded-full text-sm font-medium bg-white text-black hover:bg-zinc-100 transition-colors"
            data-testid="retry-button"
          >
            Retry
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// StageRow — collapsed by default, expandable per the PRD ("stage detail is
// hidden by default"). Status badge derived directly from StageStatus so the
// vocabulary stays aligned with install-manifest's ItemStatus.
// ---------------------------------------------------------------------------

interface StageRowProps {
  stage: StageState;
  onToggleExpanded: () => void;
}

function StageRow({ stage, onToggleExpanded }: StageRowProps) {
  // Render shouldn't surprise the reader: silence the `toItemStatus` import
  // by referencing it once — it documents the vocabulary alignment.
  void toItemStatus;
  return (
    <div
      data-stage={stage.id}
      data-status={stage.status}
      className={`flex flex-col gap-2 bg-white/5 border border-white/10 rounded-xl px-4 py-3 transition-opacity duration-300 ${
        stage.status === "skipped" ? "opacity-50" : "opacity-100"
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-zinc-200">{stage.label}</span>
        <div className="flex items-center gap-2">
          {stage.status === "pending" && (
            <span className="text-xs text-zinc-600">Waiting</span>
          )}
          {stage.status === "running" && (
            <span className="text-xs text-zinc-400 hq-text-shimmer">Working…</span>
          )}
          {stage.status === "ok" && (
            <span className="text-xs text-green-400">Done</span>
          )}
          {stage.status === "skipped" && (
            <span className="text-xs text-zinc-500">Skipped</span>
          )}
          {stage.status === "failed" && (
            <span className="text-xs text-red-400">Failed</span>
          )}

          {/* Detail toggle hides until the stage has output to show — keeps
              the row clean while waiting. */}
          {(stage.logLines.length > 0 || stage.status !== "pending") && (
            <button
              type="button"
              onClick={onToggleExpanded}
              className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
              aria-label={stage.expanded ? "Hide details" : "Show details"}
            >
              {stage.expanded ? "Hide" : "Details"}
            </button>
          )}
        </div>
      </div>

      {stage.expanded && (
        <div
          data-log-panel
          className="text-xs font-mono text-zinc-500 bg-black/20 rounded-lg px-3 py-2 max-h-32 overflow-y-auto"
        >
          {stage.logLines.length === 0 ? (
            <div className="text-zinc-600 italic">(no output)</div>
          ) : (
            stage.logLines.map((line, i) => <div key={i}>{line}</div>)
          )}
        </div>
      )}

      {stage.status === "failed" && stage.error && (
        <p className="text-xs text-red-400 break-words">{stage.error}</p>
      )}
    </div>
  );
}
