import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { DepsInstall } from "../04-deps.js";

// ---------------------------------------------------------------------------
// DepsInstall screen tests (US-014)
//
// These tests are written BEFORE the implementation exists.
// They will fail until src/screens/04-deps.tsx is created.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tauri API mocks
// ---------------------------------------------------------------------------

// Track listen callbacks so tests can fire install:progress events
type EventCallback = (event: { payload: unknown }) => void;
const listenCallbacks = new Map<string, EventCallback[]>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-shell", () => ({
  open: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: EventCallback) => {
    if (!listenCallbacks.has(event)) {
      listenCallbacks.set(event, []);
    }
    listenCallbacks.get(event)!.push(handler);
    // Return an unlisten function
    return () => {
      const handlers = listenCallbacks.get(event);
      if (handlers) {
        const idx = handlers.indexOf(handler);
        if (idx !== -1) handlers.splice(idx, 1);
      }
    };
  }),
  emit: vi.fn().mockResolvedValue(undefined),
}));

import { invoke } from "@tauri-apps/api/core";
import { open as shellOpen } from "@tauri-apps/plugin-shell";

const mockInvoke = vi.mocked(invoke);
const mockShellOpen = vi.mocked(shellOpen);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fire all registered handlers for a given event name */
function fireListenEvent(event: string, payload: unknown) {
  const handlers = listenCallbacks.get(event) ?? [];
  for (const handler of handlers) {
    handler({ payload });
  }
}

const ALL_TOOLS = ["homebrew", "xcode-clt", "node", "git", "gh", "claude-code", "qmd", "hq-cloud"] as const;
type Tool = typeof ALL_TOOLS[number];

/** Binary name used by the Rust `check_dep` command, keyed by UI id.
 *  When a binary name differs from the id, the frontend passes the binary.
 *  Tests express overrides in terms of UI ids for readability. */
const BINARY_TO_ID: Record<string, Tool> = {
  brew: "homebrew",
  claude: "claude-code",
  "hq-sync-runner": "hq-cloud",
};

/** Build a default invoke mock that marks all tools as installed */
function buildInvokeMock(overrides: Partial<Record<Tool, { installed: boolean }>> = {}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return vi.fn(async (command: string, args?: any): Promise<any> => {
    if (command === "check_dep") {
      const binary = (args as { tool?: string })?.tool as string;
      const id = (BINARY_TO_ID[binary] ?? binary) as Tool;
      const override = overrides[id];
      return override ?? { installed: true };
    }
    if (command === "xcode_clt_status") {
      const override = overrides["xcode-clt"];
      return override ?? { installed: true };
    }
    // Install commands resolve successfully by default
    return null;
  });
}

// ---------------------------------------------------------------------------

