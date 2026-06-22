// deps-install.ts — US-002
// Non-interactive dependency install routine for the unified orchestrator.
//
// The DEPS table owns the optional/required partition, dependency graph, and
// install commands. runDepsInstall() skips optional deps, installs ready
// required deps in dependency-aware waves, and returns structured results the
// caller can render or surface as an error.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// ---------------------------------------------------------------------------
// Dep definitions — canonical table, shared between screen and install logic
// ---------------------------------------------------------------------------

export interface DepDef {
  id: string;
  label: string;
  installCmd: string;
  installUrl: string;
  /** CLI binary name for `which` lookup. Defaults to `id` when omitted. */
  binary?: string;
  /** When true, a missing/failed state does NOT block progress. */
  optional?: boolean;
  /** IDs that must be `ok` before this dep's install is attempted. */
  dependsOn?: readonly string[];
  /** Optional secondary line for disambiguation. */
  subtitle?: string;
}

export const DEPS: readonly DepDef[] = [
  {
    id: "node",
    label: "Node.js",
    installCmd: "install_node",
    installUrl: "https://nodejs.org",
    subtitle: "Managed local install — no admin access required",
  },
  {
    id: "yq",
    label: "yq",
    installCmd: "install_yq",
    installUrl: "https://github.com/mikefarah/yq",
    subtitle: "Installed directly when Homebrew is unavailable",
  },
  {
    id: "qmd",
    label: "qmd",
    installCmd: "install_qmd",
    installUrl: "https://github.com/tobi/qmd",
    dependsOn: ["node"],
  },
  {
    id: "hq-cli",
    label: "HQ CLI",
    installCmd: "install_hq_cli",
    installUrl: "https://www.npmjs.com/package/@indigoai-us/hq-cli",
    binary: "hq",
    dependsOn: ["node"],
    subtitle: "Auth, deploy, and package management for HQ",
  },
  {
    id: "git",
    label: "Git",
    installCmd: "install_git",
    installUrl: "https://git-scm.com",
    subtitle:
      "Portable Git installed into the HQ toolchain — no Xcode tools or Homebrew. Required: autocommit, repos, agents, and pack install all use it",
  },
  {
    id: "gh",
    label: "gh",
    installCmd: "install_gh",
    installUrl: "https://cli.github.com",
    optional: true,
  },
  {
    id: "claude-code",
    label: "Claude Code",
    installCmd: "install_claude_code",
    installUrl: "https://docs.anthropic.com/en/claude-code",
    binary: "claude",
    optional: true,
    dependsOn: ["node"],
    subtitle: "Anthropic CLI — not the Claude desktop app",
  },
  {
    id: "homebrew",
    label: "Homebrew",
    installCmd: "install_homebrew",
    installUrl: "https://brew.sh",
    binary: "brew",
    optional: true,
    subtitle: "Optional system package manager — may require admin access",
  },
] as const;

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface DepInstallResult {
  id: string;
  label: string;
  optional: boolean;
  status: "ok" | "skipped" | "failed";
  error?: string;
}

export interface DepsInstallSummary {
  results: DepInstallResult[];
  /** True when every required (non-optional) dep succeeded. */
  allRequiredOk: boolean;
}

// ---------------------------------------------------------------------------
// runDepsInstall
// ---------------------------------------------------------------------------

/**
 * Non-interactive dependency installer.
 *
 * - Required deps: checked then installed if missing. A failure surfaces as a
 *   structured error and sets allRequiredOk = false.
 * - Optional deps: always skipped. A missing optional never blocks progress.
 *
 * onProgress receives (depId, progressLine) for each streaming line emitted by
 * the Tauri install commands. Caller may render these or ignore them.
 */
export async function runDepsInstall(
  onProgress?: (depId: string, line: string) => void,
  onHandle?: (depId: string, handle: string) => void,
): Promise<DepsInstallSummary> {
  const resultById = new Map<string, DepInstallResult>();
  const processed = new Set<string>();
  // Track which deps succeeded so dependsOn gating works.
  const okSet = new Set<string>();

  // Register a single install:progress listener for the whole run.
  type ProgressPayload = { line?: string; handle?: string };
  const seenHandles = new Set<string>();
  const handleDepIds = new Map<string, string>();
  const activeDepIds = new Set<string>();
  const representativeDepId = () => activeDepIds.values().next().value ?? null;
  const unlisten = await listen("install:progress", (event: { payload: unknown }) => {
    const payload = event.payload as ProgressPayload;
    const depId =
      (payload?.handle ? handleDepIds.get(payload.handle) : null) ??
      representativeDepId();
    if (
      depId &&
      payload?.handle &&
      payload.handle !== "preflight" &&
      !seenHandles.has(payload.handle)
    ) {
      seenHandles.add(payload.handle);
      handleDepIds.set(payload.handle, depId);
      onHandle?.(depId, payload.handle);
    }
    const line = payload?.line ?? "";
    if (depId && line && onProgress) {
      onProgress(depId, line);
    }
  });

  async function installRequiredDep(dep: DepDef): Promise<DepInstallResult> {
    // Check if already installed.
    try {
      const checkResult = await invoke<{ installed: boolean }>("check_dep", {
        tool: dep.binary ?? dep.id,
      });
      if (checkResult.installed) {
        return { id: dep.id, label: dep.label, optional: false, status: "ok" };
      }
    } catch {
      // check_dep failure treated as not installed — proceed to install.
    }

    activeDepIds.add(dep.id);
    try {
      await invoke(dep.installCmd);
      return { id: dep.id, label: dep.label, optional: false, status: "ok" };
    } catch (err) {
      const errorMsg =
        typeof err === "string"
          ? err
          : err instanceof Error
            ? err.message
            : "Installation failed";
      return {
        id: dep.id,
        label: dep.label,
        optional: false,
        status: "failed",
        error: errorMsg,
      };
    } finally {
      activeDepIds.delete(dep.id);
    }
  }

  try {
    for (const dep of DEPS) {
      if (!dep.optional) continue;
      processed.add(dep.id);
      resultById.set(dep.id, {
        id: dep.id,
        label: dep.label,
        optional: true,
        status: "skipped",
      });
    }

    while (true) {
      const ready = DEPS.filter(
        (dep) =>
          !dep.optional &&
          !processed.has(dep.id) &&
          (dep.dependsOn ?? []).every((parentId) => okSet.has(parentId)),
      );
      if (ready.length === 0) break;

      const settled = await Promise.all(ready.map((dep) => installRequiredDep(dep)));
      for (const result of settled) {
        processed.add(result.id);
        resultById.set(result.id, result);
        if (result.status === "ok") {
          okSet.add(result.id);
        }
      }
    }

    for (const dep of DEPS) {
      if (dep.optional || processed.has(dep.id)) continue;
      resultById.set(dep.id, {
        id: dep.id,
        label: dep.label,
        optional: false,
        status: "failed",
        error: `Prerequisite not installed: ${(dep.dependsOn ?? []).filter((p) => !okSet.has(p)).join(", ")}`,
      });
    }
  } finally {
    unlisten();
  }

  const results = DEPS.map((dep) => {
    const result = resultById.get(dep.id);
    if (result) return result;
    return {
      id: dep.id,
      label: dep.label,
      optional: !!dep.optional,
      status: dep.optional ? "skipped" : "failed",
      error: dep.optional ? undefined : "Dependency was not processed",
    } satisfies DepInstallResult;
  });

  const allRequiredOk = results
    .filter((r) => !r.optional)
    .every((r) => r.status === "ok");

  return { results, allRequiredOk };
}
