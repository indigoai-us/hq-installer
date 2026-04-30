// 06-directory.test.tsx — US-015 (revised 2026-04-29)
// New flow: pick a parent location, name the HQ folder, create & continue.
// Existing-HQ detection still surfaces graft/overwrite when the resolved
// folder already contains an HQ install.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
// fs + app plugins are touched by the install-manifest helper. Stub them
// rather than risk real fs writes during tests.
vi.mock("@tauri-apps/plugin-fs", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  readTextFile: vi.fn().mockRejectedValue(new Error("not found")),
  writeTextFile: vi.fn().mockResolvedValue(undefined),
  exists: vi.fn().mockResolvedValue(false),
}));
vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn().mockResolvedValue("test"),
}));
// Telemetry pings would otherwise hit the network — stub.
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
}));

import { invoke } from "@tauri-apps/api/core";
const mockInvoke = vi.mocked(invoke);

// ---------------------------------------------------------------------------
// Default invoke behaviour
// ---------------------------------------------------------------------------
function setupInvokeMock({
  pickedPath = "/Users/test",
  createResult = {
    path: "/Users/test/hq",
    already_existed: false,
    non_empty: false,
  },
  detectResult = { exists: true, isHq: false },
}: {
  pickedPath?: string | null;
  createResult?: {
    path: string;
    already_existed?: boolean;
    non_empty?: boolean;
  };
  detectResult?: { exists: boolean; isHq: boolean };
} = {}) {
  mockInvoke.mockImplementation(async (command: string): Promise<unknown> => {
    if (command === "pick_directory") return pickedPath;
    if (command === "create_directory") return createResult;
    if (command === "detect_hq") return detectResult;
    return null;
  });
}

async function clickChooseLocation(user: ReturnType<typeof userEvent.setup>) {
  const btn =
    screen.queryByRole("button", { name: /choose location/i }) ??
    screen.queryByRole("button", { name: /choose folder/i });
  expect(btn).not.toBeNull();
  await user.click(btn!);
}

async function clickCreateAndContinue(
  user: ReturnType<typeof userEvent.setup>,
) {
  const btn = await waitFor(() => {
    const b = screen.queryByRole("button", { name: /create.*continue/i });
    expect(b).not.toBeNull();
    return b!;
  });
  await user.click(btn);
}

// ---------------------------------------------------------------------------