describe("DepsInstall screen (04-deps.tsx)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listenCallbacks.clear();
    // Default: all tools installed
    mockInvoke.mockImplementation(buildInvokeMock());
  });

  // -------------------------------------------------------------------------
  describe("on-mount dep checks", () => {
    it("calls check_dep with binary name 'brew' (not UI id 'homebrew') on mount", async () => {
      render(<DepsInstall onNext={vi.fn()} />);
      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith("check_dep", { tool: "brew" });
      });
      // Must NOT call check_dep with the UI slug — that's the bug fixed here.
      const calledWithSlug = mockInvoke.mock.calls.some(
        ([cmd, args]) => cmd === "check_dep" && (args as Record<string,string>)?.tool === "homebrew"
      );
      expect(calledWithSlug).toBe(false);
    });

    it("calls xcode_clt_status (not check_dep) for xcode-clt on mount", async () => {
      render(<DepsInstall onNext={vi.fn()} />);
      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith("xcode_clt_status");
      });
      // Must NOT call check_dep with tool: "xcode-clt"
      const checkDepXcode = mockInvoke.mock.calls.some(
        ([cmd, args]) => cmd === "check_dep" && (args as Record<string,string>)?.tool === "xcode-clt"
      );
      expect(checkDepXcode).toBe(false);
    });

    it("calls check_dep for 'node' on mount", async () => {
      render(<DepsInstall onNext={vi.fn()} />);
      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith("check_dep", { tool: "node" });
      });
    });

    it("calls check_dep for 'git' on mount", async () => {
      render(<DepsInstall onNext={vi.fn()} />);
      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith("check_dep", { tool: "git" });
      });
    });

    it("calls check_dep for 'gh' on mount", async () => {
      render(<DepsInstall onNext={vi.fn()} />);
      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith("check_dep", { tool: "gh" });
      });
    });

    it("calls check_dep with binary name 'claude' (not UI id 'claude-code') on mount", async () => {
      render(<DepsInstall onNext={vi.fn()} />);
      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith("check_dep", { tool: "claude" });
      });
      // Must NOT call check_dep with the UI slug — that's the bug fixed here.
      const calledWithSlug = mockInvoke.mock.calls.some(
        ([cmd, args]) => cmd === "check_dep" && (args as Record<string,string>)?.tool === "claude-code"
      );
      expect(calledWithSlug).toBe(false);
    });

    it("calls check_dep for 'qmd' on mount", async () => {
      render(<DepsInstall onNext={vi.fn()} />);
      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith("check_dep", { tool: "qmd" });
      });
    });

    it("calls check_dep with binary name 'hq-sync-runner' (not UI id 'hq-cloud') on mount", async () => {
      render(<DepsInstall onNext={vi.fn()} />);
      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith("check_dep", { tool: "hq-sync-runner" });
      });
      // Must NOT call check_dep with the UI slug — `hq-cloud` is a package
      // name, not a binary; the binary installed by the package is `hq-sync-runner`.
      const calledWithSlug = mockInvoke.mock.calls.some(
        ([cmd, args]) => cmd === "check_dep" && (args as Record<string,string>)?.tool === "hq-cloud"
      );
      expect(calledWithSlug).toBe(false);
    });

    it("checks all 8 tools on mount (no extras, no fewer)", async () => {
      render(<DepsInstall onNext={vi.fn()} />);
      await waitFor(() => {
        // 7 check_dep calls + 1 xcode_clt_status = 8 total dep checks
        const checkDepCalls = mockInvoke.mock.calls.filter(([cmd]) => cmd === "check_dep");
        const xcodeCall = mockInvoke.mock.calls.some(([cmd]) => cmd === "xcode_clt_status");
        expect(checkDepCalls).toHaveLength(7);
        expect(xcodeCall).toBe(true);
      });
    });
  });

  // -------------------------------------------------------------------------
  describe("installed status display", () => {
    it("shows each tool name in the UI", async () => {
      render(<DepsInstall onNext={vi.fn()} />);
      await waitFor(() => {
        // All 7 tool names must appear somewhere in the UI
        const text = document.body.textContent ?? "";
        for (const tool of ALL_TOOLS) {
          // Allow partial match (e.g. "Homebrew", "Node.js", "Claude Code")
          const toolBase = tool.replace(/-/g, "").toLowerCase();
          const textLower = text.toLowerCase().replace(/[-.\s]/g, "");
          expect(textLower).toContain(toolBase);
        }
      });
    });

    it("shows an installed indicator for tools that return installed:true", async () => {
      mockInvoke.mockImplementation(buildInvokeMock());
      render(<DepsInstall onNext={vi.fn()} />);
      await waitFor(() => {
        // At least one installed indicator must be in the DOM
        const installedEl =
          screen.queryByText(/installed/i) ||
          document.querySelector("[data-status='installed']") ||
          document.querySelector("[aria-label*='installed']") ||
          document.querySelector(".text-green-") ||
          document.querySelector("[data-testid*='installed']");
        expect(installedEl).not.toBeNull();
      });
    });

    it("shows a missing/not-installed indicator for tools that return installed:false", async () => {
      mockInvoke.mockImplementation(
        buildInvokeMock({ homebrew: { installed: false } })
      );
      render(<DepsInstall onNext={vi.fn()} />);
      await waitFor(() => {
        const missingEl =
          screen.queryByText(/missing|not installed|not found/i) ||
          document.querySelector("[data-status='missing']") ||
          document.querySelector("[data-status='not-installed']") ||
          document.querySelector("[aria-label*='missing']");
        expect(missingEl).not.toBeNull();
      });
    });
  });

  // -------------------------------------------------------------------------
  describe("Install button per missing tool", () => {
    it("renders an Install button when a tool is missing", async () => {
      mockInvoke.mockImplementation(
        buildInvokeMock({ homebrew: { installed: false } })
      );
      render(<DepsInstall onNext={vi.fn()} />);
      await waitFor(() => {
        const installBtn =
          screen.queryByRole("button", { name: /install homebrew/i }) ||
          screen.queryByRole("button", { name: /install/i });
        expect(installBtn).not.toBeNull();
      });
    });

    it("does NOT render an Install button for tools that are already installed", async () => {
      // All tools installed — no install buttons should appear
      mockInvoke.mockImplementation(buildInvokeMock());
      render(<DepsInstall onNext={vi.fn()} />);
      await waitFor(() => {
        // All dep checks have resolved
        expect(mockInvoke).toHaveBeenCalledWith("check_dep", { tool: "brew" });
      });
      // No install buttons expected
      const installBtns = screen.queryAllByRole("button", { name: /^install/i });
      expect(installBtns).toHaveLength(0);
    });

    it("clicking Install for homebrew calls the correct invoke command", async () => {
      const user = userEvent.setup();
      // First check returns missing, subsequent invoke calls (install) resolve OK
      let callCount = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockInvoke.mockImplementation(async (command: string, args?: any): Promise<any> => {
        if (command === "check_dep" && (args as { tool?: string })?.tool === "brew") {
          callCount++;
          // First call: missing; after install, mark installed
          return callCount === 1 ? { installed: false } : { installed: true };
        }
        if (command === "xcode_clt_status") return { installed: true };
        if (command === "check_dep") return { installed: true };
        return null;
      });

      render(<DepsInstall onNext={vi.fn()} />);

      await waitFor(() => {
        const installBtn = screen.queryByRole("button", { name: /install/i });
        expect(installBtn).not.toBeNull();
      });

      const installBtn = screen.queryByRole("button", { name: /install/i });
      await user.click(installBtn!);

      await waitFor(() => {
        // Should have invoked an install command for homebrew
        const installCall = mockInvoke.mock.calls.some(
          ([cmd]) =>
            cmd === "install_homebrew" ||
            cmd === "install_dep" ||
            (typeof cmd === "string" && cmd.toLowerCase().includes("homebrew"))
        );
        expect(installCall).toBe(true);
      });
    });

    it("clicking Install for node calls the correct invoke command", async () => {
      const user = userEvent.setup();
      mockInvoke.mockImplementation(// eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (command: string, args?: any): Promise<any> => {
        if (command === "check_dep" && args?.tool === "node") return { installed: false };
        if (command === "xcode_clt_status") return { installed: true };
        if (command === "check_dep") return { installed: true };
        return null;
      });

      render(<DepsInstall onNext={vi.fn()} />);

      await waitFor(() => {
        const installBtn = screen.queryByRole("button", { name: /install/i });
        expect(installBtn).not.toBeNull();
      });

      const installBtn = screen.queryByRole("button", { name: /install/i });
      await user.click(installBtn!);

      await waitFor(() => {
        const installCall = mockInvoke.mock.calls.some(
          ([cmd]) =>
            cmd === "install_node" ||
            cmd === "install_dep" ||
            (typeof cmd === "string" && cmd.toLowerCase().includes("node"))
        );
        expect(installCall).toBe(true);
      });
    });
  });

  // -------------------------------------------------------------------------
  describe("install:progress event streaming", () => {
    it("registers a listener for 'install:progress' events on mount", async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const mockListen = vi.mocked(listen);

      render(<DepsInstall onNext={vi.fn()} />);

      await waitFor(() => {
        const registered = mockListen.mock.calls.some(
          ([event]) => event === "install:progress"
        );
        expect(registered).toBe(true);
      });
    });

    it("displays progress output lines when install:progress events are received", async () => {
      const user = userEvent.setup();
      mockInvoke.mockImplementation(// eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (command: string, args?: any): Promise<any> => {
        if (command === "check_dep" && args?.tool === "brew") return { installed: false };
        if (command === "xcode_clt_status") return { installed: true };
        if (command === "check_dep") return { installed: true };
        // Install command hangs (never resolves) so progress events can arrive first
        if (command === "install_homebrew" || command === "install_dep") {
          return new Promise(() => {}); // never resolves
        }
        return null;
      });

      render(<DepsInstall onNext={vi.fn()} />);

      await waitFor(() => {
        const installBtn = screen.queryByRole("button", { name: /install/i });
        expect(installBtn).not.toBeNull();
      });

      const installBtn = screen.queryByRole("button", { name: /install/i });
      await user.click(installBtn!);

      // Fire a progress event
      act(() => {
        fireListenEvent("install:progress", { line: "Downloading homebrew..." });
      });

      await waitFor(() => {
        const progressText = screen.queryByText(/downloading/i);
        expect(progressText).not.toBeNull();
      });
    });

    it("accumulates multiple progress lines", async () => {
      const user = userEvent.setup();
      mockInvoke.mockImplementation(// eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (command: string, args?: any): Promise<any> => {
        if (command === "check_dep" && args?.tool === "brew") return { installed: false };
        if (command === "xcode_clt_status") return { installed: true };
        if (command === "check_dep") return { installed: true };
        return new Promise(() => {});
      });

      render(<DepsInstall onNext={vi.fn()} />);

      await waitFor(() => {
        expect(screen.queryByRole("button", { name: /install/i })).not.toBeNull();
      });

      await user.click(screen.queryByRole("button", { name: /install/i })!);

      act(() => {
        fireListenEvent("install:progress", { line: "Step 1: downloading..." });
        fireListenEvent("install:progress", { line: "Step 2: extracting..." });
      });

      await waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Step 1");
        expect(text).toContain("Step 2");
      });
    });
  });

  // -------------------------------------------------------------------------
  describe("install:progress for xcode-clt", () => {
    it("registers a listener for 'xcode:progress' events on mount", async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const mockListen = vi.mocked(listen);

      render(<DepsInstall onNext={vi.fn()} />);

      await waitFor(() => {
        const registered = mockListen.mock.calls.some(
          ([event]) => event === "xcode:progress"
        );
        expect(registered).toBe(true);
      });
    });
  });

  // -------------------------------------------------------------------------
  describe("failure states — retry + browser fallback", () => {
    it("shows a retry button when an install command fails", async () => {
      const user = userEvent.setup();
      mockInvoke.mockImplementation(// eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (command: string, args?: any): Promise<any> => {
        if (command === "check_dep" && args?.tool === "brew") return { installed: false };
        if (command === "xcode_clt_status") return { installed: true };
        if (command === "check_dep") return { installed: true };
        // Any install command rejects
        throw new Error("install failed");
      });

      render(<DepsInstall onNext={vi.fn()} />);

      await waitFor(() => {
        expect(screen.queryByRole("button", { name: /install/i })).not.toBeNull();
      });

      await user.click(screen.queryByRole("button", { name: /install/i })!);

      await waitFor(() => {
        const retryBtn =
          screen.queryByRole("button", { name: /retry/i }) ||
          screen.queryByRole("button", { name: /try again/i });
        expect(retryBtn).not.toBeNull();
      });
    });

    it("shows an 'Open install page' button when an install command fails", async () => {
      const user = userEvent.setup();
      mockInvoke.mockImplementation(// eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (command: string, args?: any): Promise<any> => {
        if (command === "check_dep" && args?.tool === "brew") return { installed: false };
        if (command === "xcode_clt_status") return { installed: true };
        if (command === "check_dep") return { installed: true };
        throw new Error("install failed");
      });

      render(<DepsInstall onNext={vi.fn()} />);

      await waitFor(() => {
        expect(screen.queryByRole("button", { name: /install/i })).not.toBeNull();
      });

      await user.click(screen.queryByRole("button", { name: /install/i })!);

      await waitFor(() => {
        const openBtn =
          screen.queryByRole("button", { name: /open.*install/i }) ||
          screen.queryByRole("button", { name: /open.*page/i }) ||
          screen.queryByRole("button", { name: /open.*browser/i }) ||
          screen.queryByRole("link", { name: /open.*install/i });
        expect(openBtn).not.toBeNull();
      });
    });

    it("clicking 'Open install page' calls shell open with a URL", async () => {
      const user = userEvent.setup();
      mockInvoke.mockImplementation(// eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (command: string, args?: any): Promise<any> => {
        if (command === "check_dep" && args?.tool === "brew") return { installed: false };
        if (command === "xcode_clt_status") return { installed: true };
        if (command === "check_dep") return { installed: true };
        throw new Error("install failed");
      });

      render(<DepsInstall onNext={vi.fn()} />);

      await waitFor(() => {
        expect(screen.queryByRole("button", { name: /install/i })).not.toBeNull();
      });

      await user.click(screen.queryByRole("button", { name: /install/i })!);

      await waitFor(() => {
        const openBtn =
          screen.queryByRole("button", { name: /open.*install/i }) ||
          screen.queryByRole("button", { name: /open.*page/i }) ||
          screen.queryByRole("button", { name: /open.*browser/i });
        expect(openBtn).not.toBeNull();
      });

      const openBtn =
        screen.queryByRole("button", { name: /open.*install/i }) ||
        screen.queryByRole("button", { name: /open.*page/i }) ||
        screen.queryByRole("button", { name: /open.*browser/i });
      await user.click(openBtn!);

      await waitFor(() => {
        expect(mockShellOpen).toHaveBeenCalledTimes(1);
        const [url] = mockShellOpen.mock.calls[0];
        expect(typeof url).toBe("string");
        expect(url).toMatch(/^https?:\/\//);
      });
    });

    it("clicking Retry re-invokes the install command", async () => {
      const user = userEvent.setup();
      let installAttempts = 0;
      mockInvoke.mockImplementation(// eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (command: string, args?: any): Promise<any> => {
        if (command === "check_dep" && args?.tool === "brew") return { installed: false };
        if (command === "xcode_clt_status") return { installed: true };
        if (command === "check_dep") return { installed: true };
        installAttempts++;
        throw new Error("install failed");
      });

      render(<DepsInstall onNext={vi.fn()} />);

      await waitFor(() => {
        expect(screen.queryByRole("button", { name: /install/i })).not.toBeNull();
      });

      await user.click(screen.queryByRole("button", { name: /install/i })!);

      await waitFor(() => {
        const retryBtn =
          screen.queryByRole("button", { name: /retry/i }) ||
          screen.queryByRole("button", { name: /try again/i });
        expect(retryBtn).not.toBeNull();
      });

      const retryBtn =
        screen.queryByRole("button", { name: /retry/i }) ||
        screen.queryByRole("button", { name: /try again/i });
      await user.click(retryBtn!);

      await waitFor(() => {
        // Second install attempt was made
        expect(installAttempts).toBeGreaterThanOrEqual(2);
      });
    });
  });

  // -------------------------------------------------------------------------
  describe("Continue button — all deps satisfied", () => {
    it("shows a Continue button when all deps are installed", async () => {
      // All tools installed by default
      mockInvoke.mockImplementation(buildInvokeMock());
      render(<DepsInstall onNext={vi.fn()} />);

      await waitFor(() => {
        const continueBtn =
          screen.queryByRole("button", { name: /continue/i }) ||
          screen.queryByRole("button", { name: /next/i }) ||
          screen.queryByRole("button", { name: /finish/i });
        expect(continueBtn).not.toBeNull();
      });
    });

    it("Continue button calls onNext when all deps are installed", async () => {
      const user = userEvent.setup();
      const onNext = vi.fn();
      mockInvoke.mockImplementation(buildInvokeMock());
      render(<DepsInstall onNext={onNext} />);

      await waitFor(() => {
        const continueBtn =
          screen.queryByRole("button", { name: /continue/i }) ||
          screen.queryByRole("button", { name: /next/i }) ||
          screen.queryByRole("button", { name: /finish/i });
        expect(continueBtn).not.toBeNull();
      });

      const continueBtn =
        screen.queryByRole("button", { name: /continue/i }) ||
        screen.queryByRole("button", { name: /next/i }) ||
        screen.queryByRole("button", { name: /finish/i });
      await user.click(continueBtn!);

      expect(onNext).toHaveBeenCalledTimes(1);
    });

    it("Continue button is disabled when at least one dep is still missing", async () => {
      mockInvoke.mockImplementation(
        buildInvokeMock({ homebrew: { installed: false } })
      );
      render(<DepsInstall onNext={vi.fn()} />);

      await waitFor(() => {
        // Check that the dep check has run
        expect(mockInvoke).toHaveBeenCalledWith("check_dep", { tool: "brew" });
      });

      const continueBtn =
        screen.queryByRole("button", { name: /continue/i }) ||
        screen.queryByRole("button", { name: /next/i }) ||
        screen.queryByRole("button", { name: /finish/i });

      if (continueBtn) {
        // If Continue is rendered at all, it must be disabled
        expect((continueBtn as HTMLButtonElement).disabled).toBe(true);
      }
      // Acceptable if Continue button is simply absent when deps are missing
    });

    it("does NOT call onNext on initial mount", () => {
      const onNext = vi.fn();
      mockInvoke.mockImplementation(buildInvokeMock());
      render(<DepsInstall onNext={onNext} />);
      expect(onNext).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  describe("dep state matrix — React test coverage", () => {
    it("all installed: shows 8 installed statuses, no Install buttons", async () => {
      mockInvoke.mockImplementation(buildInvokeMock());
      render(<DepsInstall onNext={vi.fn()} />);

      await waitFor(() => {
        const checkDepCalls = mockInvoke.mock.calls.filter(([cmd]) => cmd === "check_dep");
        expect(checkDepCalls).toHaveLength(7);
      });

      const installBtns = screen.queryAllByRole("button", { name: /^install/i });
      expect(installBtns).toHaveLength(0);
    });

    it("one missing: shows exactly 1 Install button", async () => {
      mockInvoke.mockImplementation(
        buildInvokeMock({ node: { installed: false } })
      );
      render(<DepsInstall onNext={vi.fn()} />);

      await waitFor(() => {
        const installBtns = screen.queryAllByRole("button", { name: /install/i });
        expect(installBtns).toHaveLength(1);
      });
    });

    it("multiple missing: shows one Install button per missing tool", async () => {
      mockInvoke.mockImplementation(
        buildInvokeMock({
          homebrew: { installed: false },
          node: { installed: false },
          gh: { installed: false },
        })
      );
      render(<DepsInstall onNext={vi.fn()} />);

      await waitFor(() => {
        const installBtns = screen.queryAllByRole("button", { name: /install/i });
        expect(installBtns).toHaveLength(3);
      });
    });

    it("all missing: shows 7 Install buttons and no Continue button", async () => {
      mockInvoke.mockImplementation(
        buildInvokeMock({
          homebrew: { installed: false },
          "xcode-clt": { installed: false },
          node: { installed: false },
          git: { installed: false },
          gh: { installed: false },
          "claude-code": { installed: false },
          qmd: { installed: false },
        })
      );
      render(<DepsInstall onNext={vi.fn()} />);

      await waitFor(() => {
        const installBtns = screen.queryAllByRole("button", { name: /install/i });
        expect(installBtns).toHaveLength(7);
      });

      // Continue must be absent or disabled
      const continueBtn =
        screen.queryByRole("button", { name: /continue/i }) ||
        screen.queryByRole("button", { name: /^next$/i }) ||
        screen.queryByRole("button", { name: /^finish$/i });
      if (continueBtn) {
        expect((continueBtn as HTMLButtonElement).disabled).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  describe("UI policy — no-purple-monochrome-ui", () => {
    it("does NOT use 'purple' class names in the DOM", async () => {
      render(<DepsInstall onNext={vi.fn()} />);
      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith("check_dep", { tool: "brew" });
      });
      expect(document.body.innerHTML).not.toMatch(/\bpurple\b/);
    });

    it("does NOT use 'indigo' class names in the DOM", async () => {
      render(<DepsInstall onNext={vi.fn()} />);
      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith("check_dep", { tool: "brew" });
      });
      expect(document.body.innerHTML).not.toMatch(/\bindigo\b/);
    });
  });

  // -------------------------------------------------------------------------
  describe("Tauri environment compatibility", () => {
    it("renders cleanly when Tauri APIs are mocked", () => {
      expect(() => {
        render(<DepsInstall onNext={vi.fn()} />);
      }).not.toThrow();
    });
  });
});
