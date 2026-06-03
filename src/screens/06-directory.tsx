// 06-directory.tsx — US-001
// Silent local install step: resolves ~/hq automatically, no picker or name input.
// Calls onNext as soon as the path is ready; shows a spinner while working.

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { setInstallPath } from "@/lib/wizard-state";
import {
  getInstallerVersion,
  recordStepStart,
  recordStepOk,
  recordStepFailure,
} from "@/lib/install-manifest";
import { pingFailure } from "@/lib/telemetry";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface DirectoryPickerProps {
  onNext?: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DirectoryPicker({ onNext }: DirectoryPickerProps) {
  const [error, setError] = useState<string | null>(null);
  // Stable ref so the effect closure always calls the latest onNext without
  // re-running the effect when the parent re-renders with a new callback ref.
  const onNextRef = useRef(onNext);
  useEffect(() => {
    onNextRef.current = onNext;
  });

  useEffect(() => {
    let cancelled = false;

    async function run() {
      try {
        const installPath = await invoke<string>("resolve_hq_path");
        if (cancelled) return;

        setInstallPath(installPath);

        const installerVersion = await getInstallerVersion();
        try {
          await recordStepStart(installPath, installerVersion, "directory");
          await recordStepOk(installPath, installerVersion, "directory");
        } catch {
          // manifest writes are non-fatal
        }

        onNextRef.current?.();
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        const installerVersion = await getInstallerVersion();
        void pingFailure({
          stage: "directory",
          message: msg,
          version: installerVersion,
          detail: {},
        });
        try {
          await recordStepFailure(
            "",
            installerVersion,
            "directory",
            msg,
            {},
          );
        } catch {
          /* ignore */
        }
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className="flex flex-col gap-6 max-w-lg">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-medium text-white">Setup failed</h1>
          <p className="text-sm font-light text-zinc-400">
            Could not prepare the HQ directory.
          </p>
        </div>
        <p className="text-xs text-zinc-400 bg-white/5 border border-white/10 rounded-lg px-3 py-2">
          {error}
        </p>
      </div>
    );
  }

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
