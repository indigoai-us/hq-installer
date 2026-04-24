import Handlebars from "handlebars";
import { mkdir, writeTextFile } from "@tauri-apps/plugin-fs";

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
  /** Starter project template — optional; when omitted no starter project
   *  files are written. The redesigned Personalize screen no longer asks
   *  for this, but the writer still supports it for callers that do. */
  starterProject?: "personal-assistant" | "social-media" | "code-worker";
  customizations?: Record<string, string>;
  /** Optional list of companies the user wants scaffolded under companies/. */
  companies?: CompanySeed[];
  /** Slugs of companies that already exist at `{baseDir}/companies/{slug}/`.
   *  When present, the scaffold loop skips mkdir of subdirs AND writeTextFile
   *  of company.yaml for any entry whose slug is in this set — so grafts
   *  don't clobber pre-existing company data. Other companies in the same
   *  batch are unaffected. Defaults to an empty set. */
  existingSlugs?: Set<string>;
}

/** "Indigo Test" → "indigo-test" — same rule as the team-setup screen. */
export function slugifyCompany(s: string): string {
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
  /** Injected starter project files: filename -> content (for tests) */
  starterProjectFiles?: Record<string, string>;
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

/**
 * Load starter project files: use the injected map if provided, otherwise
 * resolve bundled resource paths and read via @tauri-apps/plugin-fs.
 */
async function loadStarterProjectFiles(
  injected: Record<string, string> | undefined,
  starterProject: string,
): Promise<Record<string, string>> {
  if (injected !== undefined) {
    return injected;
  }
  // At runtime, starter-projects are bundled as Tauri resources.
  const { resolveResource } = await import("@tauri-apps/api/path");
  const { readDir, readTextFile: readText } = await import(
    "@tauri-apps/plugin-fs"
  );
  const resourceBase = `templates/starter-projects/${starterProject}`;
  const resolvedBase = await resolveResource(resourceBase);
  const files: Record<string, string> = {};

  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await readDir(dir);
    for (const entry of entries) {
      const relativeName = prefix ? `${prefix}/${entry.name}` : entry.name;
      const fullPath = `${dir}/${entry.name}`;
      if (entry.isDirectory) {
        await walk(fullPath, relativeName);
      } else {
        files[relativeName] = await readText(fullPath);
      }
    }
  }

  await walk(resolvedBase, "");
  return files;
}

/**
 * Derive the parent directory from a file path string.
 * e.g. "/tmp/foo/bar/baz.md" => "/tmp/foo/bar"
 */
function parentDir(filePath: string): string | null {
  const lastSlash = filePath.lastIndexOf("/");
  if (lastSlash <= 0) return null;
  return filePath.slice(0, lastSlash);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Personalise an HQ installation directory by writing:
 *  - knowledge/{name}/profile.md
 *  - knowledge/{name}/voice-style.md
 *  - companies/personal/projects/{starterProject}/** (from starter project files)
 *  - companies/personal/settings/cognito.json  (empty JSON object)
 *  - companies/personal/settings/.gitkeep
 *  - companies/personal/workers/.gitkeep
 */
export async function personalize(
  answers: PersonalizationAnswers,
  baseDir: string,
  options?: PersonalizeOptions,
): Promise<void> {
  const {
    name,
    about,
    goals,
    starterProject,
    customizations,
    companies,
    existingSlugs,
  } = answers;
  const existing = existingSlugs ?? new Set<string>();

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
  // 3. Write knowledge files
  // -----------------------------------------------------------------------
  const knowledgeDir = `${baseDir}/knowledge/${name}`;
  await mkdir(knowledgeDir, { recursive: true });
  await writeTextFile(`${knowledgeDir}/profile.md`, profileContent);
  await writeTextFile(`${knowledgeDir}/voice-style.md`, voiceStyleContent);

  // -----------------------------------------------------------------------
  // 4. Write starter project files (only if the caller asked for one)
  // -----------------------------------------------------------------------
  if (starterProject) {
    const starterFiles = await loadStarterProjectFiles(
      options?.starterProjectFiles,
      starterProject,
    );
    const projectBase = `${baseDir}/companies/personal/projects/${starterProject}`;

    for (const [filename, content] of Object.entries(starterFiles)) {
      const destPath = `${projectBase}/${filename}`;
      const parent = parentDir(destPath);
      if (parent) {
        await mkdir(parent, { recursive: true });
      }
      await writeTextFile(destPath, content);
    }
  }

  // -----------------------------------------------------------------------
  // 5. Scaffold companies/personal/settings/
  // -----------------------------------------------------------------------
  const settingsDir = `${baseDir}/companies/personal/settings`;
  await mkdir(settingsDir, { recursive: true });
  await writeTextFile(`${settingsDir}/cognito.json`, JSON.stringify({}));
  await writeTextFile(`${settingsDir}/.gitkeep`, "");

  // -----------------------------------------------------------------------
  // 6. Scaffold companies/personal/workers/
  // -----------------------------------------------------------------------
  const workersDir = `${baseDir}/companies/personal/workers`;
  await mkdir(workersDir, { recursive: true });
  await writeTextFile(`${workersDir}/.gitkeep`, "");

  // -----------------------------------------------------------------------
  // 7. Scaffold user-supplied companies (optional)
  // -----------------------------------------------------------------------
  // Each company gets the standard HQ skeleton: knowledge/, settings/,
  // workers/, projects/ + a company.yaml capturing display name + website.
  // We dedupe by slug so duplicate names don't collide on disk, and skip any
  // slug in `existingSlugs` so grafts preserve pre-existing company data.
  if (companies && companies.length > 0) {
    const seen = new Set<string>();
    for (const co of companies) {
      const displayName = co.name.trim();
      if (!displayName) continue;
      const slug = slugifyCompany(displayName);
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);

      // Skip companies already present on disk — don't clobber their
      // company.yaml or their subtree. The loop still runs so mixed
      // batches write the non-existing entries normally.
      if (existing.has(slug)) continue;

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
    }
  }
}
