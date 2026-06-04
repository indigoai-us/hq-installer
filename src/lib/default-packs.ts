// default-packs.ts
//
// The HQ content packs the installer installs by default, immediately after
// login. The v4.x wizard showed a catalog with a few packs pre-selected; the
// streamlined v5 flow drops the picker and just installs the default set.
//
// These are the four packs v4.x pre-selected, all published to npm under the
// @indigoai-us scope. We install via the npm transport (`hq install
// @scope/name`) — NOT the `github:` transport — because a fresh consumer Mac
// has no git (only the Xcode stub), so a git clone fails. npm needs only the
// managed Node toolchain the installer already provisions.
//
// Engineering is intentionally NOT in this list yet. It isn't published to npm
// (npm 404) and the entitlement-gated registry is undeployed
// (packages/sources.yaml → registry.indigo-nx.com, "once the registry API is
// deployed"), so it has no working clean-install path. Its distribution is
// tracked separately; add it here once it's npm-published (or wire the registry
// flow) so the installer can install it the same way.

export interface DefaultPack {
  /** `hq-pack-*` name — stable id, install-manifest key, and log label. */
  name: string;
  /** Source spec passed verbatim to `hq install` (npm scope spec). */
  source: string;
}

/**
 * The installer's default packs, in install order. npm scope specs so
 * `hq install <source>` uses the npm transport (no git required).
 */
export const DEFAULT_PACKS: DefaultPack[] = [
  { name: "hq-pack-design-styles", source: "@indigoai-us/hq-pack-design-styles" },
  { name: "hq-pack-design-quality", source: "@indigoai-us/hq-pack-design-quality" },
  { name: "hq-pack-gemini", source: "@indigoai-us/hq-pack-gemini" },
  { name: "hq-pack-gstack", source: "@indigoai-us/hq-pack-gstack" },
];

/** The packs the installer installs by default. Indirected through a function
 *  so callers (and tests) have a single seam to stub. */
export function getDefaultPacks(): DefaultPack[] {
  return DEFAULT_PACKS;
}
