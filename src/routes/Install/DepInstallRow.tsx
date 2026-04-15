/**
 * A single dep row inside the install wizard.
 *
 * Wider than `DepStatusRow` from US-006 because it shows an action column
 * (retry / skip) when the status is `failed`, plus a spinner when
 * `installing`. The presentation stays faithful to the retro palette.
 */

import type { DepId } from "@/lib/tauri-invoke";
import { DEP_DISPLAY_NAME } from "@/lib/tauri-invoke";
import type { DepInstallStatus } from "@/lib/install-state";

interface DepInstallRowProps {
  depId: DepId;
  status: DepInstallStatus;
  onRetry?: (depId: DepId) => void;
  onSkip?: (depId: DepId) => void;
}

const STATUS_GLYPH: Record<DepInstallStatus, { char: string; className: string; label: string }> = {
  pending: { char: "·", className: "retro-install-glyph--pending", label: "pending" },
  installing: { char: "▸", className: "retro-install-glyph--running", label: "installing" },
  done: { char: "✓", className: "retro-install-glyph--ok", label: "installed" },
  failed: { char: "✗", className: "retro-install-glyph--miss", label: "failed" },
  skipped: { char: "↷", className: "retro-install-glyph--skip", label: "skipped" },
};

const DepInstallRow = ({
  depId,
  status,
  onRetry,
  onSkip,
}: DepInstallRowProps) => {
  const glyph = STATUS_GLYPH[status];
  const name = DEP_DISPLAY_NAME[depId];

  return (
    <div
      className={`retro-install-row retro-install-row--${status}`}
      role="row"
      data-testid={`install-row-${depId}`}
      data-status={status}
    >
      <span
        className={`retro-install-glyph ${glyph.className}`}
        aria-label={glyph.label}
        role="img"
      >
        {glyph.char}
      </span>
      <span className="text-zinc-200 flex-1">{name}</span>

      {status === "installing" && (
        <span className="text-xs text-cyan-300 font-mono animate-pulse">
          running…
        </span>
      )}

      {status === "failed" && (
        <div className="flex items-center gap-2" data-testid={`install-row-actions-${depId}`}>
          <button
            type="button"
            className="retro-row-action retro-row-action--retry"
            onClick={() => onRetry?.(depId)}
            data-testid={`retry-${depId}`}
          >
            Retry
          </button>
          <button
            type="button"
            className="retro-row-action retro-row-action--skip"
            onClick={() => onSkip?.(depId)}
            data-testid={`skip-${depId}`}
          >
            Skip (advanced)
          </button>
        </div>
      )}

      {status === "done" && (
        <span className="text-xs text-cyan-500 font-mono">installed</span>
      )}
      {status === "skipped" && (
        <span className="text-xs text-zinc-500 font-mono">skipped</span>
      )}
      {status === "pending" && (
        <span className="text-xs text-zinc-600 font-mono">queued</span>
      )}
    </div>
  );
};

export default DepInstallRow;
