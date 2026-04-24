// 04-deps.tsx — US-014
// Dependency detection and auto-install screen.
//
// Each row is gated by its `dependsOn` list — a dep stays locked ("Waiting
// for X") until every parent reports `status: "installed"`. When the last
// blocker flips, the Install button fades + scales in so the unlock reads
// as a small reward instead of a dead-button surprise.
//
// Xcode CLT was removed in v0.1.22: Homebrew's installer bootstraps the
// commandline tools itself, and the separate row used to race Homebrew's
// own CLT prompt and fail. The `xcode_clt_*` Tauri commands are still
// registered on the Rust side as dead IPC — safe to leave, trivial to
// delete in a follow-up.

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-shell";
import { listen } from "@tauri-apps/api/event";

// ---------------------------------------------------------------------------
// Dep definitions
// ---------------------------------------------------------------------------

interface DepDef {
  id: string;
  label: string;
  installCmd: string;
  installUrl: string;
  /** CLI binary name for `which` lookup. Defaults to `id` when omitted. */
  binary?: string;
  /** When true, a missing/failed state does NOT block the Continue button. */
  optional?: boolean;
  /** IDs that must be `installed` before this row unlocks. Empty = root. */
  dependsOn?: readonly string[];
  /** Optional secondary line rendered below the label — use for disambiguation hints. */
  subtitle?: string;
}

