import { render, screen } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WizardShell } from "../WizardShell.js";

// CustomTitlebar (rendered inside WizardShell) calls getCurrentWindow() from
// the Tauri window API once it detects a Tauri environment. Stub it so the
// Tauri-env render path doesn't throw on the unmocked native binding.
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isMaximized: vi.fn().mockResolvedValue(false),
    onResized: vi.fn().mockResolvedValue(() => {}),
    minimize: vi.fn().mockResolvedValue(undefined),
    toggleMaximize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  }),
}));

// ---------------------------------------------------------------------------
// WizardShell component tests — US-005 5-step contract
//
// The shell hosts the sidebar ProgressIndicator and the per-step content
// slot. With the flow collapsed to 5 steps (welcome → install → signin →
// setup → done), `currentStep` only ever takes values 1..5.
// ---------------------------------------------------------------------------

describe("WizardShell", () => {
  // -------------------------------------------------------------------------
  describe("children rendering", () => {
    it("renders its children", () => {
      render(
        <WizardShell currentStep={1}>
          <div data-testid="child-content">Hello from step</div>
        </WizardShell>,
      );
      expect(screen.getByTestId("child-content")).toBeTruthy();
      expect(screen.getByText("Hello from step")).toBeTruthy();
    });

    it("renders multiple children", () => {
      render(
        <WizardShell currentStep={1}>
          <span data-testid="child-a">A</span>
          <span data-testid="child-b">B</span>
        </WizardShell>,
      );
      expect(screen.getByTestId("child-a")).toBeTruthy();
      expect(screen.getByTestId("child-b")).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------
  describe("titlebar — data-tauri-drag-region placement", () => {
    it("renders a titlebar element with data-tauri-drag-region", () => {
      const { container } = render(
        <WizardShell currentStep={1}>
          <div>content</div>
        </WizardShell>,
      );
      const titlebars = container.querySelectorAll("[data-tauri-drag-region]");
      expect(titlebars.length).toBeGreaterThanOrEqual(1);
    });

    it("titlebar with data-tauri-drag-region has role=banner or data-testid=titlebar", () => {
      const { container } = render(
        <WizardShell currentStep={1}>
          <div>content</div>
        </WizardShell>,
      );
      const dragEl = container.querySelector("[data-tauri-drag-region]");
      expect(dragEl).not.toBeNull();
      const hasBannerRole = dragEl!.getAttribute("role") === "banner";
      const hasTitlebarTestId = dragEl!.getAttribute("data-testid") === "titlebar";
      // The titlebar strip should be identifiable — either by role or testid
      expect(hasBannerRole || hasTitlebarTestId).toBe(true);
    });

    it("data-tauri-drag-region is confined to the titlebar strip (main container does NOT carry it)", () => {
      const { container } = render(
        <WizardShell currentStep={1}>
          <div>content</div>
        </WizardShell>,
      );
      // The CustomTitlebar may mark several sub-regions draggable on Windows.
      // The invariant is that EVERY draggable element lives inside the
      // titlebar banner, and nothing in the body/main area is draggable.
      const titlebar = container.querySelector('[data-testid="titlebar"]');
      expect(titlebar).not.toBeNull();
      const dragEls = container.querySelectorAll("[data-tauri-drag-region]");
      expect(dragEls.length).toBeGreaterThanOrEqual(1);
      for (const el of dragEls) {
        expect(el === titlebar || titlebar!.contains(el)).toBe(true);
      }
    });

    it("main container / overlay panel does NOT have data-tauri-drag-region", () => {
      const { container } = render(
        <WizardShell currentStep={1}>
          <div>content</div>
        </WizardShell>,
      );
      // The root element (first child of container) must not carry data-tauri-drag-region
      const root = container.firstElementChild;
      expect(root).not.toBeNull();
      expect(root!.hasAttribute("data-tauri-drag-region")).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe("Tauri detection — window.__TAURI_INTERNALS__", () => {
    beforeEach(() => {
      // Simulate non-Tauri browser environment
      Object.defineProperty(window, "__TAURI_INTERNALS__", {
        value: undefined,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(window, "__TAURI__", {
        value: undefined,
        writable: true,
        configurable: true,
      });
    });

    afterEach(() => {
      // Clean up
      // @ts-expect-error — deleting non-standard window property
      delete window.__TAURI_INTERNALS__;
      // @ts-expect-error — deleting non-standard window property
      delete window.__TAURI__;
    });

    it("renders without errors in non-Tauri browser environment (__TAURI_INTERNALS__ undefined)", () => {
      expect(() => {
        render(
          <WizardShell currentStep={1}>
            <div>content</div>
          </WizardShell>,
        );
      }).not.toThrow();
    });

    it("renders without errors when __TAURI_INTERNALS__ is set (Tauri environment)", () => {
      // @ts-expect-error — setting non-standard window property for test
      window.__TAURI_INTERNALS__ = { invoke: vi.fn() };
      expect(() => {
        render(
          <WizardShell currentStep={1}>
            <div>content</div>
          </WizardShell>,
        );
      }).not.toThrow();
    });

    it("does NOT reference window.__TAURI__ for Tauri detection (legacy API)", () => {
      // Set __TAURI__ but NOT __TAURI_INTERNALS__ — component should behave as non-Tauri
      // @ts-expect-error — setting non-standard window property for test
      window.__TAURI__ = { invoke: vi.fn() };
      // @ts-expect-error — setting non-standard window property for test
      window.__TAURI_INTERNALS__ = undefined;

      render(
        <WizardShell currentStep={1}>
          <div data-testid="step-content">content</div>
        </WizardShell>,
      );

      // Should render normally (not crash) — the key assertion is that
      // __TAURI__ alone doesn't change behavior when __TAURI_INTERNALS__ is absent.
      expect(screen.getByTestId("step-content")).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------
  describe("monochrome / zinc theme — no color accents", () => {
    it("renders without purple class names in the DOM", () => {
      const { container } = render(
        <WizardShell currentStep={1}>
          <div>content</div>
        </WizardShell>,
      );
      expect(container.innerHTML).not.toMatch(/\bpurple\b/);
    });

    it("renders without indigo class names in the DOM", () => {
      const { container } = render(
        <WizardShell currentStep={1}>
          <div>content</div>
        </WizardShell>,
      );
      expect(container.innerHTML).not.toMatch(/\bindigo\b/);
    });
  });

  // -------------------------------------------------------------------------
  describe("ProgressIndicator integration", () => {
    it("renders ProgressIndicator with step numbers visible", () => {
      render(
        <WizardShell currentStep={1}>
          <div>content</div>
        </WizardShell>,
      );
      // WizardShell should embed the ProgressIndicator — step 1 numeral visible
      expect(screen.getByText("1")).toBeTruthy();
    });

    it("passes currentStep to ProgressIndicator correctly", () => {
      render(
        <WizardShell currentStep={4}>
          <div>content</div>
        </WizardShell>,
      );
      // Step 4 numeral should be visible (Setup in the 5-step flow)
      expect(screen.getByText("4")).toBeTruthy();
    });
  });
});
