/**
 * Location picker route (US-008).
 *
 * User journey:
 *   1. Default the target to `~/hq` (the canonical HQ root).
 *   2. Let the user edit the path (plain text for MVP — native picker
 *      needs `@tauri-apps/plugin-dialog` which isn't installed yet; a
 *      follow-up card can add that without changing the contract here).
 *   3. Optionally let the user sign in to GitHub via CloudSyncPanel,
 *      which emits a `CloudDecision` (clone existing or start fresh).
 *   4. On "Next":
 *        - If decision is `clone`: call `clone_cloud_existing` with
 *          `force=false`. If TargetNotEmpty, show OverwriteConfirm; on
 *          confirm, call again with `force=true`.
 *        - If decision is `fresh` (the default): call `scaffold_hq`
 *          with `force=false`, same overwrite flow on TargetNotEmpty.
 *   5. On success: bubble the resolved `LocationResult` up to the app
 *      shell so the next route (US-009 success screen) can render.
 *
 * The route owns no long-lived data — everything it needs comes from
 * CloudSyncPanel's decision and from the Rust command layer.
 */

import { useCallback, useState } from "react";
import {
  cloneCloudExisting,
  scaffoldHq,
  type CloneCloudOutcome,
  type ScaffoldOutcome,
} from "@/lib/tauri-invoke";
import CloudSyncPanel, {
  type CloudDecision,
} from "@/routes/Location/CloudSyncPanel";
import OverwriteConfirm from "@/routes/Location/OverwriteConfirm";

export interface LocationResult {
  target_dir: string;
  /** Which code path actually shipped the files — used by US-009 to
   *  customize the success screen copy. */
  mode: "scaffold" | "clone";
  /** Short commit SHA (scaffold) or "cloned" (clone) — surfaced in US-009. */
  detail: string;
}

interface LocationRouteProps {
  /** Default path shown in the input — `~/hq` in production, overridable
   *  for tests so they don't depend on the OS home dir. */
  defaultPath?: string;
  /** Called when the route has successfully provisioned HQ at `target_dir`. */
  onComplete: (result: LocationResult) => void;
}

// Cheap, deterministic default — `~/hq` is documented everywhere as the
// canonical root. We don't resolve `~` here because the Rust side does
// the expansion in `scaffold_hq`.
const DEFAULT_TARGET_PATH = "~/hq";

// Request IDs for the streaming clone progress channel. Format matches
// the install wizard's `dep-install:<dep-id>` channel naming.
function makeRequestId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}`;
}

type Phase =
  | { name: "idle" }
  | { name: "running" }
  | { name: "needs-overwrite" }
  | { name: "error"; message: string };

const LocationRoute = ({
  defaultPath = DEFAULT_TARGET_PATH,
  onComplete,
}: LocationRouteProps) => {
  const [targetPath, setTargetPath] = useState<string>(defaultPath);
  const [decision, setDecision] = useState<CloudDecision>({ action: "fresh" });
  const [phase, setPhase] = useState<Phase>({ name: "idle" });

  const runScaffoldOrClone = useCallback(
    async (force: boolean): Promise<void> => {
      setPhase({ name: "running" });
      if (decision.action === "clone") {
        const requestId = makeRequestId("clone");
        const outcome: CloneCloudOutcome = await cloneCloudExisting(
          decision.spec,
          targetPath,
          force,
          requestId,
        );
        if (outcome.result === "ok") {
          onComplete({
            target_dir: outcome.summary.target_dir,
            mode: "clone",
            detail: outcome.summary.backend,
          });
          return;
        }
        if (outcome.kind === "target-not-empty") {
          setPhase({ name: "needs-overwrite" });
          return;
        }
        setPhase({ name: "error", message: outcome.message });
        return;
      }

      // action === "fresh"
      const requestId = makeRequestId("scaffold");
      const outcome: ScaffoldOutcome = await scaffoldHq(
        targetPath,
        force,
        requestId,
      );
      if (outcome.result === "ok") {
        onComplete({
          target_dir: outcome.summary.target_dir,
          mode: "scaffold",
          detail: outcome.summary.commit_sha,
        });
        return;
      }
      if (outcome.kind === "target-not-empty") {
        setPhase({ name: "needs-overwrite" });
        return;
      }
      setPhase({ name: "error", message: outcome.message });
    },
    [decision, onComplete, targetPath],
  );

  const handleNextClick = useCallback(() => {
    void runScaffoldOrClone(false);
  }, [runScaffoldOrClone]);

  const handleOverwriteConfirm = useCallback(() => {
    void runScaffoldOrClone(true);
  }, [runScaffoldOrClone]);

  const handleOverwriteCancel = useCallback(() => {
    setPhase({ name: "idle" });
  }, []);

  const pathIsEmpty = targetPath.trim() === "";
  const nextDisabled = pathIsEmpty || phase.name === "running";

  return (
    <main
      className="min-h-screen flex flex-col px-6 py-8"
      style={{ backgroundColor: "var(--retro-bg-0)" }}
      data-testid="location-route"
      data-phase={phase.name}
    >
      <header className="max-w-3xl w-full mx-auto mb-6 flex flex-col gap-2">
        <h1 className="retro-heading-block text-3xl">Where should HQ live?</h1>
        <p className="font-mono text-xs text-zinc-500 tracking-wider uppercase">
          pick a target folder + optional cloud sync
        </p>
      </header>

      <section className="max-w-3xl w-full mx-auto flex flex-col gap-6 mb-6">
        <label className="flex flex-col gap-1 font-mono text-xs">
          <span className="uppercase tracking-widest text-zinc-500">
            HQ location
          </span>
          <input
            type="text"
            className="retro-input"
            value={targetPath}
            onChange={(e) => setTargetPath(e.target.value)}
            data-testid="location-path-input"
            placeholder="~/hq"
          />
          {pathIsEmpty && (
            <span
              className="text-amber-400"
              data-testid="location-empty-warning"
            >
              Path is required.
            </span>
          )}
        </label>

        <CloudSyncPanel onDecision={setDecision} />

        {phase.name === "error" && (
          <p
            className="font-mono text-xs text-rose-400"
            data-testid="location-error"
          >
            {phase.message}
          </p>
        )}
      </section>

      <footer className="max-w-3xl w-full mx-auto flex justify-end">
        <button
          type="button"
          className="retro-cta-primary"
          disabled={nextDisabled}
          onClick={handleNextClick}
          data-testid="location-next"
        >
          {phase.name === "running" ? "Working…" : "Next"}
        </button>
      </footer>

      <OverwriteConfirm
        open={phase.name === "needs-overwrite"}
        targetPath={targetPath}
        onCancel={handleOverwriteCancel}
        onConfirm={handleOverwriteConfirm}
      />
    </main>
  );
};

export default LocationRoute;
