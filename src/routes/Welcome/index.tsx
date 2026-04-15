/**
 * Welcome route — the first screen the user sees.
 *
 * Composition (top → bottom):
 *   1. `RetroHeader` — building SVG + "INDIGO HQ" block letters + tagline
 *   2. `SystemScan` — live scan of Node / Git / GitHub CLI / Claude / etc.
 *   3. Primary CTA — label adapts to the scan outcome:
 *        - scanning      → "Scanning…" (disabled)
 *        - 0 missing     → "Install HQ"
 *        - N missing     → "Install {N} tools + HQ"
 *   4. Secondary link — "I'm a developer — use CLI instead" (copies
 *      `npx create-hq` to the clipboard and opens a modal)
 *
 * Hitting the primary CTA will advance to the Install Wizard route
 * (US-007) — for now, it calls `onBegin` so App-level routing can
 * hand control off.
 */

import { useCallback, useState } from "react";
import RetroHeader from "@/components/RetroHeader";
import SystemScan, { type ScanPayload } from "@/routes/Welcome/SystemScan";
import { missingAnyCount } from "@/lib/tauri-invoke";

interface WelcomeProps {
  /** Called when the user commits to the installer flow. */
  onBegin?: (payload: ScanPayload) => void;
}

const CLI_SNIPPET = "npx create-hq";

const Welcome = ({ onBegin }: WelcomeProps) => {
  const [scan, setScan] = useState<ScanPayload | null>(null);
  const [copied, setCopied] = useState(false);

  const handleScanComplete = useCallback((payload: ScanPayload) => {
    setScan(payload);
  }, []);

  const handleCopyCli = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(CLI_SNIPPET);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard API can fail inside sandboxed webviews; surface the
      // snippet via prompt() as a last resort.
      window.prompt("Copy this command:", CLI_SNIPPET);
    }
  }, []);

  const handleInstall = useCallback(() => {
    if (!scan) return;
    onBegin?.(scan);
  }, [onBegin, scan]);

  const ctaLabel = (() => {
    if (!scan) return "Scanning…";
    const missing = missingAnyCount(scan.results);
    if (missing === 0) return "Install HQ";
    if (missing === 1) return "Install 1 tool + HQ";
    return `Install ${missing} tools + HQ`;
  })();

  const ctaDisabled = scan === null;

  return (
    <main
      className="min-h-screen flex flex-col items-center px-6 pb-12"
      style={{ backgroundColor: "var(--retro-bg-0)" }}
      data-testid="welcome-route"
    >
      <RetroHeader />

      <SystemScan onScanComplete={handleScanComplete} />

      <div className="mt-10 flex flex-col items-center gap-4">
        <button
          type="button"
          className="retro-cta-primary"
          onClick={handleInstall}
          disabled={ctaDisabled}
          data-testid="welcome-cta-primary"
          data-scan-phase={scan ? "complete" : "scanning"}
        >
          {ctaLabel}
        </button>

        <button
          type="button"
          className="retro-cta-secondary"
          onClick={handleCopyCli}
          data-testid="welcome-cta-secondary"
        >
          {copied ? "Copied: npx create-hq" : "I'm a developer — use CLI instead"}
        </button>
      </div>
    </main>
  );
};

export default Welcome;
