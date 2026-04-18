import { describe, it, expect } from "vitest";
import { resolveLocalPath } from "../s3-sync.js";

// ---------------------------------------------------------------------------
// s3-sync.resolveLocalPath — path-mapping contract for company bucket sync
//
// Context:
//   Each company's S3 bucket is scaffolded by hq-onboarding so its root
//   mirrors `companies/{slug}/`. The installer must write each object under
//   `{installPath}/companies/{slug}/{key}` — NOT at `{installPath}/{key}`,
//   which would shadow the HQ's own top-level directories.
//
//   Pre-fix bug: `s3-sync.ts` built the local path as
//     `${installPath}/${relativePath}`
//   i.e. no subpath, so Indigo's `knowledge/interview.json` landed at
//   `{installPath}/knowledge/interview.json` and `companies/indigo/` was
//   never created. These tests lock the corrected behavior in place.
// ---------------------------------------------------------------------------

describe("resolveLocalPath", () => {
  // -------------------------------------------------------------------------
  describe("with destSubpath (the fix — company-scoped sync)", () => {
    it("lands bucket-root key under companies/{slug}/", () => {
      expect(
        resolveLocalPath("/home/u/hq", "knowledge/interview.json", "companies/indigo"),
      ).toBe("/home/u/hq/companies/indigo/knowledge/interview.json");
    });

    it("handles deep keys unchanged", () => {
      expect(
        resolveLocalPath(
          "/home/u/hq",
          "knowledge/subdir/file.md",
          "companies/acme",
        ),
      ).toBe("/home/u/hq/companies/acme/knowledge/subdir/file.md");
    });

    it("handles the dotfile at bucket root (.hq/manifest.json)", () => {
      expect(
        resolveLocalPath("/home/u/hq", ".hq/manifest.json", "companies/indigo"),
      ).toBe("/home/u/hq/companies/indigo/.hq/manifest.json");
    });

    it("trims trailing slashes on installPath", () => {
      expect(
        resolveLocalPath("/home/u/hq/", "knowledge/interview.json", "companies/indigo"),
      ).toBe("/home/u/hq/companies/indigo/knowledge/interview.json");
    });

    it("trims leading + trailing slashes on destSubpath", () => {
      expect(
        resolveLocalPath("/home/u/hq", "k.md", "/companies/indigo/"),
      ).toBe("/home/u/hq/companies/indigo/k.md");
    });
  });

  // -------------------------------------------------------------------------
  describe("without destSubpath (legacy / pre-fix behavior)", () => {
    // Kept as a compatibility surface so non-company syncs (future use) can
    // still target the HQ root directly by passing no subpath.
    it("lands keys directly under installPath", () => {
      expect(resolveLocalPath("/home/u/hq", "knowledge/interview.json")).toBe(
        "/home/u/hq/knowledge/interview.json",
      );
    });
  });

  // -------------------------------------------------------------------------
  describe("s3Prefix stripping", () => {
    // StsCredentials can carry an optional `prefix` (e.g. `indigo/`) that the
    // bucket uses to namespace objects. The helper must strip it before
    // building the local path so we don't create `{installPath}/indigo/...`.
    it("strips a matching prefix before resolving", () => {
      expect(
        resolveLocalPath(
          "/home/u/hq",
          "indigo/knowledge/interview.json",
          "companies/indigo",
          "indigo/",
        ),
      ).toBe("/home/u/hq/companies/indigo/knowledge/interview.json");
    });

    it("leaves the key alone when the prefix doesn't match", () => {
      expect(
        resolveLocalPath(
          "/home/u/hq",
          "knowledge/interview.json",
          "companies/indigo",
          "otherprefix/",
        ),
      ).toBe("/home/u/hq/companies/indigo/knowledge/interview.json");
    });
  });

  // -------------------------------------------------------------------------
  describe("safety — reject path-escape attempts", () => {
    // Defense in depth: a well-behaved bucket never produces these keys, but
    // we treat the bucket as untrusted input. Returning null lets the caller
    // skip the entry instead of aborting the whole sync.
    it("rejects a key containing `..`", () => {
      expect(
        resolveLocalPath("/home/u/hq", "../../etc/passwd", "companies/indigo"),
      ).toBeNull();
    });

    it("rejects a `..` segment mid-key", () => {
      expect(
        resolveLocalPath("/home/u/hq", "knowledge/../../etc/passwd", "companies/indigo"),
      ).toBeNull();
    });

    it("rejects a `.` segment (would resolve to the parent dir)", () => {
      expect(
        resolveLocalPath("/home/u/hq", "./interview.json", "companies/indigo"),
      ).toBeNull();
    });

    it("rejects an absolute key (leading slash)", () => {
      // After the leading `/` is not stripped as a prefix, the first segment
      // becomes empty string — which the segment check rejects.
      expect(
        resolveLocalPath("/home/u/hq", "/etc/passwd", "companies/indigo"),
      ).toBeNull();
    });

    it("rejects an empty key", () => {
      expect(
        resolveLocalPath("/home/u/hq", "", "companies/indigo"),
      ).toBeNull();
    });

    it("rejects a key containing only the prefix (empty after stripping)", () => {
      expect(
        resolveLocalPath("/home/u/hq", "indigo/", "companies/indigo", "indigo/"),
      ).toBeNull();
    });
  });
});
