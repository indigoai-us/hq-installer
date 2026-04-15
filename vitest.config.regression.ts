/// <reference types="vitest" />
import { defineConfig } from "vite";

/**
 * Vitest config for nightly regression tests.
 *
 * Runs tests in `tests/regression/` with a Node.js environment and a longer
 * timeout to accommodate GitHub API calls and tarball extraction.
 *
 * Usage:
 *   pnpm vitest run --config vitest.config.regression.ts
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/regression/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    reporters: ["verbose"],
  },
});
