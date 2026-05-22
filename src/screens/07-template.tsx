// 07-template.tsx — US-016
// Template fetch + HQ pack install.
//
// Phase 1 — Template:
//   `fetchAndExtract()` from `@/lib/template-fetcher` resolves the latest
//   non-prerelease release on `indigoai-us/hq-core` via the GitHub Release
//   API, streams the tarball through `@tauri-apps/plugin-http` (reqwest
//   bypasses CORS), gunzips + parses tar in-memory, and writes each entry
//   with `@tauri-apps/plugin-fs`.
//
// Phase 2 — HQ packs (opt-in, user-selected):
//   After the template lands the screen pauses on a pack-choice step. It
//   enumerates every pack in `indigoai-us/hq-packages` (see
//   `@/lib/pack-registry`) and renders one checkbox per pack — packs that
//   core.yaml marks `recommended` start checked. The user picks any subset;
//   Continue installs exactly the checked packs via
//   `npx --package=@indigoai-us/hq-cli hq install <source>`, one at a time
//   with `cwd = installPath`. Unchecked packs are recorded as `skipped` in
//   the install manifest and can be added later with `hq install`. If the
//   catalog can't be reached we fall back to the four core add-on packs.
//   Stdout/stderr is streamed into the visible log panel AND flushed to
//   `{installPath}/.hq-install-log/packs.log` on exit. Pack errors are
//   non-fatal: Continue stays enabled with a warning so the user can retry.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { WizardFooterSlot } from "@/components/WizardFooter";
import { listen } from "@tauri-apps/api/event";
import { mkdir, writeTextFile } from "@tauri-apps/plugin-fs";
import {
  fetchAndExtract,
  TemplateFetchError,
  type ProgressEvent as TemplateProgressEvent,
} from "@/lib/template-fetcher";
import {
  fetchAvailablePacks,
  readRecommendedPackIds,
  FALLBACK_PACKS,
} from "@/lib/pack-registry";
import {
  getInstallerVersion,
  recordStepStart,
  recordStepFailure,
  recordPacks,
  updateManifest,
} from "@/lib/install-manifest";
import { pingFailure } from "@/lib/telemetry";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Pinned to the first hq-cli build that ships with a published hq-onboarding
 *  dep (5.5.1 shipped with `@indigoai-us/hq-onboarding@0.1.0` which was never
 *  published, breaking the npx resolver). Bump this deliberately — a floating
 *  `latest` hid the 404 once already. */
const HQ_CLI_PIN = "@indigoai-us/hq-cli@5.5.2";

const PACK_LOG_DIR = ".hq-install-log";
const PACK_LOG_FILE = "packs.log";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Phase =
  | "idle"
  | "fetching"
  | "awaiting-pack-choice"
  | "installing-packs"
  | "installing-node"
  | "retrying-packs"
  | "done"
  | "done-with-warnings"
  | "error";

/** Spawn-error pattern when the wizard's npx call fails because Node is
 *  not yet installed. Surfaces in `pack.errorMsg` as the literal string
 *  emitted by `commands::process::run_process_impl`:
 *    "command not found on PATH: npx"
 *  Also matches `node` in case future npm tooling probes node directly. */
const NODE_MISSING_PATTERN = /command not found on PATH: (npx|node)/i;

type PackStatus = "pending" | "running" | "done" | "error";

