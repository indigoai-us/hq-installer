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

/** Sample minimal starter project files for injection */
const PERSONAL_ASSISTANT_FILES: Record<string, string> = {
  "README.md": "# Personal Assistant Starter",
  "workers/assistant.yaml": "name: assistant\ntype: personal-assistant\n",
  "projects/daily-standup/prd.json": '{"name":"daily-standup"}',
};

const SOCIAL_MEDIA_FILES: Record<string, string> = {
  "README.md": "# Social Media Starter",
  "workers/social.yaml": "name: social\ntype: social-media\n",
};

const CODE_WORKER_FILES: Record<string, string> = {
  "README.md": "# Code Worker Starter",
  "workers/coder.yaml": "name: coder\ntype: code-worker\n",
};

// ---------------------------------------------------------------------------
// Base answers fixture
// ---------------------------------------------------------------------------

const BASE_ANSWERS: PersonalizationAnswers = {
  name: "alice",
  about: "Software engineer and indie hacker",
  goals: "Automate repetitive tasks and ship faster",
  starterProject: "personal-assistant",
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
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("personalize", () => {
  // -------------------------------------------------------------------------
  describe("profile.md and voice-style.md", () => {
    it("writes profile.md to knowledge/{name}/profile.md under baseDir", async () => {
      await personalize(BASE_ANSWERS, BASE_DIR, {
        profileTemplate: PROFILE_TEMPLATE,
        voiceStyleTemplate: VOICE_STYLE_TEMPLATE,
        starterProjectFiles: PERSONAL_ASSISTANT_FILES,
      });

      const expectedPath = `${BASE_DIR}/knowledge/alice/profile.md`;
      expect(mockWriteTextFile).toHaveBeenCalledWith(
        expectedPath,
        expect.stringContaining("alice"),
      );
    });

    it("renders profile.md with name, about, and goals from answers", async () => {
      await personalize(BASE_ANSWERS, BASE_DIR, {
        profileTemplate: PROFILE_TEMPLATE,
        voiceStyleTemplate: VOICE_STYLE_TEMPLATE,
        starterProjectFiles: PERSONAL_ASSISTANT_FILES,
      });

      const content = getWrittenText(`${BASE_DIR}/knowledge/alice/profile.md`);
      expect(content).toBeDefined();
      expect(content).toContain("alice");
      expect(content).toContain("Software engineer and indie hacker");
      expect(content).toContain("Automate repetitive tasks and ship faster");
    });

    it("writes voice-style.md to knowledge/{name}/voice-style.md under baseDir", async () => {
      await personalize(BASE_ANSWERS, BASE_DIR, {
        profileTemplate: PROFILE_TEMPLATE,
        voiceStyleTemplate: VOICE_STYLE_TEMPLATE,
        starterProjectFiles: PERSONAL_ASSISTANT_FILES,
      });

      const expectedPath = `${BASE_DIR}/knowledge/alice/voice-style.md`;
      expect(mockWriteTextFile).toHaveBeenCalledWith(
        expectedPath,
        expect.any(String),
      );
    });

    it("renders voice-style.md with customizations from answers", async () => {
      await personalize(BASE_ANSWERS, BASE_DIR, {
        profileTemplate: PROFILE_TEMPLATE,
        voiceStyleTemplate: VOICE_STYLE_TEMPLATE,
        starterProjectFiles: PERSONAL_ASSISTANT_FILES,
      });

      const content = getWrittenText(`${BASE_DIR}/knowledge/alice/voice-style.md`);
      expect(content).toBeDefined();
      expect(content).toContain("alice");
      expect(content).toContain("concise and direct");
      expect(content).toContain("America/New_York");
    });

    it("creates parent knowledge/{name} directory recursively", async () => {
      await personalize(BASE_ANSWERS, BASE_DIR, {
        profileTemplate: PROFILE_TEMPLATE,
        voiceStyleTemplate: VOICE_STYLE_TEMPLATE,
        starterProjectFiles: PERSONAL_ASSISTANT_FILES,
      });

      expect(mockMkdir).toHaveBeenCalledWith(
        `${BASE_DIR}/knowledge/alice`,
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
          starterProjectFiles: PERSONAL_ASSISTANT_FILES,
        }),
      ).resolves.toBeUndefined();

      const content = getWrittenText(`${BASE_DIR}/knowledge/alice/voice-style.md`);
      expect(content).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  describe("starter project copying", () => {
    it("copies personal-assistant files to companies/personal/projects/personal-assistant/", async () => {
      await personalize(BASE_ANSWERS, BASE_DIR, {
        profileTemplate: PROFILE_TEMPLATE,
        voiceStyleTemplate: VOICE_STYLE_TEMPLATE,
        starterProjectFiles: PERSONAL_ASSISTANT_FILES,
      });

      const expectedBase = `${BASE_DIR}/companies/personal/projects/personal-assistant`;
      expect(mockWriteTextFile).toHaveBeenCalledWith(
        `${expectedBase}/README.md`,
        "# Personal Assistant Starter",
      );
      expect(mockWriteTextFile).toHaveBeenCalledWith(
        `${expectedBase}/workers/assistant.yaml`,
        expect.stringContaining("assistant"),
      );
    });

    it("copies social-media files to companies/personal/projects/social-media/", async () => {
      const answers: PersonalizationAnswers = {
        ...BASE_ANSWERS,
        starterProject: "social-media",
      };

      await personalize(answers, BASE_DIR, {
        profileTemplate: PROFILE_TEMPLATE,
        voiceStyleTemplate: VOICE_STYLE_TEMPLATE,
        starterProjectFiles: SOCIAL_MEDIA_FILES,
      });

      const expectedBase = `${BASE_DIR}/companies/personal/projects/social-media`;
      expect(mockWriteTextFile).toHaveBeenCalledWith(
        `${expectedBase}/README.md`,
        "# Social Media Starter",
      );
    });

    it("copies code-worker files to companies/personal/projects/code-worker/", async () => {
      const answers: PersonalizationAnswers = {
        ...BASE_ANSWERS,
        starterProject: "code-worker",
      };

      await personalize(answers, BASE_DIR, {
        profileTemplate: PROFILE_TEMPLATE,
        voiceStyleTemplate: VOICE_STYLE_TEMPLATE,
        starterProjectFiles: CODE_WORKER_FILES,
      });

      const expectedBase = `${BASE_DIR}/companies/personal/projects/code-worker`;
      expect(mockWriteTextFile).toHaveBeenCalledWith(
        `${expectedBase}/README.md`,
        "# Code Worker Starter",
      );
    });

    it("creates parent project directories recursively before writing files", async () => {
      await personalize(BASE_ANSWERS, BASE_DIR, {
        profileTemplate: PROFILE_TEMPLATE,
        voiceStyleTemplate: VOICE_STYLE_TEMPLATE,
        starterProjectFiles: PERSONAL_ASSISTANT_FILES,
      });

      const projectBase = `${BASE_DIR}/companies/personal/projects/personal-assistant`;
      // Expect mkdir for the project base or a subdirectory within it
      const mkdirPaths = mockMkdir.mock.calls.map((c) => c[0]);
      expect(
        mkdirPaths.some((p) => p.startsWith(projectBase)),
      ).toBe(true);
    });

    it("does not write files from other starter projects when personal-assistant is selected", async () => {
      await personalize(BASE_ANSWERS, BASE_DIR, {
        profileTemplate: PROFILE_TEMPLATE,
        voiceStyleTemplate: VOICE_STYLE_TEMPLATE,
        starterProjectFiles: PERSONAL_ASSISTANT_FILES,
      });

      const writtenPaths = allWrittenPaths();
      expect(writtenPaths.some((p) => p.includes("social-media"))).toBe(false);
      expect(writtenPaths.some((p) => p.includes("code-worker"))).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe("settings scaffold", () => {
    it("writes cognito.json as an empty JSON object to companies/personal/settings/", async () => {
      await personalize(BASE_ANSWERS, BASE_DIR, {
        profileTemplate: PROFILE_TEMPLATE,
        voiceStyleTemplate: VOICE_STYLE_TEMPLATE,
        starterProjectFiles: PERSONAL_ASSISTANT_FILES,
      });

      const expectedPath = `${BASE_DIR}/companies/personal/settings/cognito.json`;
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

    it("writes .gitkeep to companies/personal/settings/", async () => {
      await personalize(BASE_ANSWERS, BASE_DIR, {
        profileTemplate: PROFILE_TEMPLATE,
        voiceStyleTemplate: VOICE_STYLE_TEMPLATE,
        starterProjectFiles: PERSONAL_ASSISTANT_FILES,
      });

      const writtenPaths = allWrittenPaths();
      expect(
        writtenPaths.some(
          (p) => p === `${BASE_DIR}/companies/personal/settings/.gitkeep`,
        ),
      ).toBe(true);
    });

    it("creates companies/personal/settings/ directory recursively", async () => {
      await personalize(BASE_ANSWERS, BASE_DIR, {
        profileTemplate: PROFILE_TEMPLATE,
        voiceStyleTemplate: VOICE_STYLE_TEMPLATE,
        starterProjectFiles: PERSONAL_ASSISTANT_FILES,
      });

      expect(mockMkdir).toHaveBeenCalledWith(
        `${BASE_DIR}/companies/personal/settings`,
        { recursive: true },
      );
    });

    it("writes .gitkeep to companies/personal/workers/ directory", async () => {
      await personalize(BASE_ANSWERS, BASE_DIR, {
        profileTemplate: PROFILE_TEMPLATE,
        voiceStyleTemplate: VOICE_STYLE_TEMPLATE,
        starterProjectFiles: PERSONAL_ASSISTANT_FILES,
      });

      const writtenPaths = allWrittenPaths();
      expect(
        writtenPaths.some(
          (p) => p === `${BASE_DIR}/companies/personal/workers/.gitkeep`,
        ),
      ).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe("golden snapshot: complete output file tree", () => {
    it("personal-assistant: sorted created-path list matches snapshot", async () => {
      await personalize(BASE_ANSWERS, BASE_DIR, {
        profileTemplate: PROFILE_TEMPLATE,
        voiceStyleTemplate: VOICE_STYLE_TEMPLATE,
        starterProjectFiles: PERSONAL_ASSISTANT_FILES,
      });

      const writtenPaths = allWrittenPaths();

      // Normalise to paths relative to baseDir for a stable snapshot
      const relativePaths = writtenPaths
        .map((p) => p.replace(`${BASE_DIR}/`, ""))
        .sort();

      expect(relativePaths).toMatchSnapshot();
    });

    it("social-media: sorted created-path list matches snapshot", async () => {
      const answers: PersonalizationAnswers = {
        ...BASE_ANSWERS,
        starterProject: "social-media",
      };

      await personalize(answers, BASE_DIR, {
        profileTemplate: PROFILE_TEMPLATE,
        voiceStyleTemplate: VOICE_STYLE_TEMPLATE,
        starterProjectFiles: SOCIAL_MEDIA_FILES,
      });

      const relativePaths = allWrittenPaths()
        .map((p) => p.replace(`${BASE_DIR}/`, ""))
        .sort();

      expect(relativePaths).toMatchSnapshot();
    });

    it("code-worker: sorted created-path list matches snapshot", async () => {
      const answers: PersonalizationAnswers = {
        ...BASE_ANSWERS,
        starterProject: "code-worker",
      };

      await personalize(answers, BASE_DIR, {
        profileTemplate: PROFILE_TEMPLATE,
        voiceStyleTemplate: VOICE_STYLE_TEMPLATE,
        starterProjectFiles: CODE_WORKER_FILES,
      });

      const relativePaths = allWrittenPaths()
        .map((p) => p.replace(`${BASE_DIR}/`, ""))
        .sort();

      expect(relativePaths).toMatchSnapshot();
    });

    it("every written path is under baseDir (no path traversal)", async () => {
      await personalize(BASE_ANSWERS, BASE_DIR, {
        profileTemplate: PROFILE_TEMPLATE,
        voiceStyleTemplate: VOICE_STYLE_TEMPLATE,
        starterProjectFiles: PERSONAL_ASSISTANT_FILES,
      });

      const writtenPaths = allWrittenPaths();
      for (const p of writtenPaths) {
        expect(p).toMatch(new RegExp(`^${BASE_DIR.replace(/[/\\]/g, "\\$&")}`));
      }
    });
  });

  // -------------------------------------------------------------------------
  describe("existingSlugs dedupe (US-002)", () => {
    // The graft flow passes the set of company slugs already present at
    // `{baseDir}/companies/{slug}/`. The scaffold loop must skip mkdir + the
    // company.yaml write for any matching slug — without affecting other
    // companies in the same batch.

    it("writes every company when existingSlugs is empty (legacy behaviour)", async () => {
      await personalize(
        {
          ...BASE_ANSWERS,
          companies: [
            { name: "Acme Corp" },
            { name: "Globex" },
          ],
          existingSlugs: new Set<string>(),
        },
        BASE_DIR,
        {
          profileTemplate: PROFILE_TEMPLATE,
          voiceStyleTemplate: VOICE_STYLE_TEMPLATE,
          starterProjectFiles: PERSONAL_ASSISTANT_FILES,
        },
      );

      const paths = allWrittenPaths();
      // company.yaml written for BOTH
      expect(
        paths.some((p) => p === `${BASE_DIR}/companies/acme-corp/company.yaml`),
      ).toBe(true);
      expect(
        paths.some((p) => p === `${BASE_DIR}/companies/globex/company.yaml`),
      ).toBe(true);
    });

    it("skips ALL scaffold writes for a company whose slug is in existingSlugs", async () => {
      await personalize(
        {
          ...BASE_ANSWERS,
          companies: [{ name: "Indigo" }],
          existingSlugs: new Set(["indigo"]),
        },
        BASE_DIR,
        {
          profileTemplate: PROFILE_TEMPLATE,
          voiceStyleTemplate: VOICE_STYLE_TEMPLATE,
          starterProjectFiles: PERSONAL_ASSISTANT_FILES,
        },
      );

      const paths = allWrittenPaths();
      const mkdirPaths = mockMkdir.mock.calls.map((c) => c[0]);

      // No subdir mkdir under companies/indigo/
      expect(
        mkdirPaths.some((p) => p.startsWith(`${BASE_DIR}/companies/indigo`)),
      ).toBe(false);

      // No files written under companies/indigo/ — crucially, no company.yaml
      expect(
        paths.some((p) => p.startsWith(`${BASE_DIR}/companies/indigo/`)),
      ).toBe(false);
    });

    it("writes only non-existing companies in a mixed batch", async () => {
      await personalize(
        {
          ...BASE_ANSWERS,
          companies: [
            { name: "Indigo" }, // existing — should be skipped
            { name: "Acme Corp" }, // new — should be scaffolded
            { name: "Globex" }, // existing — should be skipped
            { name: "Initech" }, // new — should be scaffolded
          ],
          existingSlugs: new Set(["indigo", "globex"]),
        },
        BASE_DIR,
        {
          profileTemplate: PROFILE_TEMPLATE,
          voiceStyleTemplate: VOICE_STYLE_TEMPLATE,
          starterProjectFiles: PERSONAL_ASSISTANT_FILES,
        },
      );

      const paths = allWrittenPaths();

      // Existing companies — NO writes
      expect(
        paths.some((p) => p.startsWith(`${BASE_DIR}/companies/indigo/`)),
      ).toBe(false);
      expect(
        paths.some((p) => p.startsWith(`${BASE_DIR}/companies/globex/`)),
      ).toBe(false);

      // New companies — company.yaml written
      expect(
        paths.some((p) => p === `${BASE_DIR}/companies/acme-corp/company.yaml`),
      ).toBe(true);
      expect(
        paths.some((p) => p === `${BASE_DIR}/companies/initech/company.yaml`),
      ).toBe(true);
    });

    it("default (omitted existingSlugs) preserves pre-US-002 behaviour", async () => {
      // Callers that don't know about existingSlugs must still work — the
      // writer defaults to an empty set and scaffolds everything.
      await personalize(
        {
          ...BASE_ANSWERS,
          companies: [{ name: "Acme Corp" }],
          // existingSlugs intentionally omitted
        },
        BASE_DIR,
        {
          profileTemplate: PROFILE_TEMPLATE,
          voiceStyleTemplate: VOICE_STYLE_TEMPLATE,
          starterProjectFiles: PERSONAL_ASSISTANT_FILES,
        },
      );

      expect(
        allWrittenPaths().some(
          (p) => p === `${BASE_DIR}/companies/acme-corp/company.yaml`,
        ),
      ).toBe(true);
    });

    it("companies.length > 0 guard stays valid when every slug is existing", async () => {
      // Loop still runs but all iterations short-circuit — no fs writes
      // beyond the unrelated scaffolding (knowledge/, personal/, etc.).
      await personalize(
        {
          ...BASE_ANSWERS,
          companies: [{ name: "Indigo" }, { name: "Globex" }],
          existingSlugs: new Set(["indigo", "globex"]),
        },
        BASE_DIR,
        {
          profileTemplate: PROFILE_TEMPLATE,
          voiceStyleTemplate: VOICE_STYLE_TEMPLATE,
          starterProjectFiles: PERSONAL_ASSISTANT_FILES,
        },
      );

      // No paths under companies/indigo/ or companies/globex/
      const paths = allWrittenPaths();
      expect(
        paths.filter(
          (p) =>
            p.startsWith(`${BASE_DIR}/companies/indigo/`) ||
            p.startsWith(`${BASE_DIR}/companies/globex/`),
        ),
      ).toEqual([]);
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
        starterProjectFiles: PERSONAL_ASSISTANT_FILES,
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
        starterProjectFiles: PERSONAL_ASSISTANT_FILES,
      });

      expect(result).toBeUndefined();
    });

    it("propagates error if writeTextFile rejects", async () => {
      mockWriteTextFile.mockRejectedValueOnce(new Error("disk full"));

      await expect(
        personalize(BASE_ANSWERS, BASE_DIR, {
          profileTemplate: PROFILE_TEMPLATE,
          voiceStyleTemplate: VOICE_STYLE_TEMPLATE,
          starterProjectFiles: PERSONAL_ASSISTANT_FILES,
        }),
      ).rejects.toThrow("disk full");
    });

    it("propagates error if mkdir rejects", async () => {
      mockMkdir.mockRejectedValueOnce(new Error("permission denied"));

      await expect(
        personalize(BASE_ANSWERS, BASE_DIR, {
          profileTemplate: PROFILE_TEMPLATE,
          voiceStyleTemplate: VOICE_STYLE_TEMPLATE,
          starterProjectFiles: PERSONAL_ASSISTANT_FILES,
        }),
      ).rejects.toThrow("permission denied");
    });
  });
});
