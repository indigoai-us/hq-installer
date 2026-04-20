// 04-deps.tsx — US-014
// Dependency detection and auto-install screen.

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
  useXcodeCheck: boolean;
  /** CLI binary name for `which` lookup. Defaults to `id` when omitted. */
  binary?: string;
}

const DEPS: DepDef[] = [
  {
    id: "homebrew",
    label: "Homebrew",
    installCmd: "install_homebrew",
    installUrl: "https://brew.sh",
    useXcodeCheck: false,
    binary: "brew",
  },
  {
    id: "xcode-clt",
    label: "Xcode CLT",
    installCmd: "xcode_clt_install",
    installUrl: "https://developer.apple.com/xcode/resources/",
    useXcodeCheck: true,
  },
  {
    id: "node",
    label: "Node.js",
    installCmd: "install_node",
    installUrl: "https://nodejs.org",
    useXcodeCheck: false,
  },
  {
    id: "git",
    label: "Git",
    installCmd: "install_git",
    installUrl: "https://git-scm.com",
    useXcodeCheck: false,
  },
  {
    id: "gh",
    label: "gh",
    installCmd: "install_gh",
    installUrl: "https://cli.github.com",
    useXcodeCheck: false,
  },
  {
    id: "claude-code",
    label: "Claude Code",
    installCmd: "install_claude_code",
    installUrl: "https://docs.anthropic.com/en/claude-code",
    useXcodeCheck: false,
    binary: "claude",
  },
  {
    id: "qmd",
    label: "qmd",
    installCmd: "install_qmd",
    installUrl: "https://github.com/tobi/qmd",
    useXcodeCheck: false,
  },
  {
    id: "hq-cloud",
    label: "HQ Cloud",
    installCmd: "install_hq_cloud",
    installUrl: "https://www.npmjs.com/package/@indigoai-us/hq-cloud",
    useXcodeCheck: false,
    // `npm install -g @indigoai-us/hq-cloud` installs the `hq-sync-runner`
    // binary on PATH — that's the actual thing `check_dep` needs to find,
    // since the package name isn't a command.
    binary: "hq-sync-runner",
  },
];

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
// Helpers
// ---------------------------------------------------------------------------

/** Normalize both the real XcodeCltState enum ("installed" | "notInstalled" | "installing")
 *  and the test mock shape ({ installed: boolean }). */
