// 05-github-walkthrough.tsx — US-015
// GitHub setup walkthrough — account creation, SSH key, and PAT.

import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// ---------------------------------------------------------------------------
// Sub-step definitions
// ---------------------------------------------------------------------------

interface SubStep {
  id: string;
  label: string;
  buttonLabel: string;
  url: string;
}

const SUB_STEPS: SubStep[] = [
  {
    id: "account",
    label: "Create GitHub Account",
    buttonLabel: "Open GitHub Account",
    url: "https://github.com/signup",
  },
  {
    id: "ssh",
    label: "Add SSH Key",
    buttonLabel: "Open SSH Key",
    url: "https://github.com/settings/ssh/new",
  },
  {
    id: "pat",
    label: "Create Personal Access Token",
    buttonLabel: "Create PAT",
    url: "https://github.com/settings/tokens/new",
  },
];

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface GithubWalkthroughProps {
  onNext?: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function GithubWalkthrough({ onNext }: GithubWalkthroughProps) {
  const [checked, setChecked] = useState<Record<string, boolean>>({
    account: false,
    ssh: false,
    pat: false,
  });
  const [pat, setPat] = useState("");

  const allChecked = SUB_STEPS.every((s) => checked[s.id]);

  function handleCheckChange(id: string, value: boolean) {
    setChecked((prev) => ({ ...prev, [id]: value }));
  }

  async function handleOpenWebview(url: string) {
    await invoke("open_webview", { url });
  }

  async function handlePatBlur() {
    if (pat.trim()) {
      await invoke("keychain_set", {
        service: "pat",
        account: "github",
        secret: pat,
      });
    }
  }

  return (
    <div className="flex flex-col gap-6 max-w-lg">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-medium text-white">Set up GitHub</h1>
        <p className="text-sm font-light text-zinc-400">
          Complete each step to connect your GitHub account.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        {SUB_STEPS.map((step) => (
          <div
            key={step.id}
            className="flex flex-col gap-2 bg-white/5 border border-white/10 rounded-xl px-4 py-3"
          >
            <div className="flex items-center justify-between gap-3">
              <label className="flex items-center gap-3 cursor-pointer select-none">
                <input
                  type="checkbox"
                  data-step={step.id}
                  checked={checked[step.id]}
                  onChange={(e) => handleCheckChange(step.id, e.target.checked)}
                  className="w-4 h-4 accent-white cursor-pointer"
                />
                <span className="text-sm font-medium text-zinc-200">
                  {step.label}
                </span>
              </label>

              <button
                type="button"
                onClick={() => handleOpenWebview(step.url)}
                className="text-xs px-3 py-1 rounded-full bg-white/10 text-zinc-300 hover:bg-white/20 transition-colors font-medium"
              >
                {step.buttonLabel}
              </button>
            </div>

            {/* PAT input — only shown for the pat sub-step */}
            {step.id === "pat" && (
              <input
                id="pat-input"
                type="text"
                aria-label="PAT"
                value={pat}
                onChange={(e) => setPat(e.target.value)}
                onBlur={handlePatBlur}
                placeholder="Paste your PAT here"
                className="mt-1 w-full rounded-lg bg-black/20 border border-white/10 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-white/30"
              />
            )}
          </div>
        ))}
      </div>

      {allChecked && (
        <button
          type="button"
          onClick={onNext}
          className="self-start px-6 py-2.5 rounded-full text-sm font-medium bg-white text-black hover:bg-zinc-100 transition-colors"
        >
          Continue
        </button>
      )}
    </div>
  );
}
