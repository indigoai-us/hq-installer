import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { getWizardState } from "@/lib/wizard-state";

interface ErrorBoundaryProps {
  children: React.ReactNode;
  reload?: () => void;
}

interface ErrorBoundaryState {
  error: Error | null;
  componentStack: string;
  installPath: string | null;
  revealError: string | null;
}

function installPathFromLocalStorage(): string | null {
  try {
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (!key) continue;
      const raw = window.localStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as { installPath?: unknown };
      if (typeof parsed.installPath === "string" && parsed.installPath.length > 0) {
        return parsed.installPath;
      }
    }
  } catch {
    /* best effort only */
  }
  return null;
}

function recoverInstallPath(): string | null {
  try {
    const path = getWizardState().installPath;
    if (path) return path;
  } catch {
    /* best effort only */
  }
  return installPathFromLocalStorage();
}

export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = {
    error: null,
    componentStack: "",
    installPath: null,
    revealError: null,
  };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return {
      error,
      installPath: recoverInstallPath(),
    };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error("[ErrorBoundary]", error, errorInfo);
    this.setState({
      componentStack: errorInfo.componentStack ?? "",
      installPath: recoverInstallPath(),
    });
  }

  private handleStartOver = (): void => {
    if (this.props.reload) {
      this.props.reload();
      return;
    }
    window.location.reload();
  };

  private handleRevealFolder = async (): Promise<void> => {
    if (!this.state.installPath) return;
    this.setState({ revealError: null });
    try {
      await invoke("reveal_folder", { path: this.state.installPath });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.setState({ revealError: msg });
    }
  };

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children;

    return (
      <main className="min-h-screen bg-black text-white flex items-center justify-center px-6">
        <div className="w-full max-w-lg flex flex-col gap-5 bg-white/5 border border-white/10 rounded-xl px-5 py-5">
          <div className="flex flex-col gap-2">
            <h1 className="text-2xl font-medium text-white">
              Something went wrong
            </h1>
            <p className="text-sm text-zinc-300">
              The installer hit an unexpected error, but your files may still be
              on disk.
            </p>
          </div>

          <div className="rounded-lg border border-white/10 bg-black/30 px-3 py-2">
            <p className="text-xs text-zinc-500">Error</p>
            <p className="text-sm text-zinc-200 break-words">
              {this.state.error.message || String(this.state.error)}
            </p>
          </div>

          {this.state.componentStack && (
            <details className="rounded-lg border border-white/10 bg-black/30 px-3 py-2">
              <summary className="cursor-pointer text-xs text-zinc-400">
                Component stack
              </summary>
              <pre className="mt-2 whitespace-pre-wrap break-words text-xs text-zinc-500">
                {this.state.componentStack}
              </pre>
            </details>
          )}

          {this.state.installPath && (
            <div className="rounded-lg border border-white/10 bg-black/30 px-3 py-2">
              <p className="text-xs text-zinc-500">Recovered install path</p>
              <p className="select-all text-xs font-mono text-zinc-200 break-all">
                {this.state.installPath}
              </p>
            </div>
          )}

          {this.state.revealError && (
            <p role="alert" className="text-xs text-zinc-400">
              Could not reveal folder: {this.state.revealError}
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={this.handleStartOver}
              className="px-4 py-2 rounded-full text-sm font-medium bg-white text-black hover:bg-zinc-100 transition-colors"
            >
              Start over
            </button>
            {this.state.installPath && (
              <button
                type="button"
                onClick={this.handleRevealFolder}
                className="px-4 py-2 rounded-full text-sm font-medium bg-white/10 text-zinc-100 hover:bg-white/20 transition-colors"
              >
                Reveal HQ folder in Finder
              </button>
            )}
          </div>
        </div>
      </main>
    );
  }
}
