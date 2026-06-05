// default-packs.ts
//
// The HQ content packs the installer installs by default, immediately after
// login. The v4.x wizard showed a catalog with a few packs pre-selected; the
// streamlined v5 flow drops the picker and just installs the default set.
//
// Transport per pack:
//   - The four design/gemini/gstack packs are published to npm under the
//     @indigoai-us scope, so we install them via the npm transport
//     (`hq install @scope/name`) — lighter than cloning the packages monorepo.
//   - hq-pack-engineering is NOT on npm, so it installs from its github source.
//     That needs the git CLI — which the installer now provisions into the
//     managed toolchain (portable Git via dugite-native; see deps `install_git`).
//     Git is required anyway for autocommit, repos, and agents, so the github
//     transport is always available by the time this stage runs.

export interface DefaultPack {
  /** `hq-pack-*` name — stable id, install-manifest key, and log label. */
  name: string;
  /** Source spec passed verbatim to `hq install` (npm scope spec or `github:`). */
  source: string;
}

/** The installer's default packs, in install order. */
export const DEFAULT_PACKS: DefaultPack[] = [
  { name: "hq-pack-design-styles", source: "@indigoai-us/hq-pack-design-styles" },
  { name: "hq-pack-design-quality", source: "@indigoai-us/hq-pack-design-quality" },
  { name: "hq-pack-gemini", source: "@indigoai-us/hq-pack-gemini" },
  { name: "hq-pack-gstack", source: "@indigoai-us/hq-pack-gstack" },
  {
    name: "hq-pack-engineering",
    source: "github:indigoai-us/hq-packages#packages/hq-pack-engineering",
  },
];

/** The packs the installer installs by default. Indirected through a function
 *  so callers (and tests) have a single seam to stub. */
export function getDefaultPacks(): DefaultPack[] {
  return DEFAULT_PACKS;
}
