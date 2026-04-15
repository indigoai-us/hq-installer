/**
 * Cloud clone e2e spec.
 *
 * Flow:
 *   1. App boots with all deps installed.
 *   2. User walks to the location picker.
 *   3. User opens the "cloud sync" panel and enters a manual owner/repo.
 *   4. check_cloud_existing returns exists=true from the GitHub mock.
 *   5. User confirms "clone existing" → clone_cloud_existing runs.
 *   6. Success screen shows mode="clone" in the summary.
 */

import { browser, $ } from "@wdio/globals";
import { expect } from "@wdio/globals";
import {
  installMockInvoke,
  allDepsInstalled,
  platformMacos,
  cloudExistsGithub,
  cloudCloneOk,
  launchClaudeOk,
} from "./fixtures/mock-backends.js";

describe("US-012 cloud clone", () => {
  before(async () => {
    await browser.waitUntil(
      async () => (await browser.execute(() => document.readyState)) === "complete",
      { timeout: 30_000, timeoutMsg: "webview never loaded" },
    );

    await installMockInvoke(browser, {
      detect_platform: platformMacos,
      check_deps: allDepsInstalled,
      check_cloud_existing: cloudExistsGithub,
      clone_cloud_existing: cloudCloneOk,
      launch_claude_code: launchClaudeOk,
    });

    await browser.execute(() => window.location.reload());
    await browser.waitUntil(
      async () => (await browser.execute(() => document.readyState)) === "complete",
      { timeout: 15_000 },
    );
  });

  it("clones an existing HQ from GitHub and lands on success with clone mode", async () => {
    const beginBtn = await $('[data-testid="welcome-cta-primary"]');
    await beginBtn.waitForDisplayed({ timeout: 30_000 });
    await beginBtn.click();

    const locationInput = await $('[data-testid="location-path-input"]');
    await locationInput.waitForDisplayed({ timeout: 10_000 });

    // Cloud sync panel renders inline on the location picker — click the
    // "sign in" button to reveal the repo input.
    const signInBtn = await $('[data-testid="cloud-sync-signin"]');
    await signInBtn.waitForDisplayed({ timeout: 5_000 });
    await signInBtn.click();

    const repoInput = await $('[data-testid="cloud-sync-repo-input"]');
    await repoInput.waitForDisplayed({ timeout: 5_000 });
    await repoInput.setValue("indigoai-us/hq-demo");

    const checkBtn = await $('[data-testid="cloud-sync-check"]');
    await checkBtn.waitForDisplayed({ timeout: 5_000 });
    await checkBtn.click();

    // exists=true → "Clone existing" choice button shows.
    const cloneChoice = await $('[data-testid="cloud-sync-choice-clone"]');
    await cloneChoice.waitForDisplayed({ timeout: 10_000 });
    await cloneChoice.click();

    // Now Next → runs clone_cloud_existing → lands on Success.
    const nextBtn = await $('[data-testid="location-next"]');
    await nextBtn.click();

    const successRoute = await $('[data-testid="success-route"]');
    await successRoute.waitForDisplayed({ timeout: 20_000 });

    const modeCell = await $('[data-testid="summary-mode"]');
    await expect(modeCell).toHaveText(/cloned from/);
  });
});
