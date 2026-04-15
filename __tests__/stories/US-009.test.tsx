import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { existsSync } from "fs";
import { join } from "path";
import { invoke } from "@tauri-apps/api/core";
import { open as openShellPath } from "@tauri-apps/plugin-shell";
import SuccessRoute from "@/routes/Success";
import ConfettiOverlay from "@/routes/Success/ConfettiOverlay";
import {
  trackEvent,
  setAnalyticsTransport,
  getOrCreateInstallId,
} from "@/lib/analytics";
import type { CheckResult } from "@/lib/tauri-invoke";
import type { LocationResult } from "@/routes/Location";

const repoRoot = process.cwd();
const invokeMock = vi.mocked(invoke);
const openShellMock = vi.mocked(openShellPath);

const sampleDeps: CheckResult[] = [
  { dep_id: "node", installed: true, detected_version: "v20.11.0" },
  { dep_id: "git", installed: true, detected_version: "2.41.0" },
  { dep_id: "gh", installed: true, detected_version: "2.42.0" },
  { dep_id: "claude", installed: true, detected_version: "1.0.0" },
  { dep_id: "qmd", installed: false, detected_version: null },
];

const sampleLocation: LocationResult = {
  target_dir: "/Users/test/hq",
  mode: "scaffold",
  detail: "14 files",
};

/**
 * US-009: Success screen + handoff to Claude Code.
 *
 * Split across:
 *   1. File scaffold presence check
 *   2. analytics module unit tests (trackEvent, install id, transport swap)
 *   3. ConfettiOverlay render + prefers-reduced-motion
 *   4. SuccessRoute end-to-end: summary render, Open in Claude happy path,
 *      not-found fallback, error state, Reveal in Finder, Read the guide,
 *      platform-aware reveal label, analytics fires on mount
 */
