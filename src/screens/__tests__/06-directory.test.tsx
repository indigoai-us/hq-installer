// 06-directory.test.tsx — US-001
// Silent local install step: ~/hq resolved automatically (no picker / name
// form), then the HQ core scaffold is fetched + extracted into it before the
// wizard advances. The scaffold-fetch assertions are the regression guard for
// the bug where the install step only created an empty ~/hq and skipped ahead.

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

// The scaffold fetcher is mocked so these unit tests never touch the network;
// the regression assertions below verify the install step *calls* it correctly.
vi.mock("@/lib/template-fetcher", () => ({
  fetchAndExtract: vi.fn().mockResolvedValue({ version: "v-test" }),
  TemplateFetchError: class TemplateFetchError extends Error {},
}));

import { invoke } from "@tauri-apps/api/core";
import { fetchAndExtract } from "@/lib/template-fetcher";
const mockInvoke = vi.mocked(invoke);
const mockFetch = vi.mocked(fetchAndExtract);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupInvokeMock({
  resolvedPath = "/Users/test/hq",
  shouldFail = false,
  failMessage = "Failed to create ~/hq",
  useStaging = false,
}: {
  resolvedPath?: string;
  shouldFail?: boolean;
  failMessage?: string;
  useStaging?: boolean;
} = {}) {
  mockInvoke.mockImplementation(async (command: string): Promise<unknown> => {
    if (command === "resolve_hq_path") {
      if (shouldFail) throw new Error(failMessage);
      return resolvedPath;
    }
    if (command === "get_use_staging_source") return useStaging;
    return null;
  });
}

// ---------------------------------------------------------------------------

describe("DirectoryPicker (06-directory.tsx) — US-001 silent install", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupInvokeMock();
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ version: "v-test" });
  });

  // -------------------------------------------------------------------------
  describe("auto-resolution on mount", () => {
    it("calls invoke('resolve_hq_path') automatically with no user interaction", async () => {
      render(<DirectoryPicker onNext={vi.fn()} />);
      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith("resolve_hq_path");
      });
    });

    it("calls onNext automatically after the scaffold is installed", async () => {
      const onNext = vi.fn();
      setupInvokeMock({ resolvedPath: "/Users/test/hq" });
      render(<DirectoryPicker onNext={onNext} />);
      await waitFor(() => {
        expect(onNext).toHaveBeenCalledTimes(1);
      });
    });

    it("does NOT require any user input before advancing", async () => {
      const onNext = vi.fn();
      render(<DirectoryPicker onNext={onNext} />);
      // onNext fires without any click/fill/interaction.
      await waitFor(() => {
        expect(onNext).toHaveBeenCalled();
      });
    });
  });

  // -------------------------------------------------------------------------
  // REGRESSION: the install step must actually lay the HQ tree, not just mkdir.
  describe("scaffold install (regression: empty ~/hq bug)", () => {
    it("fetches + extracts the hq-core scaffold into the resolved ~/hq", async () => {
      setupInvokeMock({ resolvedPath: "/Users/test/hq" });
      render(<DirectoryPicker onNext={vi.fn()} />);
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
      // First positional arg is the extraction targetDir — must be the ~/hq path.
      expect(mockFetch.mock.calls[0][0]).toBe("/Users/test/hq");
    });

    it("does NOT advance until the scaffold finishes extracting", async () => {
      // Hold the fetch open so we can assert the wizard is blocked on it.
      let resolveFetch!: (v: { version: string }) => void;
      mockFetch.mockImplementation(
        () =>
          new Promise((res) => {
            resolveFetch = res;
          }),
      );
      const onNext = vi.fn();
      render(<DirectoryPicker onNext={onNext} />);
      await waitFor(() => expect(mockFetch).toHaveBeenCalled());
      // Scaffold still extracting → must not have advanced.
      expect(onNext).not.toHaveBeenCalled();
      // A progress bar is shown while installing.
      expect(screen.queryByRole("progressbar")).not.toBeNull();
      resolveFetch({ version: "v15.0.0" });
      await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
    });

    it("uses staging source without requesting a GitHub token in the renderer", async () => {
      setupInvokeMock({ useStaging: true });
      render(<DirectoryPicker onNext={vi.fn()} />);
      await waitFor(() => expect(mockFetch).toHaveBeenCalled());
      // 5th positional arg is the TemplateSource override.
      expect(mockFetch.mock.calls[0][4]).toEqual({
        repo: "indigoai-us/hq-core-staging",
        ref: "main",
      });
      expect(mockInvoke).not.toHaveBeenCalledWith("get_github_token");
    });

    it("defaults to the stable hq-core release (no source override) when staging is off", async () => {
      setupInvokeMock({ useStaging: false });
      render(<DirectoryPicker onNext={vi.fn()} />);
      await waitFor(() => expect(mockFetch).toHaveBeenCalled());
      expect(mockFetch.mock.calls[0][4]).toBeUndefined();
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

    it("renders an 'Installing HQ' progress bar while the scaffold downloads", async () => {
      let resolveFetch!: (v: { version: string }) => void;
      mockFetch.mockImplementation(
        () =>
          new Promise((res) => {
            resolveFetch = res;
          }),
      );
      render(<DirectoryPicker onNext={vi.fn()} />);
      await waitFor(() =>
        expect(screen.queryByText(/installing hq/i)).not.toBeNull(),
      );
      expect(screen.queryByRole("progressbar")).not.toBeNull();
      resolveFetch({ version: "v1" });
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

    it("shows an error and does NOT advance when scaffold extraction fails", async () => {
      mockFetch.mockRejectedValue(new Error("network down"));
      const onNext = vi.fn();
      render(<DirectoryPicker onNext={onNext} />);
      await waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text.toLowerCase()).toContain("network down");
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
