// hq-detect.test.ts — US-015

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// hq-detect lib tests (US-015)
//
// These tests are written BEFORE the implementation exists.
// They will fail until src/lib/hq-detect.ts is created.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tauri API mocks — must be declared before module under test is imported
// ---------------------------------------------------------------------------
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { detectHq } from "../hq-detect.js";

const mockInvoke = vi.mocked(invoke);

// ---------------------------------------------------------------------------

describe("hq-detect (hq-detect.ts)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  describe("detectHq() — basic contract", () => {
    it("is exported as a function", () => {
      expect(typeof detectHq).toBe("function");
    });

    it("returns a Promise", () => {
      mockInvoke.mockResolvedValue({ exists: false, isHq: false });
      const result = detectHq("/some/path");
      expect(result).toBeInstanceOf(Promise);
    });

    it("calls invoke('detect_hq', { path }) with the provided path", async () => {
      mockInvoke.mockResolvedValue({ exists: true, isHq: false });
      await detectHq("/Users/test/mydir");
      expect(mockInvoke).toHaveBeenCalledTimes(1);
      expect(mockInvoke).toHaveBeenCalledWith("detect_hq", { path: "/Users/test/mydir" });
    });

    it("passes the exact path string through to invoke", async () => {
      mockInvoke.mockResolvedValue({ exists: false, isHq: false });
      const path = "/some/deeply/nested/path/to/hq";
      await detectHq(path);
      const [, args] = mockInvoke.mock.calls[0];
      expect((args as Record<string, string>).path).toBe(path);
    });
  });

  // -------------------------------------------------------------------------
  describe("detectHq() — new directory (no HQ)", () => {
    it("returns { exists: false, isHq: false } when detect_hq returns that result", async () => {
      mockInvoke.mockResolvedValue({ exists: false, isHq: false });
      const result = await detectHq("/Users/test/newdir");
      expect(result.exists).toBe(false);
      expect(result.isHq).toBe(false);
    });

    it("returns { exists: true, isHq: false } for existing dir with no HQ markers", async () => {
      mockInvoke.mockResolvedValue({ exists: true, isHq: false });
      const result = await detectHq("/Users/test/somedir");
      expect(result.exists).toBe(true);
      expect(result.isHq).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe("detectHq() — existing HQ directory", () => {
    it("returns { exists: true, isHq: true } when detect_hq reports an HQ installation", async () => {
      mockInvoke.mockResolvedValue({ exists: true, isHq: true });
      const result = await detectHq("/Users/test/hq");
      expect(result.exists).toBe(true);
      expect(result.isHq).toBe(true);
    });

    it("return value shape always has both 'exists' and 'isHq' keys", async () => {
      mockInvoke.mockResolvedValue({ exists: true, isHq: true });
      const result = await detectHq("/Users/test/hq");
      expect("exists" in result).toBe(true);
      expect("isHq" in result).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe("detectHq() — error propagation", () => {
    it("rejects (throws) when invoke('detect_hq') rejects", async () => {
      mockInvoke.mockRejectedValue(new Error("permission denied"));
      await expect(detectHq("/restricted/path")).rejects.toThrow();
    });

    it("does NOT swallow errors — callers can catch them", async () => {
      const expectedError = new Error("Tauri command error");
      mockInvoke.mockRejectedValue(expectedError);
      let caught: Error | null = null;
      try {
        await detectHq("/some/path");
      } catch (err) {
        caught = err as Error;
      }
      expect(caught).not.toBeNull();
      expect(caught!.message).toBe("Tauri command error");
    });
  });

  // -------------------------------------------------------------------------
  describe("detectHq() — passthrough fidelity", () => {
    it("returns exactly what invoke returns (no transformation of the result)", async () => {
      const raw = { exists: true, isHq: true };
      mockInvoke.mockResolvedValue(raw);
      const result = await detectHq("/Users/test/hq");
      // Both fields must match exactly
      expect(result.exists).toBe(raw.exists);
      expect(result.isHq).toBe(raw.isHq);
    });

    it("only calls invoke once per detectHq() call (no extra pings)", async () => {
      mockInvoke.mockResolvedValue({ exists: false, isHq: false });
      await detectHq("/some/path");
      expect(mockInvoke).toHaveBeenCalledTimes(1);
    });

    it("does not call invoke on module import — only on detectHq() invocation", () => {
      // invoke should NOT have been called just from importing the module
      expect(mockInvoke).not.toHaveBeenCalled();
    });
  });
});
