// 06-directory.tsx — US-001
// Silent local install step. Two phases, no user input:
//   1. resolve ~/hq (create it; no picker, no folder-name prompt)
//   2. download + extract the HQ core scaffold (indigoai-us/hq-core release)
//      into it, behind a single progress bar, then auto-advance.
//
// Phase 2 is what actually lays the HQ file tree on disk (core/, .claude/,
// AGENTS.md, …) — see fetchAndExtract in @/lib/template-fetcher. Without it
// the installer would leave an empty ~/hq and a broken HQ.

import { useEffect, useRef, useState } from "react";
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

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface DirectoryPickerProps {
  onNext?: () => void;
}

type Phase = "preparing" | "installing";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DirectoryPicker({ onNext }: DirectoryPickerProps) {
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("preparing");
  const [downloaded, setDownloaded] = useState(0);
  const [total, setTotal] = useState<number | null>(null);

  // Stable ref so the effect closure always calls the latest onNext without
  // re-running the effect when the parent re-renders with a new callback ref.
  const onNextRef = useRef(onNext);
  useEffect(() => {
    onNextRef.current = onNext;
  });

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    let installPath = "";
    // Which phase a thrown error belongs to, for telemetry + manifest.
    let stage: "directory" | "templates" = "directory";

    async function run() {
      let installerVersion = "unknown";
      try {
        installerVersion = await getInstallerVersion();

        // ── Phase 1: resolve + create ~/hq ────────────────────────────────
        installPath = await invoke<string>("resolve_hq_path");
        if (cancelled) return;
        setInstallPath(installPath);
        try {
          await recordStepStart(installPath, installerVersion, "directory");
          await recordStepOk(installPath, installerVersion, "directory");
        } catch {
          // manifest writes are non-fatal
        }

        // ── Phase 2: download + extract the HQ scaffold into ~/hq ──────────
        // The Playwright walkthrough (tests/e2e/full-walkthrough.spec.ts) runs
        // this UI in a browser against a mocked Tauri layer that cannot serve a
        // real hq-core release tarball, so it sets `window.__HQ_INSTALLER_E2E__`
        // to skip the network scaffold fetch and validate the wizard flow only.
        // The real fetch+extract is covered by this file's unit test and by
        // clean-room VM runs. Production (real Tauri) never sets the flag, so
        // the scaffold always lands.
        const skipScaffold =
          typeof window !== "undefined" &&
          (window as unknown as { __HQ_INSTALLER_E2E__?: boolean })
            .__HQ_INSTALLER_E2E__ === true;

        if (!skipScaffold) {
          // Resolve the template source (stable release vs staging channel).
          let useStaging = false;
          try {
            useStaging = await invoke<boolean>("get_use_staging_source");
          } catch {
            useStaging = false;
          }
          let source: TemplateSource | undefined;
          if (useStaging) {
            // hq-core-staging is private — anonymous tarball requests 404, so a
            // GitHub token is required (read from `gh auth token` via Rust,
            // never persisted). Surface a clear error instead of an opaque 404.
            let token: string;
            try {
              token = await invoke<string>("get_github_token");
            } catch (tokenErr) {
              const m =
                tokenErr instanceof Error
                  ? tokenErr.message
                  : String(tokenErr);
              throw new Error(`Staging channel needs a GitHub token. ${m}`);
            }
            source = {
              repo: "indigoai-us/hq-core-staging",
              ref: "main",
              authToken: token,
            };
          }

          stage = "templates";
          setPhase("installing");
          if (cancelled) return;
          try {
            await recordStepStart(installPath, installerVersion, "templates");
          } catch {
            // non-fatal
          }
          const { version } = await fetchAndExtract(
            installPath,
            undefined,
            (event) => {
              if (cancelled) return;
              setDownloaded(event.bytes);
              if (event.total > 0) setTotal(event.total);
            },
            controller.signal,
            source,
          );
          if (cancelled) return;
          try {
            await recordStepOk(installPath, installerVersion, "templates");
            await updateManifest(installPath, installerVersion, (m) => {
              (m as unknown as Record<string, unknown>).templateVersion =
                version;
            });
          } catch {
            // non-fatal
          }

          // Record the chosen HQ folder for HQ Sync (a separate menubar app
          // with no IPC) so it reads ~/hq as Priority 1 instead of its
          // discovery scan. Best-effort — install must not fail if this fails.
          try {
            await invoke("write_menubar_hq_path", { hqPath: installPath });
          } catch {
            // non-fatal
          }
        }

        onNextRef.current?.();
      } catch (err) {
        if (cancelled || controller.signal.aborted) return;
        const msg =
          err instanceof TemplateFetchError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err);
        setError(msg);
        void pingFailure({
          stage: stage === "directory" ? "directory" : "template-fetch",
          message: msg,
          version: installerVersion,
          detail: { installPath },
        });
        try {
          await recordStepFailure(installPath, installerVersion, stage, msg, {});
        } catch {
          /* ignore */
        }
      }
    }

    void run();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  // ── Error ────────────────────────────────────────────────────────────────
  if (error) {
    return (
      <div className="flex flex-col gap-6 max-w-lg">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-medium text-white">Setup failed</h1>
          <p className="text-sm font-light text-zinc-400">
            Could not prepare your HQ files.
          </p>
        </div>
        <p className="text-xs text-zinc-400 bg-white/5 border border-white/10 rounded-lg px-3 py-2">
          {error}
        </p>
      </div>
    );
  }

  // ── Installing (downloading + extracting the scaffold) ─────────────────────
  if (phase === "installing") {
    const pct =
      total && total > 0
        ? Math.min(100, Math.round((downloaded / total) * 100))
        : null;
    return (
      <div className="flex flex-col gap-6 max-w-lg">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-medium text-white">Installing HQ</h1>
          <p className="text-sm font-light text-zinc-400">
            Downloading and setting up your HQ files at ~/hq…
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
      </div>
    );
  }

  // ── Preparing (resolving ~/hq) ─────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-6 max-w-lg">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-medium text-white">Preparing HQ</h1>
        <p className="text-sm font-light text-zinc-400">
          Setting up your HQ directory at ~/hq…
        </p>
      </div>
      <div className="flex items-center gap-3">
        <div className="animate-spin h-4 w-4 border-2 border-white/30 border-t-white rounded-full" />
        <span className="text-sm text-zinc-300">Creating ~/hq</span>
      </div>
    </div>
  );
}
