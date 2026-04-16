// 07-template.tsx — US-016
// Template fetch screen — downloads and extracts the HQ template tarball.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TemplateProgress {
  downloaded: number;
  total: number | null;
  done: boolean;
  error?: string;
}

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

  // Prevent double-starts in strict mode.
  const fetchingRef = useRef(false);

  const startFetch = useCallback(async () => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;

    setStatus("fetching");
    setDownloaded(0);
    setTotal(null);
    setErrorMsg(null);
    setLogLines([]);

    try {
      await invoke("fetch_template", {
        url: "https://github.com/coreyepstein/hq/archive/refs/heads/main.tar.gz",
        targetDir,
      });
      // fetch_template runs in a background thread and emits events.
      // The done/error state is driven by template:progress events below.
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatus("error");
      setErrorMsg(msg);
      setLogLines((prev) => [...prev, `Error: ${msg}`]);
      fetchingRef.current = false;
    }
  }, [targetDir]);

  useEffect(() => {
    let unlistenFn: (() => void) | undefined;

    const listenerPromise = listen(
      "template:progress",
      (event: { payload: unknown }) => {
        const payload = event.payload as TemplateProgress;

        if (payload.downloaded !== undefined && payload.downloaded > 0) {
          setDownloaded(payload.downloaded);
        }
        if (payload.total !== null && payload.total !== undefined) {
          setTotal(payload.total);
        }

        if (payload.done) {
          if (payload.error) {
            setStatus("error");
            setErrorMsg(payload.error);
            setLogLines((prev) => [...prev, `Error: ${payload.error}`]);
          } else {
            setStatus("done");
            setLogLines((prev) => [...prev, "Template extracted successfully."]);
          }
          fetchingRef.current = false;
        } else if (!payload.error) {
          // In-progress tick
          setLogLines((prev) => [
            ...prev,
            `Downloading… ${formatBytes(payload.downloaded)}`,
          ]);
        }
      }
    ).then((unlisten) => {
      unlistenFn = unlisten as () => void;
    });

    // Auto-start on mount.
    startFetch();

    return () => {
      listenerPromise.then(() => unlistenFn?.());
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
