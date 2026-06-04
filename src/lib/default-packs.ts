// default-packs.ts
//
// Resolves the set of HQ content packs the installer installs by default,
// immediately after login. The v4.x wizard showed a catalog with a few packs
// pre-selected; the streamlined v5 flow drops the picker and just installs the
// default set with no input.
//
// The default set is the `recommended_packages` list in the freshly-scaffolded
// `{installPath}/core/core.yaml` — the single source of truth maintained in
// hq-core. That list is the four historically pre-selected packs
// (design-styles, design-quality, gemini, gstack) plus the engineering pack,
// so reading it keeps the installer in lock-step with hq-core: a new default
// pack ships to users with no installer release.
//
// Unlike `/update-hq`, the installer installs EVERY recommended pack
// unconditionally — it ignores each entry's `conditional:` gate. Those gates
// exist to keep some packs opt-in on upgrade (notably engineering, which
// `/update-hq` only auto-installs for hosts upgrading from <15.0.0); a brand
// new HQ should ship batteries-included, engineering included.

import { readTextFile } from "@tauri-apps/plugin-fs";
import { parse as parseYaml } from "yaml";

/** Monorepo holding every published `hq-pack-*` under `packages/`. */
const PACKAGES_REPO = "indigoai-us/hq-packages";
const PACKAGES_DIR = "packages";

export interface DefaultPack {
  /** `hq-pack-*` directory name — stable id, manifest key, and log label. */
  dir: string;
  /** Source spec passed verbatim to `hq install`. */
  source: string;
}

/** Build the `hq install` source spec for a pack directory. */
function packSource(dir: string): string {
  return `github:${PACKAGES_REPO}#${PACKAGES_DIR}/${dir}`;
}

/**
 * The default pack set, used when `core.yaml` can't be read or parsed so a
 * flaky scaffold never leaves a new HQ with zero packs. Mirrors hq-core's
 * `recommended_packages`: the four historically pre-selected packs plus the
 * engineering pack.
 */
export const FALLBACK_DEFAULT_PACKS: DefaultPack[] = [
  "hq-pack-design-styles",
  "hq-pack-design-quality",
  "hq-pack-gemini",
  "hq-pack-gstack",
  "hq-pack-engineering",
].map((dir) => ({ dir, source: packSource(dir) }));

/** Extract the `hq-pack-*` token from a source spec (npm scope, github: subpath,
 *  or git URL all carry it), or null when none is present. */
function dirFromSource(source: string): string | null {
  const match = source.match(/hq-pack-[a-z0-9-]+/);
  return match ? match[0] : null;
}

/**
 * Read `{installPath}/core/core.yaml` and return its `recommended_packages` as
 * the installer's default pack set — every entry, regardless of its
 * `conditional:` gate. Falls back to {@link FALLBACK_DEFAULT_PACKS} when
 * core.yaml is missing/unparseable or lists nothing usable, so the install
 * always has a sensible default set.
 */
export async function resolveDefaultPacks(
  installPath: string,
): Promise<DefaultPack[]> {
  if (!installPath) return FALLBACK_DEFAULT_PACKS;
  try {
    const text = await readTextFile(`${installPath}/core/core.yaml`);
    const doc = parseYaml(text) as {
      recommended_packages?: Array<{ source?: string }>;
    } | null;

    const packs: DefaultPack[] = [];
    const seen = new Set<string>();
    for (const entry of doc?.recommended_packages ?? []) {
      const source = entry.source?.trim();
      if (!source) continue;
      // Identity is the hq-pack-* token; fall back to the raw source if the
      // entry uses an unexpected form so we never silently drop a pack.
      const dir = dirFromSource(source) ?? source;
      if (seen.has(dir)) continue;
      seen.add(dir);
      packs.push({ dir, source });
    }
    return packs.length > 0 ? packs : FALLBACK_DEFAULT_PACKS;
  } catch {
    return FALLBACK_DEFAULT_PACKS;
  }
}
