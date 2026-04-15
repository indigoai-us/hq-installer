import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const repoRoot = process.cwd();

/**
 * US-002: Rust core — OS + package manager detection.
 *
 * Cargo unit + integration tests (in `src-tauri/`) are the authoritative
 * proof for this story. This vitest suite is a lightweight structural gate
 * that runs in the `pnpm test` quality check so the renderer-side CI surfaces
 * US-002 status without needing to shell out to cargo.
 */
describe("US-002: Rust core — OS + package manager detection", () => {
  describe("Module layout", () => {
    it("core module declared", () => {
      expect(
        existsSync(join(repoRoot, "src-tauri/src/core/mod.rs"))
      ).toBe(true);
    });

    it("platform module exists", () => {
      expect(
        existsSync(join(repoRoot, "src-tauri/src/core/platform.rs"))
      ).toBe(true);
    });

    it("commands module declared", () => {
      expect(
        existsSync(join(repoRoot, "src-tauri/src/commands/mod.rs"))
      ).toBe(true);
    });

    it("platform command wrapper exists", () => {
      expect(
        existsSync(join(repoRoot, "src-tauri/src/commands/platform.rs"))
      ).toBe(true);
    });

    it("platform integration test exists", () => {
      expect(
        existsSync(join(repoRoot, "src-tauri/tests/platform_test.rs"))
      ).toBe(true);
    });
  });

  describe("Tauri wiring", () => {
    it("lib.rs registers detect_platform invoke command", () => {
      const libRs = readFileSync(
        join(repoRoot, "src-tauri/src/lib.rs"),
        "utf-8"
      );
      expect(libRs).toContain("pub mod commands");
      expect(libRs).toContain("pub mod core");
      expect(libRs).toContain("commands::platform::detect_platform");
    });
  });

  describe("Cargo dependencies", () => {
    it("which crate declared for binary detection", () => {
      const cargo = readFileSync(
        join(repoRoot, "src-tauri/Cargo.toml"),
        "utf-8"
      );
      expect(cargo).toMatch(/^which\s*=/m);
    });
  });

  describe("Platform module contract", () => {
    const platformRs = readFileSync(
      join(repoRoot, "src-tauri/src/core/platform.rs"),
      "utf-8"
    );

    it("exposes OsType enum with required variants", () => {
      expect(platformRs).toContain("pub enum OsType");
      for (const variant of [
        "Macos",
        "LinuxDebian",
        "LinuxFedora",
        "LinuxArch",
        "Linux",
        "Windows",
        "Unix",
      ]) {
        expect(platformRs).toContain(variant);
      }
    });

    it("exposes SystemPackageManager enum with required variants", () => {
      expect(platformRs).toContain("pub enum SystemPackageManager");
      for (const pm of [
        "Brew",
        "Apt",
        "Dnf",
        "Yum",
        "Pacman",
        "Winget",
        "Choco",
      ]) {
        expect(platformRs).toContain(pm);
      }
    });

    it("exposes PlatformInfo struct serializable to renderer", () => {
      expect(platformRs).toContain("pub struct PlatformInfo");
      expect(platformRs).toContain("pub os: OsType");
      expect(platformRs).toContain(
        "pub package_manager: Option<SystemPackageManager>"
      );
      expect(platformRs).toContain("pub npm_available: bool");
    });

    it("exposes detect_platform entry point", () => {
      expect(platformRs).toContain("pub fn detect_platform() -> PlatformInfo");
    });

    it("PlatformInfo fields serialize to camelCase for renderer", () => {
      expect(platformRs).toContain('rename = "packageManager"');
      expect(platformRs).toContain('rename = "npmAvailable"');
    });
  });
});
