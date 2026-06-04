import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { DepsInstall } from "../04-deps.js";

// ---------------------------------------------------------------------------
// DepsInstall screen tests (US-002)
//
// The screen is non-interactive: it runs all required deps automatically on
// mount via runDepsInstall() and advances (onNext) without user interaction.
// Optional deps (git, gh, claude-code, homebrew) are silently skipped.
// A failed required dep surfaces an error + Retry button; the screen never
// renders per-dep Install buttons or Waiting-for-X locked rows.
// ---------------------------------------------------------------------------

// Track listen callbacks so tests can emit install:progress events
type EventCallback = (event: { payload: unknown }) => void;
const listenCallbacks = new Map<string, EventCallback[]>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
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

vi.mock("@/lib/install-manifest", () => ({
  getInstallerVersion: vi.fn().mockResolvedValue("0.0.0"),
  recordDependencies: vi.fn().mockResolvedValue(undefined),
  recordStepOk: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/wizard-state", () => ({
  getWizardState: vi.fn().mockReturnValue({ installPath: "/tmp/hq" }),
}));

import { invoke } from "@tauri-apps/api/core";

const mockInvoke = vi.mocked(invoke);

// Helpers

function invokeAllOk() {
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === "check_dep") return Promise.resolve({ installed: false });
    return Promise.resolve(undefined);
  });
}

function invokeFailNode() {
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === "check_dep") return Promise.resolve({ installed: false });
    if (cmd === "install_node") return Promise.reject(new Error("Install failed"));
    return Promise.resolve(undefined);
  });
}

// ---------------------------------------------------------------------------

