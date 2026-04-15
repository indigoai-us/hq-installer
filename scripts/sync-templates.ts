#!/usr/bin/env tsx
/**
 * sync-templates.ts
 *
 * Copies starter-project templates from the hq public repo into this repo's
 * templates/starter-projects/ directory.
 *
 * profile.md.hbs and voice-style.md.hbs are hand-authored and are NOT
 * overwritten by this script.
 *
 * Usage:
 *   pnpm run sync-templates
 */

import { cpSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REPO_ROOT = resolve(__dirname, "..");

/** Absolute path to the hq public repo's starter-projects directory. */
const HQ_STARTER_PROJECTS = resolve(
  "/Users/coreyepstein/Documents/HQ/repos/public/hq/template/starter-projects",
);

/** Destination inside this repo. */
const DEST_STARTER_PROJECTS = resolve(REPO_ROOT, "templates/starter-projects");

function main(): void {
  if (!existsSync(HQ_STARTER_PROJECTS)) {
    console.error(
      `[sync-templates] Source directory not found: ${HQ_STARTER_PROJECTS}`,
    );
    console.error(
      "  Make sure the hq repo is cloned at /Users/coreyepstein/Documents/HQ/repos/public/hq",
    );
    process.exit(1);
  }

  mkdirSync(DEST_STARTER_PROJECTS, { recursive: true });

  cpSync(HQ_STARTER_PROJECTS, DEST_STARTER_PROJECTS, { recursive: true });

  console.log(
    `[sync-templates] Copied starter-projects from:\n  ${HQ_STARTER_PROJECTS}\n  → ${DEST_STARTER_PROJECTS}`,
  );
  console.log(
    "[sync-templates] Note: profile.md.hbs and voice-style.md.hbs were NOT touched.",
  );
}

main();
