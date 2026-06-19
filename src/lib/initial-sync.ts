// initial-sync.ts
//
// Kick off the installer's first cloud sync by spawning the SAME hq-cloud-sync
// runner the HQ-Sync menubar app uses — moved earlier, into the install flow,
// so a new account's HQ syncs to its personal vault (and any company vaults)
// the moment setup finishes instead of waiting for HQ-Sync's first launch.
//
// Why the real runner (vs a hand-rolled S3 push): it already owns personal +
// company vaults, bidirectional reconciliation, conflict resolution, the
// ignore/exclusion rules, and the sync journal. Re-implementing that in TS
// would inevitably drift from the canonical Rust/Node implementation.
//
// Auth: the refresh token stays in the OS keychain. The accessToken parameter
// is used for installer-side provisioning, and cognito.ts maintains an
// access-token-only ~/.hq/cognito-tokens.json handoff for the sync runner until
// the runner can read the keychain directly.
//
// Prerequisite: the personal vault bucket MUST be provisioned first — the
// runner errors (422) if it's missing. Callers run ensurePersonProvisioned()
// before reaching here.

import { invoke } from "@tauri-apps/api/core";
import { ensurePersonProvisioned } from "./vault-handoff";

// The runner bin `hq-sync-runner` ships inside the `@indigoai-us/hq-cloud`
// package. Keep this version pin in lockstep with hq-sync's HQ_CLOUD_VERSION
// (its src-tauri/src/commands/sync.rs) so the installer runs the exact same
// sync engine HQ-Sync does.
export const HQ_CLOUD_PACKAGE = "@indigoai-us/hq-cloud@~5.38.0";

/** Args accepted by the installer's `spawn_process` Tauri command. */
export interface SpawnArgs {
  cmd: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface InitialSyncDeps {
  ensure?: typeof ensurePersonProvisioned;
  /** Spawn a background process; resolves immediately with a process handle. */
  spawn?: (args: SpawnArgs) => Promise<string>;
}

export interface InitialSyncResult {
  personUid: string;
  /** Handle of the spawned runner process (for cancellation / observability). */
  handle: string;
}

/**
 * Guarantee the personal vault bucket, then spawn the hq-cloud-sync runner in
 * the background. Returns as soon as the process is launched — the sync streams
 * on its own thread and never blocks the wizard.
 *
 * `--companies --direction both --on-conflict keep` is the exact invocation
 * HQ-Sync uses; the personal slot is synced even when the account has zero
 * companies, so this covers the "no connected company" case too.
 */
export async function startInitialCloudSync(
  installPath: string,
  accessToken: string,
  person: { ownerSub: string; displayName: string },
  deps: InitialSyncDeps = {}
): Promise<InitialSyncResult> {
  const ensure = deps.ensure ?? ensurePersonProvisioned;
  const spawn =
    deps.spawn ??
    // The Rust command signature is `spawn_process(args: SpawnArgs)`, so the
    // invoke payload nests the spawn args under the `args` parameter name —
    // the same shape setup-progress's spawnAndWait uses.
    ((args: SpawnArgs) => invoke<string>("spawn_process", { args }));

  // 1. Make sure the personal bucket exists — the runner 422s otherwise.
  const { personUid } = await ensure(accessToken, person);

  // 2. Spawn the runner. HQ_ROOT + --hq-root point it at this install; PATH is
  //    augmented by spawn_process so the npx shebang resolves node.
  const handle = await spawn({
    cmd: "npx",
    args: [
      "-y",
      `--package=${HQ_CLOUD_PACKAGE}`,
      "hq-sync-runner",
      "--companies",
      "--direction",
      "both",
      "--on-conflict",
      "keep",
      "--hq-root",
      installPath,
    ],
    cwd: installPath,
    env: { HQ_ROOT: installPath },
  });

  return { personUid, handle };
}
