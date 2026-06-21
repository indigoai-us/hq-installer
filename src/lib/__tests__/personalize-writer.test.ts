import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock @tauri-apps/api/core's `invoke` BEFORE importing the module under test
// ---------------------------------------------------------------------------
//
// personalize-writer now routes every install-tree write through the
// install-root-guarded Rust commands (via src/lib/install-fs.ts), so the unit
// under test ultimately calls `invoke("create_dir" | "write_file", args)`. We
// mock `invoke` and assert on the command name + the root-relative `path` /
// `installRoot` payload the Rust guard receives.

const mockInvoke = vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(
  async () => undefined,
);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => mockInvoke(cmd, args),
}));

// Mock the manifest writer so company seeds can be asserted without touching
// the (unmocked) fs reads/writes ensureManifestEntries performs internally.
const mockEnsureManifestEntries = vi.fn<
  (installPath: string, seeds: unknown) => Promise<unknown>
>(async () => ({ added: [], skipped: [] }));

vi.mock("../manifest-writer.js", () => ({
  ensureManifestEntries: (installPath: string, seeds: unknown) =>
    mockEnsureManifestEntries(installPath, seeds),
}));

// ---------------------------------------------------------------------------
// Import module under test AFTER mocks are registered
// ---------------------------------------------------------------------------

import {
  personalize,
  type PersonalizationAnswers,
} from "../personalize-writer.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Calls routed through `invoke("write_file", ...)` (text + binary writes). */
function writeFileCalls(): { path: string; contents: unknown; installRoot: string }[] {
  return mockInvoke.mock.calls
    .filter((c) => c[0] === "write_file")
    .map((c) => c[1] as { path: string; contents: unknown; installRoot: string });
}

/** Calls routed through `invoke("create_dir", ...)`. */
function createDirCalls(): { path: string; installRoot: string }[] {
  return mockInvoke.mock.calls
    .filter((c) => c[0] === "create_dir")
    .map((c) => c[1] as { path: string; installRoot: string });
}

/** Root-relative paths that were written (write_file only). */
function writtenRelativePaths(): string[] {
  return writeFileCalls()
    .map((c) => c.path)
    .sort();
}

/** Root-relative paths that had a directory created (create_dir only). */
function createdRelativeDirs(): string[] {
  return createDirCalls().map((c) => c.path);
}

/**
 * Decode the bytes written to a given root-relative path back into text.
 * personalize-writer writes via writeInstallText, which TextEncoder-encodes the
 * string and passes `Array.from(bytes)` to invoke — so contents is a number[].
 */
function getWrittenText(relativePath: string): string | undefined {
  const call = writeFileCalls().find((c) => c.path === relativePath);
  if (!call) return undefined;
  const bytes = Uint8Array.from(call.contents as number[]);
  return new TextDecoder().decode(bytes);
}

/** Minimal profile Handlebars template (mirrors what templates/profile.md.hbs will contain) */
const PROFILE_TEMPLATE = `# {{name}}

## About
{{about}}

## Goals
{{goals}}
`;

/** Minimal voice-style Handlebars template */
const VOICE_STYLE_TEMPLATE = `# Voice & Style: {{name}}

## Customizations
{{#each customizations}}
- {{@key}}: {{this}}
{{/each}}
`;

// ---------------------------------------------------------------------------
// Base answers fixture
// ---------------------------------------------------------------------------

const BASE_ANSWERS: PersonalizationAnswers = {
  name: "alice",
  about: "Software engineer and indie hacker",
  goals: "Automate repetitive tasks and ship faster",
  customizations: {
    tone: "concise and direct",
    timezone: "America/New_York",
  },
};

