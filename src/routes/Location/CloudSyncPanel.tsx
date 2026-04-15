/**
 * CloudSyncPanel — the cloud decision UI nested inside the Location route.
 *
 * Internal state machine (purely local, no redux):
 *
 *   hidden (initial)
 *     └─ user clicks "Sign in to GitHub" → `signed-in-input`
 *   signed-in-input
 *     └─ user types `owner/repo` and clicks "Check cloud" → running
 *   running
 *     └─ `check_cloud_existing` resolves →
 *          - ok + exists          → `exists`
 *          - ok + does-not-exist  → `not-found`
 *          - err                   → `error` (retriable)
 *   exists  → user picks Clone existing | Start fresh
 *   not-found → "Start fresh" pre-selected, no alternative offered
 *   error    → user can retry or skip
 *
 * The panel never calls `clone_cloud_existing` itself — that's the
 * parent Location route's job at the "Next" step, using the
 * `CloudDecision` this panel emits via `onDecision`.
 *
 * The reason for that split: overwrite confirmation is a property of the
 * *destination* (target dir), not of the cloud source, and belongs in
 * the parent so the same confirmation path works for both `scaffold_hq`
 * and `clone_cloud_existing`.
 */

import { useCallback, useMemo, useState } from "react";
import {
  checkCloudExisting,
  type CloudBackendSpec,
} from "@/lib/tauri-invoke";
import {
  signInManual,
  validateRepoSpec,
  type GithubRepoSpec,
} from "@/lib/oauth-github";

/**
 * The decision the panel surfaces to the parent route.
 *
 * - `{action: "fresh"}` → scaffold a fresh HQ at the target.
 * - `{action: "clone", spec}` → clone the cloud backend into target.
 */
export type CloudDecision =
  | { action: "fresh" }
  | { action: "clone"; spec: CloudBackendSpec };

type CloudPhase =
  | { name: "hidden" }
  | { name: "signed-in-input"; spec: GithubRepoSpec }
  | { name: "running"; spec: GithubRepoSpec }
  | { name: "exists"; spec: GithubRepoSpec; lastModified: string | null }
  | { name: "not-found"; spec: GithubRepoSpec }
  | { name: "error"; spec: GithubRepoSpec; message: string };

interface CloudSyncPanelProps {
  /** Called whenever the panel's decision changes. */
  onDecision: (decision: CloudDecision) => void;
}

