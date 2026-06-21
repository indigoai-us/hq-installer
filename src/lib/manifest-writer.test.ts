import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock root-validated install fs helpers BEFORE importing the module under test
// ---------------------------------------------------------------------------

const mockReadInstallTextFile = vi.fn();
const mockWriteInstallTextFile = vi.fn();

vi.mock("./install-fs", () => ({
  readInstallTextFile: (...args: unknown[]) => mockReadInstallTextFile(...args),
  writeInstallTextFile: (...args: unknown[]) => mockWriteInstallTextFile(...args),
}));

// ---------------------------------------------------------------------------
// Import module under test AFTER mocks are registered
// ---------------------------------------------------------------------------

import {
  ensureManifestEntries,
  mergeManifestEntries,
} from "./manifest-writer.js";
import { parse } from "yaml";

// ---------------------------------------------------------------------------
// Pure logic — mergeManifestEntries
// ---------------------------------------------------------------------------

describe("mergeManifestEntries", () => {
  it("adds an entry when slug is new", () => {
    const { manifest, result } = mergeManifestEntries(
      { companies: { personal: { name: "Personal" } } },
      [{ slug: "indigo", name: "Indigo" }],
    );
    expect(result.added).toEqual(["indigo"]);
    expect(result.skipped).toEqual([]);
    expect(manifest.companies?.indigo).toMatchObject({
      name: "Indigo",
      goal: "",
      path: "companies/indigo",
      sources: [],
      repos: [],
      knowledge: "companies/indigo/knowledge/",
      qmd_collections: ["indigo"],
    });
  });

  it("skips slugs that already exist (never overwrites)", () => {
    const { manifest, result } = mergeManifestEntries(
      {
        companies: {
          indigo: { name: "Existing Indigo", custom_field: "preserved" },
        },
      },
      [{ slug: "indigo", name: "Replacement Indigo", cloudUid: "cmp_x" }],
    );
    expect(result.added).toEqual([]);
    expect(result.skipped).toEqual(["indigo"]);
    expect(manifest.companies?.indigo).toEqual({
      name: "Existing Indigo",
      custom_field: "preserved",
    });
  });

  it("includes cloud_uid and bucket_name when supplied", () => {
    const { manifest } = mergeManifestEntries({ companies: {} }, [
      {
        slug: "voyage",
        name: "Voyage",
        cloudUid: "cmp_01ABC",
        bucketName: "hq-vault-cmp-01abc",
      },
    ]);
    expect(manifest.companies?.voyage).toMatchObject({
      cloud_uid: "cmp_01ABC",
      bucket_name: "hq-vault-cmp-01abc",
    });
  });

  it("omits cloud fields when not supplied", () => {
    const { manifest } = mergeManifestEntries({ companies: {} }, [
      { slug: "local-only", name: "Local Only" },
    ]);
    expect(manifest.companies?.["local-only"]).not.toHaveProperty("cloud_uid");
    expect(manifest.companies?.["local-only"]).not.toHaveProperty(
      "bucket_name",
    );
  });

  it("creates `companies` map when manifest has none", () => {
    const { manifest, result } = mergeManifestEntries({}, [
      { slug: "fresh", name: "Fresh" },
    ]);
    expect(result.added).toEqual(["fresh"]);
    expect(manifest.companies?.fresh).toBeDefined();
  });

  it("skips empty slugs without erroring", () => {
    const { result } = mergeManifestEntries({ companies: {} }, [
      { slug: "  ", name: "Whitespace" },
      { slug: "", name: "Empty" },
    ]);
    expect(result.added).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("handles a mix of new and existing slugs in one call", () => {
    const { result } = mergeManifestEntries(
      { companies: { personal: { name: "Personal" } } },
      [
        { slug: "personal", name: "Personal" },
        { slug: "new-co", name: "New Co" },
      ],
    );
    expect(result.added).toEqual(["new-co"]);
    expect(result.skipped).toEqual(["personal"]);
  });
});

// ---------------------------------------------------------------------------
// Filesystem integration — ensureManifestEntries
// ---------------------------------------------------------------------------

describe("ensureManifestEntries", () => {
  beforeEach(() => {
    mockReadInstallTextFile.mockReset();
    mockWriteInstallTextFile.mockReset();
  });

  it("creates manifest from scratch when file is missing", async () => {
    mockReadInstallTextFile.mockRejectedValue(new Error("ENOENT"));
    mockWriteInstallTextFile.mockResolvedValue(undefined);

    const result = await ensureManifestEntries("/hq", [
      { slug: "indigo", name: "Indigo" },
    ]);

    expect(result.added).toEqual(["indigo"]);
    expect(mockWriteInstallTextFile).toHaveBeenCalledTimes(1);
    expect(mockWriteInstallTextFile).toHaveBeenCalledWith(
      "/hq",
      "/hq/companies/manifest.yaml",
      expect.any(String),
    );

    const [, , written] = mockWriteInstallTextFile.mock.calls[0];
    const parsed = parse(written as string) as {
      companies: Record<string, unknown>;
    };
    expect(parsed.companies.indigo).toBeDefined();
  });

  it("appends to existing manifest preserving prior entries", async () => {
    const existing = `companies:
  personal:
    name: Personal
    goal: ""
    path: companies/personal
    sources: []
    repos: []
    knowledge: companies/personal/knowledge/
    qmd_collections:
      - personal
`;
    mockReadInstallTextFile.mockResolvedValue(existing);
    mockWriteInstallTextFile.mockResolvedValue(undefined);

    const result = await ensureManifestEntries("/hq", [
      { slug: "voyage", name: "Voyage", cloudUid: "cmp_x", bucketName: "b" },
    ]);

    expect(result.added).toEqual(["voyage"]);
    const [, , written] = mockWriteInstallTextFile.mock.calls[0];
    const parsed = parse(written as string) as {
      companies: Record<string, { name: string; cloud_uid?: string }>;
    };
    expect(parsed.companies.personal.name).toBe("Personal");
    expect(parsed.companies.voyage.cloud_uid).toBe("cmp_x");
  });

  it("is idempotent — re-running with same seeds is a no-op write", async () => {
    const existing = `companies:
  indigo:
    name: Indigo
    path: companies/indigo
`;
    mockReadInstallTextFile.mockResolvedValue(existing);

    const result = await ensureManifestEntries("/hq", [
      { slug: "indigo", name: "Should Not Replace" },
    ]);

    expect(result.added).toEqual([]);
    expect(result.skipped).toEqual(["indigo"]);
    expect(mockWriteInstallTextFile).not.toHaveBeenCalled();
  });

  it("is a no-op when seeds is empty", async () => {
    await ensureManifestEntries("/hq", []);
    expect(mockReadInstallTextFile).not.toHaveBeenCalled();
    expect(mockWriteInstallTextFile).not.toHaveBeenCalled();
  });

  it("recovers from malformed root by treating manifest as empty", async () => {
    mockReadInstallTextFile.mockResolvedValue("- not\n- a\n- mapping\n");
    mockWriteInstallTextFile.mockResolvedValue(undefined);

    const result = await ensureManifestEntries("/hq", [
      { slug: "fresh", name: "Fresh" },
    ]);

    expect(result.added).toEqual(["fresh"]);
    const [, , written] = mockWriteInstallTextFile.mock.calls[0];
    const parsed = parse(written as string) as {
      companies: Record<string, unknown>;
    };
    expect(parsed.companies.fresh).toBeDefined();
  });
});
