// setup-progress.tsx — US-004
// Unified post-login orchestrator. Sequences eight stages behind a single
// progress bar with one explanatory line and no intermediate input:
//
//   1. deps         — runDepsInstall() (core deps; optionals skipped)
//   2. initial-sync — provision the personal vault bucket + spawn the
//                     hq-cloud-sync runner in the background (best-effort)
//   3. packages     — install the default HQ content packs (no picker)
//   4. git-init     — invoke("git_init") with identity from Google idToken
//   5. personalize  — detect cloud company (non-fatal) + personalize()
//   6. import       — apply Codex parity + defer Claude adoption handoff
//   7. indexing     — qmd collection add (writes embeddings-pending marker)
//   8. menubar      — install_menubar_app (HQ Sync tray app)
//
// The initial cloud sync is kicked off HERE, as early as the flow allows
// (login already happened; deps just put node/npx on disk), and deliberately
// before packages per product direction — the runner syncs concurrently while
// the remaining stages run. It is fire-and-forget: the stage only provisions
// the personal bucket and launches the runner, then moves on. The HQ Sync
// menu-bar app (last stage) still owns continuous sync and re-reconciles on
// first launch, which also covers anything written after the runner's pass
// (packages, personalization, company detection).
//
// Each stage outcome is journaled to the install-manifest so a later /setup
// can resume any failed stage. On failure the bar freezes — prior stages keep
// their `ok` status and the user gets a Retry that resumes from the failure
// point. (initial-sync and import are the exceptions: kickoff/discovery
// failures are journaled but never fail the stage.)

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  BaseDirectory,
  mkdir,
  readTextFile,
  rename,
  writeTextFile,
} from "@tauri-apps/plugin-fs";
import { runDepsInstall, type DepInstallResult } from "@/lib/deps-install";
import { personalize, type CompanySeed } from "@/lib/personalize-writer";
import { getCurrentUser } from "@/lib/cognito";
import {
  claimPendingInvitesForUser,
  listUserCompanies,
} from "@/lib/vault-handoff";
import { startInitialCloudSync } from "@/lib/initial-sync";
import {
  setGitIdentity,
  setIsPersonal,
  setPersonalized,
  setTeam,
} from "@/lib/wizard-state";
import {
  getInstallerVersion,
  recordDependencies,
  recordImport,
  recordPacks,
  recordStepFailure,
  recordStepOk,
  recordStepStart,
  type ItemStatus,
} from "@/lib/install-manifest";
import { getDefaultPacks, type DefaultPack } from "@/lib/default-packs";
import { runExistingImport } from "@/lib/import-existing";

// ---------------------------------------------------------------------------
// Stage model
// ---------------------------------------------------------------------------

export type StageId =
  | "deps"
  | "initial-sync"
  | "packages"
  | "git-init"
  | "personalize"
  | "import"
  | "indexing"
  | "menubar";

type StageStatus = "pending" | "running" | "ok" | "failed";

interface StageState {
  id: StageId;
  label: string;
  status: StageStatus;
  error: string | null;
  logLines: string[];
}

const STAGE_LABELS: Record<StageId, string> = {
  deps: "Installing dependencies",
  "initial-sync": "Starting initial cloud sync",
  packages: "Installing packages",
  "git-init": "Initialising workspace",
  personalize: "Personalizing",
  import: "Importing existing setup",
  indexing: "Registering for search",
  menubar: "Installing HQ Sync",
};

