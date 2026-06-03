// 06-directory.test.tsx — US-001
// Silent local install step: ~/hq resolved automatically, no picker or name form.

import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { DirectoryPicker } from "../06-directory.js";

// ---------------------------------------------------------------------------
// Tauri API mocks
// ---------------------------------------------------------------------------
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-shell", () => ({
  open: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  readTextFile: vi.fn().mockRejectedValue(new Error("not found")),
  writeTextFile: vi.fn().mockResolvedValue(undefined),
  exists: vi.fn().mockResolvedValue(false),
}));
vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn().mockResolvedValue("test"),
}));
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
}));

import { invoke } from "@tauri-apps/api/core";
const mockInvoke = vi.mocked(invoke);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupInvokeMock({
  resolvedPath = "/Users/test/hq",
  shouldFail = false,
  failMessage = "Failed to create ~/hq",
}: {
  resolvedPath?: string;
  shouldFail?: boolean;
  failMessage?: string;
} = {}) {
  mockInvoke.mockImplementation(async (command: string): Promise<unknown> => {
    if (command === "resolve_hq_path") {
      if (shouldFail) throw new Error(failMessage);
      return resolvedPath;
    }
    return null;
  });
}

// ---------------------------------------------------------------------------

describe("DirectoryPicker (06-directory.tsx) — US-001 silent install", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupInvokeMock();
  });

  // -------------------------------------------------------------------------
  describe("auto-resolution on mount", () => {
    it("calls invoke('resolve_hq_path') automatically with no user interaction", async () => {
      render(<DirectoryPicker onNext={vi.fn()} />);
      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith("resolve_hq_path");
      });
    });

    it("calls onNext automatically after ~/hq is resolved", async () => {
      const onNext = vi.fn();
      setupInvokeMock({ resolvedPath: "/Users/test/hq" });
      render(<DirectoryPicker onNext={onNext} />);
      await waitFor(() => {
        expect(onNext).toHaveBeenCalledTimes(1);
      });
    });

    it("does NOT require any user input before calling onNext", async () => {
      const onNext = vi.fn();
      render(<DirectoryPicker onNext={onNext} />);
      // onNext fires without any click/fill/interaction.
      await waitFor(() => {
        expect(onNext).toHaveBeenCalled();
      });
    });
  });

  // -------------------------------------------------------------------------
  describe("no interactive controls rendered", () => {
    it("does NOT render a folder picker / 'Choose location' button", () => {
      render(<DirectoryPicker onNext={vi.fn()} />);
      const btn =
        screen.queryByRole("button", { name: /choose location/i }) ??
        screen.queryByRole("button", { name: /choose folder/i });
      expect(btn).toBeNull();
    });

    it("does NOT render a folder name input", () => {
      render(<DirectoryPicker onNext={vi.fn()} />);
      const input = screen.queryByRole("textbox");
      expect(input).toBeNull();
    });

    it("does NOT render Graft / Overwrite prompt buttons", async () => {
      render(<DirectoryPicker onNext={vi.fn()} />);
      // Wait long enough for the async effect to complete.
      await waitFor(() => expect(mockInvoke).toHaveBeenCalled());
      expect(screen.queryByRole("button", { name: /graft/i })).toBeNull();
      expect(screen.queryByRole("button", { name: /overwrite/i })).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe("progress indicator", () => {
    it("renders a heading about preparing HQ before resolution completes", () => {
      // Never resolve so the spinner stays visible.
      mockInvoke.mockImplementation(() => new Promise(() => {}));
      render(<DirectoryPicker onNext={vi.fn()} />);
      const heading = screen.queryByText(/preparing hq/i);
      expect(heading).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe("error handling", () => {
    it("shows an error message when resolve_hq_path fails", async () => {
      setupInvokeMock({ shouldFail: true, failMessage: "permission denied" });
      render(<DirectoryPicker onNext={vi.fn()} />);
      await waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text.toLowerCase()).toContain("permission denied");
      });
    });

    it("does NOT call onNext when resolve_hq_path fails", async () => {
      const onNext = vi.fn();
      setupInvokeMock({ shouldFail: true });
      render(<DirectoryPicker onNext={onNext} />);
      await waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text.toLowerCase()).toContain("setup failed");
      });
      expect(onNext).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  describe("UI policy — no-purple-monochrome-ui", () => {
    it("does NOT use 'purple' class names in the DOM", () => {
      const { container } = render(<DirectoryPicker onNext={vi.fn()} />);
      expect(container.innerHTML).not.toMatch(/\bpurple\b/);
    });

    it("does NOT use 'indigo' class names in the DOM", () => {
      const { container } = render(<DirectoryPicker onNext={vi.fn()} />);
      expect(container.innerHTML).not.toMatch(/\bindigo\b/);
    });
  });

  // -------------------------------------------------------------------------
  describe("Tauri environment compatibility", () => {
    it("renders cleanly when Tauri APIs are mocked", () => {
      expect(() => {
        render(<DirectoryPicker onNext={vi.fn()} />);
      }).not.toThrow();
    });
  });
});
