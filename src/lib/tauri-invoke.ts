// Typed wrappers around Tauri invoke commands exposed by the Rust core.
//
// Types mirror the `serde` shapes in `src-tauri/src/core/*.rs` — keep them
// in sync with the Rust source or the runtime will silently deserialize to
// `undefined`.

import { invoke } from "@tauri-apps/api/core";

// ──────────────────────────────────────────────────────────────────────────
// Platform (mirrors core::platform)
// ──────────────────────────────────────────────────────────────────────────

/** `OsType` enum, `serde(rename_all = "kebab-case")`. */
export type OsType =
  | "macos"
  | "linux-debian"
  | "linux-fedora"
  | "linux-arch"
  | "linux"
  | "windows"
  | "unix";

/** `SystemPackageManager` enum, `serde(rename_all = "lowercase")`. */
export type SystemPackageManager =
  | "brew"
  | "apt"
  | "dnf"
  | "yum"
  | "pacman"
  | "winget"
  | "choco";

/** `PlatformInfo` — note field rename to camelCase via serde. */
export interface PlatformInfo {
  os: OsType;
  packageManager: SystemPackageManager | null;
  npmAvailable: boolean;
}

export async function detectPlatform(): Promise<PlatformInfo> {
  return await invoke<PlatformInfo>("detect_platform");
}

// ──────────────────────────────────────────────────────────────────────────
// Deps (mirrors core::deps)
// ──────────────────────────────────────────────────────────────────────────

/** `DepId` enum, `serde(rename_all = "kebab-case")`. */
export type DepId =
  | "node"
  | "git"
  | "gh"
  | "claude"
  | "qmd"
  | "yq"
  | "vercel"
  | "hq-cli";

/** Ordered list matching create-hq + spec §3. Renderer uses this to display
 * deps in a deterministic order instead of relying on `dep_registry()`
 * insertion order. */
export const DEP_ORDER: readonly DepId[] = [
  "node",
  "git",
  "gh",
  "claude",
  "qmd",
  "yq",
  "vercel",
  "hq-cli",
] as const;

/** Human-readable display name per `DepId`. */
export const DEP_DISPLAY_NAME: Record<DepId, string> = {
  node: "Node.js",
  git: "Git",
  gh: "GitHub CLI",
  claude: "Claude Code",
  qmd: "qmd (search)",
  yq: "yq (YAML)",
  vercel: "Vercel CLI",
  "hq-cli": "HQ CLI",
};

/** `DepDescriptor` — matches `core::deps::DepDescriptor`. */
export interface DepDescriptor {
  id: DepId;
  name: string;
  check_cmd: string;
  required: boolean;
  auto_installable: boolean;
  install_hint: string;
  // `install_commands` is a HashMap<PackageManager, String> on the Rust
  // side; we only need the keys in the renderer so we leave it untyped.
  install_commands: Record<string, string>;
}

/** `CheckResult` — one dep probe. */
export interface CheckResult {
  dep_id: DepId;
  installed: boolean;
  detected_version: string | null;
}

export async function depRegistry(): Promise<DepDescriptor[]> {
  return await invoke<DepDescriptor[]>("dep_registry");
}

export async function checkDeps(): Promise<CheckResult[]> {
  return await invoke<CheckResult[]>("check_deps");
}

// ──────────────────────────────────────────────────────────────────────────
// Install (mirrors commands::deps::install_dep)
// ──────────────────────────────────────────────────────────────────────────

export type InstallOutcome =
  | { result: "auto"; command: string; exit_code: number | null }
  | { result: "manual"; hint: string }
  | { result: "not-found"; dep_id: DepId };

export async function installDep(depId: DepId): Promise<InstallOutcome> {
  return await invoke<InstallOutcome>("install_dep", { depId });
}

// ──────────────────────────────────────────────────────────────────────────
// Scaffold (mirrors commands::scaffold)
// ──────────────────────────────────────────────────────────────────────────

export interface ScaffoldSummary {
  target_dir: string;
  file_count: number;
  duration_ms: number;
  commit_sha: string;
}