// Default ~/hq-style install root.
const BASE_DIR = "/Users/alice/hq";

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockInvoke.mockReset().mockResolvedValue(undefined);
  mockEnsureManifestEntries
    .mockReset()
    .mockResolvedValue({ added: [], skipped: [] });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("personalize", () => {
  // -------------------------------------------------------------------------
  describe("profile.md and voice-style.md", () => {
    it("writes profile.md to core/knowledge/{name}/profile.md (root-relative)", async () => {
      await personalize(BASE_ANSWERS, BASE_DIR, {
        profileTemplate: PROFILE_TEMPLATE,
        voiceStyleTemplate: VOICE_STYLE_TEMPLATE,
      });

      const call = writeFileCalls().find(
        (c) => c.path === "core/knowledge/alice/profile.md",
      );
      expect(call).toBeDefined();
      expect(call!.installRoot).toBe(BASE_DIR);
      expect(getWrittenText("core/knowledge/alice/profile.md")).toContain(
        "alice",
      );
    });

    it("renders profile.md with name, about, and goals from answers", async () => {
      await personalize(BASE_ANSWERS, BASE_DIR, {
        profileTemplate: PROFILE_TEMPLATE,
        voiceStyleTemplate: VOICE_STYLE_TEMPLATE,
      });

      const content = getWrittenText("core/knowledge/alice/profile.md");
      expect(content).toBeDefined();
      expect(content).toContain("alice");
      expect(content).toContain("Software engineer and indie hacker");
      expect(content).toContain("Automate repetitive tasks and ship faster");
    });

    it("writes voice-style.md to core/knowledge/{name}/voice-style.md (root-relative)", async () => {
      await personalize(BASE_ANSWERS, BASE_DIR, {
        profileTemplate: PROFILE_TEMPLATE,
        voiceStyleTemplate: VOICE_STYLE_TEMPLATE,
      });

      const call = writeFileCalls().find(
        (c) => c.path === "core/knowledge/alice/voice-style.md",
      );
      expect(call).toBeDefined();
      expect(call!.installRoot).toBe(BASE_DIR);
    });

    it("renders voice-style.md with customizations from answers", async () => {
      await personalize(BASE_ANSWERS, BASE_DIR, {
        profileTemplate: PROFILE_TEMPLATE,
        voiceStyleTemplate: VOICE_STYLE_TEMPLATE,
      });

      const content = getWrittenText("core/knowledge/alice/voice-style.md");
      expect(content).toBeDefined();
      expect(content).toContain("alice");
      expect(content).toContain("concise and direct");
      expect(content).toContain("America/New_York");
    });

    it("creates parent core/knowledge/{name} directory via create_dir", async () => {
      await personalize(BASE_ANSWERS, BASE_DIR, {
        profileTemplate: PROFILE_TEMPLATE,
        voiceStyleTemplate: VOICE_STYLE_TEMPLATE,
      });

      const call = createDirCalls().find(
        (c) => c.path === "core/knowledge/alice",
      );
      expect(call).toBeDefined();
      expect(call!.installRoot).toBe(BASE_DIR);
    });

    it("handles answers with no customizations without error", async () => {
      const answersNoCustom: PersonalizationAnswers = {
        ...BASE_ANSWERS,
        customizations: undefined,
      };

      await expect(
        personalize(answersNoCustom, BASE_DIR, {
          profileTemplate: PROFILE_TEMPLATE,
          voiceStyleTemplate: VOICE_STYLE_TEMPLATE,
        }),
      ).resolves.toBeUndefined();

      const content = getWrittenText("core/knowledge/alice/voice-style.md");
      expect(content).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  describe("settings scaffold", () => {
    it("writes cognito.json as an empty JSON object to personal/settings/", async () => {
      await personalize(BASE_ANSWERS, BASE_DIR, {
        profileTemplate: PROFILE_TEMPLATE,
        voiceStyleTemplate: VOICE_STYLE_TEMPLATE,
      });

      const relativePath = "personal/settings/cognito.json";
      const call = writeFileCalls().find((c) => c.path === relativePath);
      expect(call).toBeDefined();
      expect(call!.installRoot).toBe(BASE_DIR);

      const content = getWrittenText(relativePath);
      expect(content).toBeDefined();
      // Should be valid JSON and parse to an empty object
      expect(() => JSON.parse(content!)).not.toThrow();
      expect(JSON.parse(content!)).toEqual({});
    });

    it("writes .gitkeep to personal/settings/", async () => {
      await personalize(BASE_ANSWERS, BASE_DIR, {
        profileTemplate: PROFILE_TEMPLATE,
        voiceStyleTemplate: VOICE_STYLE_TEMPLATE,
      });

      expect(writtenRelativePaths()).toContain("personal/settings/.gitkeep");
    });

    it("creates personal/settings/ directory via create_dir", async () => {
      await personalize(BASE_ANSWERS, BASE_DIR, {
        profileTemplate: PROFILE_TEMPLATE,
        voiceStyleTemplate: VOICE_STYLE_TEMPLATE,
      });

      const call = createDirCalls().find(
        (c) => c.path === "personal/settings",
      );
      expect(call).toBeDefined();
      expect(call!.installRoot).toBe(BASE_DIR);
    });

    it("writes .gitkeep to personal/workers/ directory", async () => {
      await personalize(BASE_ANSWERS, BASE_DIR, {
        profileTemplate: PROFILE_TEMPLATE,
        voiceStyleTemplate: VOICE_STYLE_TEMPLATE,
      });

      expect(writtenRelativePaths()).toContain("personal/workers/.gitkeep");
    });
  });

  // -------------------------------------------------------------------------
  describe("install root routing", () => {
    // The install root is user-chosen and may live anywhere — including outside
    // $HOME. Containment is enforced in Rust against that root, so every write
    // must carry the chosen root as `installRoot` and a path that is *relative*
    // to it (the Rust guard rejects absolute paths). Regression guard for the
    // "install anywhere" contract.
    const OPT_DIR = "/opt/hq";

    it("routes writes through write_file with root-relative path + installRoot for a non-~/hq root", async () => {
      await personalize(BASE_ANSWERS, OPT_DIR, {
        profileTemplate: PROFILE_TEMPLATE,
        voiceStyleTemplate: VOICE_STYLE_TEMPLATE,
      });

      // The chosen root is passed verbatim as installRoot on every command,
      // and never leaks into the relative `path`.
      for (const call of writeFileCalls()) {
        expect(call.installRoot).toBe(OPT_DIR);
        expect(call.path.startsWith("/")).toBe(false);
        expect(call.path.startsWith(OPT_DIR)).toBe(false);
      }
      for (const call of createDirCalls()) {
        expect(call.installRoot).toBe(OPT_DIR);
        expect(call.path.startsWith("/")).toBe(false);
        expect(call.path.startsWith(OPT_DIR)).toBe(false);
      }

      // The relative paths are identical to the default-root case — only the
      // installRoot differs.
      expect(writtenRelativePaths()).toContain("core/knowledge/alice/profile.md");
      expect(writtenRelativePaths()).toContain(
        "core/knowledge/alice/voice-style.md",
      );
      expect(createdRelativeDirs()).toContain("core/knowledge/alice");
    });

    it("routes create_dir for settings/workers with installRoot = chosen root", async () => {
      await personalize(BASE_ANSWERS, OPT_DIR, {
        profileTemplate: PROFILE_TEMPLATE,
        voiceStyleTemplate: VOICE_STYLE_TEMPLATE,
      });

      const settings = createDirCalls().find(
        (c) => c.path === "personal/settings",
      );
      const workers = createDirCalls().find(
        (c) => c.path === "personal/workers",
      );
      expect(settings?.installRoot).toBe(OPT_DIR);
      expect(workers?.installRoot).toBe(OPT_DIR);
    });

    it("never asks the Rust guard to create the install root itself (empty relative path)", async () => {
      await personalize(BASE_ANSWERS, OPT_DIR, {
        profileTemplate: PROFILE_TEMPLATE,
        voiceStyleTemplate: VOICE_STYLE_TEMPLATE,
      });

      // A "" relative path would be the root itself, which the guard rejects.
      expect(createdRelativeDirs()).not.toContain("");
      expect(writtenRelativePaths()).not.toContain("");
    });
  });

  // -------------------------------------------------------------------------
  describe("golden snapshot: complete output file tree", () => {
    it("sorted created-path list matches snapshot", async () => {
      await personalize(BASE_ANSWERS, BASE_DIR, {
        profileTemplate: PROFILE_TEMPLATE,
        voiceStyleTemplate: VOICE_STYLE_TEMPLATE,
      });

      // Paths are already root-relative (that's what the Rust guard receives),
      // so the snapshot is stable regardless of where HQ is installed.
      expect(writtenRelativePaths()).toMatchSnapshot();
    });

    it("every written path is root-relative (no absolute paths, no traversal)", async () => {
      await personalize(BASE_ANSWERS, BASE_DIR, {
        profileTemplate: PROFILE_TEMPLATE,
        voiceStyleTemplate: VOICE_STYLE_TEMPLATE,
      });

      for (const path of [...writtenRelativePaths(), ...createdRelativeDirs()]) {
        expect(path.startsWith("/")).toBe(false);
        expect(path.startsWith(BASE_DIR)).toBe(false);
        expect(path.split("/")).not.toContain("..");
      }
    });
  });

  // -------------------------------------------------------------------------
  describe("edge cases", () => {
    it("name with spaces is used as-is in output paths", async () => {
      const answers: PersonalizationAnswers = {
        ...BASE_ANSWERS,
        name: "Alice Wonderland",
      };

      await personalize(answers, BASE_DIR, {
        profileTemplate: PROFILE_TEMPLATE,
        voiceStyleTemplate: VOICE_STYLE_TEMPLATE,
      });

      expect(
        writtenRelativePaths().some((p) => p.includes("Alice Wonderland")),
      ).toBe(true);
    });

    it("returns void (undefined) on success", async () => {
      const result = await personalize(BASE_ANSWERS, BASE_DIR, {
        profileTemplate: PROFILE_TEMPLATE,
        voiceStyleTemplate: VOICE_STYLE_TEMPLATE,
      });

      expect(result).toBeUndefined();
    });

    it("propagates error if a write_file invoke rejects", async () => {
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === "write_file") throw new Error("disk full");
        return undefined;
      });

      await expect(
        personalize(BASE_ANSWERS, BASE_DIR, {
          profileTemplate: PROFILE_TEMPLATE,
          voiceStyleTemplate: VOICE_STYLE_TEMPLATE,
        }),
      ).rejects.toThrow("disk full");
    });

    it("propagates error if a create_dir invoke rejects", async () => {
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === "create_dir") throw new Error("permission denied");
        return undefined;
      });

      await expect(
        personalize(BASE_ANSWERS, BASE_DIR, {
          profileTemplate: PROFILE_TEMPLATE,
          voiceStyleTemplate: VOICE_STYLE_TEMPLATE,
        }),
      ).rejects.toThrow("permission denied");
    });
  });

  // -------------------------------------------------------------------------
  describe("cloud-backed companies", () => {
    const CLOUD_ANSWERS: PersonalizationAnswers = {
      ...BASE_ANSWERS,
      companies: [
        { name: "Broya", cloud: true, cloudCompanyUid: "ent_broya_123" },
      ],
    };

    // Regression: a cloud company's knowledge/ dir is sync-owned and usually a
    // symlink, so scaffolding it threw "forbidden path: …/companies/broya/
    // knowledge" and hard-failed Setup. The folder must never be touched.
    it("never touches any path under the cloud company's folder", async () => {
      await personalize(CLOUD_ANSWERS, BASE_DIR, {
        profileTemplate: PROFILE_TEMPLATE,
        voiceStyleTemplate: VOICE_STYLE_TEMPLATE,
      });

      const companyPrefix = "companies/broya";

      expect(
        createdRelativeDirs().some((p) => p.startsWith(companyPrefix)),
      ).toBe(false);
      expect(
        writtenRelativePaths().some((p) => p.startsWith(companyPrefix)),
      ).toBe(false);
      // The exact path the fs guard rejected must never be requested.
      expect(createdRelativeDirs()).not.toContain(`${companyPrefix}/knowledge`);
    });

    it("still registers the cloud company in the manifest with its cloud uid", async () => {
      await personalize(CLOUD_ANSWERS, BASE_DIR, {
        profileTemplate: PROFILE_TEMPLATE,
        voiceStyleTemplate: VOICE_STYLE_TEMPLATE,
      });

      expect(mockEnsureManifestEntries).toHaveBeenCalledTimes(1);
      const [installArg, seedsArg] = mockEnsureManifestEntries.mock.calls[0];
      expect(installArg).toBe(BASE_DIR);
      expect(seedsArg).toEqual([
        { slug: "broya", name: "Broya", cloudUid: "ent_broya_123" },
      ]);
    });

    it("completes without throwing when a cloud company is present", async () => {
      await expect(
        personalize(CLOUD_ANSWERS, BASE_DIR, {
          profileTemplate: PROFILE_TEMPLATE,
          voiceStyleTemplate: VOICE_STYLE_TEMPLATE,
        }),
      ).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  describe("local (non-cloud) companies", () => {
    const LOCAL_ANSWERS: PersonalizationAnswers = {
      ...BASE_ANSWERS,
      companies: [{ name: "Acme Co", website: "https://acme.test" }],
    };

    it("scaffolds the standard skeleton + company.yaml", async () => {
      await personalize(LOCAL_ANSWERS, BASE_DIR, {
        profileTemplate: PROFILE_TEMPLATE,
        voiceStyleTemplate: VOICE_STYLE_TEMPLATE,
      });

      const base = "companies/acme-co";
      for (const sub of ["knowledge", "settings", "workers", "projects"]) {
        expect(createdRelativeDirs()).toContain(`${base}/${sub}`);
        expect(writtenRelativePaths()).toContain(`${base}/${sub}/.gitkeep`);
      }

      const yaml = getWrittenText(`${base}/company.yaml`);
      expect(yaml).toContain("name: Acme Co");
      expect(yaml).toContain("slug: acme-co");
      expect(yaml).toContain("website: https://acme.test");
    });

    // Best-effort: a failed scaffold write must not abort Setup — the manifest
    // entry (what makes the company discoverable) is still registered.
    it("does not abort Setup when a company scaffold write fails", async () => {
      mockInvoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
        const path = (args?.path as string | undefined) ?? "";
        if (
          (cmd === "write_file" || cmd === "create_dir") &&
          path.startsWith("companies/acme-co")
        ) {
          throw new Error(`forbidden path: ${path}`);
        }
        return undefined;
      });

      await expect(
        personalize(LOCAL_ANSWERS, BASE_DIR, {
          profileTemplate: PROFILE_TEMPLATE,
          voiceStyleTemplate: VOICE_STYLE_TEMPLATE,
        }),
      ).resolves.toBeUndefined();

      expect(mockEnsureManifestEntries).toHaveBeenCalledTimes(1);
    });
  });
});