describe("DepsInstall screen (04-deps.tsx)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listenCallbacks.clear();
    invokeAllOk();
  });

  // -------------------------------------------------------------------------
  describe("auto-run on mount", () => {
    it("renders the 'Installing dependencies' heading", () => {
      render(<DepsInstall onNext={vi.fn()} />);
      expect(screen.getByText(/installing dependencies/i)).toBeTruthy();
    });

    it("shows that required tools install automatically", () => {
      render(<DepsInstall onNext={vi.fn()} />);
      expect(document.body.textContent).toMatch(/required tools install automatically/i);
    });

    it("calls onNext automatically when all required deps succeed", async () => {
      const onNext = vi.fn();
      invokeAllOk();
      render(<DepsInstall onNext={onNext} />);
      await waitFor(() => {
        expect(onNext).toHaveBeenCalledTimes(1);
      });
    });

    it("does NOT render any Install button (non-interactive)", async () => {
      invokeAllOk();
      render(<DepsInstall onNext={vi.fn()} />);
      await waitFor(() => {
        // After install finishes there should be no install buttons
        const installBtns = screen.queryAllByRole("button", { name: /^install/i });
        expect(installBtns).toHaveLength(0);
      });
    });

    it("does NOT render any Waiting-for-X locked row text", async () => {
      invokeAllOk();
      render(<DepsInstall onNext={vi.fn()} />);
      await waitFor(() => {
        expect(document.body.textContent).not.toMatch(/waiting for/i);
      });
    });
  });

  // -------------------------------------------------------------------------
  describe("optional deps skipped", () => {
    it("marks optional dep rows with data-status='skipped'", async () => {
      invokeAllOk();
      render(<DepsInstall onNext={vi.fn()} />);
      await waitFor(() => {
        for (const id of ["git", "gh", "claude-code", "homebrew"]) {
          const row = document.querySelector(`[data-dep="${id}"]`);
          expect(row).not.toBeNull();
          expect(row!.getAttribute("data-status")).toBe("skipped");
        }
      });
    });

    it("does NOT call check_dep for optional deps (git, gh, claude-code, homebrew)", async () => {
      invokeAllOk();
      render(<DepsInstall onNext={vi.fn()} />);
      await waitFor(() => {
        // onNext gets called when done
        const onNext = vi.fn();
        return onNext;
      });
      // Give the install time to complete
      await new Promise((r) => setTimeout(r, 50));
      const optionalBinaries = ["brew", "git", "gh", "claude"];
      const calledTools = mockInvoke.mock.calls
        .filter(([cmd]) => cmd === "check_dep")
        .map(([, args]) => (args as Record<string, string>)?.tool);
      for (const binary of optionalBinaries) {
        expect(calledTools).not.toContain(binary);
      }
    });
  });

  // -------------------------------------------------------------------------
  describe("required dep rows", () => {
    it("renders a row for each required dep (node, yq, qmd, hq-cli)", async () => {
      invokeAllOk();
      render(<DepsInstall onNext={vi.fn()} />);
      await waitFor(() => {
        for (const id of ["node", "yq", "qmd", "hq-cli"]) {
          const row = document.querySelector(`[data-dep="${id}"]`);
          expect(row).not.toBeNull();
        }
      });
    });

    it("sets data-status='ok' on required dep rows that succeed", async () => {
      invokeAllOk();
      render(<DepsInstall onNext={vi.fn()} />);
      await waitFor(() => {
        for (const id of ["node", "yq", "qmd", "hq-cli"]) {
          const row = document.querySelector(`[data-dep="${id}"]`);
          expect(row?.getAttribute("data-status")).toBe("ok");
        }
      });
    });
  });

  // -------------------------------------------------------------------------
  describe("failure handling", () => {
    it("does NOT call onNext when a required dep fails", async () => {
      const onNext = vi.fn();
      invokeFailNode();
      render(<DepsInstall onNext={onNext} />);
      await waitFor(() => {
        const nodeRow = document.querySelector("[data-dep='node']");
        expect(nodeRow?.getAttribute("data-status")).toBe("failed");
      });
      expect(onNext).not.toHaveBeenCalled();
    });

    it("shows a Retry button when a required dep fails", async () => {
      invokeFailNode();
      render(<DepsInstall onNext={vi.fn()} />);
      await waitFor(() => {
        const retryBtn = screen.queryByRole("button", { name: /retry/i });
        expect(retryBtn).not.toBeNull();
      });
    });

    it("shows an error message when a required dep fails", async () => {
      invokeFailNode();
      render(<DepsInstall onNext={vi.fn()} />);
      await waitFor(() => {
        // Some error message must be visible
        const errorText =
          screen.queryByText(/failed to install/i) ||
          document.querySelector(".text-red-400");
        expect(errorText).not.toBeNull();
      });
    });

    it("clicking Retry re-runs the install", async () => {
      const user = userEvent.setup();
      let installAttempts = 0;

      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === "check_dep") return Promise.resolve({ installed: false });
        if (cmd === "install_node") {
          installAttempts++;
          return Promise.reject(new Error("Install failed"));
        }
        return Promise.resolve(undefined);
      });

      render(<DepsInstall onNext={vi.fn()} />);

      await waitFor(() => {
        expect(screen.queryByRole("button", { name: /retry/i })).not.toBeNull();
      });

      const firstAttempts = installAttempts;
      await user.click(screen.getByRole("button", { name: /retry/i }));

      await waitFor(() => {
        expect(installAttempts).toBeGreaterThan(firstAttempts);
      });
    });
  });

  // -------------------------------------------------------------------------
  describe("progress streaming", () => {
    it("registers a listener for 'install:progress' events on mount", async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const mockListen = vi.mocked(listen);

      render(<DepsInstall onNext={vi.fn()} />);

      await waitFor(() => {
        const registered = mockListen.mock.calls.some(
          ([event]) => event === "install:progress",
        );
        expect(registered).toBe(true);
      });
    });
  });

  // -------------------------------------------------------------------------
  describe("Tauri environment compatibility", () => {
    it("renders without throwing when Tauri APIs are mocked", () => {
      expect(() => {
        render(<DepsInstall onNext={vi.fn()} />);
      }).not.toThrow();
    });
  });
});
