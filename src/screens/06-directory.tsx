// 06-directory.tsx — US-015
// Directory picker screen — folder selection and existing-HQ detection.

import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { setInstallPath } from "@/lib/wizard-state";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type HqMode = "graft" | "overwrite" | null;

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
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [isHq, setIsHq] = useState(false);
  const [hqMode, setHqMode] = useState<HqMode>(null);
  const [detecting, setDetecting] = useState(false);
  const [newDirectory, setNewDirectory] = useState(false);

  async function handleChooseFolder() {
    const picked = await invoke<string | null>("pick_directory", {
      defaultPath: "~/hq",
    });

    if (picked === null || picked === undefined) {
      return;
    }

    setSelectedPath(picked);
    setIsHq(false);
    setHqMode(null);
    setNewDirectory(false);
    setDetecting(true);

    try {
      const result = await invoke<{ exists: boolean; isHq: boolean }>(
        "detect_hq",
        { path: picked }
      );

      if (result.isHq) {
        setIsHq(true);
      } else {
        setNewDirectory(true);
      }
    } finally {
      setDetecting(false);
    }
  }

  function handleGraft() {
    setHqMode("graft");
  }

  function handleOverwrite() {
    setHqMode("overwrite");
  }

  // Continue is enabled when:
  // - New directory selected (no existing HQ)
  // - Existing HQ detected AND user has chosen graft or overwrite
  const canContinue =
    selectedPath !== null &&
    (newDirectory || (isHq && hqMode !== null));

  return (
    <div className="flex flex-col gap-6 max-w-lg">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-medium text-white">Choose install directory</h1>
        <p className="text-sm font-light text-zinc-400">
          Select where HQ will be installed on your machine.
        </p>
      </div>

      <div className="flex flex-col gap-4">
        <button
          type="button"
          onClick={handleChooseFolder}
          className="self-start px-6 py-2.5 rounded-full text-sm font-medium bg-white text-black hover:bg-zinc-100 transition-colors"
        >
          Choose folder
        </button>

        {selectedPath && (
          <div className="flex flex-col gap-2 bg-white/5 border border-white/10 rounded-xl px-4 py-3">
            <p className="text-sm font-mono text-zinc-300 break-all">
              {selectedPath}
            </p>

            {detecting && (
              <p className="text-xs text-zinc-500">Detecting…</p>
            )}

            {!detecting && newDirectory && (
              <p className="text-xs text-zinc-400">New directory — fresh install.</p>
            )}

            {!detecting && isHq && (
              <div className="flex flex-col gap-3">
                <p className="text-sm font-medium text-zinc-200">
                  Existing HQ detected
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={handleGraft}
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
                    onClick={handleOverwrite}
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
      </div>

      {canContinue && (
        <button
          type="button"
          onClick={() => {
            if (selectedPath) {
              setInstallPath(selectedPath);
            }
            onNext?.();
          }}
          className="self-start px-6 py-2.5 rounded-full text-sm font-medium bg-white text-black hover:bg-zinc-100 transition-colors"
        >
          Continue
        </button>
      )}
    </div>
  );
}