const CloudSyncPanel = ({ onDecision }: CloudSyncPanelProps) => {
  const [phase, setPhase] = useState<CloudPhase>({ name: "hidden" });
  const [repoInput, setRepoInput] = useState<string>("");
  // When the user is in the `exists` phase, they can flip between the
  // two radio options. We mirror that here so the parent knows which
  // outcome the panel is currently reporting.
  const [existsChoice, setExistsChoice] = useState<"clone" | "fresh">(
    "clone",
  );

  const repoValidationError = useMemo(
    () => (repoInput === "" ? null : validateRepoSpec(repoInput)),
    [repoInput],
  );

  // -----------------------------------------------------------------------
  // Transitions
  // -----------------------------------------------------------------------

  const handleBeginSignIn = useCallback(async () => {
    // Default the input to an empty string and move into the signed-in
    // shape with a blank spec — the real validation happens on Check.
    const result = await signInManual("placeholder/placeholder");
    if (!result.ok) return;
    setPhase({
      name: "signed-in-input",
      spec: { full_name: "", token: null },
    });
  }, []);

  const handleCheckCloud = useCallback(async () => {
    const err = validateRepoSpec(repoInput);
    if (err) return;
    const spec: GithubRepoSpec = { full_name: repoInput.trim(), token: null };
    setPhase({ name: "running", spec });

    const backend: CloudBackendSpec = {
      backend: "github",
      repo: spec.full_name,
    };
    const outcome = await checkCloudExisting(backend);

    if (outcome.result === "err") {
      if (outcome.kind === "not-found") {
        setPhase({ name: "not-found", spec });
        onDecision({ action: "fresh" });
        return;
      }
      setPhase({ name: "error", spec, message: outcome.message });
      return;
    }

    if (outcome.info.exists) {
      setPhase({
        name: "exists",
        spec,
        lastModified: outcome.info.last_modified,
      });
      setExistsChoice("clone");
      onDecision({ action: "clone", spec: backend });
      return;
    }

    setPhase({ name: "not-found", spec });
    onDecision({ action: "fresh" });
  }, [onDecision, repoInput]);

  const handleExistsChoice = useCallback(
    (choice: "clone" | "fresh") => {
      if (phase.name !== "exists") return;
      setExistsChoice(choice);
      if (choice === "clone") {
        onDecision({
          action: "clone",
          spec: { backend: "github", repo: phase.spec.full_name },
        });
      } else {
        onDecision({ action: "fresh" });
      }
    },
    [onDecision, phase],
  );

  const handleSkip = useCallback(() => {
    setPhase({ name: "hidden" });
    setRepoInput("");
    onDecision({ action: "fresh" });
  }, [onDecision]);

  const handleRetry = useCallback(() => {
    if (phase.name === "error") {
      setPhase({ name: "signed-in-input", spec: phase.spec });
    }
  }, [phase]);

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  return (
    <section
      className="retro-panel flex flex-col gap-4 p-5"
      data-testid="cloud-sync-panel"
      data-phase={phase.name}
    >
      <header className="flex items-baseline justify-between gap-3">
        <h3 className="retro-heading-sub text-sm uppercase tracking-widest">
          Cloud sync
        </h3>
        {phase.name !== "hidden" && (
          <button
            type="button"
            className="retro-text-link text-xs"
            onClick={handleSkip}
            data-testid="cloud-sync-skip"
          >
            Set up cloud later
          </button>
        )}
      </header>

      {phase.name === "hidden" && (
        <>
          <p className="font-mono text-xs text-zinc-400">
            HQ can sync to a GitHub repo so your work follows you across
            machines. You can skip this and set it up later with{" "}
            <code>hq cloud link</code>.
          </p>
          <div className="flex gap-3">
            <button
              type="button"
              className="retro-cta-primary"
              onClick={handleBeginSignIn}
              data-testid="cloud-sync-signin"
            >
              Sign in to GitHub
            </button>
            <button
              type="button"
              className="retro-text-link text-xs self-center"
              onClick={handleSkip}
              data-testid="cloud-sync-skip-initial"
            >
              Skip for now
            </button>
          </div>
        </>
      )}

      {phase.name === "signed-in-input" && (
        <>
          <p className="font-mono text-xs text-zinc-400">
            Paste the GitHub repo you want to treat as your HQ mirror.
          </p>
          <label className="flex flex-col gap-1 font-mono text-xs">
            <span className="uppercase tracking-widest text-zinc-500">
              owner/repo
            </span>
            <input
              type="text"
              className="retro-input"
              placeholder="indigoai-us/hq"
              value={repoInput}
              onChange={(e) => setRepoInput(e.target.value)}
              data-testid="cloud-sync-repo-input"
            />
            {repoValidationError && (
              <span
                className="text-rose-400"
                data-testid="cloud-sync-repo-error"
              >
                {repoValidationError}
              </span>
            )}
          </label>
          <div className="flex gap-3">
            <button
              type="button"
              className="retro-cta-primary"
              onClick={handleCheckCloud}
              disabled={repoValidationError !== null || repoInput === ""}
              data-testid="cloud-sync-check"
            >
              Check cloud
            </button>
          </div>
        </>
      )}

      {phase.name === "running" && (
        <p
          className="font-mono text-xs text-zinc-400"
          data-testid="cloud-sync-running"
        >
          Checking {phase.spec.full_name}…
        </p>
      )}

      {phase.name === "exists" && (
        <div className="flex flex-col gap-3">
          <p className="font-mono text-xs text-zinc-300">
            Found an existing HQ at{" "}
            <code data-testid="cloud-sync-found-repo">
              {phase.spec.full_name}
            </code>
            {phase.lastModified && (
              <>
                , last updated{" "}
                <span data-testid="cloud-sync-last-modified">
                  {phase.lastModified}
                </span>
              </>
            )}
            .
          </p>
          <label className="flex items-center gap-2 font-mono text-xs">
            <input
              type="radio"
              name="cloud-choice"
              checked={existsChoice === "clone"}
              onChange={() => handleExistsChoice("clone")}
              data-testid="cloud-sync-choice-clone"
            />
            Clone existing HQ
          </label>
          <label className="flex items-center gap-2 font-mono text-xs">
            <input
              type="radio"
              name="cloud-choice"
              checked={existsChoice === "fresh"}
              onChange={() => handleExistsChoice("fresh")}
              data-testid="cloud-sync-choice-fresh"
            />
            Start fresh (ignore cloud)
          </label>
        </div>
      )}

      {phase.name === "not-found" && (
        <p
          className="font-mono text-xs text-zinc-400"
          data-testid="cloud-sync-not-found"
        >
          No existing HQ found at <code>{phase.spec.full_name}</code>. We'll
          scaffold a fresh HQ and you can push it up later.
        </p>
      )}

      {phase.name === "error" && (
        <div className="flex flex-col gap-2">
          <p
            className="font-mono text-xs text-rose-400"
            data-testid="cloud-sync-error"
          >
            Cloud check failed: {phase.message}
          </p>
          <button
            type="button"
            className="retro-cta-primary retro-cta-primary--secondary"
            onClick={handleRetry}
            data-testid="cloud-sync-retry"
          >
            Try again
          </button>
        </div>
      )}
    </section>
  );
};

export default CloudSyncPanel;
