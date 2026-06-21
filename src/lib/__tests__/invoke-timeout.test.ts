import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { invokeWithTimeout, TimeoutError } from "../invoke-timeout.js";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const mockInvoke = vi.mocked(invoke);

describe("invokeWithTimeout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects with TimeoutError when invoke never resolves", async () => {
    vi.useFakeTimers();
    mockInvoke.mockReturnValue(new Promise(() => {}));

    try {
      const pending = invokeWithTimeout("check_ai_tools", undefined, 25).catch(
        (err: unknown) => err,
      );
      await vi.advanceTimersByTimeAsync(25);
      const err = await pending;
      expect(err).toBeInstanceOf(TimeoutError);
      expect(err).toMatchObject({
        command: "check_ai_tools",
        ms: 25,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
