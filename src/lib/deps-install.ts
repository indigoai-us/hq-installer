// deps-install.ts — US-002
// Non-interactive dependency install routine for the unified orchestrator.
//
// The DEPS table owns the optional/required partition and install commands.
// runDepsInstall() iterates the table, skips optional deps, installs required
// ones via the existing Tauri commands, and returns a structured result the
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
  const results: DepInstallResult[] = [];
  // Track which deps succeeded so dependsOn gating works.
  const okSet = new Set<string>();

  // Register a single install:progress listener for the whole run.
  type ProgressPayload = { line?: string; handle?: string };
  const seenHandles = new Set<string>();
  let activeDepId: string | null = null;
  const unlisten = await listen("install:progress", (event: { payload: unknown }) => {
    const payload = event.payload as ProgressPayload;
    if (
      activeDepId &&
      payload?.handle &&
      payload.handle !== "preflight" &&
      !seenHandles.has(payload.handle)
    ) {
      seenHandles.add(payload.handle);
      onHandle?.(activeDepId, payload.handle);
    }
    const line = payload?.line ?? "";
    if (activeDepId && line && onProgress) {
      onProgress(activeDepId, line);
    }
  });

  try {
    for (const dep of DEPS) {
      // Skip optional deps — they never block progress.
      if (dep.optional) {
        results.push({ id: dep.id, label: dep.label, optional: true, status: "skipped" });
        continue;
      }

      // Skip required deps whose parents didn't succeed — record as failed so
      // allRequiredOk reflects the true outcome.
      if (dep.dependsOn && dep.dependsOn.some((parentId) => !okSet.has(parentId))) {
        results.push({
          id: dep.id,
          label: dep.label,
          optional: false,
          status: "failed",
          error: `Prerequisite not installed: ${dep.dependsOn.filter((p) => !okSet.has(p)).join(", ")}`,
        });
        continue;
      }

      // Check if already installed.
      try {
        const checkResult = await invoke<{ installed: boolean }>("check_dep", {
          tool: dep.binary ?? dep.id,
        });
        if (checkResult.installed) {
          okSet.add(dep.id);
          results.push({ id: dep.id, label: dep.label, optional: false, status: "ok" });
          continue;
        }
      } catch {
        // check_dep failure treated as not installed — proceed to install.
      }

      // Install the dep.
      activeDepId = dep.id;
      try {
        await invoke(dep.installCmd);
        okSet.add(dep.id);
        results.push({ id: dep.id, label: dep.label, optional: false, status: "ok" });
      } catch (err) {
        const errorMsg =
          typeof err === "string"
            ? err
            : err instanceof Error
              ? err.message
              : "Installation failed";
        results.push({
          id: dep.id,
          label: dep.label,
          optional: false,
          status: "failed",
          error: errorMsg,
        });
      } finally {
        activeDepId = null;
      }
    }
  } finally {
    unlisten();
  }

  const allRequiredOk = results
    .filter((r) => !r.optional)
    .every((r) => r.status === "ok");

  return { results, allRequiredOk };
}
