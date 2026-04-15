/**
 * Mock-backend helpers for e2e specs.
 *
 * These functions don't run in the Node test process — they're serialized
 * into the webview via `browser.execute()` and installed onto `window` by
 * the installer's dev bridge. The installer reads `window.__HQ_E2E__` at
 * startup and routes Tauri invoke calls through the mock table instead of
 * hitting the real Rust commands.
 *
 * # Why not `window.__TAURI_INTERNALS__`?
 *
 * Patching `__TAURI_INTERNALS__.invoke` works for Tauri 1 but Tauri 2 uses
 * IPC builders that are harder to monkey-patch cleanly. The installer ships
 * its own `window.__HQ_E2E__` hook (gated on `NODE_ENV !== "production"`)
 * that the TS invoke wrappers consult first — set the flag, set the table,
 * invoke is mocked.
 */

import type { Browser } from "webdriverio";

export type MockHandler = (args: unknown) => unknown;
export type MockTable = Record<string, MockHandler>;

/** Install a mock invoke table in the running webview. */
export async function installMockInvoke(
  browser: Browser,
  table: MockTable,
): Promise<void> {
  // We serialize the table as `{name: fn.toString()}` and rebuild it on
  // the browser side because functions can't cross the WebDriver wire.
  const serialized: Record<string, string> = {};
  for (const [k, v] of Object.entries(table)) {
    serialized[k] = v.toString();
  }
  await browser.execute((entries: Record<string, string>) => {
    const rebuilt: Record<string, (args: unknown) => unknown> = {};
    for (const [k, src] of Object.entries(entries)) {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      rebuilt[k] = new Function(`return (${src})`)() as (
        args: unknown,
      ) => unknown;
    }
    (window as unknown as { __HQ_E2E__: { invoke: typeof rebuilt } }).__HQ_E2E__ = {
      invoke: rebuilt,
    };
  }, serialized);
}

// ──────────────────────────────────────────────────────────────────────────
// Canned handlers — each spec composes a table from these pieces.
// ──────────────────────────────────────────────────────────────────────────

/** Happy-path: every dep reports installed + latest version. */
export const allDepsInstalled: MockHandler = () => [
  { dep_id: "node", installed: true, detected_version: "v22.0.0" },
  { dep_id: "git", installed: true, detected_version: "2.45.0" },
  { dep_id: "gh", installed: true, detected_version: "2.50.0" },
  { dep_id: "claude", installed: true, detected_version: "1.2.0" },
  { dep_id: "qmd", installed: true, detected_version: "0.6.0" },
  { dep_id: "yq", installed: true, detected_version: "4.41.0" },
  { dep_id: "vercel", installed: true, detected_version: "34.0.0" },
  { dep_id: "hq-cli", installed: true, detected_version: "0.2.0" },
];

/** Missing-deps: four required deps are absent. */
export const requiredDepsMissing: MockHandler = () => [
  { dep_id: "node", installed: false, detected_version: null },
  { dep_id: "git", installed: false, detected_version: null },
  { dep_id: "gh", installed: false, detected_version: null },
  { dep_id: "claude", installed: false, detected_version: null },
  { dep_id: "qmd", installed: true, detected_version: "0.6.0" },
  { dep_id: "yq", installed: true, detected_version: "4.41.0" },
  { dep_id: "vercel", installed: true, detected_version: "34.0.0" },
  { dep_id: "hq-cli", installed: true, detected_version: "0.2.0" },
];

/** Platform mock — deterministic macos + brew. */
export const platformMacos: MockHandler = () => ({
  os: "macos",
  packageManager: "brew",
  npmAvailable: true,
});

/** Scaffold success into the e2e tmpdir. */
export const scaffoldOk: MockHandler = () => ({
  result: "ok",
  summary: {
    target_dir: process.env.HQ_E2E_TMPDIR ?? "/tmp/hq-e2e",
    file_count: 14,
    duration_ms: 42,
    commit_sha: "e2e1234",
  },
});

/** Cloud existing check — returns exists=true from a fake GitHub repo. */
export const cloudExistsGithub: MockHandler = () => ({
  result: "ok",
  info: {
    exists: true,
    last_modified: "2026-04-14T00:00:00Z",
    estimated_size: 12345,
  },
});

/** Cloud clone success. */
export const cloudCloneOk: MockHandler = () => ({
  result: "ok",
  summary: {
    target_dir: process.env.HQ_E2E_TMPDIR ?? "/tmp/hq-e2e",
    backend: "github",
    duration_ms: 234,
  },
});

/** Install-dep success (auto install via package manager). */
export const installDepAuto: MockHandler = () => ({
  result: "auto",
  command: "brew install node",
  exit_code: 0,
});

/** Launch claude happy path. */
export const launchClaudeOk: MockHandler = () => ({
  result: "spawned",
  command: "claude",
  pid: 9999,
});
