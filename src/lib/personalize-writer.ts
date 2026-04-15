import Handlebars from "handlebars";
import { mkdir, writeTextFile } from "@tauri-apps/plugin-fs";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PersonalizationAnswers {
  name: string;
  about: string;
  goals: string;
  starterProject: "personal-assistant" | "social-media" | "code-worker";
  customizations?: Record<string, string>;
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
  const { name, about, goals, starterProject, customizations } = answers;

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
  // 4. Write starter project files
  // -----------------------------------------------------------------------
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
}
