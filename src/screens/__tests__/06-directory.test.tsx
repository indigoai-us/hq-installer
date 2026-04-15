// 06-directory.test.tsx — US-015

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { DirectoryPicker } from "../06-directory.js";

// ---------------------------------------------------------------------------
// DirectoryPicker screen tests (US-015)
//
// These tests are written BEFORE the implementation exists.
// They will fail until src/screens/06-directory.tsx is created.
// ---------------------------------------------------------------------------

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

import { invoke } from "@tauri-apps/api/core";
const mockInvoke = vi.mocked(invoke);

// ---------------------------------------------------------------------------
// Default invoke behaviour: pick_directory returns ~/hq, detect_hq returns no HQ
// ---------------------------------------------------------------------------
function setupInvokeMock({
  pickedPath = "/Users/test/hq",
  detectResult = { exists: true, isHq: false },
}: {
  pickedPath?: string | null;
  detectResult?: { exists: boolean; isHq: boolean };
} = {}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockInvoke.mockImplementation(async (command: string): Promise<any> => {
    if (command === "pick_directory") return pickedPath;
    if (command === "detect_hq") return detectResult;
    return null;
  });
}

// ---------------------------------------------------------------------------

describe("DirectoryPicker screen (06-directory.tsx)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupInvokeMock();
  });

  // -------------------------------------------------------------------------
  describe("initial render", () => {
    it("renders a 'Choose folder' button", () => {
      render(<DirectoryPicker onNext={vi.fn()} />);
      const btn =
        screen.queryByRole("button", { name: /choose folder/i }) ||
        screen.queryByRole("button", { name: /browse/i }) ||
        screen.queryByRole("button", { name: /select folder/i }) ||
        screen.queryByRole("button", { name: /pick folder/i });
      expect(btn).not.toBeNull();
    });

    it("does NOT show a Continue button before a directory is selected", () => {
      render(<DirectoryPicker onNext={vi.fn()} />);
      const continueBtn =
        screen.queryByRole("button", { name: /continue/i }) ||
        screen.queryByRole("button", { name: /next/i });
      if (continueBtn) {
        expect((continueBtn as HTMLButtonElement).disabled).toBe(true);
      }
    });

    it("does NOT call onNext on initial render", () => {
      const onNext = vi.fn();
      render(<DirectoryPicker onNext={onNext} />);
      expect(onNext).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  describe("folder picker invocation", () => {
    it("clicking 'Choose folder' calls invoke('pick_directory', { defaultPath: '~/hq' })", async () => {
      const user = userEvent.setup();
      render(<DirectoryPicker onNext={vi.fn()} />);

      const btn =
        screen.queryByRole("button", { name: /choose folder/i }) ||
        screen.queryByRole("button", { name: /browse/i }) ||
        screen.queryByRole("button", { name: /select folder/i }) ||
        screen.queryByRole("button", { name: /pick folder/i });
      expect(btn).not.toBeNull();

      await user.click(btn!);

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith("pick_directory", {
          defaultPath: "~/hq",
        });
      });
    });

    it("displays the selected directory path after pick_directory resolves", async () => {
      const user = userEvent.setup();
      setupInvokeMock({ pickedPath: "/Users/test/hq" });
      render(<DirectoryPicker onNext={vi.fn()} />);

      const btn =
        screen.queryByRole("button", { name: /choose folder/i }) ||
        screen.queryByRole("button", { name: /browse/i }) ||
        screen.queryByRole("button", { name: /select folder/i }) ||
        screen.queryByRole("button", { name: /pick folder/i });
      await user.click(btn!);

      await waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("/Users/test/hq");
      });
    });

    it("calls invoke('detect_hq', { path }) after a directory is picked", async () => {
      const user = userEvent.setup();
      setupInvokeMock({ pickedPath: "/Users/test/hq" });
      render(<DirectoryPicker onNext={vi.fn()} />);

      const btn =
        screen.queryByRole("button", { name: /choose folder/i }) ||
        screen.queryByRole("button", { name: /browse/i }) ||
        screen.queryByRole("button", { name: /select folder/i }) ||
        screen.queryByRole("button", { name: /pick folder/i });
      await user.click(btn!);

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith("detect_hq", {
          path: "/Users/test/hq",
        });
      });
    });

    it("does nothing when pick_directory returns null (user cancelled)", async () => {
      const user = userEvent.setup();
      setupInvokeMock({ pickedPath: null });
      render(<DirectoryPicker onNext={vi.fn()} />);

      const btn =
        screen.queryByRole("button", { name: /choose folder/i }) ||
        screen.queryByRole("button", { name: /browse/i }) ||
        screen.queryByRole("button", { name: /select folder/i }) ||
        screen.queryByRole("button", { name: /pick folder/i });
      await user.click(btn!);

      // detect_hq must NOT be called when path is null
      await new Promise((r) => setTimeout(r, 50));
      const detectCall = mockInvoke.mock.calls.find(([cmd]) => cmd === "detect_hq");
      expect(detectCall).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  describe("new directory path (no existing HQ)", () => {
    it("shows a 'New directory' message when detect_hq returns isHq: false", async () => {
      const user = userEvent.setup();
      setupInvokeMock({
        pickedPath: "/Users/test/hq",
        detectResult: { exists: false, isHq: false },
      });
      render(<DirectoryPicker onNext={vi.fn()} />);

      const btn =
        screen.queryByRole("button", { name: /choose folder/i }) ||
        screen.queryByRole("button", { name: /browse/i }) ||
        screen.queryByRole("button", { name: /select folder/i }) ||
        screen.queryByRole("button", { name: /pick folder/i });
      await user.click(btn!);

      await waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text.toLowerCase()).toMatch(/new directory|fresh install|no existing hq/i);
      });
    });

    it("shows a Continue button for a new directory after selection", async () => {
      const user = userEvent.setup();
      setupInvokeMock({
        pickedPath: "/Users/test/hq",
        detectResult: { exists: false, isHq: false },
      });
      render(<DirectoryPicker onNext={vi.fn()} />);

      const btn =
        screen.queryByRole("button", { name: /choose folder/i }) ||
        screen.queryByRole("button", { name: /browse/i }) ||
        screen.queryByRole("button", { name: /select folder/i }) ||
        screen.queryByRole("button", { name: /pick folder/i });
      await user.click(btn!);

      await waitFor(() => {
        const continueBtn =
          screen.queryByRole("button", { name: /continue/i }) ||
          screen.queryByRole("button", { name: /next/i });
        expect(continueBtn).not.toBeNull();
        expect((continueBtn as HTMLButtonElement).disabled).toBe(false);
      });
    });

    it("clicking Continue on a new directory calls onNext()", async () => {
      const user = userEvent.setup();
      const onNext = vi.fn();
      setupInvokeMock({
        pickedPath: "/Users/test/hq",
        detectResult: { exists: false, isHq: false },
      });
      render(<DirectoryPicker onNext={onNext} />);

      const btn =
        screen.queryByRole("button", { name: /choose folder/i }) ||
        screen.queryByRole("button", { name: /browse/i }) ||
        screen.queryByRole("button", { name: /select folder/i }) ||
        screen.queryByRole("button", { name: /pick folder/i });
      await user.click(btn!);

      const continueBtn = await waitFor(() => {
        const b =
          screen.queryByRole("button", { name: /continue/i }) ||
          screen.queryByRole("button", { name: /next/i });
        expect(b).not.toBeNull();
        return b!;
      });

      await user.click(continueBtn);
      expect(onNext).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  describe("existing HQ detection — graft or overwrite", () => {
    it("shows 'Existing HQ detected' when detect_hq returns isHq: true", async () => {
      const user = userEvent.setup();
      setupInvokeMock({
        pickedPath: "/Users/test/existing-hq",
        detectResult: { exists: true, isHq: true },
      });
      render(<DirectoryPicker onNext={vi.fn()} />);

      const btn =
        screen.queryByRole("button", { name: /choose folder/i }) ||
        screen.queryByRole("button", { name: /browse/i }) ||
        screen.queryByRole("button", { name: /select folder/i }) ||
        screen.queryByRole("button", { name: /pick folder/i });
      await user.click(btn!);

      await waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text.toLowerCase()).toMatch(/existing hq detected|existing hq found/i);
      });
    });

    it("shows a 'Graft' button when existing HQ is detected", async () => {
      const user = userEvent.setup();
      setupInvokeMock({
        pickedPath: "/Users/test/existing-hq",
        detectResult: { exists: true, isHq: true },
      });
      render(<DirectoryPicker onNext={vi.fn()} />);

      const btn =
        screen.queryByRole("button", { name: /choose folder/i }) ||
        screen.queryByRole("button", { name: /browse/i }) ||
        screen.queryByRole("button", { name: /select folder/i }) ||
        screen.queryByRole("button", { name: /pick folder/i });
      await user.click(btn!);

      await waitFor(() => {
        const graftBtn = screen.queryByRole("button", { name: /graft/i });
        expect(graftBtn).not.toBeNull();
      });
    });

    it("shows an 'Overwrite' button when existing HQ is detected", async () => {
      const user = userEvent.setup();
      setupInvokeMock({
        pickedPath: "/Users/test/existing-hq",
        detectResult: { exists: true, isHq: true },
      });
      render(<DirectoryPicker onNext={vi.fn()} />);

      const btn =
        screen.queryByRole("button", { name: /choose folder/i }) ||
        screen.queryByRole("button", { name: /browse/i }) ||
        screen.queryByRole("button", { name: /select folder/i }) ||
        screen.queryByRole("button", { name: /pick folder/i });
      await user.click(btn!);

      await waitFor(() => {
        const overwriteBtn = screen.queryByRole("button", { name: /overwrite/i });
        expect(overwriteBtn).not.toBeNull();
      });
    });

    it("does NOT show a Continue button until Graft or Overwrite is chosen", async () => {
      const user = userEvent.setup();
      setupInvokeMock({
        pickedPath: "/Users/test/existing-hq",
        detectResult: { exists: true, isHq: true },
      });
      render(<DirectoryPicker onNext={vi.fn()} />);

      const btn =
        screen.queryByRole("button", { name: /choose folder/i }) ||
        screen.queryByRole("button", { name: /browse/i }) ||
        screen.queryByRole("button", { name: /select folder/i }) ||
        screen.queryByRole("button", { name: /pick folder/i });
      await user.click(btn!);

      // Wait for detection UI to appear
      await waitFor(() => {
        expect(screen.queryByRole("button", { name: /graft/i })).not.toBeNull();
      });

      const continueBtn =
        screen.queryByRole("button", { name: /continue/i }) ||
        screen.queryByRole("button", { name: /next/i });

      if (continueBtn) {
        expect((continueBtn as HTMLButtonElement).disabled).toBe(true);
      }
    });

    it("clicking 'Graft' shows Continue button (or calls onNext directly)", async () => {
      const user = userEvent.setup();
      const onNext = vi.fn();
      setupInvokeMock({
        pickedPath: "/Users/test/existing-hq",
        detectResult: { exists: true, isHq: true },
      });
      render(<DirectoryPicker onNext={onNext} />);

      const pickBtn =
        screen.queryByRole("button", { name: /choose folder/i }) ||
        screen.queryByRole("button", { name: /browse/i }) ||
        screen.queryByRole("button", { name: /select folder/i }) ||
        screen.queryByRole("button", { name: /pick folder/i });
      await user.click(pickBtn!);

      const graftBtn = await waitFor(() => {
        const b = screen.queryByRole("button", { name: /graft/i });
        expect(b).not.toBeNull();
        return b!;
      });

      await user.click(graftBtn);

      // Either Continue becomes available, or onNext is called directly
      await waitFor(() => {
        const continueBtn =
          screen.queryByRole("button", { name: /continue/i }) ||
          screen.queryByRole("button", { name: /next/i });
        const continueEnabled =
          continueBtn && !(continueBtn as HTMLButtonElement).disabled;
        expect(continueEnabled || onNext.mock.calls.length > 0).toBe(true);
      });
    });

    it("clicking 'Overwrite' shows Continue button (or calls onNext directly)", async () => {
      const user = userEvent.setup();
      const onNext = vi.fn();
      setupInvokeMock({
        pickedPath: "/Users/test/existing-hq",
        detectResult: { exists: true, isHq: true },
      });
      render(<DirectoryPicker onNext={onNext} />);

      const pickBtn =
        screen.queryByRole("button", { name: /choose folder/i }) ||
        screen.queryByRole("button", { name: /browse/i }) ||
        screen.queryByRole("button", { name: /select folder/i }) ||
        screen.queryByRole("button", { name: /pick folder/i });
      await user.click(pickBtn!);

      const overwriteBtn = await waitFor(() => {
        const b = screen.queryByRole("button", { name: /overwrite/i });
        expect(b).not.toBeNull();
        return b!;
      });

      await user.click(overwriteBtn);

      await waitFor(() => {
        const continueBtn =
          screen.queryByRole("button", { name: /continue/i }) ||
          screen.queryByRole("button", { name: /next/i });
        const continueEnabled =
          continueBtn && !(continueBtn as HTMLButtonElement).disabled;
        expect(continueEnabled || onNext.mock.calls.length > 0).toBe(true);
      });
    });
  });

  // -------------------------------------------------------------------------
  describe("HQ detection markers", () => {
    it("calls detect_hq (not inline file checks) — marker logic is server-side", async () => {
      // The screen must delegate HQ detection to the Tauri command, not re-implement it
      const user = userEvent.setup();
      setupInvokeMock({
        pickedPath: "/Users/test/hq",
        detectResult: { exists: true, isHq: true },
      });
      render(<DirectoryPicker onNext={vi.fn()} />);

      const btn =
        screen.queryByRole("button", { name: /choose folder/i }) ||
        screen.queryByRole("button", { name: /browse/i }) ||
        screen.queryByRole("button", { name: /select folder/i }) ||
        screen.queryByRole("button", { name: /pick folder/i });
      await user.click(btn!);

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith("detect_hq", expect.objectContaining({ path: "/Users/test/hq" }));
      });
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
