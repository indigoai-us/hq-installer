#!/usr/bin/env tsx
/**
 * sync-templates.ts
 *
 * Copies starter-project templates from the hq public repo into this repo's
 * templates/starter-projects/ directory, and mirrors them into any existing
 * src-tauri/target/{debug,release}/templates/starter-projects/ dev builds.
 *
 * profile.md.hbs and voice-style.md.hbs are hand-authored and are NOT
 * overwritten by this script.
 *
 * Why the target/ mirror:
 *   Tauri copies `tauri.conf.json` resources into `target/{profile}/`
 *   at cargo build time. Changes to the source `templates/` directory
 *   AFTER the last build are not picked up automatically — a running
 *   `tauri dev` keeps reading the stale copy. Mirroring here means the
 *   live dev binary sees new templates immediately, no rebuild needed.
 *
 * Usage:
 *   pnpm run sync-templates
 *
 * Environment:
 *   HQ_REPO_PATH  Absolute path to the checked-out hq public repo.
 *                 Defaults to a sibling lookup: assumes this repo lives at
 *                 `<root>/repos/private/hq-installer/` and the hq public repo
 *                 is at `<root>/repos/public/hq/` (the canonical HQ layout on
 *                 every contributor's machine). Override on CI or
 *                 non-standard checkouts:
 *                   HQ_REPO_PATH=/path/to/hq pnpm run sync-templates
 */

import { cpSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REPO_ROOT = resolve(__dirname, "..");

// Sibling-lookup default: <repo-root>/../../public/hq from this script's
// REPO_ROOT, i.e. <root>/repos/private/hq-installer → <root>/repos/public/hq.
// Matches the HQ canonical checkout layout so fresh clones work without env.
const DEFAULT_HQ_REPO_PATH = resolve(REPO_ROOT, "..", "..", "public", "hq");

const HQ_REPO_PATH = resolve(
  process.env.HQ_REPO_PATH ?? DEFAULT_HQ_REPO_PATH,
);

/** Absolute path to the hq public repo's starter-projects directory. */
const HQ_STARTER_PROJECTS = resolve(HQ_REPO_PATH, "template/starter-projects");

/** Canonical destination — source of truth for bundle-time resource copy. */
const DEST_STARTER_PROJECTS = resolve(REPO_ROOT, "templates/starter-projects");

/**
 * Additional dev-build mirrors. Only written if the parent
 * `templates/` dir already exists (i.e. cargo has built at least
 * once). Missing target dirs are skipped silently — a fresh clone
 * that has never run `tauri dev` doesn't have them yet, and the
 * next build will populate them from DEST_STARTER_PROJECTS.
 */
const DEV_MIRRORS = [
  resolve(REPO_ROOT, "src-tauri/target/debug/templates"),
  resolve(REPO_ROOT, "src-tauri/target/release/templates"),
];

function copyStarterProjects(destDir: string): void {
  const target = resolve(destDir, "starter-projects");
  if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true });
  }
  mkdirSync(destDir, { recursive: true });
  cpSync(HQ_STARTER_PROJECTS, target, { recursive: true });
}

function main(): void {
  const optional = process.argv.includes("--optional");

  if (!existsSync(HQ_STARTER_PROJECTS)) {
    const log = optional ? console.warn : console.error;
    log(
      `[sync-templates] Source directory not found: ${HQ_STARTER_PROJECTS}`,
    );
    log(
      "  Set HQ_REPO_PATH to the absolute path of the hq repo checkout.",
    );
    if (optional) {
      console.warn(
        "[sync-templates] --optional set; skipping (templates will be missing until you run `pnpm sync-templates` with the source available).",
      );
      return;
    }
    process.exit(1);
  }

  // 1. Canonical destination — always written.
  copyStarterProjects(resolve(DEST_STARTER_PROJECTS, ".."));
  console.log(
    `[sync-templates] Copied starter-projects from:\n  ${HQ_STARTER_PROJECTS}\n  → ${DEST_STARTER_PROJECTS}`,
  );

  // 2. Dev-build mirrors — only if the parent `templates/` already exists,
  //    signalling a prior `tauri dev`/`tauri build` that populated this slot.
  for (const mirror of DEV_MIRRORS) {
    if (existsSync(mirror)) {
      copyStarterProjects(mirror);
      console.log(
        `[sync-templates] Mirrored to dev build: ${mirror}/starter-projects`,
      );
    }
  }

  console.log(
    "[sync-templates] Note: profile.md.hbs and voice-style.md.hbs were NOT touched.",
  );
}

main();