describe("US-009: Success + handoff to Claude Code", () => {
  beforeEach(() => {
    // Each test gets a fresh invoke call history — the Success screen
    // inspects call order/counts, and stale history from prior tests in
    // this file (analytics + Success end-to-end share the mock) would
    // make assertions non-deterministic.
    invokeMock.mockClear();
    openShellMock.mockClear();
    // analytics module uses localStorage — clear between tests so
    // "new install" tests don't inherit a cached id.
    try {
      globalThis.localStorage?.clear();
    } catch {
      /* ignore — memory fallback */
    }
  });

  describe("File scaffold", () => {
    it("success route files all exist", () => {
      const paths = [
        "src/routes/Success/index.tsx",
        "src/routes/Success/ConfettiOverlay.tsx",
        "src/lib/analytics.ts",
        "src-tauri/src/commands/launch.rs",
      ];
      for (const p of paths) {
        expect(existsSync(join(repoRoot, p))).toBe(true);
      }
    });
  });

  describe("analytics module", () => {
    it("trackEvent fires the injected transport with name + install_id + props", () => {
      const calls: Array<{ name: string; install_id: string; props: Record<string, unknown> }> = [];
      const restore = setAnalyticsTransport((event) => {
        calls.push({
          name: event.name,
          install_id: event.install_id,
          props: event.props,
        });
      });

      trackEvent("install.completed", { duration_seconds: 42 });

      expect(calls).toHaveLength(1);
      expect(calls[0]!.name).toBe("install.completed");
      expect(calls[0]!.install_id).toMatch(/^[0-9a-f-]+$/);
      expect(calls[0]!.props).toEqual({ duration_seconds: 42 });

      restore();
    });

    it("getOrCreateInstallId is stable across calls (persisted in localStorage)", () => {
      const first = getOrCreateInstallId();
      const second = getOrCreateInstallId();
      expect(first).toBe(second);
      expect(first.length).toBeGreaterThan(8);
    });

    it("setAnalyticsTransport returns a restore function that unwires the override", () => {
      const transportCalls: string[] = [];
      const restore = setAnalyticsTransport((event) => {
        transportCalls.push(event.name);
      });
      trackEvent("install.started", {});
      expect(transportCalls).toHaveLength(1);

      restore();
      // After restore, the default transport (console.info) is back —
      // spy on it so we can verify without swallowing real console output.
      const consoleSpy = vi.spyOn(console, "info").mockImplementation(() => {});
      trackEvent("install.completed", {});
      expect(consoleSpy).toHaveBeenCalled();
      // And the earlier override did not receive the second event.
      expect(transportCalls).toHaveLength(1);
      consoleSpy.mockRestore();
    });

    it("trackEvent never throws even if transport explodes", () => {
      const restore = setAnalyticsTransport(() => {
        throw new Error("boom");
      });
      // Must not propagate — analytics is fire-and-forget.
      expect(() => trackEvent("install.failed", {})).not.toThrow();
      restore();
    });
  });

  describe("ConfettiOverlay", () => {
    it("renders 24 pieces when motion is allowed", () => {
      render(<ConfettiOverlay />);
      const overlay = screen.getByTestId("confetti-overlay");
      expect(overlay).toBeInTheDocument();
      // 24 pieces — PIECE_COUNT constant in ConfettiOverlay.
      for (let i = 0; i < 24; i++) {
        expect(screen.getByTestId(`confetti-piece-${i}`)).toBeInTheDocument();
      }
    });

    it("renders nothing when prefers-reduced-motion is set", () => {
      // Override matchMedia for this test only.
      const originalMatchMedia = window.matchMedia;
      Object.defineProperty(window, "matchMedia", {
        value: vi.fn((query: string) => ({
          matches: query.includes("reduce"),
          media: query,
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        })),
        writable: true,
        configurable: true,
      });

      const { container } = render(<ConfettiOverlay />);
      expect(container.firstChild).toBeNull();

      // Restore.
      Object.defineProperty(window, "matchMedia", {
        value: originalMatchMedia,
        writable: true,
        configurable: true,
      });
    });

    it("fires onDone exactly once after all pieces finish animating", () => {
      const onDone = vi.fn();
      render(<ConfettiOverlay onDone={onDone} />);

      // Simulate 24 animationEnd events firing in sequence.
      for (let i = 0; i < 24; i++) {
        const piece = screen.getByTestId(`confetti-piece-${i}`);
        fireEvent.animationEnd(piece);
      }

      expect(onDone).toHaveBeenCalledTimes(1);
    });
  });

  describe("SuccessRoute end-to-end", () => {
    it("renders location, mode, and deps summary", () => {
      render(
        <SuccessRoute
          location={sampleLocation}
          finalDeps={sampleDeps}
          durationSeconds={87}
        />,
      );

      expect(screen.getByTestId("success-route")).toBeInTheDocument();
      expect(screen.getByTestId("summary-location")).toHaveTextContent(
        "/Users/test/hq",
      );
      expect(screen.getByTestId("summary-mode")).toHaveTextContent(
        "fresh (14 files)",
      );
      // 4 installed / 5 total.
      expect(screen.getByTestId("summary-deps-count")).toHaveTextContent("4 / 5");
      expect(screen.getByTestId("summary-deps-missing")).toHaveTextContent("qmd");
    });

    it("shows clone detail when mode is 'clone'", () => {
      render(
        <SuccessRoute
          location={{ target_dir: "/tmp/hq", mode: "clone", detail: "indigoai-us/hq" }}
          finalDeps={sampleDeps.slice(0, 4)}
          durationSeconds={10}
        />,
      );
      expect(screen.getByTestId("summary-mode")).toHaveTextContent(
        "cloned from indigoai-us/hq",
      );
    });

    it("fires install.completed analytics on mount", async () => {
      const events: string[] = [];
      const restore = setAnalyticsTransport((event) => {
        events.push(event.name);
      });

      render(
        <SuccessRoute
          location={sampleLocation}
          finalDeps={sampleDeps}
          durationSeconds={42}
        />,
      );

      await waitFor(() => expect(events).toContain("install.completed"));
      restore();
    });

    it("'Open in Claude Code' happy path → launched state", async () => {
      // Default mock returns spawned — just trigger the click.
      render(
        <SuccessRoute
          location={sampleLocation}
          finalDeps={sampleDeps}
          durationSeconds={20}
        />,
      );

      fireEvent.click(screen.getByTestId("success-open-claude"));

      await waitFor(() => {
        expect(screen.getByTestId("success-launched")).toBeInTheDocument();
      });
      expect(screen.getByTestId("success-route")).toHaveAttribute(
        "data-launch-state",
        "launched",
      );
    });

    it("'Open in Claude Code' not-found → fallback with copyable cmd", async () => {
      invokeMock.mockImplementationOnce(async () => ({
        result: "err",
        kind: "not-found",
        message: "claude CLI is not on PATH",
      }));

      render(
        <SuccessRoute
          location={sampleLocation}
          finalDeps={sampleDeps}
          durationSeconds={20}
        />,
      );

      fireEvent.click(screen.getByTestId("success-open-claude"));

      await waitFor(() => {
        expect(screen.getByTestId("success-fallback")).toBeInTheDocument();
      });
      expect(screen.getByTestId("success-fallback-cmd")).toHaveTextContent(
        `cd "${sampleLocation.target_dir}" && claude`,
      );
      expect(screen.getByTestId("success-route")).toHaveAttribute(
        "data-launch-state",
        "fallback",
      );
    });

    it("'Open in Claude Code' spawn-failed → error state", async () => {
      invokeMock.mockImplementationOnce(async () => ({
        result: "err",
        kind: "spawn-failed",
        message: "fork failed",
      }));

      render(
        <SuccessRoute
          location={sampleLocation}
          finalDeps={sampleDeps}
          durationSeconds={20}
        />,
      );

      fireEvent.click(screen.getByTestId("success-open-claude"));

      await waitFor(() => {
        expect(screen.getByTestId("success-error")).toBeInTheDocument();
      });
      expect(screen.getByTestId("success-error")).toHaveTextContent("fork failed");
    });

    it("fallback 'Copy' button invokes navigator.clipboard.writeText", async () => {
      invokeMock.mockImplementationOnce(async () => ({
        result: "err",
        kind: "not-found",
        message: "no claude",
      }));

      render(
        <SuccessRoute
          location={sampleLocation}
          finalDeps={sampleDeps}
          durationSeconds={20}
        />,
      );

      fireEvent.click(screen.getByTestId("success-open-claude"));
      await waitFor(() =>
        expect(screen.getByTestId("success-fallback")).toBeInTheDocument(),
      );

      const writeText = navigator.clipboard.writeText as ReturnType<typeof vi.fn>;
      writeText.mockClear();
      fireEvent.click(screen.getByTestId("success-fallback-copy"));
      await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
      expect(writeText).toHaveBeenCalledWith(
        `cd "${sampleLocation.target_dir}" && claude`,
      );
    });

    it("'Reveal in Finder' calls reveal_in_file_manager", async () => {
      render(
        <SuccessRoute
          location={sampleLocation}
          finalDeps={sampleDeps}
          durationSeconds={20}
          platform="macos"
        />,
      );

      expect(screen.getByTestId("success-reveal")).toHaveTextContent(
        "Reveal in Finder",
      );
      fireEvent.click(screen.getByTestId("success-reveal"));

      await waitFor(() => {
        const revealCalls = invokeMock.mock.calls.filter(
          (c) => c[0] === "reveal_in_file_manager",
        );
        expect(revealCalls).toHaveLength(1);
      });
    });

    it("reveal button label matches platform", () => {
      const { rerender } = render(
        <SuccessRoute
          location={sampleLocation}
          finalDeps={sampleDeps}
          durationSeconds={20}
          platform="windows"
        />,
      );
      expect(screen.getByTestId("success-reveal")).toHaveTextContent(
        "Show in Explorer",
      );

      rerender(
        <SuccessRoute
          location={sampleLocation}
          finalDeps={sampleDeps}
          durationSeconds={20}
          platform="linux"
        />,
      );
      expect(screen.getByTestId("success-reveal")).toHaveTextContent(
        "Open in file manager",
      );
    });

    it("'Read the USER-GUIDE' opens via tauri-plugin-shell", async () => {
      render(
        <SuccessRoute
          location={sampleLocation}
          finalDeps={sampleDeps}
          durationSeconds={20}
        />,
      );

      fireEvent.click(screen.getByTestId("success-open-guide"));

      await waitFor(() => {
        expect(openShellMock).toHaveBeenCalledTimes(1);
      });
      expect(openShellMock.mock.calls[0]![0]).toMatch(/USER-GUIDE/);
    });

    it("hides Missing row when all deps installed", () => {
      const allInstalled = sampleDeps.map((d) => ({ ...d, installed: true }));
      render(
        <SuccessRoute
          location={sampleLocation}
          finalDeps={allInstalled}
          durationSeconds={5}
        />,
      );
      expect(screen.queryByTestId("summary-deps-missing")).not.toBeInTheDocument();
    });

    it("heading renders elapsed seconds", () => {
      render(
        <SuccessRoute
          location={sampleLocation}
          finalDeps={sampleDeps}
          durationSeconds={127}
        />,
      );
      expect(screen.getByTestId("success-heading")).toHaveTextContent("HQ is ready");
      // The subtitle under the heading shows "installed in 127s".
      expect(screen.getByText(/installed in 127s/)).toBeInTheDocument();
    });
  });
});
