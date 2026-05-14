import Handlebars from "handlebars";
import { mkdir, writeTextFile } from "@tauri-apps/plugin-fs";
import {
  ensureManifestEntries,
  type ManifestEntrySeed,
} from "./manifest-writer";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CompanySeed {
  /** Display name of the company (e.g. "Indigo"). Becomes the slug source. */
  name: string;
  /** Optional marketing site URL — captured into the company manifest. */
  website?: string;
  /** If true, this company is backed by an HQ-Cloud bucket the user is a
   *  member of — recorded in company.yaml so downstream tooling can skip
   *  first-time provisioning and know the folder is remote-synced. */
  cloud?: boolean;
  /** Vault entity UID of the cloud company (present when `cloud` is true). */
  cloudCompanyUid?: string;
}

export interface PersonalizationAnswers {
  name: string;
  about?: string;
  goals?: string;
  customizations?: Record<string, string>;
  /** Optional list of companies the user wants scaffolded under companies/. */
  companies?: CompanySeed[];
}

/** "Indigo Test" → "indigo-test" — same rule as the team-setup screen. */
function slugifyCompany(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface PersonalizeOptions {
  /** Injected Handlebars template string for profile.md (for tests) */
  profileTemplate?: string;
  /** Injected Handlebars template string for voice-style.md (for tests) */
  voiceStyleTemplate?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Load a template: use the injected string if provided, otherwise resolve the
 * bundled Tauri resource path and read via @tauri-apps/plugin-fs.
 */
async function loadTemplate(
  injected: string | undefined,
  resourceRelPath: string,
): Promise<string> {
  if (injected !== undefined) {
    return injected;
  }
  // At runtime in a packaged Tauri app, templates/ is bundled as a resource.
  // resolveResource() maps "templates/..." to the correct on-disk path.
  const { resolveResource } = await import("@tauri-apps/api/path");
  const { readTextFile } = await import("@tauri-apps/plugin-fs");
  const resolved = await resolveResource(resourceRelPath);
  return readTextFile(resolved);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Personalise an HQ installation directory by writing:
 *  - core/knowledge/{name}/profile.md
 *  - core/knowledge/{name}/voice-style.md
 *  - personal/settings/cognito.json  (empty JSON object)
 *  - personal/settings/.gitkeep
 *  - personal/workers/.gitkeep
 *
 * HQ template layout (hq-core / hq-core-staging) places shared knowledge
 * under `core/knowledge/` and the user's personal workspace at top-level
 * `personal/` (NOT `companies/personal/`). Writing to the legacy paths
 * leaves orphaned trees alongside the real ones the template ships.
 */
export async function personalize(
  answers: PersonalizationAnswers,
  baseDir: string,
  options?: PersonalizeOptions,
): Promise<void> {
  const { name, about, goals, customizations, companies } = answers;

  // -----------------------------------------------------------------------
  // 1. Load and render profile.md
  // -----------------------------------------------------------------------
  const profileTemplateStr = await loadTemplate(
    options?.profileTemplate,
    "templates/profile.md.hbs",
  );
  const renderProfile = Handlebars.compile(profileTemplateStr);
  const profileContent = renderProfile({ name, about, goals });

  // -----------------------------------------------------------------------
  // 2. Load and render voice-style.md
  // -----------------------------------------------------------------------
  const voiceStyleTemplateStr = await loadTemplate(
    options?.voiceStyleTemplate,
    "templates/voice-style.md.hbs",
  );
  const renderVoiceStyle = Handlebars.compile(voiceStyleTemplateStr);
  const voiceStyleContent = renderVoiceStyle({ name, customizations });

  // -----------------------------------------------------------------------
  // 3. Write knowledge files under core/knowledge/{name}/
  // -----------------------------------------------------------------------
  const knowledgeDir = `${baseDir}/core/knowledge/${name}`;
  await mkdir(knowledgeDir, { recursive: true });
  await writeTextFile(`${knowledgeDir}/profile.md`, profileContent);
  await writeTextFile(`${knowledgeDir}/voice-style.md`, voiceStyleContent);

  // -----------------------------------------------------------------------
  // 4. Scaffold personal/settings/ (top-level, NOT companies/personal/)
  // -----------------------------------------------------------------------
  const settingsDir = `${baseDir}/personal/settings`;
  await mkdir(settingsDir, { recursive: true });
  await writeTextFile(`${settingsDir}/cognito.json`, JSON.stringify({}));
  await writeTextFile(`${settingsDir}/.gitkeep`, "");

  // -----------------------------------------------------------------------
  // 5. Scaffold personal/workers/
  // -----------------------------------------------------------------------
  const workersDir = `${baseDir}/personal/workers`;
  await mkdir(workersDir, { recursive: true });
  await writeTextFile(`${workersDir}/.gitkeep`, "");

  // -----------------------------------------------------------------------
  // 6. Scaffold user-supplied companies (optional)
  // -----------------------------------------------------------------------
  // Each company gets the standard HQ skeleton: knowledge/, settings/,
  // workers/, projects/ + a company.yaml capturing display name + website.
  // We dedupe by slug so duplicate names don't collide on disk.
  // Each scaffolded company also gets a manifest entry — without that,
  // hq-sync's reconciler can't find the folder via manifest-first lookup
  // and the company stays orphaned from the workspaces list.
  const manifestSeeds: ManifestEntrySeed[] = [];
  if (companies && companies.length > 0) {
    const seen = new Set<string>();
    for (const co of companies) {
      const displayName = co.name.trim();
      if (!displayName) continue;
      const slug = slugifyCompany(displayName);
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);

      const coBase = `${baseDir}/companies/${slug}`;
      for (const sub of ["knowledge", "settings", "workers", "projects"]) {
        const subDir = `${coBase}/${sub}`;
        await mkdir(subDir, { recursive: true });
        await writeTextFile(`${subDir}/.gitkeep`, "");
      }

      // Minimal company.yaml — downstream tooling can enrich it later.
      const websiteLine = co.website?.trim()
        ? `website: ${co.website.trim()}\n`
        : "";
      const cloudLines = co.cloud
        ? `cloud: true\n` +
          (co.cloudCompanyUid
            ? `cloudCompanyUid: ${co.cloudCompanyUid}\n`
            : "")
        : "";
      const yaml =
        `name: ${displayName}\n` +
        `slug: ${slug}\n` +
        websiteLine +
        cloudLines;
      await writeTextFile(`${coBase}/company.yaml`, yaml);

      manifestSeeds.push({
        slug,
        name: displayName,
        cloudUid: co.cloud ? co.cloudCompanyUid : undefined,
      });
    }
  }

  // -----------------------------------------------------------------------
  // 7. Update companies/manifest.yaml
  // -----------------------------------------------------------------------
  // Add an entry for every scaffolded company that doesn't already have
  // one. Idempotent — re-running personalize never clobbers existing
  // entries. Errors here surface to the caller (Personalize screen) so
  // the user sees the failure rather than getting a silently broken HQ.
  if (manifestSeeds.length > 0) {
    await ensureManifestEntries(baseDir, manifestSeeds);
  }
}
