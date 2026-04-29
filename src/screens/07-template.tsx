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
// Phase 2 — HQ packs:
//   After the template lands we install the 4 host-side HQ packs
//   (`HQ_PACKAGES`) via `npx --package=@indigoai-us/hq-cli hq install <pkg>`,
//   running one pack at a time with `cwd = installPath`. Stdout/stderr is
//   streamed into the visible log panel AND flushed to
//   `{installPath}/.hq-install-log/packs.log` on exit so post-mortem is
//   possible. Previously this ran silently in the git-init step — pack
//   failures (notably the hq-onboarding 404 that gated install in v0.1.20)
//   were invisible to the user. Pack errors are non-fatal: Continue stays
//   enabled with a warning so the user can retry individual packs with
//   `hq install <pkg>` later.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { mkdir, writeTextFile } from "@tauri-apps/plugin-fs";
import {
  fetchAndExtract,
  TemplateFetchError,
  type ProgressEvent as TemplateProgressEvent,
} from "@/lib/template-fetcher";
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

const HQ_PACKAGES = [
  "@indigoai-us/hq-pack-design-quality",
  "@indigoai-us/hq-pack-design-styles",
  "@indigoai-us/hq-pack-gemini",
  "@indigoai-us/hq-pack-gstack",
] as const;

const PACK_LOG_DIR = ".hq-install-log";
const PACK_LOG_FILE = "packs.log";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Phase =
  | "idle"
  | "fetching"
  | "installing-packs"
  | "done"
  | "done-with-warnings"
  | "error";

type PackStatus = "pending" | "running" | "done" | "error";

interface PackState {
  name: string;
  status: PackStatus;
  errorMsg: string | null;
}

