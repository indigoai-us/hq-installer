// install-manifest.ts
//
// Persistent install state, written into `{installPath}/.hq/install-manifest.json`.
// Agents reading an HQ tree consult this file to detect partial installs and
// self-heal (e.g. retry failed packs, re-run skipped dependency installs).
//
// The manifest is written incrementally — each wizard screen merges a partial
// state on completion or failure. Best-effort: write errors are logged but
// never block the wizard.

import { mkdir, readTextFile, writeTextFile, exists } from "@tauri-apps/plugin-fs";
import { getVersion } from "@tauri-apps/api/app";

const MANIFEST_DIR = ".hq";
const MANIFEST_FILE = "install-manifest.json";

/**
 * Single-source-of-truth for the installer version, cached after first read.
 * Reads from Tauri's app metadata (driven by `tauri.conf.json` / Cargo.toml).
 * Falls back to "unknown" if Tauri's API isn't reachable (e.g. unit tests).
 */
let cachedVersion: string | null = null;
export async function getInstallerVersion(): Promise<string> {
  if (cachedVersion !== null) return cachedVersion;
  try {
    cachedVersion = await getVersion();
  } catch {
    cachedVersion = "unknown";
  }
  return cachedVersion;
}

/** Status of a single tracked unit (step, dependency, or pack). */
export type ItemStatus = "pending" | "running" | "ok" | "failed" | "skipped";

export interface StepRecord {
  status: ItemStatus;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface DependencyRecord {
  status: ItemStatus;
  version?: string;
  error?: string;
  updatedAt: string;
}

export interface PackRecord {
  status: ItemStatus;
  error?: string;
  updatedAt: string;
}

export interface FailureRecord {
  stage: string;
  message: string;
  ts: string;
  /** Optional structured detail — keep small and serializable. */
  detail?: Record<string, unknown>;
}

export interface InstallManifest {
  /** Schema version — bump when shape changes so agents can branch. */
  schemaVersion: 1;
  /** Installer app version (from CARGO_PKG_VERSION when available). */
  installerVersion: string;
  installPath: string;
  startedAt: string;
  completedAt: string | null;
  steps: Record<string, StepRecord>;
  dependencies: Record<string, DependencyRecord>;
  packs: Record<string, PackRecord>;
  failures: FailureRecord[];
}

function manifestPath(installPath: string): string {
  return `${installPath}/${MANIFEST_DIR}/${MANIFEST_FILE}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function emptyManifest(installPath: string, installerVersion: string): InstallManifest {
  return {
    schemaVersion: 1,
    installerVersion,
    installPath,
    startedAt: nowIso(),
    completedAt: null,
    steps: {},
    dependencies: {},
    packs: {},
    failures: [],
  };
}

/** Read the manifest from disk, or return a fresh one if absent/corrupt. */
export async function readManifest(
  installPath: string,
  installerVersion: string,
): Promise<InstallManifest> {
  try {
    const path = manifestPath(installPath);
    if (!(await exists(path))) {
      return emptyManifest(installPath, installerVersion);
    }
    const raw = await readTextFile(path);
    const parsed = JSON.parse(raw) as InstallManifest;
    // Defensive: if any required field is missing, fall back to fresh.
    if (!parsed.schemaVersion || !parsed.steps) {
      return emptyManifest(installPath, installerVersion);
    }
    return parsed;
  } catch {
    return emptyManifest(installPath, installerVersion);
  }
}

/** Write the manifest to disk. Best-effort — never throws. */
export async function writeManifest(manifest: InstallManifest): Promise<void> {
  try {
    const dir = `${manifest.installPath}/${MANIFEST_DIR}`;
    await mkdir(dir, { recursive: true });
    await writeTextFile(
      manifestPath(manifest.installPath),
      JSON.stringify(manifest, null, 2) + "\n",
    );
  } catch (err) {
    // Non-fatal — surface to console for dev visibility.
    console.error("[install-manifest] write failed:", err);
  }
}

/** Read-modify-write convenience: load manifest, apply mutator, persist. */
export async function updateManifest(
  installPath: string,
  installerVersion: string,
  mutate: (m: InstallManifest) => void,
): Promise<InstallManifest> {
  const manifest = await readManifest(installPath, installerVersion);
  mutate(manifest);
  await writeManifest(manifest);
  return manifest;
}

// ---------------------------------------------------------------------------
// Convenience helpers — preferred entry points for screens
// ---------------------------------------------------------------------------

/** Mark a wizard step as started. */
export async function recordStepStart(
  installPath: string,
  installerVersion: string,
  stepId: string,
): Promise<void> {
  await updateManifest(installPath, installerVersion, (m) => {
    m.steps[stepId] = {
      ...(m.steps[stepId] ?? {}),
      status: "running",
      startedAt: nowIso(),
    };
  });
}

/** Mark a wizard step as completed. */
export async function recordStepOk(
  installPath: string,
  installerVersion: string,
  stepId: string,
): Promise<void> {
  await updateManifest(installPath, installerVersion, (m) => {
    m.steps[stepId] = {
      ...(m.steps[stepId] ?? {}),
      status: "ok",
      completedAt: nowIso(),
      error: undefined,
    };
  });
}

/** Mark a wizard step as failed and append a structured failure record. */
export async function recordStepFailure(
  installPath: string,
  installerVersion: string,
  stepId: string,
  error: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  await updateManifest(installPath, installerVersion, (m) => {
    m.steps[stepId] = {
      ...(m.steps[stepId] ?? {}),
      status: "failed",
      completedAt: nowIso(),
      error,
    };
    m.failures.push({ stage: stepId, message: error, ts: nowIso(), detail });
  });
}

/** Snapshot the current state of every tracked dependency in one write. */
export async function recordDependencies(
  installPath: string,
  installerVersion: string,
  deps: Record<string, { status: ItemStatus; version?: string; error?: string }>,
): Promise<void> {
  await updateManifest(installPath, installerVersion, (m) => {
    for (const [name, record] of Object.entries(deps)) {
      m.dependencies[name] = { ...record, updatedAt: nowIso() };
    }
  });
}

/** Snapshot the current state of every tracked HQ pack in one write. */
export async function recordPacks(
  installPath: string,
  installerVersion: string,
  packs: Record<string, { status: ItemStatus; error?: string }>,
): Promise<void> {
  await updateManifest(installPath, installerVersion, (m) => {
    for (const [name, record] of Object.entries(packs)) {
      m.packs[name] = { ...record, updatedAt: nowIso() };
    }
  });
}

/** Mark the install as complete (sets completedAt). Idempotent. */
export async function recordInstallComplete(
  installPath: string,
  installerVersion: string,
): Promise<void> {
  await updateManifest(installPath, installerVersion, (m) => {
    m.completedAt = nowIso();
  });
}
