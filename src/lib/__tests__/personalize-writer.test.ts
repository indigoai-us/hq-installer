import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock @tauri-apps/plugin-fs BEFORE importing the module under test
// ---------------------------------------------------------------------------

const mockMkdir = vi.fn<(path: string, opts?: { recursive?: boolean }) => Promise<void>>(
  async () => undefined,
);
const mockWriteTextFile = vi.fn<(path: string, data: string) => Promise<void>>(
  async () => undefined,
);
const mockWriteFile = vi.fn<(path: string, data: Uint8Array) => Promise<void>>(
  async () => undefined,
);

vi.mock("@tauri-apps/plugin-fs", () => ({
  mkdir: (path: string, opts?: { recursive?: boolean }) => mockMkdir(path, opts),
  writeTextFile: (path: string, data: string) => mockWriteTextFile(path, data),
  writeFile: (path: string, data: Uint8Array) => mockWriteFile(path, data),
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

/** Collect all paths that were written (both text and binary) */
function allWrittenPaths(): string[] {
  const textPaths = mockWriteTextFile.mock.calls.map((c) => c[0]);
  const binaryPaths = mockWriteFile.mock.calls.map((c) => c[0]);
  return [...textPaths, ...binaryPaths].sort();
}

/** Get the content written to a specific path (text only) */
function getWrittenText(path: string): string | undefined {
  const call = mockWriteTextFile.mock.calls.find((c) => c[0] === path);
  return call ? call[1] : undefined;
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

const BASE_DIR = "/tmp/hq-personalize-test";

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockMkdir.mockReset().mockResolvedValue(undefined);
  mockWriteTextFile.mockReset().mockResolvedValue(undefined);
  mockWriteFile.mockReset().mockResolvedValue(undefined);
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
    it("writes profile.md to core/knowledge/{name}/profile.md under baseDir", async () => {
      await personalize(BASE_ANSWERS, BASE_DIR, {
        profileTemplate: PROFILE_TEMPLATE,
        voiceStyleTemplate: VOICE_STYLE_TEMPLATE,
      });

      const expectedPath = `${BASE_DIR}/core/knowledge/alice/profile.md`;
      expect(mockWriteTextFile).toHaveBeenCalledWith(
        expectedPath,
        expect.stringContaining("alice"),
      );
    });

    it("renders profile.md with name, about, and goals from answers", async () => {
      await personalize(BASE_ANSWERS, BASE_DIR, {
        profileTemplate: PROFILE_TEMPLATE,
        voiceStyleTemplate: VOICE_STYLE_TEMPLATE,
      });

      const content = getWrittenText(`${BASE_DIR}/core/knowledge/alice/profile.md`);
      expect(content).toBeDefined();
      expect(content).toContain("alice");
      expect(content).toContain("Software engineer and indie hacker");
      expect(content).toContain("Automate repetitive tasks and ship faster");
    });

    it("writes voice-style.md to core/knowledge/{name}/voice-style.md under baseDir", async () => {
      await personalize(BASE_ANSWERS, BASE_DIR, {
        profileTemplate: PROFILE_TEMPLATE,
        voiceStyleTemplate: VOICE_STYLE_TEMPLATE,
      });

      const expectedPath = `${BASE_DIR}/core/knowledge/alice/voice-style.md`;
      expect(mockWriteTextFile).toHaveBeenCalledWith(
        expectedPath,
        expect.any(String),
      );
    });

    it("renders voice-style.md with customizations from answers", async () => {
      await personalize(BASE_ANSWERS, BASE_DIR, {
        profileTemplate: PROFILE_TEMPLATE,
        voiceStyleTemplate: VOICE_STYLE_TEMPLATE,
      });

      const content = getWrittenText(`${BASE_DIR}/core/knowledge/alice/voice-style.md`);
      expect(content).toBeDefined();
      expect(content).toContain("alice");
      expect(content).toContain("concise and direct");
      expect(content).toContain("America/New_York");
    });

    it("creates parent core/knowledge/{name} directory recursively", async () => {
      await personalize(BASE_ANSWERS, BASE_DIR, {
        profileTemplate: PROFILE_TEMPLATE,
        voiceStyleTemplate: VOICE_STYLE_TEMPLATE,
      });

      expect(mockMkdir).toHaveBeenCalledWith(
        `${BASE_DIR}/core/knowledge/alice`,
        { recursive: true },
      );
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

      const content = getWrittenText(`${BASE_DIR}/core/knowledge/alice/voice-style.md`);
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

      const expectedPath = `${BASE_DIR}/personal/settings/cognito.json`;
      expect(mockWriteTextFile).toHaveBeenCalledWith(
        expectedPath,
        expect.any(String),
      );

      const content = getWrittenText(expectedPath);
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

      const writtenPaths = allWrittenPaths();
      expect(
        writtenPaths.some(
          (p) => p === `${BASE_DIR}/personal/settings/.gitkeep`,
        ),
      ).toBe(true);
    });

    it("creates personal/settings/ directory recursively", async () => {
      await personalize(BASE_ANSWERS, BASE_DIR, {
        profileTemplate: PROFILE_TEMPLATE,
        voiceStyleTemplate: VOICE_STYLE_TEMPLATE,
      });

      expect(mockMkdir).toHaveBeenCalledWith(
        `${BASE_DIR}/personal/settings`,
        { recursive: true },
      );
    });

    it("writes .gitkeep to personal/workers/ directory", async () => {
      await personalize(BASE_ANSWERS, BASE_DIR, {
        profileTemplate: PROFILE_TEMPLATE,
        voiceStyleTemplate: VOICE_STYLE_TEMPLATE,
      });

      const writtenPaths = allWrittenPaths();
      expect(
        writtenPaths.some(
          (p) => p === `${BASE_DIR}/personal/workers/.gitkeep`,
        ),
      ).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe("golden snapshot: complete output file tree", () => {
    it("sorted created-path list matches snapshot", async () => {
      await personalize(BASE_ANSWERS, BASE_DIR, {
        profileTemplate: PROFILE_TEMPLATE,
        voiceStyleTemplate: VOICE_STYLE_TEMPLATE,
      });

      const writtenPaths = allWrittenPaths();

      // Normalise to paths relative to baseDir for a stable snapshot
      const relativePaths = writtenPaths
        .map((p) => p.replace(`${BASE_DIR}/`, ""))
        .sort();

      expect(relativePaths).toMatchSnapshot();
    });

    it("every written path is under baseDir (no path traversal)", async () => {
      await personalize(BASE_ANSWERS, BASE_DIR, {
        profileTemplate: PROFILE_TEMPLATE,
        voiceStyleTemplate: VOICE_STYLE_TEMPLATE,
      });

      const writtenPaths = allWrittenPaths();
      for (const p of writtenPaths) {
        expect(p).toMatch(new RegExp(`^${BASE_DIR.replace(/[/\\]/g, "\\$&")}`));
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

      const writtenPaths = allWrittenPaths();
      expect(
        writtenPaths.some((p) => p.includes("Alice Wonderland")),
      ).toBe(true);
    });

    it("returns void (undefined) on success", async () => {
      const result = await personalize(BASE_ANSWERS, BASE_DIR, {
        profileTemplate: PROFILE_TEMPLATE,
        voiceStyleTemplate: VOICE_STYLE_TEMPLATE,
      });

      expect(result).toBeUndefined();
    });

    it("propagates error if writeTextFile rejects", async () => {
      mockWriteTextFile.mockRejectedValueOnce(new Error("disk full"));

      await expect(
        personalize(BASE_ANSWERS, BASE_DIR, {
          profileTemplate: PROFILE_TEMPLATE,
          voiceStyleTemplate: VOICE_STYLE_TEMPLATE,
        }),
      ).rejects.toThrow("disk full");
    });

    it("propagates error if mkdir rejects", async () => {
      mockMkdir.mockRejectedValueOnce(new Error("permission denied"));

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
    // symlink, so scaffolding it via the scope-restricted fs plugin threw
    // "forbidden path: …/companies/broya/knowledge" and hard-failed Setup.
    it("never touches any on-disk path under the cloud company's folder", async () => {
      await personalize(CLOUD_ANSWERS, BASE_DIR, {
        profileTemplate: PROFILE_TEMPLATE,
        voiceStyleTemplate: VOICE_STYLE_TEMPLATE,
      });

      const companyPrefix = `${BASE_DIR}/companies/broya`;
      const mkdirPaths = mockMkdir.mock.calls.map((c) => c[0]);

      expect(mkdirPaths.some((p) => p.startsWith(companyPrefix))).toBe(false);
      expect(allWrittenPaths().some((p) => p.startsWith(companyPrefix))).toBe(
        false,
      );
      // The exact path Tauri's fs scope rejected must never be requested.
      expect(mkdirPaths).not.toContain(`${companyPrefix}/knowledge`);
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

      const base = `${BASE_DIR}/companies/acme-co`;
      const mkdirPaths = mockMkdir.mock.calls.map((c) => c[0]);
      for (const sub of ["knowledge", "settings", "workers", "projects"]) {
        expect(mkdirPaths).toContain(`${base}/${sub}`);
        expect(allWrittenPaths()).toContain(`${base}/${sub}/.gitkeep`);
      }

      const yaml = getWrittenText(`${base}/company.yaml`);
      expect(yaml).toContain("name: Acme Co");
      expect(yaml).toContain("slug: acme-co");
      expect(yaml).toContain("website: https://acme.test");
    });

    // Best-effort: a failed scaffold write must not abort Setup — the manifest
    // entry (what makes the company discoverable) is still registered.
    it("does not abort Setup when a company scaffold write fails", async () => {
      mockWriteTextFile.mockImplementation(async (path: string) => {
        if (path.includes("/companies/acme-co/")) {
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
