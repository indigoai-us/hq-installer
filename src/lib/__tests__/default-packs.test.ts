import { describe, it, expect } from "vitest";
import { DEFAULT_PACKS, getDefaultPacks } from "../default-packs.js";

// ---------------------------------------------------------------------------
// default-packs — the installer's default content packs.
//
// The streamlined flow installs these right after login, no picker. They are
// the four packs v4.x pre-selected, installed via the npm transport
// (`hq install @scope/name`) so no git is needed on a fresh consumer Mac.
// Engineering is intentionally excluded for now — not on npm, registry
// undeployed — and tracked separately.
// ---------------------------------------------------------------------------

describe("default-packs", () => {
  it("returns the four v4.x pre-selected add-on packs, in install order", () => {
    expect(getDefaultPacks().map((p) => p.name)).toEqual([
      "hq-pack-design-styles",
      "hq-pack-design-quality",
      "hq-pack-gemini",
      "hq-pack-gstack",
    ]);
  });

  it("uses the npm transport — every source is an @indigoai-us scope spec, never `github:`/git", () => {
    for (const pack of getDefaultPacks()) {
      expect(pack.source).toMatch(/^@indigoai-us\/hq-pack-[a-z-]+$/);
      expect(pack.source).not.toContain("github:");
      expect(pack.source).not.toContain(".git");
    }
  });

  it("source scope matches the pack name", () => {
    for (const pack of getDefaultPacks()) {
      expect(pack.source).toBe(`@indigoai-us/${pack.name}`);
    }
  });

  it("does NOT include the engineering pack (deferred — no npm/registry path yet)", () => {
    expect(getDefaultPacks().some((p) => p.name.includes("engineering"))).toBe(
      false,
    );
  });

  it("getDefaultPacks returns the exported DEFAULT_PACKS", () => {
    expect(getDefaultPacks()).toBe(DEFAULT_PACKS);
  });
});
