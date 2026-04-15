/**
 * A single dependency row in the system scan list.
 *
 * States:
 *   - scanning: shows spinner glyph, dim bar
 *   - installed: green check, version string, cyan bar
 *   - missing: red X, "not found" label, red bar
 *
 * The state-derivation helper lives in `./depRowState` so this file only
 * exports React components (required by HMR's react-refresh plugin).
 */

import type { DepId } from "@/lib/tauri-invoke";
import { DEP_DISPLAY_NAME } from "@/lib/tauri-invoke";
import type { ScanRowState } from "./depRowState";

interface DepStatusRowProps {
  depId: DepId;
  state: ScanRowState;
  version?: string | null;
  required?: boolean;
}

const GLYPH: Record<ScanRowState, { char: string; className: string; label: string }> = {
  scanning: { char: "…", className: "retro-scan-glyph--wait", label: "scanning" },
  installed: { char: "✓", className: "retro-scan-glyph--ok", label: "installed" },
  missing: { char: "✗", className: "retro-scan-glyph--miss", label: "missing" },
};

const rowClass: Record<ScanRowState, string> = {
  scanning: "retro-scan-row retro-scan-row--scanning",
  installed: "retro-scan-row retro-scan-row--installed",
  missing: "retro-scan-row retro-scan-row--missing",
};

const DepStatusRow = ({
  depId,
  state,
  version,
  required,
}: DepStatusRowProps) => {
  const glyph = GLYPH[state];
  const name = DEP_DISPLAY_NAME[depId];
  const trailing =
    state === "installed" && version
      ? version
      : state === "missing"
      ? required
        ? "not found — required"
        : "not found — optional"
      : "—";

  return (
    <div
      className={rowClass[state]}
      role="row"
      data-testid={`dep-row-${depId}`}
      data-state={state}
    >
      <span
        className={`retro-scan-glyph ${glyph.className}`}
        aria-label={glyph.label}
        role="img"
      >
        {glyph.char}
      </span>
      <span className="text-zinc-200">{name}</span>
      <span className="text-zinc-500 text-xs">{trailing}</span>
    </div>
  );
};

export default DepStatusRow;