const DEPS: readonly DepDef[] = [
  {
    id: "homebrew",
    label: "Homebrew",
    installCmd: "install_homebrew",
    installUrl: "https://brew.sh",
    binary: "brew",
  },
  {
    id: "node",
    label: "Node.js",
    installCmd: "install_node",
    installUrl: "https://nodejs.org",
    dependsOn: ["homebrew"],
  },
  {
    id: "git",
    label: "Git",
    installCmd: "install_git",
    installUrl: "https://git-scm.com",
    dependsOn: ["homebrew"],
  },
  {
    id: "yq",
    label: "yq",
    installCmd: "install_yq",
    installUrl: "https://github.com/mikefarah/yq",
    // Serialized behind `node` (not `homebrew`) on purpose: brew holds a
    // per-prefix lock (~/.../var/homebrew/locks) while a formula installs,
    // and kicking off `brew install yq` mid-`brew install node` aborts
    // with "Another active Homebrew process is already in progress". Gating
    // yq on node's completion removes the race without adding any custom
    // locking logic on the Rust side.
    dependsOn: ["node"],
  },
  {
    id: "gh",
    label: "gh",
    installCmd: "install_gh",
    installUrl: "https://cli.github.com",
    optional: true,
    dependsOn: ["homebrew"],
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
    id: "qmd",
    label: "qmd",
    installCmd: "install_qmd",
    installUrl: "https://github.com/tobi/qmd",
    optional: true,
    dependsOn: ["node"],
  },
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DepStatus = "loading" | "installed" | "missing" | "installing" | "error";

interface ToolState {
  status: DepStatus;
  progressLines: string[];
  errorMsg: string | null;
}

type DepsMap = Record<string, ToolState>;

function initMap(): DepsMap {
  const m: DepsMap = {};
  for (const dep of DEPS) {
    m[dep.id] = { status: "loading", progressLines: [], errorMsg: null };
  }
  return m;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface DepsInstallProps {
  onNext?: () => void;
}

export function DepsInstall({ onNext }: DepsInstallProps) {
  const [deps, setDeps] = useState<DepsMap>(initMap);

  const activeToolRef = useRef<string | null>(null);

  function updateTool(id: string, patch: Partial<ToolState>) {
    setDeps((prev) => ({
      ...prev,
      [id]: { ...prev[id], ...patch },
    }));
  }

  function appendProgress(id: string, line: string) {
    setDeps((prev) => ({
      ...prev,
      [id]: {
        ...prev[id],
        progressLines: [...prev[id].progressLines, line],
      },
    }));
  }

  // ---------------------------------------------------------------------------
  // Mount: check all deps + register progress listener
  // ---------------------------------------------------------------------------

  useEffect(() => {
    async function checkAll() {
      await Promise.all(
        DEPS.map(async (dep) => {
          try {
            const result = await invoke<{ installed: boolean }>("check_dep", {
              tool: dep.binary ?? dep.id,
            });
            updateTool(dep.id, {
              status: result.installed ? "installed" : "missing",
            });
          } catch {
            updateTool(dep.id, { status: "missing" });
          }
        }),
      );
    }

    checkAll();

    let unlistenInstall: (() => void) | undefined;
    const installListenerPromise = listen(
      "install:progress",
      (event: { payload: unknown }) => {
        const payload = event.payload as { line?: string };
        const line = payload?.line ?? "";
        const activeId = activeToolRef.current;
        if (activeId && line) {
          appendProgress(activeId, line);
        }
      },
    ).then((unlisten) => {
      unlistenInstall = unlisten as () => void;
    });

    return () => {
      installListenerPromise.then(() => unlistenInstall?.());
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Install handler
  // ---------------------------------------------------------------------------

  async function handleInstall(dep: DepDef) {
    activeToolRef.current = dep.id;
    updateTool(dep.id, {
      status: "installing",
      progressLines: [],
      errorMsg: null,
    });
    try {
      await invoke(dep.installCmd);
      const result = await invoke<{ installed: boolean }>("check_dep", {
        tool: dep.binary ?? dep.id,
      });
      updateTool(dep.id, { status: result.installed ? "installed" : "missing" });
    } catch (err) {
      // Tauri's `invoke` rejects with the raw Err value — for our Rust
      // commands that's a plain string, not an Error instance.
      const errorMsg =
        typeof err === "string"
          ? err
          : err instanceof Error
            ? err.message
            : "Installation failed";
      updateTool(dep.id, { status: "error", errorMsg });
    } finally {
      activeToolRef.current = null;
    }
  }

  async function handleOpenPage(url: string) {
    await open(url);
  }

  // ---------------------------------------------------------------------------
  // Derived state
  // ---------------------------------------------------------------------------

  const allRequiredInstalled = DEPS.filter((d) => !d.optional).every(
    (dep) => deps[dep.id].status === "installed",
  );

  /** Returns unmet parent deps by label — empty array means unlocked. */
  function unmetDepsFor(dep: DepDef): string[] {
    if (!dep.dependsOn || dep.dependsOn.length === 0) return [];
    const unmet: string[] = [];
    for (const parentId of dep.dependsOn) {
      const parent = deps[parentId];
      if (!parent || parent.status !== "installed") {
        const parentDef = DEPS.find((d) => d.id === parentId);
        unmet.push(parentDef?.label ?? parentId);
      }
    }
    return unmet;
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="flex flex-col gap-6 max-w-lg">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-medium text-white">Install dependencies</h1>
        <p className="text-sm font-light text-zinc-400">
          The following tools are required. Missing ones will be installed automatically.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        {DEPS.map((dep) => {
          const tool = deps[dep.id];
          const unmet = unmetDepsFor(dep);
          return (
            <DepRow
              key={dep.id}
              dep={dep}
              tool={tool}
              unmetDeps={unmet}
              onInstall={() => handleInstall(dep)}
              onOpenPage={() => handleOpenPage(dep.installUrl)}
              onRetry={() => handleInstall(dep)}
            />
          );
        })}
      </div>

      {allRequiredInstalled && (
        <button
          type="button"
          onClick={onNext}
          className="self-start px-6 py-2.5 rounded-full text-sm font-medium bg-white text-black hover:bg-zinc-100 transition-colors animate-in fade-in-0 zoom-in-95 duration-500"
        >
          Continue
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DepRow
// ---------------------------------------------------------------------------

interface DepRowProps {
  dep: DepDef;
  tool: ToolState;
  /** Parent labels that aren't yet `installed`. Non-empty ⇒ locked. */
  unmetDeps: string[];
  onInstall: () => void;
  onRetry: () => void;
  onOpenPage: () => void;
}

function DepRow({
  dep,
  tool,
  unmetDeps,
  onInstall,
  onRetry,
  onOpenPage,
}: DepRowProps) {
  // Locked = dep is missing AND at least one parent isn't installed yet.
  // We still render the row normally — just swap the Install button for a
  // dimmed "Waiting for X" label. When the last blocker lands, React
  // re-renders this row, and the Install button mounts with the animate-in
  // classes firing a one-shot fade/zoom so the unlock reads as a reward.
  const locked = tool.status === "missing" && unmetDeps.length > 0;
  const installable = tool.status === "missing" && unmetDeps.length === 0;

  return (
    <div
      className={`flex flex-col gap-2 bg-white/5 border border-white/10 rounded-xl px-4 py-3 transition-opacity duration-300 ${
        locked ? "opacity-60" : "opacity-100"
      }`}
      data-dep={dep.id}
      data-locked={locked ? "true" : "false"}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col">
          <span className="text-sm font-medium text-zinc-200">
            {dep.label}
            {dep.optional && (
              <span className="ml-2 text-[10px] uppercase tracking-wider text-zinc-500 font-normal">
                Optional
              </span>
            )}
          </span>
          {dep.subtitle && (
            <span
              data-subtitle
              className="text-xs text-zinc-500 font-normal mt-0.5"
            >
              {dep.subtitle}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {tool.status === "loading" && (
            <span className="text-xs text-zinc-500 hq-text-shimmer">Checking…</span>
          )}
          {tool.status === "installed" && (
            <span data-status="installed" className="text-xs text-green-400 animate-in fade-in-0 duration-500">
              Installed
            </span>
          )}
          {locked && (
            <span
              data-status="locked"
              className="text-xs text-zinc-500 italic"
              title={`Install ${unmetDeps.join(", ")} first`}
            >
              Waiting for {unmetDeps.join(", ")}
            </span>
          )}
          {installable && (
            <>
              <span data-status="missing" className="text-xs text-zinc-500">
                Missing
              </span>
              <button
                type="button"
                onClick={onInstall}
                className="text-xs px-3 py-1 rounded-full bg-white text-black hover:bg-zinc-100 transition-colors font-medium animate-in fade-in-0 zoom-in-95 duration-500"
              >
                Install {dep.label}
              </button>
            </>
          )}
          {tool.status === "installing" && (
            <span className="text-xs text-zinc-400 hq-text-shimmer">Installing…</span>
          )}
          {tool.status === "error" && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onRetry}
                className="text-xs px-3 py-1 rounded-full bg-white/10 text-zinc-300 hover:bg-white/20 transition-colors font-medium"
              >
                Retry
              </button>
              <button
                type="button"
                onClick={onOpenPage}
                className="text-xs px-3 py-1 rounded-full bg-white/5 border border-white/10 text-zinc-400 hover:text-white transition-colors font-medium"
              >
                Open install page
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Progress output */}
      {tool.progressLines.length > 0 && (
        <div className="text-xs font-mono text-zinc-500 bg-black/20 rounded-lg px-3 py-2 max-h-32 overflow-y-auto">
          {tool.progressLines.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}

      {/* Error message */}
      {tool.status === "error" && tool.errorMsg && (
        <p className="text-xs text-red-400">{tool.errorMsg}</p>
      )}
    </div>
  );
}