export type ScaffoldErrorKind =
  | "target-not-empty"
  | "target-not-writable"
  | "io"
  | "git-failed"
  | "embedded-template-empty"
  | "git-config-missing";

export type ScaffoldOutcome =
  | { result: "ok"; summary: ScaffoldSummary }
  | { result: "err"; kind: ScaffoldErrorKind; message: string };

export async function scaffoldHq(
  targetDir: string,
  force: boolean,
  requestId: string,
): Promise<ScaffoldOutcome> {
  return await invoke<ScaffoldOutcome>("scaffold_hq", {
    targetDir,
    force,
    requestId,
  });
}

export async function templateFileCount(): Promise<number> {
  return await invoke<number>("template_file_count");
}

// ──────────────────────────────────────────────────────────────────────────
// Cloud (mirrors commands::cloud)
// ──────────────────────────────────────────────────────────────────────────

/** `CloudBackendSpec` — kebab-case `backend` tag as the discriminator.
 *  Matches the serde shape in `src-tauri/src/commands/cloud.rs`. */
export type CloudBackendSpec =
  | { backend: "github"; repo: string }
  | { backend: "s3"; bucket: string; prefix: string };

/** `ExistingInfo` — bytes on the wire are serde snake_case. */
export interface ExistingInfo {
  exists: boolean;
  last_modified: string | null;
  estimated_size: number | null;
}

/** `ClonedHqSummary` — summary returned when a clone completes. */
export interface ClonedHqSummary {
  target_dir: string;
  backend: string;
  duration_ms: number;
}

/** Stable kebab-case discriminators for `CloudError` mapped to the renderer. */
export type CloudErrorKind =
  | "not-found"
  | "auth-failed"
  | "network-failed"
  | "tool-missing"
  | "parse-error"
  | "target-not-empty"
  | "io"
  | "not-implemented";

export type CheckCloudOutcome =
  | { result: "ok"; info: ExistingInfo }
  | { result: "err"; kind: CloudErrorKind; message: string };

export type CloneCloudOutcome =
  | { result: "ok"; summary: ClonedHqSummary }
  | { result: "err"; kind: CloudErrorKind; message: string };

/** Ask the configured backend if an HQ already exists at the remote.
 *  Wraps `#[tauri::command] check_cloud_existing`. */
export async function checkCloudExisting(
  spec: CloudBackendSpec,
): Promise<CheckCloudOutcome> {
  return await invoke<CheckCloudOutcome>("check_cloud_existing", { spec });
}

/** Clone a remote HQ to `target_dir`, streaming progress events on the
 *  `cloud-clone:<request_id>` channel. Wraps
 *  `#[tauri::command] clone_cloud_existing`. */
export async function cloneCloudExisting(
  spec: CloudBackendSpec,
  targetDir: string,
  force: boolean,
  requestId: string,
): Promise<CloneCloudOutcome> {
  return await invoke<CloneCloudOutcome>("clone_cloud_existing", {
    spec,
    targetDir,
    force,
    requestId,
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

/** True when every required dep in `results` has `installed == true`.
 *
 * Required = node | git | gh | claude per spec §3.1. Optional deps don't
 * block the install button. */
export function allRequiredInstalled(
  results: CheckResult[],
  descriptors: DepDescriptor[],
): boolean {
  const requiredIds = new Set(
    descriptors.filter((d) => d.required).map((d) => d.id),
  );
  for (const r of results) {
    if (requiredIds.has(r.dep_id) && !r.installed) return false;
  }
  return true;
}

/** Returns the count of missing required deps. Used to label the CTA
 *  ("Install 3 tools + HQ" vs "Install HQ"). */
export function missingRequiredCount(
  results: CheckResult[],
  descriptors: DepDescriptor[],
): number {
  const requiredIds = new Set(
    descriptors.filter((d) => d.required).map((d) => d.id),
  );
  return results.filter((r) => requiredIds.has(r.dep_id) && !r.installed)
    .length;
}

/** Returns the count of missing deps across required + optional.
 *  Used for the "Install N tools + HQ" CTA label. */
export function missingAnyCount(results: CheckResult[]): number {
  return results.filter((r) => !r.installed).length;
}
