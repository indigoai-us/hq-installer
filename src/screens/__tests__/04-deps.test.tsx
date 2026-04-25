import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { DepsInstall } from "../04-deps.js";

// ---------------------------------------------------------------------------
// DepsInstall screen tests (US-014)
//
// v0.1.22: Xcode CLT row removed (Homebrew installs it transitively) and rows
// are now dependency-gated — a dep stays locked ("Waiting for X") until every
// parent reports `installed`. Tests below reflect that: `node` and friends
// depend on `homebrew`; `claude-code`/`qmd` depend on `node`.
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

function fireListenEvent(event: string, payload: unknown) {
  const handlers = listenCallbacks.get(event) ?? [];
  for (const handler of handlers) {
    handler({ payload });
  }
}

const ALL_TOOLS = ["homebrew", "node", "git", "yq", "gh", "claude-code", "qmd"] as const;
type Tool = typeof ALL_TOOLS[number];

/** Binary name used by the Rust `check_dep` command, keyed by UI id. */
const BINARY_TO_ID: Record<string, Tool> = {
  brew: "homebrew",
  claude: "claude-code",
};

function buildInvokeMock(overrides: Partial<Record<Tool, { installed: boolean }>> = {}) {
  return vi.fn(async (command: string, args?: any): Promise<any> => {
    if (command === "check_dep") {
      const binary = (args as { tool?: string })?.tool as string;
      const id = (BINARY_TO_ID[binary] ?? binary) as Tool;
      const override = overrides[id];
      return override ?? { installed: true };
    }
    return null;
  });
}

// ---------------------------------------------------------------------------

