// 07-template.tsx — US-016
// Template fetch screen — downloads and extracts the HQ template tarball.
//
// Transport: `fetchAndExtract()` from `@/lib/template-fetcher`. That helper
// resolves the latest non-prerelease release on `indigoai-us/hq` via the
// GitHub Release API, streams the tarball through `@tauri-apps/plugin-http`
// (which bypasses CORS via the Rust reqwest client), gunzips + parses tar
// in-memory, and writes each entry with `@tauri-apps/plugin-fs`. No shell
// curl; no event bus; progress flows in-process via an onProgress callback.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchAndExtract,
  TemplateFetchError,
  type ProgressEvent as TemplateProgressEvent,
} from "@/lib/template-fetcher";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FetchStatus = "idle" | "fetching" | "done" | "error";

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
  const [status, setStatus] = useState<FetchStatus>("idle");
  const [downloaded, setDownloaded] = useState(0);
  const [total, setTotal] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);

  // Prevent double-starts in strict mode, and allow in-flight cancellation.
  const fetchingRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  const startFetch = useCallback(async () => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;

    // Abort any stale in-flight fetch (unlikely but cheap insurance).
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setStatus("fetching");
    setDownloaded(0);
    setTotal(null);
    setErrorMsg(null);
    setLogLines(["Resolving latest release…"]);

    const handleProgress = (event: TemplateProgressEvent) => {
      setDownloaded(event.bytes);
      if (event.total > 0) setTotal(event.total);
    };

    try {
      const { version } = await fetchAndExtract(
        targetDir,
        undefined, // latest non-prerelease
        handleProgress,
        controller.signal,
      );
      setStatus("done");
      setLogLines((prev) => [
        ...prev,
        `Downloaded release ${version}.`,
        "Template extracted successfully.",
      ]);
    } catch (err) {
      // Swallow cancellation (intentional unmount / retry) rather than
      // surfacing it as a user-facing error.
      if (controller.signal.aborted) {
        return;
      }
      const msg =
        err instanceof TemplateFetchError
          ? err.message
          : err instanceof Error
          ? err.message
          : String(err);
      setStatus("error");
      setErrorMsg(msg);
      setLogLines((prev) => [...prev, `Error: ${msg}`]);
    } finally {
      fetchingRef.current = false;
    }
  }, [targetDir]);

  useEffect(() => {
    // Auto-start on mount.
    startFetch();

    return () => {
      // Cancel in-flight fetch on unmount so we don't leak bytes or writes.
      abortRef.current?.abort();
      fetchingRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleRetry() {
    fetchingRef.current = false;
    startFetch();
  }

  // ---------------------------------------------------------------------------
  // Derived
  // ---------------------------------------------------------------------------

  const progressPct =
    total !== null && total > 0 ? Math.min(100, (downloaded / total) * 100) : null;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="flex flex-col gap-6 max-w-lg">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-medium text-white">Fetching template</h1>
        <p className="text-sm font-light text-zinc-400">
          Downloading the HQ starter template into{" "}
          <span className="font-mono text-zinc-300 break-all">{targetDir}</span>
        </p>
      </div>

      {/* Progress area */}
      <div className="flex flex-col gap-3 bg-white/5 border border-white/10 rounded-xl px-4 py-4">
        {/* Status label */}
        <div className="flex items-center gap-2">
          {status === "fetching" && (
            <span className="text-sm text-zinc-400">Downloading…</span>
          )}
          {status === "done" && (
            <span className="text-sm text-zinc-200">Download complete</span>
          )}
          {status === "error" && (
            <span className="text-sm text-red-400">Download failed</span>
          )}
          {status === "idle" && (
            <span className="text-sm text-zinc-500">Starting…</span>
          )}
        </div>

        {/* Progress bar */}
        <div
          role="progressbar"
          aria-valuenow={progressPct ?? (status === "fetching" ? 0 : undefined)}
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
                  : status === "fetching"
                  ? "60%"  // indeterminate — show partial bar
                  : status === "done"
                  ? "100%"
                  : "0%",
            }}
          />
        </div>

        {/* Byte counter */}
        {(status === "fetching" || status === "done") && (
          <p className="text-xs text-zinc-500">
            {formatBytes(downloaded)}
            {total !== null ? ` / ${formatBytes(total)}` : ""}
          </p>
        )}
      </div>

      {/* Log panel */}
      {logLines.length > 0 && (
        <div className="text-xs font-mono text-zinc-500 bg-black/20 rounded-lg px-3 py-2 max-h-32 overflow-y-auto">
          {logLines.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}

      {/* Error message */}
      {status === "error" && errorMsg && (
        <p className="text-xs text-red-400">{errorMsg}</p>
      )}

      {/* Action buttons */}
      <div className="flex gap-3">
        {status === "done" && (
          <button
            type="button"
            onClick={onNext}
            className="px-6 py-2.5 rounded-full text-sm font-medium bg-white text-black hover:bg-zinc-100 transition-colors"
          >
            Continue
          </button>
        )}

        {status === "error" && (
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
                // Scroll log panel into view / expand it
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