interface PackState {
  /** `hq-pack-*` directory name — stable key, manifest id, log label. */
  id: string;
  /** Human description from the pack's package.yaml. */
  description: string;
  /** Source spec passed to `hq install`. */
  source: string;
  /** Whether the user wants this pack installed. */
  selected: boolean;
  status: PackStatus;
  errorMsg: string | null;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface TemplateFetchProps {
  targetDir: string;
  onNext?: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TemplateFetch({ targetDir, onNext }: TemplateFetchProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [downloaded, setDownloaded] = useState(0);
  const [total, setTotal] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);
  // Available packs — populated by loadAvailablePacks() from the catalog once
  // the template lands. Each carries its own `selected` flag (the checkbox).
  const [packs, setPacks] = useState<PackState[]>([]);
  // Pack-catalog fetch state, surfaced on the awaiting-pack-choice screen.
  const [registryLoading, setRegistryLoading] = useState(false);
  const [registryError, setRegistryError] = useState<string | null>(null);

  // Prevent double-starts in strict mode, and allow in-flight cancellation.
  const runningRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  // Listeners registered during the pack-install phase — tracked so we can
  // clean them up on unmount or retry.
  const unlistenRefs = useRef<Array<() => void>>([]);
  // Accumulated log (template + all packs) — flushed to disk on completion.
  const diskLogRef = useRef<string[]>([]);

  // -------------------------------------------------------------------------
  // Log helpers
  // -------------------------------------------------------------------------

  function appendLog(line: string) {
    setLogLines((prev) => [...prev, line]);
    diskLogRef.current.push(line);
  }

  async function flushDiskLog() {
    // Best-effort diagnostic write — don't surface failures in the UI.
    try {
      const dir = `${targetDir}/${PACK_LOG_DIR}`;
      await mkdir(dir, { recursive: true });
      const body =
        `# HQ install log — ${new Date().toISOString()}\n` +
        `# target: ${targetDir}\n\n` +
        diskLogRef.current.join("\n") + "\n";
      await writeTextFile(`${dir}/${PACK_LOG_FILE}`, body);
    } catch {
      /* ignore */
    }
  }

  // -------------------------------------------------------------------------
  // Phase 2: discover + install HQ packs
  // -------------------------------------------------------------------------

  function patchPack(idx: number, patch: Partial<PackState>) {
    setPacks((prev) => prev.map((p, i) => (i === idx ? { ...p, ...patch } : p)));
  }

  /** Enumerate the pack catalog and seed `packs` with the user's default
   *  selection — packs core.yaml marks recommended start checked. Falls back
   *  to the four core add-on packs if the catalog can't be reached. */
  async function loadAvailablePacks(): Promise<void> {
    setRegistryLoading(true);
    setRegistryError(null);

    // Default to the bundled fallback list; replace it with the live catalog
    // when the fetch succeeds with a non-empty result.
    let available = FALLBACK_PACKS;
    try {
      const fetched = await fetchAvailablePacks(abortRef.current?.signal);
      if (fetched.length > 0) available = fetched;
    } catch (err) {
      if (abortRef.current?.signal.aborted) return;
      setRegistryError(err instanceof Error ? err.message : String(err));
    }

    // Pre-check recommended packs. If core.yaml yields no recommendations we
    // can't tell which are staples, so pre-check everything and let the user
    // pare it down — the checkboxes make the choice explicit either way.
    const recommended = await readRecommendedPackIds(targetDir);
    setPacks(
      available.map((p) => ({
        id: p.dir,
        description: p.description,
        source: p.source,
        selected: recommended.size > 0 ? recommended.has(p.dir) : true,
        status: "pending" as const,
        errorMsg: null,
      })),
    );
    setRegistryLoading(false);
  }

  /** Best-effort pack-status write to {targetDir}/.hq/install-manifest.json.
   *  Failures are swallowed — the diskLog flush + UI state remain the user-
   *  visible record. The manifest is the agent-readable record. */
  async function writePackStatus(
    id: string,
    status: "running" | "ok" | "failed",
    error?: string,
  ): Promise<void> {
    if (!targetDir) return;
    try {
      const installerVersion = await getInstallerVersion();
      await recordPacks(targetDir, installerVersion, {
        [id]: { status, error },
      });
    } catch {
      /* ignore */
    }
  }

  /** Spawn `npx ... hq install <source>` with cwd = targetDir and stream
   *  stdout/stderr into the visible log. Resolves true on exit 0. */
  async function installOnePack(idx: number, pack: PackState): Promise<boolean> {
    patchPack(idx, { status: "running" });
    appendLog(`→ Installing ${pack.id}`);
    // Snapshot pack as `running` in the install manifest so an interrupted
    // install reads as "in progress" for any agent self-healing pass.
    void writePackStatus(pack.id, "running");

    let handle: string;
    try {
      handle = await invoke<string>("spawn_process", {
        args: {
          cmd: "npx",
          args: ["-y", `--package=${HQ_CLI_PIN}`, "hq", "install", pack.source],
          cwd: targetDir,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      patchPack(idx, { status: "error", errorMsg: msg });
      appendLog(`[spawn error] ${msg}`);
      void writePackStatus(pack.id, "failed", msg);
      // Spawn failures here are dominantly "npx not on PATH" — i.e. the user
      // skipped or didn't complete the deps screen Node install. Recoverable
      // in-wizard via the "Install Node + Retry" button. Failure is recorded
      // in the manifest above; Sentry still captures unexpected exceptions.
      return false;
    }

    const stdoutUnlisten = await listen(
      `process://${handle}/stdout`,
      (event: { payload: unknown }) => {
        const payload = event.payload as { line: string };
        appendLog(payload.line ?? "");
      },
    );
    const stderrUnlisten = await listen(
      `process://${handle}/stderr`,
      (event: { payload: unknown }) => {
        const payload = event.payload as { line: string };
        appendLog(`[stderr] ${payload.line ?? ""}`);
      },
    );

    return new Promise<boolean>((resolve) => {
      listen(
        `process://${handle}/exit`,
        (event: { payload: unknown }) => {
          const payload = event.payload as { code: number | null; success: boolean };
          if (payload.success) {
            patchPack(idx, { status: "done" });
            void writePackStatus(pack.id, "ok");
            resolve(true);
          } else {
            const msg = `exit ${payload.code ?? -1}`;
            patchPack(idx, { status: "error", errorMsg: msg });
            appendLog(`✗ ${pack.id} failed (${msg})`);
            void writePackStatus(pack.id, "failed", msg);
            void pingFailure({
              stage: `pack-install:${pack.id}`,
              message: `pack install ${msg}`,
              detail: { pkg: pack.id, kind: "non-zero-exit", code: payload.code },
            });
            resolve(false);
          }
          (stdoutUnlisten as () => void)();
          (stderrUnlisten as () => void)();
        },
      ).then((exitUnlisten) => {
        unlistenRefs.current.push(
          stdoutUnlisten as () => void,
          stderrUnlisten as () => void,
          exitUnlisten as () => void,
        );
      });
    });
  }

  /** Install every pack the user left checked, in catalog order. */
  async function installPacks(): Promise<"done" | "done-with-warnings"> {
    let anyFailed = false;
    const snapshot = packs;
    for (let i = 0; i < snapshot.length; i++) {
      if (!snapshot[i].selected) continue;
      const ok = await installOnePack(i, snapshot[i]);
      if (!ok) anyFailed = true;
    }
    return anyFailed ? "done-with-warnings" : "done";
  }

  // -------------------------------------------------------------------------
  // Orchestration
  // -------------------------------------------------------------------------

  const startRun = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    // App-menu "Use Staging Channel" toggle — when on, the wizard pulls
    // `indigoai-us/hq-core-staging` @ `main` instead of the latest stable
    // hq-core release. Resolved at fetch time so a mid-wizard toggle takes
    // effect on Retry without needing an app restart. Best-effort: any
    // failure (command missing, IPC error) falls back to the stable channel.
    let useStaging = false;
    try {
      useStaging = await invoke<boolean>("get_use_staging_source");
    } catch {
      useStaging = false;
    }

    // Staging repo is private — anonymous tarball requests 404. Pull a
    // GitHub token from `gh auth token` via Rust. If gh is missing or
    // unauthenticated, surface the error immediately instead of letting the
    // wizard fail later with an opaque 404 from GitHub. Token is held only
    // in this closure scope and passed into fetchAndExtract; never logged.
    let stagingToken: string | undefined;
    if (useStaging) {
      try {
        stagingToken = await invoke<string>("get_github_token");
      } catch (tokenErr) {
        const msg =
          tokenErr instanceof Error ? tokenErr.message : String(tokenErr);
        setPhase("error");
        setErrorMsg(
          `Staging channel needs a GitHub token. ${msg}`,
        );
        setLogLines([
          "Resolving staging branch (hq-core-staging @ main)…",
          `Couldn't read GitHub token: ${msg}`,
        ]);
        runningRef.current = false;
        return;
      }
    }
    const source = useStaging
      ? {
          repo: "indigoai-us/hq-core-staging",
          ref: "main",
          authToken: stagingToken,
        }
      : undefined;

    setPhase("fetching");
    setDownloaded(0);
    setTotal(null);
    setErrorMsg(null);
    const initialLog = useStaging
      ? "Resolving staging branch (hq-core-staging @ main)…"
      : "Resolving latest release…";
    setLogLines([initialLog]);
    setPacks([]);
    diskLogRef.current = [initialLog];

    const installerVersion = await getInstallerVersion();
    if (targetDir) {
      try {
        await recordStepStart(targetDir, installerVersion, "templates");
      } catch {
        /* manifest write failures are non-fatal */
      }
    }

    const handleProgress = (event: TemplateProgressEvent) => {
      setDownloaded(event.bytes);
      if (event.total > 0) setTotal(event.total);
    };

    // Phase 1 — template
    try {
      const { version } = await fetchAndExtract(
        targetDir,
        undefined,
        handleProgress,
        controller.signal,
        source,
      );
      appendLog(
        useStaging
          ? `Downloaded staging (${version}) from hq-core-staging.`
          : `Downloaded release ${version}.`,
      );
      appendLog("Template extracted successfully.");
      // Persist the resolved release version into the manifest so agents
      // self-healing a partial install know what template version landed.
      try {
        await updateManifest(targetDir, installerVersion, (m) => {
          m.steps["templates"] = {
            ...(m.steps["templates"] ?? {}),
            status: "running",
          };
          (m as unknown as Record<string, unknown>).templateVersion = version;
        });
      } catch {
        /* non-fatal */
      }

      // Persist the chosen HQ folder to ~/.hq/menubar.json `hqPath` so HQ Sync
      // (a separate menubar app, no IPC with this installer) reads it as
      // Priority 1 instead of falling back to its core.yaml discovery scan
      // or the hardcoded ~/HQ default. Best-effort — install must not fail
      // if this write fails.
      try {
        await invoke("write_menubar_hq_path", { hqPath: targetDir });
        appendLog(`Recorded HQ path ${targetDir} for HQ Sync.`);
      } catch (writeErr) {
        appendLog(
          `Warning: couldn't write hqPath to menubar.json — HQ Sync will fall back to discovery (${
            writeErr instanceof Error ? writeErr.message : String(writeErr)
          })`,
        );
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      const msg =
        err instanceof TemplateFetchError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      setPhase("error");
      setErrorMsg(msg);
      appendLog(`Error: ${msg}`);
      await flushDiskLog();
      // Manifest + Slack notify so an interrupted install is visible to
      // agents and engineers without the user having to surface it.
      if (targetDir) {
        try {
          await recordStepFailure(
            targetDir,
            installerVersion,
            "templates",
            msg,
            { phase: "fetch" },
          );
        } catch {
          /* non-fatal */
        }
      }
      void pingFailure({
        stage: "template-fetch",
        message: msg,
        version: installerVersion,
        detail: { targetDir },
      });
      runningRef.current = false;
      return;
    }

    // Phase 1 done. Phase 2 (pack install) is opt-in + user-selected — pause
    // on the pack-choice screen and enumerate the catalog. installPacks runs
    // from handleConfirmPackChoice once the user picks.
    await flushDiskLog();
    setPhase("awaiting-pack-choice");
    runningRef.current = false;
    void loadAvailablePacks();
    // flushDiskLog / loadAvailablePacks / installPacks close over state
    // setters and refs that don't change across renders — safe to omit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetDir]);

  useEffect(() => {
    startRun();
    return () => {
      abortRef.current?.abort();
      for (const u of unlistenRefs.current) u?.();
      unlistenRefs.current = [];
      runningRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Footer "Continue" handler for the awaiting-pack-choice phase. Installs
   *  the packs the user left checked; skips straight to the next wizard step
   *  if none are checked. Unchecked packs are recorded as `skipped` so the
   *  install manifest is an honest record either way. */
  async function handleConfirmPackChoice() {
    const installerVersion = await getInstallerVersion();
    const selected = packs.filter((p) => p.selected);
    const unselected = packs.filter((p) => !p.selected);

    // Record unselected packs as skipped — honest manifest on every path.
    if (targetDir && unselected.length > 0) {
      try {
        const skipped: Record<string, { status: "skipped" }> = {};
        for (const p of unselected) skipped[p.id] = { status: "skipped" };
        await recordPacks(targetDir, installerVersion, skipped);
      } catch {
        /* manifest writes are best-effort */
      }
    }

    if (selected.length === 0) {
      // Nothing selected — mark the templates step ok (the template itself
      // landed fine), flush the log, then advance to the next wizard step.
      appendLog("No HQ packages selected — skipping pack install.");
      if (targetDir) {
        try {
          await updateManifest(targetDir, installerVersion, (m) => {
            m.steps["templates"] = {
              ...(m.steps["templates"] ?? {}),
              status: "ok",
              completedAt: new Date().toISOString(),
            };
          });
        } catch {
          /* non-fatal */
        }
      }
      await flushDiskLog();
      onNext?.();
      return;
    }

    // Install the selected packs.
    runningRef.current = true;
    setPhase("installing-packs");
    const packsOutcome = await installPacks();
    setPhase(packsOutcome);
    await flushDiskLog();
    if (targetDir) {
      try {
        await updateManifest(targetDir, installerVersion, (m) => {
          m.steps["templates"] = {
            ...(m.steps["templates"] ?? {}),
            status: packsOutcome === "done" ? "ok" : "failed",
            completedAt: new Date().toISOString(),
            error:
              packsOutcome === "done"
                ? undefined
                : "one or more packs failed — see packs map",
          };
        });
      } catch {
        /* non-fatal */
      }
    }
    runningRef.current = false;
  }

  function handleRetry() {
    runningRef.current = false;
    for (const u of unlistenRefs.current) u?.();
    unlistenRefs.current = [];
    startRun();
  }

  /** Re-run the pack install for every pack currently in `error` state.
   *  Used by both `handleInstallNodeAndRetry` (after Node lands) and
   *  `handleRetryFailedPacks` (Node already present, transient failure). */
  async function retryFailedPacks(): Promise<"done" | "done-with-warnings"> {
    setPhase("retrying-packs");
    let anyFailed = false;
    // Snapshot the current pack list so we don't iterate against mid-update
    // state. `installOnePack` calls `patchPack` which uses functional setState,
    // so the underlying state is safe; we just need a stable iteration order.
    const snapshot = packs;
    for (let i = 0; i < snapshot.length; i++) {
      if (snapshot[i].status === "error") {
        // Reset so the row re-shows "Installing…" rather than "Failed".
        patchPack(i, { status: "pending", errorMsg: null });
        const ok = await installOnePack(i, snapshot[i]);
        if (!ok) anyFailed = true;
      }
    }
    const outcome: "done" | "done-with-warnings" = anyFailed
      ? "done-with-warnings"
      : "done";
    setPhase(outcome);
    await flushDiskLog();
    return outcome;
  }

  /** Click handler for the "Install Node + Retry" button. Runs Node's
   *  managed-toolchain install, then re-runs every failed pack. */
  async function handleInstallNodeAndRetry() {
    setPhase("installing-node");
    appendLog("→ Installing Node (managed local install — no admin)");
    try {
      const result = await invoke<string>("install_node");
      appendLog(`✓ ${result}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      appendLog(`✗ Node install failed: ${msg}`);
      // Drop back to the previous warning state so the user can try again
      // or skip.
      setPhase("done-with-warnings");
      void pingFailure({
        stage: "install-node-from-templates",
        message: msg,
      });
      await flushDiskLog();
      return;
    }
    await retryFailedPacks();
  }

  /** Plain "Retry" handler — re-runs failed packs without touching Node. */
  async function handleRetryFailedPacks() {
    await retryFailedPacks();
  }

  // -------------------------------------------------------------------------
  // Derived
  // -------------------------------------------------------------------------

  const progressPct =
    total !== null && total > 0 ? Math.min(100, (downloaded / total) * 100) : null;

  const templateDone = phase !== "idle" && phase !== "fetching" && phase !== "error";
  const finalDone = phase === "done" || phase === "done-with-warnings";
  const failedPacks = packs.filter((p) => p.status === "error");
  /** True iff at least one failed pack failed because Node/npx wasn't on
   *  PATH when the wizard tried to run npx. Drives the "Install Node + Retry"
   *  CTA — fixing the only failure mode that's deterministically actionable
   *  inline. */
  const nodeMissingDetected = failedPacks.some(
    (p) => p.errorMsg !== null && NODE_MISSING_PATTERN.test(p.errorMsg),
  );
  const recoveryInProgress =
    phase === "installing-node" || phase === "retrying-packs";

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="flex flex-col gap-6 max-w-lg">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-medium text-white">Fetching template</h1>
        <p className="text-sm font-light text-zinc-400">
          Downloading the HQ starter template into{" "}
          <span className="font-mono text-zinc-300 break-all">{targetDir}</span>
        </p>
      </div>

      {/* Template phase */}
      <div className="flex flex-col gap-3 bg-white/5 border border-white/10 rounded-xl px-4 py-4">
        <div className="flex items-center gap-2">
          {phase === "fetching" && (
            <span className="text-sm text-zinc-400 hq-text-shimmer">Downloading template…</span>
          )}
          {templateDone && (
            <span className="text-sm text-zinc-200">Template ready</span>
          )}
          {phase === "error" && (
            <span className="text-sm text-zinc-400">Download incomplete</span>
          )}
          {phase === "idle" && (
            <span className="text-sm text-zinc-500 hq-text-shimmer">Starting…</span>
          )}
        </div>

        <div
          role="progressbar"
          aria-valuenow={progressPct ?? (phase === "fetching" ? 0 : undefined)}
          aria-valuemin={0}
          aria-valuemax={100}
          className="w-full h-1.5 rounded-full bg-white/10 overflow-hidden"
        >
          <div
            className="h-full rounded-full bg-white transition-all duration-300"
            style={{
              width:
                progressPct !== null
                  ? `${progressPct}%`
                  : phase === "fetching"
                    ? "60%"
                    : templateDone
                      ? "100%"
                      : "0%",
            }}
          />
        </div>

        {(phase === "fetching" || templateDone) && (
          <p className="text-xs text-zinc-500">
            {formatBytes(downloaded)}
            {total !== null ? ` / ${formatBytes(total)}` : ""}
          </p>
        )}
      </div>

      {/* Pack selection + install */}
      {(phase === "awaiting-pack-choice" ||
        phase === "installing-packs" ||
        finalDone ||
        recoveryInProgress) && (
        <div className="flex flex-col gap-2 bg-white/5 border border-white/10 rounded-xl px-4 py-3">
          <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider">
            HQ packages
          </p>

          {/* awaiting-pack-choice — the catalog checklist */}
          {phase === "awaiting-pack-choice" && (
            <>
              <p className="text-xs text-zinc-500">
                Optional add-ons. Pick the ones you want — any of these can be
                installed later with{" "}
                <span className="font-mono">hq install</span>.
              </p>
              {registryLoading && (
                <p className="text-sm text-zinc-400 hq-text-shimmer">
                  Loading available packages…
                </p>
              )}
              {!registryLoading && registryError && (
                <p className="text-xs text-amber-400">
                  Couldn't load the full package catalog ({registryError}) —
                  showing the core add-ons.
                </p>
              )}
              {!registryLoading &&
                packs.map((pack, idx) => (
                  <label
                    key={pack.id}
                    className="flex items-start gap-3 py-1 cursor-pointer select-none"
                    data-pack={pack.id}
                  >
                    <input
                      type="checkbox"
                      checked={pack.selected}
                      onChange={(e) =>
                        patchPack(idx, { selected: e.target.checked })
                      }
                      className="mt-0.5 h-4 w-4 shrink-0 accent-white"
                      aria-label={pack.id}
                    />
                    <span className="flex flex-col gap-0.5">
                      <span className="text-sm font-mono text-zinc-200">
                        {pack.id}
                      </span>
                      {pack.description && (
                        <span className="text-xs text-zinc-500">
                          {pack.description}
                        </span>
                      )}
                    </span>
                  </label>
                ))}
            </>
          )}

          {/* install / done phases — status rows for the selected packs */}
          {phase !== "awaiting-pack-choice" &&
            packs
              .filter((pack) => pack.selected)
              .map((pack) => (
                <div
                  key={pack.id}
                  className="flex items-center justify-between gap-3"
                  data-pack={pack.id}
                  data-pack-status={pack.status}
                >
                  <span className="text-sm font-mono text-zinc-300 truncate">
                    {pack.id}
                  </span>
                  <span className="text-xs shrink-0">
                    {pack.status === "pending" && (
                      <span className="text-zinc-600">Waiting</span>
                    )}
                    {pack.status === "running" && (
                      <span className="text-zinc-400 hq-text-shimmer">Installing…</span>
                    )}
                    {pack.status === "done" && (
                      <span className="text-green-400">Done</span>
                    )}
                    {pack.status === "error" && (
                      <span className="text-amber-400">Failed</span>
                    )}
                  </span>
                </div>
              ))}
          {phase === "done-with-warnings" && failedPacks.length > 0 && (
            <div className="flex flex-col gap-2 mt-1">
              <p className="text-xs text-amber-400">
                {failedPacks.length} pack
                {failedPacks.length === 1 ? "" : "s"} failed
                {nodeMissingDetected
                  ? " — Node isn't installed yet. We can install Node and retry."
                  : " — you can retry now or skip and run "}
                {!nodeMissingDetected && (
                  <>
                    <span className="font-mono">hq install &lt;pkg&gt;</span>{" "}
                    later.
                  </>
                )}{" "}
                Log:{" "}
                <span className="font-mono break-all">
                  {PACK_LOG_DIR}/{PACK_LOG_FILE}
                </span>
              </p>
              <div className="flex gap-2 mt-1">
                {nodeMissingDetected ? (
                  <button
                    type="button"
                    onClick={handleInstallNodeAndRetry}
                    className="text-xs px-3 py-1.5 rounded-full font-medium bg-white text-black hover:bg-zinc-100 transition-colors"
                  >
                    Install Node + Retry
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleRetryFailedPacks}
                    className="text-xs px-3 py-1.5 rounded-full font-medium bg-white text-black hover:bg-zinc-100 transition-colors"
                  >
                    Retry
                  </button>
                )}
              </div>
            </div>
          )}
          {phase === "installing-node" && (
            <p className="text-xs text-zinc-400 mt-1 hq-text-shimmer">
              Installing Node (managed local install — no admin)…
            </p>
          )}
          {phase === "retrying-packs" && (
            <p className="text-xs text-zinc-400 mt-1 hq-text-shimmer">
              Retrying pack installs…
            </p>
          )}
        </div>
      )}

      {/* Log panel */}
      {logLines.length > 0 && (
        <div
          data-log-panel
          className="text-xs font-mono text-zinc-500 bg-black/20 rounded-lg px-3 py-2 max-h-40 overflow-y-auto"
        >
          {logLines.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}

      {/* Error message */}
      {phase === "error" && errorMsg && (
        <p className="text-xs text-zinc-400">{errorMsg}</p>
      )}

      {/* Inline error actions — these stay in-content since they're contextual */}
      {phase === "error" && (
        <div className="flex gap-3">
          <button
            type="button"
            onClick={handleRetry}
            className="px-6 py-2.5 rounded-full text-sm font-medium bg-white text-black hover:bg-zinc-100 transition-colors"
          >
            Retry
          </button>
          <button
            type="button"
            onClick={() => {
              const log = document.querySelector("[data-log-panel]");
              log?.scrollIntoView({ behavior: "smooth" });
            }}
            className="px-6 py-2.5 rounded-full text-sm font-medium bg-white/10 text-zinc-300 hover:bg-white/20 transition-colors"
          >
            View log
          </button>
        </div>
      )}

      {phase === "awaiting-pack-choice" && (
        <WizardFooterSlot>
          <button
            type="button"
            onClick={handleConfirmPackChoice}
            disabled={registryLoading}
            className="px-6 py-2.5 rounded-full text-sm font-medium bg-white text-black hover:bg-zinc-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Continue
          </button>
        </WizardFooterSlot>
      )}

      {finalDone && (
        <WizardFooterSlot>
          <button
            type="button"
            onClick={onNext}
            className="px-6 py-2.5 rounded-full text-sm font-medium bg-white text-black hover:bg-zinc-100 transition-colors"
          >
            Continue
          </button>
        </WizardFooterSlot>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