function initialPacks(): PackState[] {
  return HQ_PACKAGES.map((name) => ({ name, status: "pending", errorMsg: null }));
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
  const [packs, setPacks] = useState<PackState[]>(initialPacks);

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
  // Phase 2: install HQ packs
  // -------------------------------------------------------------------------

  function patchPack(idx: number, patch: Partial<PackState>) {
    setPacks((prev) => prev.map((p, i) => (i === idx ? { ...p, ...patch } : p)));
  }

  /** Best-effort pack-status write to {targetDir}/.hq/install-manifest.json.
   *  Failures are swallowed — the diskLog flush + UI state remain the user-
   *  visible record. The manifest is the agent-readable record. */
  async function writePackStatus(
    name: string,
    status: "running" | "ok" | "failed",
    error?: string,
  ): Promise<void> {
    if (!targetDir) return;
    try {
      const installerVersion = await getInstallerVersion();
      await recordPacks(targetDir, installerVersion, {
        [name]: { status, error },
      });
    } catch {
      /* ignore */
    }
  }

  /** Spawn `npx ... hq install <pkg>` with cwd = targetDir and stream
   *  stdout/stderr into the visible log. Resolves true on exit 0. */
  async function installOnePack(idx: number, pkg: string): Promise<boolean> {
    patchPack(idx, { status: "running" });
    appendLog(`→ Installing ${pkg}`);
    // Snapshot pack as `running` in the install manifest so an interrupted
    // install reads as "in progress" for any agent self-healing pass.
    void writePackStatus(pkg, "running");

    let handle: string;
    try {
      handle = await invoke<string>("spawn_process", {
        args: {
          cmd: "npx",
          args: ["-y", `--package=${HQ_CLI_PIN}`, "hq", "install", pkg],
          cwd: targetDir,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      patchPack(idx, { status: "error", errorMsg: msg });
      appendLog(`[spawn error] ${msg}`);
      void writePackStatus(pkg, "failed", msg);
      void pingFailure({
        stage: `pack-install:${pkg}`,
        message: `spawn failed: ${msg}`,
        detail: { pkg, kind: "spawn-error" },
      });
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
            void writePackStatus(pkg, "ok");
            resolve(true);
          } else {
            const msg = `exit ${payload.code ?? -1}`;
            patchPack(idx, { status: "error", errorMsg: msg });
            appendLog(`✗ ${pkg} failed (${msg})`);
            void writePackStatus(pkg, "failed", msg);
            void pingFailure({
              stage: `pack-install:${pkg}`,
              message: `pack install ${msg}`,
              detail: { pkg, kind: "non-zero-exit", code: payload.code },
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

  async function installPacks(): Promise<"done" | "done-with-warnings"> {
    let anyFailed = false;
    for (let i = 0; i < HQ_PACKAGES.length; i++) {
      const ok = await installOnePack(i, HQ_PACKAGES[i]);
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

    setPhase("fetching");
    setDownloaded(0);
    setTotal(null);
    setErrorMsg(null);
    setLogLines(["Resolving latest release…"]);
    setPacks(initialPacks());
    diskLogRef.current = ["Resolving latest release…"];

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
      );
      appendLog(`Downloaded release ${version}.`);
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

    // Phase 2 — packs
    setPhase("installing-packs");
    const packsOutcome = await installPacks();
    setPhase(packsOutcome);
    await flushDiskLog();
    // Final manifest write — mark templates step ok if everything landed,
    // or note that warnings exist so an agent can target failed packs.
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
    if (packsOutcome === "done-with-warnings") {
      // packsOutcome failures are recoverable — recorded per-pack above —
      // but we still want a single rolled-up Slack ping so on-call sees
      // the run as a whole.
      void pingFailure({
        stage: "template-fetch",
        message: "one or more HQ packs failed during install",
        version: installerVersion,
        detail: { targetDir, kind: "pack-warnings" },
      });
    }
    runningRef.current = false;
    // flushDiskLog and installPacks close over state setters and refs that
    // don't change across renders — safe to omit from deps.
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

  function handleRetry() {
    runningRef.current = false;
    for (const u of unlistenRefs.current) u?.();
    unlistenRefs.current = [];
    startRun();
  }

  // -------------------------------------------------------------------------
  // Derived
  // -------------------------------------------------------------------------

  const progressPct =
    total !== null && total > 0 ? Math.min(100, (downloaded / total) * 100) : null;

  const templateDone = phase !== "idle" && phase !== "fetching" && phase !== "error";
  const finalDone = phase === "done" || phase === "done-with-warnings";
  const failedPacks = packs.filter((p) => p.status === "error");

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
            <span className="text-sm text-red-400">Download failed</span>
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

      {/* Pack install phase */}
      {(phase === "installing-packs" || finalDone) && (
        <div className="flex flex-col gap-2 bg-white/5 border border-white/10 rounded-xl px-4 py-3">
          <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider">
            HQ packages
          </p>
          {packs.map((pack) => (
            <div
              key={pack.name}
              className="flex items-center justify-between gap-3"
              data-pack={pack.name}
              data-pack-status={pack.status}
            >
              <span className="text-sm font-mono text-zinc-300 truncate">
                {pack.name}
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
                  <span className="text-amber-400">Skipped</span>
                )}
              </span>
            </div>
          ))}
          {phase === "done-with-warnings" && failedPacks.length > 0 && (
            <p className="text-xs text-amber-400 mt-1">
              {failedPacks.length} pack
              {failedPacks.length === 1 ? "" : "s"} failed — you can continue and
              retry later with{" "}
              <span className="font-mono">hq install &lt;pkg&gt;</span>. Log:{" "}
              <span className="font-mono break-all">
                {PACK_LOG_DIR}/{PACK_LOG_FILE}
              </span>
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
        <p className="text-xs text-red-400">{errorMsg}</p>
      )}

      {/* Action buttons */}
      <div className="flex gap-3">
        {finalDone && (
          <button
            type="button"
            onClick={onNext}
            className="px-6 py-2.5 rounded-full text-sm font-medium bg-white text-black hover:bg-zinc-100 transition-colors"
          >
            Continue
          </button>
        )}

        {phase === "error" && (
          <>
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
          </>
        )}
      </div>
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
