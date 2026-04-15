/**
 * Shared helper used by `SystemScan` to derive the `ScanRowState` of a
 * `DepStatusRow` from the (possibly-undefined) `CheckResult` emitted by
 * the Rust `check_deps` command.
 *
 * Kept in its own module so HMR's react-refresh plugin isn't confused by
 * a component file that also exports a plain function.
 */

import type { CheckResult } from "@/lib/tauri-invoke";

export type ScanRowState = "scanning" | "installed" | "missing";

export function rowStateFromResult(
  r: CheckResult | undefined,
): ScanRowState {
  if (!r) return "scanning";
  return r.installed ? "installed" : "missing";
}
