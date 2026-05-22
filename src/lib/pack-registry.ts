// pack-registry.ts
//
// Discovers the HQ content packs available to install. The installer used to
// ship a hardcoded list of four packs; this module enumerates every pack in
// the `indigoai-us/hq-packages` repo at install time, so new packs appear in
// the wizard without needing an installer release.
//
// Two pieces of data drive the pack-choice screen:
//   - fetchAvailablePacks()    — every pack in the catalog (GitHub API).
//   - readRecommendedPackIds() — which of them core.yaml marks recommended,
//                                so the wizard can pre-check sensible defaults.

import { fetch } from "@tauri-apps/plugin-http";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { parse as parseYaml } from "yaml";

const GITHUB_API = "https://api.github.com";
/** Monorepo holding every published `hq-pack-*` under `packages/`. */
const PACKAGES_REPO = "indigoai-us/hq-packages";
const PACKAGES_DIR = "packages";
const GITHUB_JSON = { Accept: "application/vnd.github+json" };
const GITHUB_RAW = { Accept: "application/vnd.github.raw" };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AvailablePack {
  /** Directory name under hq-packages/packages/, e.g. "hq-pack-engineering".
   *  Stable identity — used as the React key, manifest key, and log label. */
  dir: string;
  /** `name:` declared in the pack's package.yaml (usually equals `dir`). */
  name: string;
  /** `description:` from package.yaml — shown beside the checkbox. */
  description: string;
  /** Source spec passed verbatim to `hq install`. */
  source: string;
}

export class PackRegistryError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "PackRegistryError";
    Object.setPrototypeOf(this, PackRegistryError.prototype);
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Build the `hq install` source spec for a pack directory. */
function packSource(dir: string): string {
  return `github:${PACKAGES_REPO}#${PACKAGES_DIR}/${dir}`;
}

/**
 * The four core add-on packs, used as a graceful fallback when the GitHub
 * catalog enumeration fails (offline, rate-limited). Keeps the wizard usable
 * without a successful round-trip to the catalog.
 */
export const FALLBACK_PACKS: AvailablePack[] = [
  "hq-pack-design-quality",
  "hq-pack-design-styles",
  "hq-pack-gemini",
  "hq-pack-gstack",
].map((dir) => ({ dir, name: dir, description: "", source: packSource(dir) }));

interface GitHubContentEntry {
  name: string;
  type: string;
}

// ---------------------------------------------------------------------------
// Catalog enumeration
// ---------------------------------------------------------------------------

/**
 * Enumerate every `hq-pack-*` directory in `indigoai-us/hq-packages/packages/`
 * and read each pack's `package.yaml` for its name + description.
 *
 * Throws {@link PackRegistryError} on a hard failure (the catalog listing
 * itself failed). Individual packs whose package.yaml can't be read are
 * dropped from the result rather than failing the whole call.
 */
export async function fetchAvailablePacks(
  signal?: AbortSignal,
): Promise<AvailablePack[]> {
  const listUrl = `${GITHUB_API}/repos/${PACKAGES_REPO}/contents/${PACKAGES_DIR}`;
  let listRes: Response;
  try {
    listRes = await fetch(listUrl, { headers: GITHUB_JSON, signal });
  } catch (err) {
    throw new PackRegistryError(
      `Network error listing the pack catalog: ${String(err)}`,
      err,
    );
  }
  if (!listRes.ok) {
    throw new PackRegistryError(
      `GitHub API error ${listRes.status} listing the pack catalog`,
    );
  }

  const entries = (await listRes.json()) as GitHubContentEntry[];
  const dirs = entries
    .filter((e) => e.type === "dir" && e.name.startsWith("hq-pack-"))
    .map((e) => e.name)
    .sort();

  const packs = await Promise.all(
    dirs.map((dir) => fetchPackMeta(dir, signal)),
  );
  return packs.filter((p): p is AvailablePack => p !== null);
}

/** Read one pack's package.yaml; returns null if it can't be read/parsed. */
async function fetchPackMeta(
  dir: string,
  signal?: AbortSignal,
): Promise<AvailablePack | null> {
  const url = `${GITHUB_API}/repos/${PACKAGES_REPO}/contents/${PACKAGES_DIR}/${dir}/package.yaml`;
  try {
    const res = await fetch(url, { headers: GITHUB_RAW, signal });
    if (!res.ok) return null;
    const meta = parseYaml(await res.text()) as {
      name?: string;
      description?: string;
    } | null;
    return {
      dir,
      name: meta?.name ?? dir,
      description: meta?.description ?? "",
      source: packSource(dir),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Recommended-pack defaults (from the extracted core.yaml)
// ---------------------------------------------------------------------------

/**
 * Read `{targetDir}/core/core.yaml` and return the set of pack directory
 * names that core.yaml lists under `recommended_packages`. The wizard
 * pre-checks these. Returns an empty set if core.yaml is missing or
 * unparseable — callers treat "unknown" as "let the user decide".
 *
 * Matches packs by the `hq-pack-*` token embedded in each `source:` string,
 * so it works regardless of which transport form core.yaml uses (npm scope,
 * `github:` subpath, or a git URL).
 */
export async function readRecommendedPackIds(
  targetDir: string,
): Promise<Set<string>> {
  const ids = new Set<string>();
  if (!targetDir) return ids;
  try {
    const text = await readTextFile(`${targetDir}/core/core.yaml`);
    const doc = parseYaml(text) as {
      recommended_packages?: Array<{ source?: string }>;
    } | null;
    for (const entry of doc?.recommended_packages ?? []) {
      const match = entry.source?.match(/hq-pack-[a-z0-9-]+/);
      if (match) ids.add(match[0]);
    }
  } catch {
    /* core.yaml missing/unreadable — caller treats empty as "unknown" */
  }
  return ids;
}