describe("DepsInstall screen (04-deps.tsx)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listenCallbacks.clear();
    mockInvoke.mockImplementation(buildInvokeMock());
  });

  // -------------------------------------------------------------------------
  describe("on-mount dep checks", () => {
    it("calls check_dep with binary name 'brew' (not UI id 'homebrew') on mount", async () => {
      render(<DepsInstall onNext={vi.fn()} />);
      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith("check_dep", { tool: "brew" });
      });
      const calledWithSlug = mockInvoke.mock.calls.some(
        ([cmd, args]) => cmd === "check_dep" && (args as Record<string,string>)?.tool === "homebrew"
      );
      expect(calledWithSlug).toBe(false);
    });

    it("does NOT call xcode_clt_status (row removed in v0.1.22)", async () => {
      render(<DepsInstall onNext={vi.fn()} />);
      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith("check_dep", { tool: "brew" });
      });
      const xcodeCall = mockInvoke.mock.calls.some(([cmd]) => cmd === "xcode_clt_status");
      expect(xcodeCall).toBe(false);
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

    it("calls check_dep for 'yq' on mount", async () => {
      render(<DepsInstall onNext={vi.fn()} />);
      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith("check_dep", { tool: "yq" });
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
      const calledWithSlug = mockInvoke.mock.calls.some(
        ([cmd, args]) => cmd === "check_dep" && (args as Record<string,string>)?.tool === "claude-code"
      );
      expect(calledWithSlug).toBe(false);
    });

    it("renders 'Anthropic CLI — not the Claude desktop app' subtitle on the claude-code row", async () => {
      render(<DepsInstall onNext={vi.fn()} />);
      const subtitle = await screen.findByText("Anthropic CLI — not the Claude desktop app");
      expect(subtitle).toBeTruthy();
      // The subtitle must live inside the claude-code row — not floating elsewhere.
      const row = subtitle.closest('[data-dep="claude-code"]');
      expect(row).not.toBeNull();
    });

    it("calls check_dep for 'qmd' on mount", async () => {
      render(<DepsInstall onNext={vi.fn()} />);
      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith("check_dep", { tool: "qmd" });
      });
    });

    it("checks exactly 7 tools on mount (no xcode-clt, no extras)", async () => {
      render(<DepsInstall onNext={vi.fn()} />);
      await waitFor(() => {
        const checkDepCalls = mockInvoke.mock.calls.filter(([cmd]) => cmd === "check_dep");
        expect(checkDepCalls).toHaveLength(7);
      });
    });
  });

  // -------------------------------------------------------------------------
  describe("installed status display", () => {
    it("shows each tool name in the UI", async () => {
      render(<DepsInstall onNext={vi.fn()} />);
      await waitFor(() => {
        const text = document.body.textContent ?? "";
        for (const tool of ALL_TOOLS) {
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
  describe("dependency gating (locked/unlock)", () => {
    it("node stays locked (data-locked='true') while homebrew is missing", async () => {
      mockInvoke.mockImplementation(
        buildInvokeMock({
          homebrew: { installed: false },
          node: { installed: false },
        })
      );
      render(<DepsInstall onNext={vi.fn()} />);

      await waitFor(() => {
        const nodeRow = document.querySelector<HTMLElement>("[data-dep='node']");
        expect(nodeRow).not.toBeNull();
        expect(nodeRow!.getAttribute("data-locked")).toBe("true");
      });

      // Homebrew row is the root — must NOT be locked
      const brewRow = document.querySelector<HTMLElement>("[data-dep='homebrew']");
      expect(brewRow?.getAttribute("data-locked")).toBe("false");
    });

    it("shows 'Waiting for Homebrew' on node row when homebrew is missing", async () => {
      mockInvoke.mockImplementation(
        buildInvokeMock({
          homebrew: { installed: false },
          node: { installed: false },
        })
      );
      render(<DepsInstall onNext={vi.fn()} />);

      await waitFor(() => {
        const nodeRow = document.querySelector<HTMLElement>("[data-dep='node']");
        expect(nodeRow?.textContent ?? "").toMatch(/waiting for.*homebrew/i);
      });
    });

    it("yq stays locked while node is missing (brew-lock race fix)", async () => {
      // yq gating on node (not homebrew) serializes past the brew formula-lock
      // race when node + yq try to install concurrently under the same brew prefix.
      mockInvoke.mockImplementation(
        buildInvokeMock({
          node: { installed: false },
          yq: { installed: false },
        })
      );
      render(<DepsInstall onNext={vi.fn()} />);

      await waitFor(() => {
        const yqRow = document.querySelector<HTMLElement>("[data-dep='yq']");
        expect(yqRow).not.toBeNull();
        expect(yqRow!.getAttribute("data-locked")).toBe("true");
        expect(yqRow!.textContent ?? "").toMatch(/waiting for.*node/i);
      });
    });

    it("claude-code stays locked while node is missing (even if homebrew is installed)", async () => {
      mockInvoke.mockImplementation(
        buildInvokeMock({
          node: { installed: false },
          "claude-code": { installed: false },
        })
      );
      render(<DepsInstall onNext={vi.fn()} />);

      await waitFor(() => {
        const ccRow = document.querySelector<HTMLElement>("[data-dep='claude-code']");
        expect(ccRow).not.toBeNull();
        expect(ccRow!.getAttribute("data-locked")).toBe("true");
        expect(ccRow!.textContent ?? "").toMatch(/waiting for.*node/i);
      });

      // Node itself is unlocked (homebrew is installed by default override)
      const nodeRow = document.querySelector<HTMLElement>("[data-dep='node']");
      expect(nodeRow?.getAttribute("data-locked")).toBe("false");
    });

    it("locked row does NOT render an Install button", async () => {
      mockInvoke.mockImplementation(
        buildInvokeMock({
          homebrew: { installed: false },
          node: { installed: false },
        })
      );
      render(<DepsInstall onNext={vi.fn()} />);

      await waitFor(() => {
        const nodeRow = document.querySelector<HTMLElement>("[data-dep='node']");
        expect(nodeRow?.getAttribute("data-locked")).toBe("true");
      });

      const nodeRow = document.querySelector<HTMLElement>("[data-dep='node']")!;
      const installBtn = nodeRow.querySelector("button");
      // Node row should have no install button while locked
      expect(installBtn).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe("Install button per missing tool", () => {
    it("renders an Install button when a root tool is missing", async () => {
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
      mockInvoke.mockImplementation(buildInvokeMock());
      render(<DepsInstall onNext={vi.fn()} />);
      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith("check_dep", { tool: "brew" });
      });
      const installBtns = screen.queryAllByRole("button", { name: /^install/i });
      expect(installBtns).toHaveLength(0);
    });

    it("clicking Install for homebrew calls install_homebrew", async () => {
      const user = userEvent.setup();
      let callCount = 0;
      mockInvoke.mockImplementation(async (command: string, args?: any): Promise<any> => {
        if (command === "check_dep" && (args as { tool?: string })?.tool === "brew") {
          callCount++;
          return callCount === 1 ? { installed: false } : { installed: true };
        }
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
            cmd === "install_homebrew" ||
            cmd === "install_dep" ||
            (typeof cmd === "string" && cmd.toLowerCase().includes("homebrew"))
        );
        expect(installCall).toBe(true);
      });
    });

    it("clicking Install for node (with homebrew already installed) calls install_node", async () => {
      const user = userEvent.setup();
      mockInvoke.mockImplementation(async (command: string, args?: any): Promise<any> => {
        if (command === "check_dep" && args?.tool === "node") return { installed: false };
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
      mockInvoke.mockImplementation(async (command: string, args?: any): Promise<any> => {
        if (command === "check_dep" && args?.tool === "brew") return { installed: false };
        if (command === "check_dep") return { installed: true };
        if (command === "install_homebrew" || command === "install_dep") {
          return new Promise(() => {});
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
      mockInvoke.mockImplementation(async (command: string, args?: any): Promise<any> => {
        if (command === "check_dep" && args?.tool === "brew") return { installed: false };
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
  describe("failure states — retry + browser fallback", () => {
    it("shows a retry button when an install command fails", async () => {
      const user = userEvent.setup();
      mockInvoke.mockImplementation(async (command: string, args?: any): Promise<any> => {
        if (command === "check_dep" && args?.tool === "brew") return { installed: false };
        if (command === "check_dep") return { installed: true };
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
      mockInvoke.mockImplementation(async (command: string, args?: any): Promise<any> => {
        if (command === "check_dep" && args?.tool === "brew") return { installed: false };
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
      mockInvoke.mockImplementation(async (command: string, args?: any): Promise<any> => {
        if (command === "check_dep" && args?.tool === "brew") return { installed: false };
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
      mockInvoke.mockImplementation(async (command: string, args?: any): Promise<any> => {
        if (command === "check_dep" && args?.tool === "brew") return { installed: false };
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
        expect(installAttempts).toBeGreaterThanOrEqual(2);
      });
    });
  });

  // -------------------------------------------------------------------------
  describe("Continue button — all deps satisfied", () => {
    it("shows a Continue button when all required deps are installed", async () => {
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

    it("Continue button calls onNext when all required deps are installed", async () => {
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

    it("Continue button is absent when at least one required dep is still missing", async () => {
      mockInvoke.mockImplementation(
        buildInvokeMock({ homebrew: { installed: false } })
      );
      render(<DepsInstall onNext={vi.fn()} />);

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith("check_dep", { tool: "brew" });
      });

      const continueBtn =
        screen.queryByRole("button", { name: /continue/i }) ||
        screen.queryByRole("button", { name: /next/i }) ||
        screen.queryByRole("button", { name: /finish/i });

      // Continue should be absent entirely when required deps are missing
      expect(continueBtn).toBeNull();
    });

    it("Continue appears when optional deps (claude-code, qmd, gh) are missing but required deps are installed", async () => {
      mockInvoke.mockImplementation(
        buildInvokeMock({
          gh: { installed: false },
          "claude-code": { installed: false },
          qmd: { installed: false },
        })
      );
      render(<DepsInstall onNext={vi.fn()} />);

      await waitFor(() => {
        const continueBtn =
          screen.queryByRole("button", { name: /continue/i }) ||
          screen.queryByRole("button", { name: /next/i }) ||
          screen.queryByRole("button", { name: /finish/i });
        expect(continueBtn).not.toBeNull();
      });
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
    it("all installed: shows 7 dep checks, no Install buttons", async () => {
      mockInvoke.mockImplementation(buildInvokeMock());
      render(<DepsInstall onNext={vi.fn()} />);

      await waitFor(() => {
        const checkDepCalls = mockInvoke.mock.calls.filter(([cmd]) => cmd === "check_dep");
        expect(checkDepCalls).toHaveLength(7);
      });

      const installBtns = screen.queryAllByRole("button", { name: /^install/i });
      expect(installBtns).toHaveLength(0);
    });

    it("one root missing: shows exactly 1 Install button", async () => {
      mockInvoke.mockImplementation(
        buildInvokeMock({ node: { installed: false } })
      );
      render(<DepsInstall onNext={vi.fn()} />);

      await waitFor(() => {
        const installBtns = screen.queryAllByRole("button", { name: /install/i });
        expect(installBtns).toHaveLength(1);
      });
    });

    it("multiple missing children with missing parent: only parent is installable", async () => {
      // homebrew missing blocks node + gh — so only homebrew's Install renders
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
        expect(installBtns).toHaveLength(1);
        expect(installBtns[0].textContent ?? "").toMatch(/homebrew/i);
      });

      // node and gh should be locked
      const nodeRow = document.querySelector<HTMLElement>("[data-dep='node']");
      const ghRow = document.querySelector<HTMLElement>("[data-dep='gh']");
      expect(nodeRow?.getAttribute("data-locked")).toBe("true");
      expect(ghRow?.getAttribute("data-locked")).toBe("true");
    });

    it("all missing: only homebrew is installable initially; Continue is absent", async () => {
      mockInvoke.mockImplementation(
        buildInvokeMock({
          homebrew: { installed: false },
          node: { installed: false },
          git: { installed: false },
          yq: { installed: false },
          gh: { installed: false },
          "claude-code": { installed: false },
          qmd: { installed: false },
        })
      );
      render(<DepsInstall onNext={vi.fn()} />);

      await waitFor(() => {
        const installBtns = screen.queryAllByRole("button", { name: /install/i });
        // Only homebrew (root) is installable; the other 6 are locked behind it
        expect(installBtns).toHaveLength(1);
        expect(installBtns[0].textContent ?? "").toMatch(/homebrew/i);
      });

      const continueBtn =
        screen.queryByRole("button", { name: /continue/i }) ||
        screen.queryByRole("button", { name: /^next$/i }) ||
        screen.queryByRole("button", { name: /^finish$/i });
      expect(continueBtn).toBeNull();
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
