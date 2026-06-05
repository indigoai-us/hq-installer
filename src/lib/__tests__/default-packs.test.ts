import { describe, it, expect } from "vitest";
import { DEFAULT_PACKS, getDefaultPacks } from "../default-packs.js";

// ---------------------------------------------------------------------------
// default-packs — the installer's default content packs.
//
// Installed right after login, no picker: the four v4.x pre-selected packs
// (via npm) plus the engineering pack (via github, since it isn't on npm —
// the installer provisions a portable git so the github transport works).
// ---------------------------------------------------------------------------

describe("default-packs", () => {
  it("returns all five default packs, in install order", () => {
    expect(getDefaultPacks().map((p) => p.name)).toEqual([
      "hq-pack-design-styles",
      "hq-pack-design-quality",
      "hq-pack-gemini",
      "hq-pack-gstack",
      "hq-pack-engineering",
    ]);
  });

  it("installs the four published add-ons via the npm transport", () => {
    for (const name of [
      "hq-pack-design-styles",
      "hq-pack-design-quality",
      "hq-pack-gemini",
      "hq-pack-gstack",
    ]) {
      const pack = getDefaultPacks().find((p) => p.name === name);
      expect(pack?.source).toBe(`@indigoai-us/${name}`);
    }
  });

  it("includes the engineering pack from github (not published to npm)", () => {
    const eng = getDefaultPacks().find((p) => p.name === "hq-pack-engineering");
    expect(eng).toBeDefined();
    expect(eng?.source).toBe(
      "github:indigoai-us/hq-packages#packages/hq-pack-engineering",
    );
  });

  it("getDefaultPacks returns the exported DEFAULT_PACKS", () => {
    expect(getDefaultPacks()).toBe(DEFAULT_PACKS);
  });
});
