// 08b-sync.tsx — US-005
// S3 initial sync screen. Pulls company files from S3 using scoped STS
// credentials from vault-service. Inserted between git-init (08) and
// personalize (09) in the wizard flow.

import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentUser } from "@/lib/cognito";
import { getWizardState } from "@/lib/wizard-state";
import {
  vendStsCredentials,
  syncFromS3,
  type SyncProgress,
} from "@/lib/s3-sync";

interface SyncScreenProps {
  onNext?: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function SyncScreen({ onNext }: SyncScreenProps) {
  const [status, setStatus] = useState<
    "idle" | "syncing" | "done" | "error"
  >("idle");
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [result, setResult] = useState<{
    fileCount: number;
    totalBytes: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const attemptedRef = useRef(false);

  useEffect(() => {
    if (attemptedRef.current) return;
    attemptedRef.current = true;

    async function sync() {
      setStatus("syncing");

      try {
        const user = await getCurrentUser();
        if (!user) {
          throw new Error("No active session — please sign in again.");
        }

        const state = getWizardState();
        if (!state.team) {
          throw new Error("No company detected — please go back.");
        }

        const installPath = state.installPath ?? `${await invoke<string>("home_dir")}/hq`;

        // Vend scoped STS credentials
        const creds = await vendStsCredentials(
          user.tokens.accessToken,
          state.team.companyId
        );

        // Sync files from S3
        const syncResult = await syncFromS3(creds, installPath, setProgress);

        // Write .hq/config.json with company context
        const config = {
          companyUid: state.team.companyId,
          companySlug: state.team.slug,
          personUid: state.team.teamId,
          role: state.team.joinedViaInvite ? "member" : "admin",
          bucketName: creds.bucketName,
          vaultApiUrl:
            (import.meta.env.VITE_VAULT_API_URL as string | undefined) ??
            "https://tqdwdqxv75.execute-api.us-east-1.amazonaws.com",
          configuredAt: new Date().toISOString(),
        };

        await invoke("write_file", {
          path: `${installPath}/.hq/config.json`,
          contents: Array.from(
            new TextEncoder().encode(JSON.stringify(config, null, 2))
          ),
        });

        setResult(syncResult);
        setStatus("done");
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Sync failed"
        );
        setStatus("error");
      }
    }

    sync();
  }, []);

  // Syncing state with progress
  if (status === "syncing") {
    return (
      <div className="flex flex-col items-center gap-6 max-w-sm">
        <h1 className="text-2xl font-medium text-white">
          Syncing your workspace
        </h1>
        {progress && (
          <div className="w-full flex flex-col gap-3">
            {/* Progress bar */}
            <div className="w-full h-2 bg-white/10 rounded-full overflow-hidden">
              <div
                className="h-full bg-white transition-all duration-300"
                style={{
                  width: `${
                    progress.totalFiles > 0
                      ? (progress.downloadedFiles / progress.totalFiles) * 100
                      : 0
                  }%`,
                }}
              />
            </div>
            <div className="text-xs text-zinc-400 flex justify-between">
              <span>
                {progress.downloadedFiles} / {progress.totalFiles} files
              </span>
              <span>
                {formatBytes(progress.downloadedBytes)} /{" "}
                {formatBytes(progress.totalBytes)}
              </span>
            </div>
            <p className="text-xs text-zinc-500 truncate">
              {progress.currentFile}
            </p>
          </div>
        )}
        {!progress && (
          <div className="w-8 h-8 border-2 border-white/20 border-t-white rounded-full animate-spin" />
        )}
      </div>
    );
  }

  // Done state
  if (status === "done" && result) {
    return (
      <div className="flex flex-col items-center gap-6 max-w-sm">
        <div className="w-12 h-12 rounded-full bg-green-500/20 flex items-center justify-center text-green-400 text-xl">
          {"\u2713"}
        </div>
        <h1 className="text-2xl font-medium text-white">Sync complete</h1>
        <p className="text-sm text-zinc-400 text-center">
          {result.fileCount} files synced ({formatBytes(result.totalBytes)})
        </p>
        <button
          type="button"
          onClick={() => onNext?.()}
          className="rounded-full py-2.5 px-8 text-sm font-medium bg-white text-black hover:bg-zinc-100 transition-colors"
        >
          Continue
        </button>
      </div>
    );
  }

  // Error state
  if (status === "error") {
    return (
      <div className="flex flex-col items-center gap-6 max-w-sm">
        <h1 className="text-2xl font-medium text-white">Sync failed</h1>
        <div
          role="alert"
          className="text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-xl px-4 py-2 w-full"
        >
          {error}
        </div>
        <p className="text-xs text-zinc-500 text-center">
          You can retry now or skip and sync later with{" "}
          <code className="text-zinc-400">hq sync pull</code>.
        </p>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => {
              attemptedRef.current = false;
              setStatus("idle");
              setError(null);
            }}
            className="rounded-full py-2.5 px-6 text-sm font-medium bg-white text-black hover:bg-zinc-100 transition-colors"
          >
            Retry
          </button>
          <button
            type="button"
            onClick={() => onNext?.()}
            className="rounded-full py-2.5 px-6 text-sm font-medium border border-white/20 text-white hover:bg-white/5 transition-colors"
          >
            Skip
          </button>
        </div>
      </div>
    );
  }

  // Idle — briefly shown before effect kicks in
  return (
    <div className="flex flex-col items-center gap-4 max-w-sm">
      <div className="w-8 h-8 border-2 border-white/20 border-t-white rounded-full animate-spin" />
      <p className="text-sm text-zinc-400">Preparing sync…</p>
    </div>
  );
}
