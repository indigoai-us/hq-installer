import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { render, screen } from "@testing-library/react";
import { clearWizardState, setTelemetryEnabled } from "@/lib/wizard-state";
import App from "../../src/App";

const repoRoot = process.cwd(); // vitest runs from repo root
const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

describe("US-001: Scaffold hq-installer repo + Tauri 2 project + CI", () => {
  beforeEach(() => {
    clearWizardState();
    setTelemetryEnabled(false);
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(true);
  });

  describe("Quality gate prerequisites", () => {
    it("package.json has all required quality gate scripts", () => {
      const pkg = JSON.parse(
        readFileSync(join(repoRoot, "package.json"), "utf-8")
      );
      expect(pkg.scripts).toHaveProperty("typecheck");
      expect(pkg.scripts).toHaveProperty("lint");
      expect(pkg.scripts).toHaveProperty("test");
      expect(pkg.scripts).toHaveProperty("build");
    });

    it("CI workflow exists and covers typecheck, lint, test, and cargo check steps", () => {
      const ciPath = join(repoRoot, ".github/workflows/ci.yml");
      expect(existsSync(ciPath)).toBe(true);
      const ci = readFileSync(ciPath, "utf-8");
      expect(ci).toContain("typecheck");
      expect(ci).toContain("lint");
      expect(ci).toContain("pnpm test");
      expect(ci).toContain("cargo check");
    });

    it("TypeScript config exists", () => {
      expect(existsSync(join(repoRoot, "tsconfig.json"))).toBe(true);
    });

    it("Cargo.toml exists for Rust backend", () => {
      expect(existsSync(join(repoRoot, "src-tauri/Cargo.toml"))).toBe(true);
    });

    it("README.md describes dev setup and quality gates", () => {
      const readme = readFileSync(join(repoRoot, "README.md"), "utf-8");
      expect(readme).toContain("pnpm install");
      expect(readme).toContain("typecheck");
      expect(readme).toContain("lint");
    });
  });

  describe("Monochrome React app rendering", () => {
    it("renders Set up HQ heading without errors", async () => {
      render(<App />);
      expect(await screen.findByText(/Set up HQ/i)).toBeTruthy();
    });

    it("renders monochrome zinc dark background (no purple classes)", async () => {
      const { container } = render(<App />);
      await screen.findByText(/Set up HQ/i);
      const html = container.innerHTML;
      expect(html).not.toMatch(/purple-/);
      expect(html).toContain("bg-zinc-950");
    });

    it("renders Get Started primary button", async () => {
      render(<App />);
      expect(
        await screen.findByRole("button", { name: /Get Started/i })
      ).toBeTruthy();
    });

    it("renders wizard overview steps list (via sidebar ProgressIndicator)", async () => {
      render(<App />);
      // Steps moved from a duplicated body list into the persistent sidebar.
      // "Sign In" is a sidebar-exclusive label in the 5-step flow — confirms
      // the sidebar rendered.
      expect(await screen.findByText(/Sign In/i)).toBeTruthy();
    });

    it("renders telemetry opt-in label", async () => {
      render(<App />);
      expect(
        await screen.findByText(/sharing anonymous usage telemetry/i)
      ).toBeTruthy();
    });
  });
});