// Order is part of the contract — the progress bar maps directly to indices.
// initial-sync sits right after deps (the earliest point node/npx exist) and
// before packages, so the cloud sync runs concurrently with the rest of setup.
const STAGE_ORDER: readonly StageId[] = [
  "deps",
  "initial-sync",
  "packages",
  "git-init",
  "personalize",
  "import",
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
  }));
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

  // ── Stage 2: initial-sync (provision personal vault + spawn the runner) ─
  //
  // The earliest point the first cloud sync can start: the user is signed in
  // (pre-this-screen) and deps just put node/npx on disk. We guarantee the
  // personal vault bucket exists (the runner 422s on a missing bucket — the
  // signup-time auto-provision is fire-and-forget and can silently miss),
  // then spawn the same hq-cloud-sync runner HQ Sync uses and move on
  // without waiting. ALWAYS returns true: a kickoff failure is journaled to
  // the manifest's failure ledger but never blocks the install — the HQ Sync
  // menu-bar app re-runs the same sync on first launch regardless.

  async function runInitialSync(): Promise<boolean> {
    try {
      const user = await getCurrentUser();
      if (!user) {
        appendLog(
          "initial-sync",
          "[warn] No signed-in user — skipping; HQ Sync will sync on first launch.",
        );
        return true;
      }
      const name =
        user.name ??
        [user.givenName, user.familyName].filter(Boolean).join(" ").trim();
      const { personUid, handle } = await startInitialCloudSync(
        installPath,
        user.tokens.accessToken,
        { ownerSub: user.sub, displayName: name || user.email },
      );
      appendLog(
        "initial-sync",
        `Personal vault ready (${personUid}); sync running in the background (${handle}).`,
      );
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      appendLog("initial-sync", `[warn] Initial cloud sync did not start: ${msg}`);
      // Leave a failure-ledger row for a later /setup; the dispatcher's
      // journalOk then marks the STEP ok (accurate — the install isn't
      // blocked), while the failures[] entry preserves what went wrong.
      try {
        const ver = await getInstallerVersion();
        await recordStepFailure(installPath, ver, "initial-sync", msg);
      } catch {
        /* non-fatal */
      }
      return true;
    }
  }

  // ── Stage 3: packages (default HQ content packs) ───────────────────────
  //
  // Installs HQ's default content packs right after login, with NO selection
  // UI — the v4.x wizard let you pick from a catalog; the streamlined flow
  // just installs the default set. We shell the deps-installed `hq` directly
  // (mirroring how HQ Sync installs packs: `hq install <source> --allow-hooks`)
  // rather than npx — `hq` is on the managed-toolchain PATH the spawner uses
  // (the same one that resolves `qmd` for indexing), and `--allow-hooks` skips
  // the interactive hooks prompt that would otherwise hang a headless run. The
  // sources are npm scope specs so no git is required (a fresh consumer Mac has
  // none, which is exactly what broke the old `github:` transport). Runs before
  // git-init so install operates on the plain scaffold.
  //
  // Per-pack failures are NON-FATAL: each outcome is journaled to the
  // install-manifest (so a later /setup can finish the job) and the stage
  // still succeeds — one flaky pack fetch never blocks the whole install.

  async function runPackages(): Promise<boolean> {
    const packs: DefaultPack[] = getDefaultPacks();
    if (packs.length === 0) return true;

    const outcomes: Record<string, { status: ItemStatus; error?: string }> = {};
    for (const pack of packs) {
      appendLog("packages", `Installing ${pack.name}…`);
      const ok = await spawnAndWait(
        "packages",
        "hq",
        ["install", pack.source, "--allow-hooks"],
        installPath,
      );
      if (ok) {
        outcomes[pack.name] = { status: "ok" };
      } else {
        outcomes[pack.name] = {
          status: "failed",
          error: `hq install ${pack.name} failed`,
        };
        appendLog(
          "packages",
          `[warn] ${pack.name} did not install — add it later with: hq install ${pack.source}`,
        );
        // Pack failures are non-fatal — clear the error spawnAndWait recorded
        // so a single pack doesn't freeze the stage.
        patchStage("packages", { error: null });
      }
    }

    // Journal per-pack outcomes (best-effort — never blocks).
    try {
      const ver = await getInstallerVersion();
      await recordPacks(installPath, ver, outcomes);
    } catch {
      /* non-fatal */
    }

    return true;
  }

  // ── Stage 4: git-init ──────────────────────────────────────────────────

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

  // ── Stage 5: personalize (with non-fatal company detection) ────────────
  //
  // We detect which cloud company the user belongs to so the Done screen and
  // the personalized HQ reflect it, then personalize from the Google name.
  // We do NOT pull the company's files here — that's HQ Sync's job. Company
  // detection is best-effort: a lookup failure falls back to Personal HQ so
  // the install always completes.

  async function runPersonalize(): Promise<boolean> {
    try {
      const user = await getCurrentUser();
      const name = user
        ? (user.name ??
            [user.givenName, user.familyName].filter(Boolean).join(" ").trim())
        : "";

      let companies: CompanySeed[] | undefined;
      if (user) {
        // Claim any email-keyed pending invites FIRST. A freshly-invited user
        // (e.g. a reinstall on a new machine) has an invite keyed by their
        // email, not yet an active personUid-keyed membership — so the company
        // lookup below would return nothing and the install would silently fall
        // back to "Personal HQ", leaving them unattached. This rewrites the
        // invite to an active membership so detection can see it. Best-effort:
        // a failure here is logged, never fatal (the lookup just finds nothing,
        // exactly as before).
        try {
          await claimPendingInvitesForUser(user.tokens.accessToken, {
            ownerSub: user.sub,
            displayName:
              name || user.name || user.email || user.sub,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          appendLog("personalize", `[warn] Invite claim failed: ${msg}`);
        }

        let cloud: Awaited<ReturnType<typeof listUserCompanies>> = [];
        try {
          cloud = await listUserCompanies(user.tokens.accessToken);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          appendLog("personalize", `[warn] Company lookup failed: ${msg}`);
        }

        if (cloud.length > 0) {
          const first = cloud[0];
          setTeam({
            teamId: first.companyUid,
            companyId: first.companyUid,
            slug: first.companySlug,
            name: first.companyName,
            joinedViaInvite: false,
            bucketName: first.bucketName,
            role: first.role,
          });
          companies = [
            {
              name: first.companyName,
              cloud: true,
              cloudCompanyUid: first.companyUid,
            },
          ];
          appendLog(
            "personalize",
            `Detected company ${first.companyName} — HQ Sync will sync its files.`,
          );
        } else {
          setIsPersonal(true);
        }
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

  // ── Stage 6: import (best-effort Codex parity + deferred Claude handoff) ─
  //
  // The HQ scaffold is already on disk by now, so we can safely shell the
  // source-of-truth import scripts from this install root. Deterministic,
  // additive Codex parity is auto-applied here; Claude adoption is limited to
  // a redacted scan + breadcrumb so the Summary screen can offer a one-click
  // `/import-claude` handoff after install. ALWAYS returns true: missing
  // scripts, scan failures, or parse problems are journaled, never blocking.

  async function runImport(): Promise<boolean> {
    appendLog("import", "Checking for an existing Claude or Codex setup…");

    try {
      const summary = await runExistingImport({
        installPath,
        onLog: (line) => appendLog("import", line),
        spawn: (cmd, args, cwd) => spawnAndCapture("import", cmd, args, cwd),
        fs: {
          mkdir: (path, opts) => mkdir(path, { recursive: opts?.recursive ?? false }),
          readTextFile,
          writeTextFile,
          rename,
        },
      });

      if (
        summary.discoveryOk &&
        typeof summary.totalClaudeArtifacts === "number" &&
        summary.totalClaudeArtifacts > 0
      ) {
        appendLog(
          "import",
          `Deferred ${summary.totalClaudeArtifacts} Claude artifact${summary.totalClaudeArtifacts === 1 ? "" : "s"} for /import-claude after install.`,
        );
      } else if (!summary.discoveryOk) {
        appendLog(
          "import",
          "[warn] Claude discovery was incomplete — you can still run /import-claude later.",
        );
      }

      try {
        const ver = await getInstallerVersion();
        await recordImport(installPath, ver, {
          codexApplied: summary.codexApplied,
          discoveryOk: summary.discoveryOk,
          claudeCounts: summary.claudeCounts,
          totalClaudeArtifacts: summary.totalClaudeArtifacts,
        });
        if (summary.issues.length > 0) {
          await recordStepFailure(
            installPath,
            ver,
            "import",
            "Existing setup import completed with warnings.",
            {
              issues: summary.issues,
              codexApplied: summary.codexApplied,
              discoveryOk: summary.discoveryOk,
              totalClaudeArtifacts: summary.totalClaudeArtifacts,
            },
          );
        }
      } catch {
        /* non-fatal */
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      appendLog("import", `[warn] Existing setup import did not complete: ${msg}`);
      try {
        const ver = await getInstallerVersion();
        await recordStepFailure(
          installPath,
          ver,
          "import",
          `Existing setup import did not complete: ${msg}`,
        );
        await recordImport(installPath, ver, {
          codexApplied: false,
          discoveryOk: false,
          claudeCounts: null,
          totalClaudeArtifacts: null,
        });
      } catch {
        /* non-fatal */
      }
    }

    return true;
  }

  // ── Stage 7: indexing ──────────────────────────────────────────────────
  //
  // qmd collection add . --name <slug>, falling back to `qmd update` if the
  // collection already exists. Writes a pending-embeddings marker so HQ Sync
  // picks up indexing on next launch.

  async function spawnAndCapture(
    stage: StageId,
    cmd: string,
    args: string[],
    cwd: string,
  ): Promise<{ ok: boolean; stdout: string; stderr: string[] }> {
    let handle: string;
    try {
      handle = await invoke<string>("spawn_process", {
        args: { cmd, args, cwd },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      patchStage(stage, { error: msg });
      return { ok: false, stdout: "", stderr: [msg] };
    }

    try {
      const stdoutLines: string[] = [];
      const stderrLines: string[] = [];

      const stdoutUnlisten = await listen(
        `process://${handle}/stdout`,
        (event: { payload: unknown }) => {
          const payload = event.payload as { line?: string };
          const line = payload?.line ?? "";
          stdoutLines.push(line);
          appendLog(stage, line);
        },
      );
      const stderrUnlisten = await listen(
        `process://${handle}/stderr`,
        (event: { payload: unknown }) => {
          const payload = event.payload as { line?: string };
          const line = payload?.line ?? "";
          stderrLines.push(line);
          appendLog(stage, `[stderr] ${line}`);
        },
      );

      let resolveExit: ((value: { ok: boolean; stdout: string; stderr: string[] }) => void) | null =
        null;
      const exitResult = new Promise<{
        ok: boolean;
        stdout: string;
        stderr: string[];
      }>((resolve) => {
        resolveExit = resolve;
      });

      let exitUnlisten: (() => void) | null = null;
      exitUnlisten = await listen(
        `process://${handle}/exit`,
        (event: { payload: unknown }) => {
          const payload = event.payload as {
            code: number | null;
            success: boolean;
          };
          (stdoutUnlisten as () => void)();
          (stderrUnlisten as () => void)();
          exitUnlisten?.();
          if (!payload.success) {
            patchStage(stage, {
              error: `Process exited with code ${payload.code ?? -1}`,
            });
          }
          resolveExit?.({
            ok: payload.success,
            stdout: stdoutLines.join("\n"),
            stderr: stderrLines,
          });
        },
      );

      return await exitResult;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      patchStage(stage, { error: msg });
      return { ok: false, stdout: "", stderr: [msg] };
    }
  }

  async function spawnAndWait(
    stage: StageId,
    cmd: string,
    args: string[],
    cwd: string,
    stderrSink?: string[],
  ): Promise<boolean> {
    const result = await spawnAndCapture(stage, cmd, args, cwd);
    stderrSink?.push(...result.stderr);
    return result.ok;
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

  // ── Stage 8: menubar (HQ Sync) ─────────────────────────────────────────

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
      case "initial-sync":
        ok = await runInitialSync();
        break;
      case "packages":
        ok = await runPackages();
        break;
      case "git-init":
        ok = await runGitInit();
        break;
      case "personalize":
        ok = await runPersonalize();
        break;
      case "import":
        ok = await runImport();
        break;
      case "indexing":
        ok = await runIndexing();
        break;
      case "menubar":
        ok = await runMenubar();
        break;
    }
    if (ok) {
      patchStage(id, { status: "ok" });
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

  // ── Derived progress + status line ──────────────────────────────────────
  //
  // Single progress bar + one explanatory line. The bar counts completed
  // (ok) stages; a failed stage freezes it so the retry semantics are obvious.

  const settledCount = stages.filter((s) => s.status === "ok").length;
  const percent = Math.round((settledCount / STAGE_ORDER.length) * 100);

  const activeStage = stages.find((s) => s.status === "running");
  const failed = failedStage
    ? (stages.find((s) => s.id === failedStage) ?? null)
    : null;
  const statusText = allDone
    ? "All set. Continuing…"
    : failed
      ? (failed.error ?? `${failed.label} needs attention.`)
      : activeStage
        ? `${activeStage.label}…`
        : "Starting…";
  const statusStage = failed?.id ?? activeStage?.id ?? null;
  const statusKind = failed ? "failed" : allDone ? "done" : "running";

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="flex flex-col gap-6 max-w-lg" data-testid="setup-progress">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-medium text-white">Setting up HQ</h1>
      </div>

      {/* Single progress bar + one explanatory line — the whole point of US-004. */}
      <div className="flex flex-col gap-3">
        <div
          className="h-1.5 rounded-full bg-white/10 overflow-hidden"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          data-testid="overall-progress"
        >
          <div
            className="h-full rounded-full bg-white transition-all duration-300 ease-out"
            style={{ width: `${Math.max(2, percent)}%` }}
          />
        </div>

        {/* One line under the bar that explains what's happening right now. */}
        <p
          data-testid="status-line"
          data-stage={statusStage ?? undefined}
          data-status={statusKind}
          className={`text-sm break-words ${
            failed
              ? "text-red-400"
              : allDone
                ? "text-zinc-400"
                : "text-zinc-400 hq-text-shimmer"
          }`}
        >
          {statusText}
        </p>
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
