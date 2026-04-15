import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { render, screen } from "@testing-library/react";
import App from "../../src/App";

const repoRoot = process.cwd(); // vitest runs from repo root

describe("US-001: Scaffold hq-installer repo + Tauri 2 project + CI", () => {
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

    it("CI workflow exists and covers typecheck, lint, test, and cargo test steps", () => {
      const ciPath = join(repoRoot, ".github/workflows/ci.yml");
      expect(existsSync(ciPath)).toBe(true);
      const ci = readFileSync(ciPath, "utf-8");
      expect(ci).toContain("typecheck");
      expect(ci).toContain("lint");
      expect(ci).toContain("pnpm test");
      expect(ci).toContain("cargo test");
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
    it("renders HQ Installer heading without errors", () => {
      render(<App />);
      expect(screen.getByText(/HQ Installer/i)).toBeTruthy();
    });

    it("renders monochrome zinc dark background (no purple classes)", () => {
      const { container } = render(<App />);
      const html = container.innerHTML;
      expect(html).not.toMatch(/purple-/);
      expect(html).toContain("bg-zinc-950");
    });

    it("renders Get Started primary button", () => {
      render(<App />);
      expect(
        screen.getByRole("button", { name: /Get Started/i })
      ).toBeTruthy();
    });

    it("renders Learn More secondary button", () => {
      render(<App />);
      expect(
        screen.getByRole("button", { name: /Learn More/i })
      ).toBeTruthy();
    });

    it("renders workspace setup subtitle text", () => {
      render(<App />);
      expect(
        screen.getByText(/Setting up your workspace/i)
      ).toBeTruthy();
    });
  });
});
