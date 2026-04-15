/**
 * WebdriverIO config for hq-installer end-to-end tests (US-012).
 *
 * # Architecture
 *
 * We use `tauri-driver` — the official Tauri WebDriver bridge — rather than
 * Playwright. Playwright can't drive Tauri's native webview; tauri-driver
 * speaks WebDriver to the platform webview (WKWebView on macOS, WebKitGTK on
 * Linux) and forwards commands from any WebDriver client. WebdriverIO is the
 * client of choice here because the Tauri team documents it in their e2e
 * guide and it has stable macOS + Linux support.
 *
 * # Running locally
 *
 *   1. Install the Rust driver once:     `cargo install tauri-driver --locked`
 *   2. Build the debug Tauri binary:     `pnpm tauri build --debug`
 *   3. Run the suite:                    `pnpm e2e`
 *
 * The `pnpm e2e` script (in package.json) starts a background tauri-driver
 * process on port 4444 and runs `wdio`. Each spec gets its own throwaway HQ
 * directory under `$TMPDIR/hq-installer-e2e-<uuid>` so nothing ever touches
 * the user's real `~/hq`.
 *
 * # CI
 *
 * `.github/workflows/e2e.yml` runs this on macos-14 on every PR. Windows is
 * a known gap — `tauri-driver` doesn't ship for Windows yet.
 *
 * # Why a single binary path, not a dev-server bridge
 *
 * It would be faster to point this at `pnpm dev` and mock `invoke()` in the
 * renderer, but that would only test the React side — it wouldn't catch
 * regressions in the Rust commands. The whole point of e2e is "did it
 * actually install HQ?" and only the real binary can answer that.
 */

import path from "node:path";
import os from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import type { Options } from "@wdio/types";

// ──────────────────────────────────────────────────────────────────────────
// Paths
// ──────────────────────────────────────────────────────────────────────────

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

/** Debug binary path — produced by `pnpm tauri build --debug`. */
function resolveBinaryPath(): string {
  const platform = process.platform;
  if (platform === "darwin") {
    return path.join(
      REPO_ROOT,
      "src-tauri",
      "target",
      "debug",
      "hq-installer",
    );
  }
  if (platform === "linux") {
    return path.join(
      REPO_ROOT,
      "src-tauri",
      "target",
      "debug",
      "hq-installer",
    );
  }
  throw new Error(
    `Unsupported e2e platform: ${platform}. tauri-driver supports macos + linux only.`,
  );
}

// ──────────────────────────────────────────────────────────────────────────
// tauri-driver lifecycle
// ──────────────────────────────────────────────────────────────────────────

let driverProcess: ChildProcess | null = null;

/** Spawn `tauri-driver --port 4444` as a background process. */
function startTauriDriver(): ChildProcess {
  const proc = spawn("tauri-driver", [], {
    stdio: [null, process.stdout, process.stderr],
  });
  proc.on("error", (err) => {
    // eslint-disable-next-line no-console
    console.error("tauri-driver failed to start:", err);
  });
  return proc;
}

// ──────────────────────────────────────────────────────────────────────────
// Config
// ──────────────────────────────────────────────────────────────────────────

export const config: Options.Testrunner = {
  runner: "local",
  tsConfigPath: "./tsconfig.json",

  // Test files — each spec declares its own isolated test HOME dir.
  specs: [
    "./happy-path.spec.ts",
    "./missing-deps.spec.ts",
    "./cloud-clone.spec.ts",
  ],

  // Run serially — tauri-driver holds a single driver session at a time.
  maxInstances: 1,

  capabilities: [
    {
      // tauri-driver proxies to the platform webview. The `tauri:options`
      // cap tells it which binary to launch.
      browserName: "wry",
      // `tauri:options` is how Tauri sessions are configured.
      "tauri:options": {
        application: resolveBinaryPath(),
      },
    },
  ],

  // tauri-driver listens on 4444 by default.
  hostname: "127.0.0.1",
  port: 4444,
  path: "/",

  logLevel: "info",
  bail: 0,
  waitforTimeout: 10_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 3,

  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: {
    ui: "bdd",
    timeout: 180_000, // Allow slow tauri build + scaffold under CI.
  },

  // ────────────────────────────────────────────────────────────────────────
  // Hooks — start/stop tauri-driver around the whole session.
  // ────────────────────────────────────────────────────────────────────────

  onPrepare() {
    driverProcess = startTauriDriver();
    // Give tauri-driver a moment to bind its port before wdio connects.
    return new Promise((resolve) => setTimeout(resolve, 1_500));
  },

  onComplete() {
    if (driverProcess && !driverProcess.killed) {
      driverProcess.kill("SIGTERM");
    }
  },

  // Per-spec setup — stamp a unique HOME for each spec so parallel reruns
  // never collide.
  beforeSession() {
    const unique = `hq-installer-e2e-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    process.env.HQ_E2E_TMPDIR = path.join(os.tmpdir(), unique);
    process.env.HQ_E2E_FAKE_ANALYTICS = "1";
  },
};