function parseXcodeInstalled(result: unknown): boolean {
  if (result === null || result === undefined) return false;
  if (typeof result === "string") return result === "installed";
  if (typeof result === "object" && "installed" in (result as object)) {
    return (result as { installed: boolean }).installed;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface DepsInstallProps {
  onNext?: () => void;
}

export function DepsInstall({ onNext }: DepsInstallProps) {
  const [deps, setDeps] = useState<DepsMap>(initMap);

  // Track which tool is currently installing so the progress listener can
  // pipe lines to the correct row.
  const activeToolRef = useRef<string | null>(null);

  // Helper: update a single tool's state immutably.
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
  // Mount: check all deps + register event listeners
  // ---------------------------------------------------------------------------

  useEffect(() => {
    // Check deps
    async function checkAll() {
      await Promise.all(
        DEPS.map(async (dep) => {
          try {
            let installed: boolean;
            if (dep.useXcodeCheck) {
              const result = await invoke("xcode_clt_status");
              installed = parseXcodeInstalled(result);
            } else {
              const result = await invoke<{ installed: boolean }>("check_dep", {
                tool: dep.binary ?? dep.id,
              });
              installed = result.installed;
            }
            updateTool(dep.id, {
              status: installed ? "installed" : "missing",
            });
          } catch {
            updateTool(dep.id, { status: "missing" });
          }
        })
      );
    }

    checkAll();

    // Register install:progress listener
    let unlistenInstall: (() => void) | undefined;
    let unlistenXcode: (() => void) | undefined;

    const installListenerPromise = listen(
      "install:progress",
      (event: { payload: unknown }) => {
        const payload = event.payload as { line?: string; finished?: boolean; error?: string };
        const line = payload?.line ?? "";
        const activeId = activeToolRef.current;
        if (activeId && line) {
          appendProgress(activeId, line);
        }
      }
    ).then((unlisten) => {
      unlistenInstall = unlisten as () => void;
    });

    const xcodeListenerPromise = listen(
      "xcode:progress",
      (event: { payload: unknown }) => {
        const payload = event.payload as { line?: string; finished?: boolean; error?: string | null };
        const line = payload?.line ?? "";
        const activeId = activeToolRef.current;
        if (activeId && line) {
          appendProgress(activeId, line);
        }
        // xcode_clt_install is async (starts a background poller).
        // The progress event with finished=true signals the final install outcome.
        if (payload?.finished === true && activeId) {
          if (payload.error) {
            updateTool(activeId, { status: "error", errorMsg: payload.error });
          } else {
            updateTool(activeId, { status: "installed" });
          }
          activeToolRef.current = null;
        }
      }
    ).then((unlisten) => {
      unlistenXcode = unlisten as () => void;
    });

    return () => {
      installListenerPromise.then(() => unlistenInstall?.());
      xcodeListenerPromise.then(() => unlistenXcode?.());
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
      if (dep.useXcodeCheck) {
        // xcode_clt_install returns quickly — it only starts the system dialog
        // and background poller. The xcode:progress listener handles the final
        // status transition (installed | error) when finished=true arrives.
        // Do NOT re-check status here; leave tool in "installing" state.
        return;
      }
      // For regular deps the install command is synchronous — re-check after.
      const result = await invoke<{ installed: boolean }>("check_dep", {
        tool: dep.binary ?? dep.id,
      });
      updateTool(dep.id, { status: result.installed ? "installed" : "missing" });
    } catch (err) {
      updateTool(dep.id, {
        status: "error",
        errorMsg: err instanceof Error ? err.message : "Installation failed",
      });
    } finally {
      // For xcode, activeToolRef is cleared by the xcode:progress listener.
      if (!dep.useXcodeCheck) {
        activeToolRef.current = null;
      }
    }
  }

  async function handleOpenPage(url: string) {
    await open(url);
  }

  // ---------------------------------------------------------------------------
  // Derived state
  // ---------------------------------------------------------------------------

  const allInstalled = DEPS.every((dep) => deps[dep.id].status === "installed");

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
          return (
            <DepRow
              key={dep.id}
              dep={dep}
              tool={tool}
              onInstall={() => handleInstall(dep)}
              onOpenPage={() => handleOpenPage(dep.installUrl)}
              onRetry={() => handleInstall(dep)}
            />
          );
        })}
      </div>

      {allInstalled && (
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

// ---------------------------------------------------------------------------
// DepRow
// ---------------------------------------------------------------------------

interface DepRowProps {
  dep: DepDef;
  tool: ToolState;
  onInstall: () => void;
  onRetry: () => void;
  onOpenPage: () => void;
}

function DepRow({ dep, tool, onInstall, onRetry, onOpenPage }: DepRowProps) {
  return (
    <div className="flex flex-col gap-2 bg-white/5 border border-white/10 rounded-xl px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-zinc-200">{dep.label}</span>

        <div className="flex items-center gap-2">
          {tool.status === "loading" && (
            <span className="text-xs text-zinc-500">Checking…</span>
          )}
          {tool.status === "installed" && (
            <span
              data-status="installed"
              className="text-xs text-green-400"
            >
              Installed
            </span>
          )}
          {tool.status === "missing" && (
            <>
              <span
                data-status="missing"
                className="text-xs text-zinc-500"
              >
                Missing
              </span>
              <button
                type="button"
                onClick={onInstall}
                className="text-xs px-3 py-1 rounded-full bg-white text-black hover:bg-zinc-100 transition-colors font-medium"
              >
                Install {dep.label}
              </button>
            </>
          )}
          {tool.status === "installing" && (
            <span className="text-xs text-zinc-400">Installing…</span>
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
