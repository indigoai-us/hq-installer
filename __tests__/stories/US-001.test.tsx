import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { render, screen, waitFor } from "@testing-library/react";
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

  describe("App boots without errors", () => {
    // US-001 only needs to prove the React shell renders cleanly; the
    // Welcome-route UI contract (INDIGO HQ heading, CTAs, system scan)
    // is exercised by US-006's test suite.
    it("mounts the app root and shows the welcome route", async () => {
      render(<App />);
      expect(screen.getByTestId("welcome-route")).toBeTruthy();
      // Let SystemScan's async effects settle so no state updates
      // escape the test's act() boundary.
      await waitFor(() => {
        expect(
          screen.getByTestId("welcome-cta-primary")
        ).not.toBeDisabled();
      });
    });

    it("contains no legacy purple accent classes", async () => {
      const { container } = render(<App />);
      expect(container.innerHTML).not.toMatch(/purple-/);
      await waitFor(() => {
        expect(
          screen.getByTestId("welcome-cta-primary")
        ).not.toBeDisabled();
      });
    });
  });
});
