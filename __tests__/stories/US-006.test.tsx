import { describe, it, expect } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import Welcome from "@/routes/Welcome";
import RetroHeader from "@/components/RetroHeader";
import DepStatusRow from "@/components/DepStatusRow";
import { rowStateFromResult } from "@/components/depRowState";
import BuildingSvg from "@/routes/Welcome/BuildingSvg";
import SystemScan from "@/routes/Welcome/SystemScan";
import {
  DEP_ORDER,
  DEP_DISPLAY_NAME,
  allRequiredInstalled,
  missingAnyCount,
  missingRequiredCount,
  type CheckResult,
  type DepDescriptor,
} from "@/lib/tauri-invoke";

const repoRoot = process.cwd();

/**
 * US-006: Retro-TUI welcome + system scan.
 *
 * Mix of structural + render assertions. The renderer tree hits the global
 * `@tauri-apps/api/core` mock installed in `src/test-setup.ts` so scans
 * resolve deterministically.
 */
describe("US-006: Retro-TUI welcome + system scan", () => {
  describe("File scaffold", () => {
    it("retro.css stylesheet exists", () => {
      expect(
        existsSync(join(repoRoot, "src/styles/retro.css"))
      ).toBe(true);
    });

    it("retro.css is imported from index.css", () => {
      const indexCss = readFileSync(
        join(repoRoot, "src/index.css"),
        "utf-8"
      );
      expect(indexCss).toMatch(/@import\s+["']\.\/styles\/retro\.css["']/);
    });

    it("BuildingSvg, RetroHeader, DepStatusRow, SystemScan, Welcome all exist", () => {
      const paths = [
        "src/routes/Welcome/BuildingSvg.tsx",
        "src/components/RetroHeader.tsx",
        "src/components/DepStatusRow.tsx",
        "src/routes/Welcome/SystemScan.tsx",
        "src/routes/Welcome/index.tsx",
      ];
      for (const p of paths) {
        expect(existsSync(join(repoRoot, p))).toBe(true);
      }
    });

    it("tauri.conf.json window is 960x700 with minWidth 900 minHeight 600", () => {
      const conf = JSON.parse(
        readFileSync(join(repoRoot, "src-tauri/tauri.conf.json"), "utf-8")
      );
      const win = conf.app.windows[0];
      expect(win.width).toBe(960);
      expect(win.height).toBe(700);
      expect(win.minWidth).toBe(900);
      expect(win.minHeight).toBe(600);
      expect(win.resizable).toBe(true);
    });
  });

  describe("tauri-invoke typed wrapper", () => {
    it("DEP_ORDER matches spec §3", () => {
      expect([...DEP_ORDER]).toEqual([
        "node",
        "git",
        "gh",
        "claude",
        "qmd",
        "yq",
        "vercel",
        "hq-cli",
      ]);
    });

    it("DEP_DISPLAY_NAME covers every DepId", () => {
      for (const id of DEP_ORDER) {
        expect(DEP_DISPLAY_NAME[id]).toBeTruthy();
      }
    });

    it("missingAnyCount counts every missing dep", () => {
      const results: CheckResult[] = [
        { dep_id: "node", installed: true, detected_version: "20" },
        { dep_id: "git", installed: false, detected_version: null },
        { dep_id: "gh", installed: false, detected_version: null },
      ];
      expect(missingAnyCount(results)).toBe(2);
    });

    it("missingRequiredCount ignores optional deps", () => {
      const descriptors: DepDescriptor[] = [
        {
          id: "node",
          name: "Node.js",
          check_cmd: "",
          required: true,
          auto_installable: true,
          install_hint: "",
          install_commands: {},
        },
        {
          id: "qmd",
          name: "qmd",
          check_cmd: "",
          required: false,
          auto_installable: true,
          install_hint: "",
          install_commands: {},
        },
      ];
      const results: CheckResult[] = [
        { dep_id: "node", installed: false, detected_version: null },
        { dep_id: "qmd", installed: false, detected_version: null },
      ];
      expect(missingRequiredCount(results, descriptors)).toBe(1);
    });

    it("allRequiredInstalled returns true when required deps present", () => {
      const descriptors: DepDescriptor[] = [
        {
          id: "node",
          name: "Node.js",
          check_cmd: "",
          required: true,
          auto_installable: true,
          install_hint: "",
          install_commands: {},
        },
      ];
      const results: CheckResult[] = [
        { dep_id: "node", installed: true, detected_version: "20" },
      ];
      expect(allRequiredInstalled(results, descriptors)).toBe(true);
    });

    it("rowStateFromResult maps undefined → scanning, installed, missing", () => {
      expect(rowStateFromResult(undefined)).toBe("scanning");
      expect(
        rowStateFromResult({
          dep_id: "node",
          installed: true,
          detected_version: "20",
        })
      ).toBe("installed");
      expect(
        rowStateFromResult({
          dep_id: "node",
          installed: false,
          detected_version: null,
        })
      ).toBe("missing");
    });
  });

  describe("BuildingSvg", () => {
    it("renders an accessible office building SVG", () => {
      render(<BuildingSvg />);
      const svg = screen.getByTestId("retro-building-svg");
      expect(svg).toBeInTheDocument();
      expect(svg.getAttribute("role")).toBe("img");
      expect(svg.getAttribute("aria-label")).toMatch(/office building/i);
    });

    it("renders 12 windows (3 rows × 4 columns)", () => {
      render(<BuildingSvg />);
      const windows: HTMLElement[] = [];
      for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 4; col++) {
          windows.push(screen.getByTestId(`retro-window-${row}-${col}`));
        }
      }
      expect(windows).toHaveLength(12);
    });
  });

  describe("RetroHeader", () => {
    it("renders the INDIGO HQ block heading", () => {
      render(<RetroHeader />);
      expect(screen.getByTestId("retro-header")).toBeInTheDocument();
      expect(screen.getByTestId("retro-heading")).toHaveTextContent(
        /INDIGO HQ/
      );
    });

    it("uses the default Personal OS tagline", () => {
      render(<RetroHeader />);
      expect(
        screen.getByText(/Personal OS for AI Workers/i)
      ).toBeInTheDocument();
    });
  });

  describe("DepStatusRow", () => {
    it("renders the scanning glyph while waiting", () => {
      render(<DepStatusRow depId="node" state="scanning" />);
      const row = screen.getByTestId("dep-row-node");
      expect(row).toHaveAttribute("data-state", "scanning");
      expect(row).toHaveTextContent("…");
      expect(row).toHaveTextContent("Node.js");
    });

    it("shows version when installed", () => {
      render(
        <DepStatusRow
          depId="node"
          state="installed"
          version="v20.11.0"
        />
      );
      const row = screen.getByTestId("dep-row-node");
      expect(row).toHaveAttribute("data-state", "installed");
      expect(row).toHaveTextContent("v20.11.0");
      expect(row).toHaveTextContent("✓");
    });

    it("shows required-vs-optional label when missing", () => {
      render(<DepStatusRow depId="git" state="missing" required />);
      expect(screen.getByTestId("dep-row-git")).toHaveTextContent(
        /not found.*required/i
      );

      render(<DepStatusRow depId="qmd" state="missing" />);
      expect(screen.getByTestId("dep-row-qmd")).toHaveTextContent(
        /not found.*optional/i
      );
    });
  });

  describe("SystemScan", () => {
    it("renders one row per dep and resolves to installed via mocks", async () => {
      render(<SystemScan />);
      const scan = screen.getByTestId("system-scan");
      expect(scan).toBeInTheDocument();

      // Each DepId gets its own row.
      for (const id of DEP_ORDER) {
        expect(screen.getByTestId(`dep-row-${id}`)).toBeInTheDocument();
      }

      // Platform label flips from "detecting…" to "macos · brew".
      await waitFor(() => {
        expect(screen.getByTestId("system-scan-platform")).toHaveTextContent(
          /macos/
        );
      });

      // All rows arrive at installed state from the mocked check_deps.
      await waitFor(() => {
        for (const id of DEP_ORDER) {
          expect(screen.getByTestId(`dep-row-${id}`)).toHaveAttribute(
            "data-state",
            "installed"
          );
        }
      });
    });

    it("fires onScanComplete with platform + descriptors + results", async () => {
      const onScanComplete = vi.fn();
      render(<SystemScan onScanComplete={onScanComplete} />);
      await waitFor(() => {
        expect(onScanComplete).toHaveBeenCalledTimes(1);
      });
      const payload = onScanComplete.mock.calls[0]?.[0];
      expect(payload.platform.os).toBe("macos");
      expect(payload.descriptors.length).toBe(DEP_ORDER.length);
      expect(payload.results.length).toBe(DEP_ORDER.length);
    });
  });

  describe("Welcome route", () => {
    it("composes RetroHeader + SystemScan + CTAs", async () => {
      render(<Welcome />);
      expect(screen.getByTestId("welcome-route")).toBeInTheDocument();
      expect(screen.getByTestId("retro-header")).toBeInTheDocument();
      expect(screen.getByTestId("system-scan")).toBeInTheDocument();
      expect(screen.getByTestId("welcome-cta-primary")).toBeInTheDocument();
      expect(screen.getByTestId("welcome-cta-secondary")).toBeInTheDocument();
      await waitFor(() => {
        expect(
          screen.getByTestId("welcome-cta-primary")
        ).not.toBeDisabled();
      });
    });

    it("primary CTA starts disabled and enables after scan", async () => {
      render(<Welcome />);
      const cta = screen.getByTestId("welcome-cta-primary");
      expect(cta).toBeDisabled();
      expect(cta).toHaveTextContent(/Scanning…/);
      await waitFor(() => {
        expect(cta).not.toBeDisabled();
      });
      expect(cta).toHaveTextContent(/Install HQ/);
    });
  });
});
