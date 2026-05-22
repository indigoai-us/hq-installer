import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// pack-registry tests
//
// `fetchAvailablePacks` enumerates the hq-packages catalog via the GitHub API
// (through `@tauri-apps/plugin-http`); `readRecommendedPackIds` parses the
// extracted core.yaml. Both Tauri plugins are mocked so the suite runs with
// no network or filesystem.
// ---------------------------------------------------------------------------

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readTextFile: vi.fn() }));

import { fetch } from "@tauri-apps/plugin-http";
import { readTextFile } from "@tauri-apps/plugin-fs";
import {
  fetchAvailablePacks,
  readRecommendedPackIds,
  FALLBACK_PACKS,
  PackRegistryError,
} from "../pack-registry";

const mockFetch = vi.mocked(fetch);
const mockReadTextFile = vi.mocked(readTextFile);

/** Minimal Response-like stub — only the members pack-registry touches. */
function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}
function textResponse(body: string, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => JSON.parse(body),
    text: async () => body,
  } as unknown as Response;
}

describe("pack-registry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("fetchAvailablePacks", () => {
    it("enumerates hq-pack-* dirs and parses each package.yaml", async () => {
      mockFetch.mockImplementation(async (url) => {
        const u = String(url);
        if (u.endsWith("/contents/packages")) {
          return jsonResponse([
            { name: "hq-pack-beta", type: "dir" },
            { name: "hq-pack-alpha", type: "dir" },
            { name: "README.md", type: "file" },
            { name: "scripts", type: "dir" },
          ]);
        }
        if (u.includes("/hq-pack-alpha/package.yaml")) {
          return textResponse("name: hq-pack-alpha\ndescription: Alpha pack.\n");
        }
        if (u.includes("/hq-pack-beta/package.yaml")) {
          return textResponse("name: hq-pack-beta\ndescription: Beta pack.\n");
        }
        throw new Error(`unexpected url ${u}`);
      });

      const packs = await fetchAvailablePacks();

      // `scripts` is dropped (not hq-pack-*), README.md dropped (not a dir),
      // and the result is sorted by dir name.
      expect(packs.map((p) => p.dir)).toEqual([
        "hq-pack-alpha",
        "hq-pack-beta",
      ]);
      expect(packs[0]).toEqual({
        dir: "hq-pack-alpha",
        name: "hq-pack-alpha",
        description: "Alpha pack.",
        source: "github:indigoai-us/hq-packages#packages/hq-pack-alpha",
      });
    });

    it("drops a pack whose package.yaml can't be read", async () => {
      mockFetch.mockImplementation(async (url) => {
        const u = String(url);
        if (u.endsWith("/contents/packages")) {
          return jsonResponse([
            { name: "hq-pack-alpha", type: "dir" },
            { name: "hq-pack-broken", type: "dir" },
          ]);
        }
        if (u.includes("/hq-pack-alpha/package.yaml")) {
          return textResponse("name: hq-pack-alpha\ndescription: Alpha.\n");
        }
        return jsonResponse(null, false, 404);
      });

      const packs = await fetchAvailablePacks();
      expect(packs.map((p) => p.dir)).toEqual(["hq-pack-alpha"]);
    });

    it("throws PackRegistryError when the catalog listing fails", async () => {
      mockFetch.mockResolvedValue(jsonResponse(null, false, 403));
      await expect(fetchAvailablePacks()).rejects.toBeInstanceOf(
        PackRegistryError,
      );
    });

    it("throws PackRegistryError on a network error", async () => {
      mockFetch.mockRejectedValue(new Error("offline"));
      await expect(fetchAvailablePacks()).rejects.toBeInstanceOf(
        PackRegistryError,
      );
    });
  });

  describe("readRecommendedPackIds", () => {
    it("extracts hq-pack-* tokens from recommended_packages sources", async () => {
      mockReadTextFile.mockResolvedValue(
        [
          "version: 1",
          "recommended_packages:",
          "  - source: 'github:indigoai-us/hq-packages#packages/hq-pack-design-styles'",
          "  - source: '@indigoai-us/hq-pack-gemini'",
          "  - source: 'github:indigoai-us/hq#core/packages/hq-pack-gstack'",
        ].join("\n"),
      );

      const ids = await readRecommendedPackIds("/tmp/hq");
      expect([...ids].sort()).toEqual([
        "hq-pack-design-styles",
        "hq-pack-gemini",
        "hq-pack-gstack",
      ]);
    });

    it("returns an empty set when core.yaml can't be read", async () => {
      mockReadTextFile.mockRejectedValue(new Error("ENOENT"));
      const ids = await readRecommendedPackIds("/tmp/hq");
      expect(ids.size).toBe(0);
    });

    it("returns an empty set for an empty targetDir without reading", async () => {
      const ids = await readRecommendedPackIds("");
      expect(ids.size).toBe(0);
      expect(mockReadTextFile).not.toHaveBeenCalled();
    });
  });

  describe("FALLBACK_PACKS", () => {
    it("lists the four core add-on packs with github sources", () => {
      expect(FALLBACK_PACKS).toHaveLength(4);
      for (const p of FALLBACK_PACKS) {
        expect(p.source).toMatch(
          /^github:indigoai-us\/hq-packages#packages\/hq-pack-/,
        );
      }
    });
  });
});
