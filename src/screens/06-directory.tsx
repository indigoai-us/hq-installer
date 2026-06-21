// 06-directory.tsx — US-001
// Silent local install step with recovery. The happy path still auto-installs
// into ~/hq and advances, but path/create/extract failures now offer folder
// picker, Documents fallback, and retry paths instead of dead-ending.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { setInstallPath } from "@/lib/wizard-state";
import {
  getInstallerVersion,
  recordStepStart,
  recordStepOk,
  recordStepFailure,
  updateManifest,
} from "@/lib/install-manifest";
import { pingFailure } from "@/lib/telemetry";
import {
  fetchAndExtract,
  TemplateFetchError,
  type TemplateSource,
} from "@/lib/template-fetcher";
import { invokeWithTimeout } from "@/lib/invoke-timeout";
import {
  DOWNLOAD_SLOW_NOTICE_MS,
  DOWNLOAD_STALL_MS,
  INSTALL_PROBE_TIMEOUT_MS,
} from "@/lib/timeouts";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface DirectoryPickerProps {
  onNext?: () => void;
}

type Phase = "preparing" | "installing" | "recovering" | "warning";

interface CreateDirectoryResult {
  path: string;
  already_existed: boolean;
  non_empty: boolean;
}

interface DetectHqResult {
  exists: boolean;
  isHq: boolean;
}

interface RecoveryState {
  title: string;
  message: string;
  detail?: string;
  path?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function messageFromError(err: unknown): string {
  return err instanceof TemplateFetchError
    ? err.message
    : err instanceof Error
      ? err.message
      : String(err);
}

function isTemplateDownloadStalled(err: unknown): boolean {
  return err instanceof TemplateFetchError && err.stalled;
}

function formatMegabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1);
}

function trimTrailingSlash(path: string): string {
  return path.replace(/[\\/]+$/, "");
}

function pathSeparator(path: string): "/" | "\\" {
  return path.includes("\\") ? "\\" : "/";
}

function joinPath(parent: string, name: string): string {
  const trimmed = trimTrailingSlash(parent);
  return `${trimmed}${pathSeparator(parent)}${name}`;
}

function splitPath(path: string): { parent: string; name: string } {
  const trimmed = trimTrailingSlash(path);
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (idx <= 0) return { parent: ".", name: trimmed };
  return {
    parent: trimmed.slice(0, idx),
    name: trimmed.slice(idx + 1),
  };
}

function friendlyPath(path: string): string {
  return path;
}

function looksLikeFileError(message: string): boolean {
  return /is a file|not a folder|not a directory/i.test(message);
}

