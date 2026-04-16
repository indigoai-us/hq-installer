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
 *
 * Environment:
 *   HQ_REPO_PATH  Absolute path to the checked-out hq repo.
 *                 Defaults to /Users/coreyepstein/Documents/HQ/repos/public/hq
 *                 Override this on CI or other workstations:
 *                   HQ_REPO_PATH=/path/to/hq pnpm run sync-templates
 */

import { cpSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REPO_ROOT = resolve(__dirname, "..");

const HQ_REPO_PATH = resolve(
  process.env.HQ_REPO_PATH ??
    "/Users/coreyepstein/Documents/HQ/repos/public/hq",
);

/** Absolute path to the hq public repo's starter-projects directory. */
const HQ_STARTER_PROJECTS = resolve(HQ_REPO_PATH, "template/starter-projects");

/** Destination inside this repo. */
const DEST_STARTER_PROJECTS = resolve(REPO_ROOT, "templates/starter-projects");

function main(): void {
  if (!existsSync(HQ_STARTER_PROJECTS)) {
    console.error(
      `[sync-templates] Source directory not found: ${HQ_STARTER_PROJECTS}`,
    );
    console.error(
      "  Set HQ_REPO_PATH to the absolute path of the hq repo checkout.",
    );
    process.exit(1);
  }

  // Remove the destination directory first so cpSync creates it at the right
  // path (not nested inside itself if the directory already existed).
  if (existsSync(DEST_STARTER_PROJECTS)) {
    rmSync(DEST_STARTER_PROJECTS, { recursive: true, force: true });
  }
  // Ensure the parent directory (templates/) exists.
  mkdirSync(resolve(DEST_STARTER_PROJECTS, ".."), { recursive: true });

  // cpSync creates DEST_STARTER_PROJECTS when it does not exist.
  cpSync(HQ_STARTER_PROJECTS, DEST_STARTER_PROJECTS, { recursive: true });

  console.log(
    `[sync-templates] Copied starter-projects from:\n  ${HQ_STARTER_PROJECTS}\n  → ${DEST_STARTER_PROJECTS}`,
  );
  console.log(
    "[sync-templates] Note: profile.md.hbs and voice-style.md.hbs were NOT touched.",
  );
}

main();