describe("DirectoryPicker screen (06-directory.tsx)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupInvokeMock();
  });

  // -------------------------------------------------------------------------
  describe("initial render", () => {
    it("renders a 'Choose location' button", () => {
      render(<DirectoryPicker onNext={vi.fn()} />);
      const btn =
        screen.queryByRole("button", { name: /choose location/i }) ??
        screen.queryByRole("button", { name: /choose folder/i });
      expect(btn).not.toBeNull();
    });

    it("does NOT show a Create & continue button before a location is picked", () => {
      render(<DirectoryPicker onNext={vi.fn()} />);
      const continueBtn = screen.queryByRole("button", {
        name: /create.*continue/i,
      });
      expect(continueBtn).toBeNull();
    });

    it("does NOT call onNext on initial render", () => {
      const onNext = vi.fn();
      render(<DirectoryPicker onNext={onNext} />);
      expect(onNext).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  describe("location picker invocation", () => {
    it("clicking 'Choose location' calls invoke('pick_directory', { defaultPath: '~' })", async () => {
      const user = userEvent.setup();
      render(<DirectoryPicker onNext={vi.fn()} />);
      await clickChooseLocation(user);
      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith("pick_directory", {
          defaultPath: "~",
        });
      });
    });

    it("displays the picked parent path and the resolved install preview", async () => {
      const user = userEvent.setup();
      setupInvokeMock({ pickedPath: "/Users/test" });
      render(<DirectoryPicker onNext={vi.fn()} />);
      await clickChooseLocation(user);
      await waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("/Users/test");
        // Default folder name is "hq" — preview should compose to /Users/test/hq
        expect(text).toContain("/Users/test/hq");
      });
    });

    it("does nothing when pick_directory returns null (user cancelled)", async () => {
      const user = userEvent.setup();
      setupInvokeMock({ pickedPath: null });
      render(<DirectoryPicker onNext={vi.fn()} />);
      await clickChooseLocation(user);
      // create_directory must NOT be called when no parent was picked
      await new Promise((r) => setTimeout(r, 50));
      const createCall = mockInvoke.mock.calls.find(
        ([cmd]) => cmd === "create_directory",
      );
      expect(createCall).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  describe("create & continue (no existing HQ)", () => {
    it("calls invoke('create_directory', { parent, name }) on Create & continue", async () => {
      const user = userEvent.setup();
      setupInvokeMock({ pickedPath: "/Users/test" });
      render(<DirectoryPicker onNext={vi.fn()} />);
      await clickChooseLocation(user);
      await clickCreateAndContinue(user);
      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith("create_directory", {
          parent: "/Users/test",
          name: "hq",
        });
      });
    });

    it("calls invoke('detect_hq', { path }) with the resolved install path", async () => {
      const user = userEvent.setup();
      setupInvokeMock({
        pickedPath: "/Users/test",
        createResult: {
          path: "/Users/test/hq",
          already_existed: false,
          non_empty: false,
        },
      });
      render(<DirectoryPicker onNext={vi.fn()} />);
      await clickChooseLocation(user);
      await clickCreateAndContinue(user);
      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith("detect_hq", {
          path: "/Users/test/hq",
        });
      });
    });

    it("calls onNext after a fresh folder is created and detection clears", async () => {
      const user = userEvent.setup();
      const onNext = vi.fn();
      setupInvokeMock({
        pickedPath: "/Users/test",
        createResult: {
          path: "/Users/test/hq",
          already_existed: false,
          non_empty: false,
        },
        detectResult: { exists: true, isHq: false },
      });
      render(<DirectoryPicker onNext={onNext} />);
      await clickChooseLocation(user);
      await clickCreateAndContinue(user);
      await waitFor(() => {
        expect(onNext).toHaveBeenCalledTimes(1);
      });
    });

    it("warns when the resolved folder already has files in it", async () => {
      const user = userEvent.setup();
      setupInvokeMock({
        pickedPath: "/Users/test",
        createResult: {
          path: "/Users/test/hq",
          already_existed: true,
          non_empty: true,
        },
        detectResult: { exists: true, isHq: false },
      });
      render(<DirectoryPicker onNext={vi.fn()} />);
      await clickChooseLocation(user);
      await clickCreateAndContinue(user);
      await waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text.toLowerCase()).toMatch(/already has files/);
      });
    });
  });

  // -------------------------------------------------------------------------
  describe("existing HQ detection — graft or overwrite", () => {
    it("shows 'Existing HQ detected' when detect_hq returns isHq: true", async () => {
      const user = userEvent.setup();
      setupInvokeMock({
        pickedPath: "/Users/test",
        createResult: {
          path: "/Users/test/hq",
          already_existed: true,
          non_empty: true,
        },
        detectResult: { exists: true, isHq: true },
      });
      render(<DirectoryPicker onNext={vi.fn()} />);
      await clickChooseLocation(user);
      await clickCreateAndContinue(user);
      await waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text.toLowerCase()).toMatch(/existing hq detected/);
      });
    });

    it("renders both Graft and Overwrite buttons when an existing HQ is detected", async () => {
      const user = userEvent.setup();
      setupInvokeMock({
        pickedPath: "/Users/test",
        createResult: {
          path: "/Users/test/hq",
          already_existed: true,
          non_empty: true,
        },
        detectResult: { exists: true, isHq: true },
      });
      render(<DirectoryPicker onNext={vi.fn()} />);
      await clickChooseLocation(user);
      await clickCreateAndContinue(user);
      await waitFor(() => {
        expect(screen.queryByRole("button", { name: /graft/i })).not.toBeNull();
        expect(
          screen.queryByRole("button", { name: /overwrite/i }),
        ).not.toBeNull();
      });
    });

    it("does NOT call onNext until Graft or Overwrite is chosen", async () => {
      const user = userEvent.setup();
      const onNext = vi.fn();
      setupInvokeMock({
        pickedPath: "/Users/test",
        createResult: {
          path: "/Users/test/hq",
          already_existed: true,
          non_empty: true,
        },
        detectResult: { exists: true, isHq: true },
      });
      render(<DirectoryPicker onNext={onNext} />);
      await clickChooseLocation(user);
      await clickCreateAndContinue(user);
      await waitFor(() => {
        expect(screen.queryByRole("button", { name: /graft/i })).not.toBeNull();
      });
      // Detection surfaced — onNext should still be untouched.
      expect(onNext).not.toHaveBeenCalled();
    });

    it("clicking Graft advances the wizard via onNext", async () => {
      const user = userEvent.setup();
      const onNext = vi.fn();
      setupInvokeMock({
        pickedPath: "/Users/test",
        createResult: {
          path: "/Users/test/hq",
          already_existed: true,
          non_empty: true,
        },
        detectResult: { exists: true, isHq: true },
      });
      render(<DirectoryPicker onNext={onNext} />);
      await clickChooseLocation(user);
      await clickCreateAndContinue(user);
      const graftBtn = await waitFor(() => {
        const b = screen.queryByRole("button", { name: /graft/i });
        expect(b).not.toBeNull();
        return b!;
      });
      await user.click(graftBtn);
      await waitFor(() => {
        expect(onNext).toHaveBeenCalledTimes(1);
      });
    });

    it("clicking Overwrite advances the wizard via onNext", async () => {
      const user = userEvent.setup();
      const onNext = vi.fn();
      setupInvokeMock({
        pickedPath: "/Users/test",
        createResult: {
          path: "/Users/test/hq",
          already_existed: true,
          non_empty: true,
        },
        detectResult: { exists: true, isHq: true },
      });
      render(<DirectoryPicker onNext={onNext} />);
      await clickChooseLocation(user);
      await clickCreateAndContinue(user);
      const overwriteBtn = await waitFor(() => {
        const b = screen.queryByRole("button", { name: /overwrite/i });
        expect(b).not.toBeNull();
        return b!;
      });
      await user.click(overwriteBtn);
      await waitFor(() => {
        expect(onNext).toHaveBeenCalledTimes(1);
      });
    });
  });

  // -------------------------------------------------------------------------
  describe("HQ detection markers", () => {
    it("delegates HQ detection to the Tauri command (no inline checks)", async () => {
      const user = userEvent.setup();
      setupInvokeMock({
        pickedPath: "/Users/test",
        createResult: {
          path: "/Users/test/hq",
          already_existed: true,
          non_empty: true,
        },
        detectResult: { exists: true, isHq: true },
      });
      render(<DirectoryPicker onNext={vi.fn()} />);
      await clickChooseLocation(user);
      await clickCreateAndContinue(user);
      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith(
          "detect_hq",
          expect.objectContaining({ path: "/Users/test/hq" }),
        );
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