function pathKey(path: string): string {
  return trimTrailingSlash(path).replace(/\\/g, "/").toLowerCase();
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DirectoryPicker({ onNext }: DirectoryPickerProps) {
  const [recovery, setRecovery] = useState<RecoveryState | null>(null);
  const [phase, setPhase] = useState<Phase>("preparing");
  const [downloaded, setDownloaded] = useState(0);
  const [total, setTotal] = useState<number | null>(null);
  const [downloadInFlight, setDownloadInFlight] = useState(false);
  const [downloadStartedAt, setDownloadStartedAt] = useState<number | null>(null);
  const [lastProgressAt, setLastProgressAt] = useState<number | null>(null);
  const [downloadNow, setDownloadNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [currentPath, setCurrentPath] = useState("");

  const mountedRef = useRef(true);
  const controllerRef = useRef<AbortController | null>(null);
  const installerVersionRef = useRef<string>("unknown");
  const hasAutoResolvedRef = useRef(false);
  const failedPathKeysRef = useRef<Set<string>>(new Set());
  const lastDownloadedRef = useRef(0);

  // Stable ref so async attempts call the latest onNext without re-running.
  const onNextRef = useRef(onNext);
  useEffect(() => {
    onNextRef.current = onNext;
  });

  const journalFailure = useCallback(
    async (
      installPath: string,
      stage: "directory" | "templates",
      msg: string,
    ) => {
      void pingFailure({
        stage: stage === "directory" ? "directory" : "template-fetch",
        message: msg,
        version: installerVersionRef.current,
        detail: { installPath },
      });
      try {
        await recordStepFailure(
          installPath,
          installerVersionRef.current,
          stage,
          msg,
          {},
        );
      } catch {
        /* ignore */
      }
    },
    [],
  );

  const fail = useCallback(
    async (
      installPath: string,
      stage: "directory" | "templates",
      title: string,
      message: string,
      detail?: string,
    ) => {
      if (!mountedRef.current) return;
      if (installPath) failedPathKeysRef.current.add(pathKey(installPath));
      setPhase("recovering");
      setBusy(false);
      setRecovery({ title, message, detail, path: installPath || undefined });
      await journalFailure(installPath, stage, detail ?? message);
    },
    [journalFailure],
  );

  const ensureDirectory = useCallback(
    async (path: string): Promise<CreateDirectoryResult> => {
      const { parent, name } = splitPath(path);
      return await invokeWithTimeout<CreateDirectoryResult>(
        "create_directory",
        { parent, name },
        INSTALL_PROBE_TIMEOUT_MS,
      );
    },
    [],
  );

  const preflightPath = useCallback(
    async (
      path: string,
      options: { allowNonHqNonEmpty?: boolean } = {},
    ): Promise<"ok" | "warning"> => {
      let created: CreateDirectoryResult;
      try {
        created = await ensureDirectory(path);
      } catch (err) {
        const msg = messageFromError(err);
        await fail(
          path,
          "directory",
          "HQ couldn't be created",
          looksLikeFileError(msg)
            ? `${friendlyPath(path)} is a file. Choose a folder location for HQ.`
            : `HQ couldn't be created at ${friendlyPath(path)}.`,
          msg,
        );
        return "warning";
      }

      const hq = await invokeWithTimeout<DetectHqResult>(
        "detect_hq",
        { path: created.path },
        INSTALL_PROBE_TIMEOUT_MS,
      );
      if (
        created.already_existed &&
        created.non_empty &&
        !hq.isHq &&
        !options.allowNonHqNonEmpty
      ) {
        if (!mountedRef.current) return "warning";
        setCurrentPath(created.path);
        setInstallPath(created.path);
        setPhase("warning");
        setBusy(false);
        setRecovery({
          title: "This folder already has files",
          message:
            `${friendlyPath(created.path)} already has files and does not look like an HQ folder.`,
          detail: "You can use it anyway or choose a different folder.",
          path: created.path,
        });
        return "warning";
      }

      const writable = await invokeWithTimeout<boolean>(
        "check_writable",
        { path: created.path },
        INSTALL_PROBE_TIMEOUT_MS,
      );
      if (!writable) {
        await fail(
          created.path,
          "directory",
          "HQ couldn't write to this folder",
          hq.exists && !hq.isHq && created.already_existed && !created.non_empty
            ? `${friendlyPath(created.path)} is a file or isn't writable.`
            : `HQ couldn't be created at ${friendlyPath(created.path)} — that location isn't writable.`,
          "The installer could not create and remove a small test file there.",
        );
        return "warning";
      }

      return "ok";
    },
    [ensureDirectory, fail],
  );

  const extractInto = useCallback(
    async (installPath: string, controller: AbortController) => {
      const skipScaffold =
        typeof window !== "undefined" &&
        (window as unknown as { __HQ_INSTALLER_E2E__?: boolean })
          .__HQ_INSTALLER_E2E__ === true;

      if (skipScaffold) return;

      let useStaging = false;
      try {
        useStaging = await invoke<boolean>("get_use_staging_source");
      } catch {
        useStaging = false;
      }
      const source: TemplateSource | undefined = useStaging
        ? { repo: "indigoai-us/hq-core-staging", ref: "main" }
        : undefined;

      setPhase("installing");
      try {
        await recordStepStart(
          installPath,
          installerVersionRef.current,
          "templates",
        );
      } catch {
        // non-fatal
      }

      const startedAt = Date.now();
      lastDownloadedRef.current = 0;
      setDownloadStartedAt(startedAt);
      setLastProgressAt(startedAt);
      setDownloadNow(startedAt);
      setDownloadInFlight(true);

      const { version } = await fetchAndExtract(
        installPath,
        undefined,
        (event) => {
          if (!mountedRef.current) return;
          const now = Date.now();
          if (event.bytes > lastDownloadedRef.current) {
            lastDownloadedRef.current = event.bytes;
            setLastProgressAt(now);
          }
          setDownloadNow(now);
          setDownloaded(event.bytes);
          if (event.total > 0) setTotal(event.total);
        },
        controller.signal,
        source,
      );
      if (mountedRef.current) {
        setDownloadInFlight(false);
      }

      try {
        await recordStepOk(installPath, installerVersionRef.current, "templates");
        await updateManifest(installPath, installerVersionRef.current, (m) => {
          (m as unknown as Record<string, unknown>).templateVersion = version;
        });
      } catch {
        // non-fatal
      }

      try {
        await invoke("write_menubar_hq_path", { hqPath: installPath });
      } catch {
        // non-fatal
      }
    },
    [],
  );

  const installAt = useCallback(
    async (
      installPath: string,
      options: { allowNonHqNonEmpty?: boolean } = {},
    ): Promise<boolean> => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      if (mountedRef.current) {
        setBusy(true);
        setRecovery(null);
        setPhase("preparing");
        setDownloaded(0);
        setTotal(null);
        setDownloadInFlight(false);
        setDownloadStartedAt(null);
        setLastProgressAt(null);
        setDownloadNow(Date.now());
        lastDownloadedRef.current = 0;
      }

      try {
        installerVersionRef.current = await getInstallerVersion();
        if (!mountedRef.current || controller.signal.aborted) return false;

        const preflight = await preflightPath(installPath, options);
        if (preflight !== "ok" || !mountedRef.current || controller.signal.aborted) {
          return false;
        }

        setCurrentPath(installPath);
        setInstallPath(installPath);
        try {
          await recordStepStart(
            installPath,
            installerVersionRef.current,
            "directory",
          );
          await recordStepOk(installPath, installerVersionRef.current, "directory");
        } catch {
          // manifest writes are non-fatal
        }

        await extractInto(installPath, controller);
        if (!mountedRef.current || controller.signal.aborted) return false;
        setBusy(false);
        onNextRef.current?.();
        return true;
      } catch (err) {
        if (!mountedRef.current || controller.signal.aborted) return false;
        setDownloadInFlight(false);
        const msg = messageFromError(err);
        if (isTemplateDownloadStalled(err)) {
          await fail(
            installPath,
            "templates",
            "Download stalled",
            "Your internet connection appears to be down — the download has stalled.",
            msg,
          );
          return false;
        }
        await fail(
          installPath,
          "templates",
          "HQ files couldn't be installed",
          `HQ couldn't finish installing files at ${friendlyPath(installPath)}.`,
          msg,
        );
        return false;
      }
    },
    [extractInto, fail, preflightPath],
  );

  const resolveAndInstall = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    if (mountedRef.current) {
      setBusy(true);
      setRecovery(null);
      setPhase("preparing");
      setDownloaded(0);
      setTotal(null);
      setDownloadInFlight(false);
      setDownloadStartedAt(null);
      setLastProgressAt(null);
      setDownloadNow(Date.now());
      lastDownloadedRef.current = 0;
    }

    let installPath = "";
    try {
      installerVersionRef.current = await getInstallerVersion();
      installPath = await invokeWithTimeout<string>(
        "resolve_hq_path",
        undefined,
        INSTALL_PROBE_TIMEOUT_MS,
      );
      if (!mountedRef.current || controller.signal.aborted) return;
      setCurrentPath(installPath);
      await installAt(installPath);
    } catch (err) {
      if (!mountedRef.current || controller.signal.aborted) return;
      const msg = messageFromError(err);
      await fail(
        installPath,
        "directory",
        "HQ couldn't be created",
        looksLikeFileError(msg)
          ? "~/hq is a file. Choose a folder location for HQ."
          : "HQ couldn't be created at ~/hq.",
        msg,
      );
    }
  }, [fail, installAt]);

  const resolveAndInstallRef = useRef(resolveAndInstall);
  useEffect(() => {
    resolveAndInstallRef.current = resolveAndInstall;
  }, [resolveAndInstall]);

  useEffect(() => {
    mountedRef.current = true;
    if (!hasAutoResolvedRef.current) {
      hasAutoResolvedRef.current = true;
      void resolveAndInstallRef.current();
    }
    return () => {
      mountedRef.current = false;
      controllerRef.current?.abort();
      // Allow a genuine remount to re-run the auto-resolve. React StrictMode
      // (dev) mounts → unmounts → remounts; without this reset the first run's
      // controller is aborted by this cleanup while the run-once guard blocks
      // the remount from starting a fresh one, leaving the installer wedged on
      // "Preparing". Prod mounts once, so this only matters under StrictMode.
      hasAutoResolvedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!downloadInFlight) return;
    setDownloadNow(Date.now());
    const interval = window.setInterval(() => {
      setDownloadNow(Date.now());
    }, 250);
    return () => window.clearInterval(interval);
  }, [downloadInFlight]);

  async function handleChooseDifferentFolder() {
    controllerRef.current?.abort();
    setBusy(true);
    try {
      const picked = await invoke<string | null>("pick_directory", {
        defaultPath: currentPath || undefined,
      });
      if (!picked) {
        if (mountedRef.current) setBusy(false);
        return;
      }
      await installAt(joinPath(picked, "HQ"));
    } catch (err) {
      await fail(
        currentPath,
        "directory",
        "Folder picker couldn't open",
        "Choose a different folder was not available.",
        messageFromError(err),
      );
    }
  }

  async function handleUseDocuments() {
    setBusy(true);
    try {
      const home = await invoke<string>("home_dir");
      const documentsDir = joinPath(home, "Documents");
      const fallbackPaths = [
        joinPath(documentsDir, "HQ"),
        joinPath(home, "HQ"),
        joinPath(documentsDir, "HQ-Recovery"),
        joinPath(home, "HQ-Recovery"),
      ];

      let attempted = false;
      for (const fallbackPath of fallbackPaths) {
        if (failedPathKeysRef.current.has(pathKey(fallbackPath))) continue;
        attempted = true;
        const ok = await installAt(fallbackPath);
        if (ok || !mountedRef.current) return;
      }
      if (!attempted && mountedRef.current) setBusy(false);
    } catch (err) {
      await fail(
        currentPath,
        "directory",
        "HQ couldn't use the fallback folder",
        "The Documents fallback was not writable, and a recovery folder could not be prepared.",
        messageFromError(err),
      );
    }
  }

  function handleRetry() {
    controllerRef.current?.abort();
    if (currentPath) {
      void installAt(currentPath);
    } else {
      void resolveAndInstall();
    }
  }

  function handleUseAnyway() {
    if (!recovery?.path) return;
    void installAt(recovery.path, { allowNonHqNonEmpty: true });
  }

  // ── Recovery / warning ─────────────────────────────────────────────────
  if (phase === "recovering" || phase === "warning") {
    return (
      <div className="flex flex-col gap-6 max-w-lg">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-medium text-white">
            {recovery?.title ?? "HQ needs a different folder"}
          </h1>
          <p className="text-sm font-light text-zinc-400">
            {recovery?.message ?? "Choose another location and setup can continue."}
          </p>
        </div>

        {recovery?.detail && (
          <p className="text-xs text-zinc-400 bg-white/5 border border-white/10 rounded-lg px-3 py-2">
            {recovery.detail}
          </p>
        )}

        <div className="flex flex-wrap gap-3">
          {phase === "warning" && (
            <button
              type="button"
              onClick={handleUseAnyway}
              disabled={busy}
              className="px-5 py-2.5 rounded-full text-sm font-medium bg-white text-black hover:bg-zinc-100 transition-colors disabled:opacity-40"
            >
              Use anyway
            </button>
          )}
          <button
            type="button"
            onClick={() => void handleChooseDifferentFolder()}
            disabled={busy}
            className="px-5 py-2.5 rounded-full text-sm font-medium bg-white text-black hover:bg-zinc-100 transition-colors disabled:opacity-40"
          >
            Choose a different folder
          </button>
          <button
            type="button"
            onClick={() => void handleUseDocuments()}
            disabled={busy}
            className="px-5 py-2.5 rounded-full text-sm font-medium bg-white/10 text-zinc-100 hover:bg-white/15 transition-colors disabled:opacity-40"
          >
            Use ~/Documents/HQ instead
          </button>
          <button
            type="button"
            onClick={handleRetry}
            disabled={busy}
            className="px-5 py-2.5 rounded-full text-sm font-medium bg-white/10 text-zinc-100 hover:bg-white/15 transition-colors disabled:opacity-40"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  // ── Installing (downloading + extracting the scaffold) ─────────────────
  if (phase === "installing") {
    const pct =
      total && total > 0
        ? Math.min(100, Math.round((downloaded / total) * 100))
        : null;
    const downloadComplete = total !== null && total > 0 && downloaded >= total;
    const stalled =
      downloadInFlight &&
      !downloadComplete &&
      lastProgressAt !== null &&
      downloadNow - lastProgressAt >= DOWNLOAD_STALL_MS;
    const slow =
      downloadInFlight &&
      !downloadComplete &&
      !stalled &&
      downloadStartedAt !== null &&
      lastProgressAt !== null &&
      downloadNow - downloadStartedAt >= DOWNLOAD_SLOW_NOTICE_MS &&
      downloadNow - lastProgressAt < DOWNLOAD_STALL_MS;
    const downloadedMb = formatMegabytes(downloaded);
    const totalMb = total && total > 0 ? formatMegabytes(total) : null;
    return (
      <div className="flex flex-col gap-6 max-w-lg">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-medium text-white">Installing HQ</h1>
          <p className="text-sm font-light text-zinc-400">
            Downloading and setting up your HQ files at{" "}
            {friendlyPath(currentPath || "~/hq")}…
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <div
            className="h-2 w-full overflow-hidden rounded-full bg-white/10"
            role="progressbar"
            aria-label="Installing HQ"
            aria-valuenow={pct ?? undefined}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="h-full rounded-full bg-white transition-[width] duration-300"
              style={{ width: pct !== null ? `${pct}%` : "33%" }}
            />
          </div>
          <span className="text-xs text-zinc-400">
            {pct !== null ? `${pct}%` : "Preparing…"}
          </span>
        </div>

        {stalled && (
          <div className="flex flex-col gap-3 rounded-lg border border-amber-300/30 bg-amber-300/10 px-4 py-3">
            <p className="text-sm text-amber-100">
              Your internet connection appears to be down — the download has stalled.
            </p>
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={handleRetry}
                className="px-4 py-2 rounded-full text-sm font-medium bg-white text-black hover:bg-zinc-100 transition-colors"
              >
                Retry
              </button>
              <button
                type="button"
                onClick={() => void handleChooseDifferentFolder()}
                className="px-4 py-2 rounded-full text-sm font-medium bg-white/10 text-zinc-100 hover:bg-white/15 transition-colors"
              >
                Choose a different folder
              </button>
            </div>
          </div>
        )}

        {slow && (
          <div className="flex flex-col gap-3 rounded-lg border border-white/10 bg-white/5 px-4 py-3">
            <p className="text-sm text-zinc-300">
              Slow internet connection — still downloading (
              {totalMb ? `${downloadedMb} of ${totalMb} MB` : `${downloadedMb} MB`}
              )…
            </p>
            <button
              type="button"
              onClick={handleRetry}
              className="self-start px-4 py-2 rounded-full text-sm font-medium bg-white/10 text-zinc-100 hover:bg-white/15 transition-colors"
            >
              Retry
            </button>
          </div>
        )}
      </div>
    );
  }

  // ── Preparing ──────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-6 max-w-lg">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-medium text-white">Preparing HQ</h1>
        <p className="text-sm font-light text-zinc-400">
          Setting up your HQ directory at {friendlyPath(currentPath || "~/hq")}…
        </p>
      </div>
      <div className="flex items-center gap-3">
        <div className="animate-spin h-4 w-4 border-2 border-white/30 border-t-white rounded-full" />
        <span className="text-sm text-zinc-300">Creating HQ folder</span>
      </div>
    </div>
  );
}
