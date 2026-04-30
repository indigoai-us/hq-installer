// 06-directory.tsx — US-015 (revised 2026-04-29)
// Directory picker screen — pick a parent location and create a named HQ
// subfolder. We always create a fresh subfolder (defaulting to "hq") so the
// install never lands on top of arbitrary files. Existing-HQ detection still
// runs on the resulting path so users with a prior HQ get graft/overwrite.

import { useState } from "react";
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
// Types
// ---------------------------------------------------------------------------

type HqMode = "graft" | "overwrite" | null;

interface CreateDirectoryResult {
  path: string;
  // serde rename in Rust → snake_case → camelCase; check both keys.
  already_existed?: boolean;
  alreadyExisted?: boolean;
  non_empty?: boolean;
  nonEmpty?: boolean;
}

interface DetectHqResult {
  exists: boolean;
  isHq: boolean;
}

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
  // Parent dir picked via the native folder picker. The actual install path
  // is `{parent}/{folderName}`.
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [folderName, setFolderName] = useState<string>("hq");
  // After Create-and-continue runs, this captures the final install path so
  // we can show graft/overwrite UI when a prior HQ is present.
  const [resolvedPath, setResolvedPath] = useState<string | null>(null);
  const [isHq, setIsHq] = useState(false);
  const [hqMode, setHqMode] = useState<HqMode>(null);
  const [nonEmpty, setNonEmpty] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleChooseParent() {
    setError(null);
    const picked = await invoke<string | null>("pick_directory", {
      defaultPath: "~",
    });
    if (picked === null || picked === undefined) return;
    setParentPath(picked);
    // Reset downstream state so a re-pick discards prior detection results.
    setResolvedPath(null);
    setIsHq(false);
    setHqMode(null);
    setNonEmpty(false);
  }

  async function handleCreateAndContinue() {
    if (!parentPath) return;
    const name = folderName.trim();
    if (!name) {
      setError("Folder name cannot be empty.");
      return;
    }

    setWorking(true);
    setError(null);

    try {
      // 1. Create (or confirm) the folder via Rust.
      const created = await invoke<CreateDirectoryResult>("create_directory", {
        parent: parentPath,
        name,
      });
      const installPath = created.path;
      const wasNonEmpty = created.non_empty ?? created.nonEmpty ?? false;
      setResolvedPath(installPath);
      setNonEmpty(wasNonEmpty);

      // 2. Detect existing HQ — if present, surface graft/overwrite UI and
      //    stop here. The user resolves with a follow-up button.
      const detection = await invoke<DetectHqResult>("detect_hq", {
        path: installPath,
      });
      if (detection.isHq) {
        setIsHq(true);
        return;
      }

      // 3. Fresh (or non-HQ) folder — record state and proceed. Manifest
      //    writes are best-effort; even if they fail we don't block the
      //    install.
      setInstallPath(installPath);
      const installerVersion = await getInstallerVersion();
      try {
        await recordStepStart(installPath, installerVersion, "directory");
        await recordStepOk(installPath, installerVersion, "directory");
      } catch {
        /* manifest write failures are non-fatal */
      }
      onNext?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      const installerVersion = await getInstallerVersion();
      // Best-effort failure telemetry. The manifest write may also fail if
      // installPath was never resolved, so we guard it.
      void pingFailure({
        stage: "directory",
        message: msg,
        version: installerVersion,
        detail: { parent: parentPath, name },
      });
      if (resolvedPath) {
        try {
          await recordStepFailure(
            resolvedPath,
            installerVersion,
            "directory",
            msg,
            { parent: parentPath, name },
          );
        } catch {
          /* ignore */
        }
      }
    } finally {
      setWorking(false);
    }
  }

  async function continueWithMode(mode: HqMode) {
    if (!resolvedPath || !mode) return;
    setHqMode(mode);
    setInstallPath(resolvedPath);
    const installerVersion = await getInstallerVersion();
    try {
      await recordStepStart(resolvedPath, installerVersion, "directory");
      await recordStepOk(resolvedPath, installerVersion, "directory");
    } catch {
      /* ignore */
    }
    onNext?.();
  }

  const previewPath =
    parentPath && folderName.trim()
      ? `${parentPath.replace(/\/$/, "")}/${folderName.trim()}`
      : null;

  return (
    <div className="flex flex-col gap-6 max-w-lg">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-medium text-white">Where should HQ live?</h1>
        <p className="text-sm font-light text-zinc-400">
          Pick a location and we'll create a folder for HQ inside it.
        </p>
      </div>

      <div className="flex flex-col gap-4">
        <button
          type="button"
          onClick={handleChooseParent}
          className="self-start px-6 py-2.5 rounded-full text-sm font-medium bg-white text-black hover:bg-zinc-100 transition-colors"
        >
          Choose location
        </button>

        {parentPath && (
          <div className="flex flex-col gap-3 bg-white/5 border border-white/10 rounded-xl px-4 py-3">
            <div className="flex flex-col gap-1">
              <span className="text-xs text-zinc-500">Location</span>
              <span className="text-sm font-mono text-zinc-300 break-all">
                {parentPath}
              </span>
            </div>

            <div className="flex flex-col gap-1">
              <label
                htmlFor="hq-folder-name"
                className="text-xs text-zinc-500"
              >
                Folder name
              </label>
              <input
                id="hq-folder-name"
                type="text"
                value={folderName}
                onChange={(e) => setFolderName(e.target.value)}
                disabled={working || isHq}
                className="text-sm font-mono bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-zinc-200 focus:outline-none focus:border-white/30 disabled:opacity-50"
              />
            </div>

            {previewPath && (
              <div className="flex flex-col gap-1">
                <span className="text-xs text-zinc-500">Install path</span>
                <span className="text-sm font-mono text-zinc-200 break-all">
                  {previewPath}
                </span>
              </div>
            )}

            {nonEmpty && !isHq && (
              <p className="text-xs text-amber-400">
                Heads up — that folder already has files in it. HQ will be
                installed alongside them.
              </p>
            )}

            {isHq && (
              <div className="flex flex-col gap-2">
                <p className="text-sm font-medium text-zinc-200">
                  Existing HQ detected
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => continueWithMode("graft")}
                    className={`text-xs px-3 py-1 rounded-full font-medium transition-colors ${
                      hqMode === "graft"
                        ? "bg-white text-black"
                        : "bg-white/10 text-zinc-300 hover:bg-white/20"
                    }`}
                  >
                    Graft
                  </button>
                  <button
                    type="button"
                    onClick={() => continueWithMode("overwrite")}
                    className={`text-xs px-3 py-1 rounded-full font-medium transition-colors ${
                      hqMode === "overwrite"
                        ? "bg-white text-black"
                        : "bg-white/10 text-zinc-300 hover:bg-white/20"
                    }`}
                  >
                    Overwrite
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {error && (
          <p className="text-xs text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2">
            {error}
          </p>
        )}
      </div>

      {parentPath && !isHq && (
        <button
          type="button"
          onClick={handleCreateAndContinue}
          disabled={working || !folderName.trim()}
          className="self-start px-6 py-2.5 rounded-full text-sm font-medium bg-white text-black hover:bg-zinc-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {working ? "Creating…" : "Create & continue"}
        </button>
      )}
    </div>
  );
}
