/**
 * Happy-path e2e spec.
 *
 * Flow:
 *   1. App boots with all deps pre-installed (mocked).
 *   2. User clicks "Begin install" on welcome.
 *   3. Install wizard skips straight to location (no deps to install).
 *   4. User accepts default HQ path.
 *   5. Scaffold runs, Success screen mounts, "HQ is ready" heading visible.
 *   6. "Open in Claude Code" button click fires launch_claude_code.
 *
 * Assertions are rendering-level — we don't assert on Rust state because
 * everything is mocked via `window.__HQ_E2E__` per fixture.
 */

import { browser, $ } from "@wdio/globals";
import { expect } from "@wdio/globals";
import {
  installMockInvoke,
  platformMacos,
  allDepsInstalled,
  scaffoldOk,
  launchClaudeOk,
} from "./fixtures/mock-backends.js";

describe("US-012 happy path", () => {
  before(async () => {
    // Wait for the webview to be ready before injecting mocks.
    await browser.waitUntil(
      async () => (await browser.execute(() => document.readyState)) === "complete",
      { timeout: 30_000, timeoutMsg: "webview never loaded" },
    );

    await installMockInvoke(browser, {
      detect_platform: platformMacos,
      check_deps: allDepsInstalled,
      scaffold_hq: scaffoldOk,
      launch_claude_code: launchClaudeOk,
      reveal_in_file_manager: () => ({
        result: "spawned",
        command: "open",
        pid: 1,
      }),
    });

    // Trigger a reload so the installer re-reads the mock table on boot.
    await browser.execute(() => window.location.reload());
    await browser.waitUntil(
      async () => (await browser.execute(() => document.readyState)) === "complete",
      { timeout: 15_000 },
    );
  });

  it("walks from welcome → success with all deps already installed", async () => {
    // 1. Welcome screen renders. The primary CTA is "Begin install".
    const beginBtn = await $('[data-testid="welcome-cta-primary"]');
    await beginBtn.waitForDisplayed({ timeout: 30_000 });
    await beginBtn.click();

    // 2. With every dep installed, we skip the install wizard and land on
    //    the location picker.
    const locationInput = await $('[data-testid="location-path-input"]');
    await locationInput.waitForDisplayed({ timeout: 10_000 });

    // 3. Accept default ~/hq path by clicking Next.
    const nextBtn = await $('[data-testid="location-next"]');
    await nextBtn.click();

    // 4. Success screen mounts.
    const successRoute = await $('[data-testid="success-route"]');
    await successRoute.waitForDisplayed({ timeout: 20_000 });

    const heading = await $('[data-testid="success-heading"]');
    await expect(heading).toHaveText("HQ is ready");

    // 5. Open in Claude Code → launched state.
    const openBtn = await $('[data-testid="success-open-claude"]');
    await openBtn.click();

    const launchedMsg = await $('[data-testid="success-launched"]');
    await launchedMsg.waitForDisplayed({ timeout: 5_000 });
  });
});
