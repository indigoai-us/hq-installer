import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// resolveDefaultPacks — the installer's "default packages" resolution.
//
// The streamlined flow installs HQ's recommended packs right after login with
// no picker. The set is core.yaml's `recommended_packages` (the four
// historically pre-selected packs + engineering), installed UNCONDITIONALLY
// (per-pack `conditional:` gates are an /update-hq concern, not the
// installer's). A missing/garbled core.yaml falls back to a hardcoded set so a
// new HQ is never left with zero packs.
// ---------------------------------------------------------------------------

vi.mock("@tauri-apps/plugin-fs", () => ({
  readTextFile: vi.fn(),
}));

import { readTextFile } from "@tauri-apps/plugin-fs";
import { resolveDefaultPacks, FALLBACK_DEFAULT_PACKS } from "../default-packs.js";

const mockReadTextFile = vi.mocked(readTextFile);

// Mirrors hq-core's core.yaml — engineering carries `auto_install` + a
// `conditional` that gates greenfield out for /update-hq; the installer must
// ignore it and install engineering anyway.
const CORE_YAML = `
version: 15.0.0
recommended_packages:
  - source: 'github:indigoai-us/hq-packages#packages/hq-pack-design-styles'
    description: 'Curated style packs'
  - source: 'github:indigoai-us/hq-packages#packages/hq-pack-design-quality'
    description: 'Quality references'
  - source: 'github:indigoai-us/hq-packages#packages/hq-pack-gemini'
    description: 'Gemini CLI workers'
    conditional: 'command -v gemini >/dev/null 2>&1'
  - source: 'github:indigoai-us/hq-packages#packages/hq-pack-gstack'
    description: 'gstack-team workers'
  - source: 'github:indigoai-us/hq-packages#packages/hq-pack-engineering'
    description: 'Engineering capabilities'
    auto_install: true
    conditional: '[ -d .claude/skills/tdd ] && [ ! -L .claude/skills/tdd ]'
`;

describe("resolveDefaultPacks", () => {
  beforeEach(() => {
    mockReadTextFile.mockReset();
  });

  it("returns every recommended pack from core.yaml, in declared order", async () => {
    mockReadTextFile.mockResolvedValue(CORE_YAML);
    const packs = await resolveDefaultPacks("/home/u/hq");
    expect(packs.map((p) => p.dir)).toEqual([
      "hq-pack-design-styles",
      "hq-pack-design-quality",
      "hq-pack-gemini",
      "hq-pack-gstack",
      "hq-pack-engineering",
    ]);
  });

  it("reads core.yaml from {installPath}/core/core.yaml", async () => {
    mockReadTextFile.mockResolvedValue(CORE_YAML);
    await resolveDefaultPacks("/home/u/hq");
    expect(mockReadTextFile).toHaveBeenCalledWith("/home/u/hq/core/core.yaml");
  });

  it("includes the engineering pack despite its conditional gate", async () => {
    mockReadTextFile.mockResolvedValue(CORE_YAML);
    const packs = await resolveDefaultPacks("/home/u/hq");
    expect(packs.some((p) => p.dir === "hq-pack-engineering")).toBe(true);
  });

  it("passes each source through verbatim for `hq install`", async () => {
    mockReadTextFile.mockResolvedValue(CORE_YAML);
    const packs = await resolveDefaultPacks("/home/u/hq");
    expect(packs[0].source).toBe(
      "github:indigoai-us/hq-packages#packages/hq-pack-design-styles",
    );
  });

  it("falls back to the default set when core.yaml is unreadable", async () => {
    mockReadTextFile.mockRejectedValue(new Error("ENOENT"));
    const packs = await resolveDefaultPacks("/home/u/hq");
    expect(packs).toEqual(FALLBACK_DEFAULT_PACKS);
  });

  it("falls back when core.yaml has no recommended_packages", async () => {
    mockReadTextFile.mockResolvedValue("version: 15.0.0\n");
    const packs = await resolveDefaultPacks("/home/u/hq");
    expect(packs).toEqual(FALLBACK_DEFAULT_PACKS);
  });

  it("falls back on an empty installPath without touching the disk", async () => {
    const packs = await resolveDefaultPacks("");
    expect(packs).toEqual(FALLBACK_DEFAULT_PACKS);
    expect(mockReadTextFile).not.toHaveBeenCalled();
  });

  it("skips entries with no source and dedupes repeats", async () => {
    mockReadTextFile.mockResolvedValue(`
recommended_packages:
  - description: 'entry with no source'
  - source: 'github:indigoai-us/hq-packages#packages/hq-pack-gstack'
  - source: 'github:indigoai-us/hq-packages#packages/hq-pack-gstack'
`);
    const packs = await resolveDefaultPacks("/home/u/hq");
    expect(packs.map((p) => p.dir)).toEqual(["hq-pack-gstack"]);
  });

  it("FALLBACK_DEFAULT_PACKS includes the engineering pack", () => {
    expect(FALLBACK_DEFAULT_PACKS.map((p) => p.dir)).toContain(
      "hq-pack-engineering",
    );
  });
});
