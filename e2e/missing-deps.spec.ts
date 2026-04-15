/**
 * Missing-deps e2e spec.
 *
 * Flow:
 *   1. App boots with four required deps missing.
 *   2. User clicks "Begin install" on welcome.
 *   3. Install wizard enumerates four deps and shows the first running.
 *   4. A forced install-dep failure triggers the retry button.
 *   5. Retry succeeds on second try, wizard advances.
 *
 * The goal is to prove the wizard's retry path actually works — this is the
 * failure class US-007 was hardest to get right.
 */

import { browser, $ } from "@wdio/globals";
import { expect } from "@wdio/globals";
import {
  installMockInvoke,
  platformMacos,
  requiredDepsMissing,
  scaffoldOk,
} from "./fixtures/mock-backends.js";

describe("US-012 missing deps + retry", () => {
  before(async () => {
    await browser.waitUntil(
      async () => (await browser.execute(() => document.readyState)) === "complete",
      { timeout: 30_000, timeoutMsg: "webview never loaded" },
    );

    // First install_dep attempt fails, second succeeds. We track this with
    // a window-scoped counter because the handler is rebuilt per execute()
    // call and can't close over Node state.
    await browser.execute(() => {
      (window as unknown as { __HQ_E2E_CALLS__: Record<string, number> }).__HQ_E2E_CALLS__ =
        {};
    });

    await installMockInvoke(browser, {
      detect_platform: () => ({
        os: "macos",
        packageManager: "brew",
        npmAvailable: true,
      }),
      check_deps: requiredDepsMissing,
      install_dep: () => {
        const w = window as unknown as { __HQ_E2E_CALLS__: Record<string, number> };
        w.__HQ_E2E_CALLS__.install_dep = (w.__HQ_E2E_CALLS__.install_dep ?? 0) + 1;
        if (w.__HQ_E2E_CALLS__.install_dep === 1) {
          return {
            result: "auto",
            command: "brew install node",
            exit_code: 1,
          };
        }
        return {
          result: "auto",
          command: "brew install node",
          exit_code: 0,
        };
      },
      scaffold_hq: scaffoldOk,
    });

    // Avoid unused-import warning on typecheck.
    void platformMacos;

    await browser.execute(() => window.location.reload());
    await browser.waitUntil(
      async () => (await browser.execute(() => document.readyState)) === "complete",
      { timeout: 15_000 },
    );
  });

  it("retry path recovers from a first-attempt failure", async () => {
    const beginBtn = await $('[data-testid="welcome-cta-primary"]');
    await beginBtn.waitForDisplayed({ timeout: 30_000 });
    await beginBtn.click();

    // Install wizard opens with four required deps queued.
    const wizard = await $('[data-testid="install-route"]');
    await wizard.waitForDisplayed({ timeout: 10_000 });

    // The first dep (node) fails → retry-node button appears.
    const retryBtn = await $('[data-testid="retry-node"]');
    await retryBtn.waitForDisplayed({ timeout: 20_000 });
    await retryBtn.click();

    // Retry succeeds, wizard advances past the failed dep.
    // Eventually (after all four deps resolve) we reach the location picker.
    const locationInput = await $('[data-testid="location-path-input"]');
    await locationInput.waitForDisplayed({ timeout: 60_000 });

    await expect(locationInput).toBeExisting();
  });
});
