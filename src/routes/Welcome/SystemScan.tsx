/**
 * System scan panel — the second block in the Welcome route.
 *
 * Lifecycle:
 *   1. On mount, call `detectPlatform()` + `depRegistry()` in parallel.
 *   2. Start `checkDeps()`; render one row per entry in `DEP_ORDER`
 *      showing the scanning glyph until the result is populated.
 *   3. When `checkDeps()` resolves, splice results by `dep_id` and flip
 *      each row to installed / missing.
 *   4. Fire `onScanComplete` with `{ platform, descriptors, results }` so
 *      the parent route can enable the "Install" CTA and pick its label.
 *
 * This component is deliberately dumb about installation — it only scans.
 * The actual `install_dep` invocation lives in the next-step install
 * wizard (US-007).
 */

import { useEffect, useState } from "react";
import DepStatusRow from "@/components/DepStatusRow";
import { rowStateFromResult } from "@/components/depRowState";
import {
  DEP_ORDER,
  type CheckResult,
  type DepDescriptor,
  type PlatformInfo,
  checkDeps,
  depRegistry,
  detectPlatform,
} from "@/lib/tauri-invoke";

export interface ScanPayload {
  platform: PlatformInfo;
  descriptors: DepDescriptor[];
  results: CheckResult[];
}

interface SystemScanProps {
  /** Called once when the scan finishes (success path). */
  onScanComplete?: (payload: ScanPayload) => void;
}

type ScanPhase = "idle" | "scanning" | "complete" | "error";

const SystemScan = ({ onScanComplete }: SystemScanProps) => {
  const [phase, setPhase] = useState<ScanPhase>("idle");
  const [platform, setPlatform] = useState<PlatformInfo | null>(null);
  const [descriptors, setDescriptors] = useState<DepDescriptor[]>([]);
  const [results, setResults] = useState<CheckResult[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      setPhase("scanning");
      try {
        // Platform + descriptors can race — they're independent.
        const [plat, descs] = await Promise.all([
          detectPlatform(),
          depRegistry(),
        ]);
        if (cancelled) return;
        setPlatform(plat);
        setDescriptors(descs);

        // Dep probes run next. While this is in-flight, rows render
        // in the "scanning" state because `results` is still empty.
        const checked = await checkDeps();
        if (cancelled) return;
        setResults(checked);
        setPhase("complete");

        onScanComplete?.({
          platform: plat,
          descriptors: descs,
          results: checked,
        });
      } catch (err) {
        if (cancelled) return;
        setErrorMessage(
          err instanceof Error ? err.message : String(err),
        );
        setPhase("error");
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [onScanComplete]);

  // Build an id→result lookup so each row can grab its CheckResult in O(1).
  const resultById = new Map<string, CheckResult>(
    results.map((r) => [r.dep_id, r]),
  );
  const requiredById = new Map<string, boolean>(
    descriptors.map((d) => [d.id, d.required]),
  );

  return (
    <section
      className="w-full max-w-xl mx-auto flex flex-col gap-2 mt-8"
      data-testid="system-scan"
      data-phase={phase}
      aria-label="System dependency scan"
    >
      <header className="flex items-center justify-between px-3 pb-1">
        <span className="font-mono text-xs tracking-wider text-zinc-500 uppercase">
          System scan
        </span>
        <span
          className="font-mono text-xs text-zinc-500"
          data-testid="system-scan-platform"
        >
          {platform
            ? `${platform.os}${
                platform.packageManager
                  ? ` · ${platform.packageManager}`
                  : ""
              }`
            : "detecting…"}
        </span>
      </header>

      <div
        role="table"
        aria-label="Dependency status"
        className="flex flex-col gap-[2px]"
      >
        {DEP_ORDER.map((depId) => {
          const result = resultById.get(depId);
          const state = rowStateFromResult(result);
          return (
            <DepStatusRow
              key={depId}
              depId={depId}
              state={state}
              version={result?.detected_version ?? null}
              required={requiredById.get(depId) ?? false}
            />
          );
        })}
      </div>

      {phase === "error" && (
        <p
          className="px-3 pt-2 text-xs text-red-400 font-mono"
          role="alert"
          data-testid="system-scan-error"
        >
          Scan failed: {errorMessage}
        </p>
      )}
    </section>
  );
};

export default SystemScan;
