import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const repoRoot = process.cwd();

/**
 * US-003: Rust core — dependency registry + install runners.
 *
 * Cargo unit + integration tests (`core::deps`, `core::runner`) are the
 * authoritative proof. This vitest suite is a structural smoke test that
 * runs in `pnpm test` so the renderer-side CI signals US-003 status.
 */
describe("US-003: Rust core — dependency registry + install runners", () => {
  describe("Module layout", () => {
    it("deps module exists", () => {
      expect(
        existsSync(join(repoRoot, "src-tauri/src/core/deps.rs"))
      ).toBe(true);
    });

    it("runner module exists", () => {
      expect(
        existsSync(join(repoRoot, "src-tauri/src/core/runner.rs"))
      ).toBe(true);
    });

    it("deps command wrapper exists", () => {
      expect(
        existsSync(join(repoRoot, "src-tauri/src/commands/deps.rs"))
      ).toBe(true);
    });

    it("deps integration test exists", () => {
      expect(
        existsSync(join(repoRoot, "src-tauri/tests/deps_test.rs"))
      ).toBe(true);
    });
  });

  describe("Tauri wiring", () => {
    const libRs = readFileSync(
      join(repoRoot, "src-tauri/src/lib.rs"),
      "utf-8"
    );

    it("registers dep_registry invoke command", () => {
      expect(libRs).toContain("commands::deps::dep_registry");
    });

    it("registers check_deps invoke command", () => {
      expect(libRs).toContain("commands::deps::check_deps");
    });

    it("registers install_dep invoke command", () => {
      expect(libRs).toContain("commands::deps::install_dep");
    });
  });

  describe("Cargo dependencies", () => {
    const cargo = readFileSync(
      join(repoRoot, "src-tauri/Cargo.toml"),
      "utf-8"
    );

    it("tokio declared with process + io-util features", () => {
      expect(cargo).toMatch(/^tokio\s*=/m);
      expect(cargo).toContain("\"process\"");
      expect(cargo).toContain("\"io-util\"");
    });
  });

  describe("Deps module contract", () => {
    const depsRs = readFileSync(
      join(repoRoot, "src-tauri/src/core/deps.rs"),
      "utf-8"
    );

    it("exposes DepDescriptor struct with id + install_commands", () => {
      expect(depsRs).toContain("pub struct DepDescriptor");
      expect(depsRs).toContain("pub id: DepId");
      expect(depsRs).toContain(
        "pub install_commands: HashMap<PackageManager, String>"
      );
    });

    it("defines PackageManager enum including Npm variant", () => {
      expect(depsRs).toContain("pub enum PackageManager");
      expect(depsRs).toContain("Npm,");
    });

    it("registry covers all AC #1 dep ids", () => {
      for (const id of [
        "Qmd",
        "Yq",
        "Claude",
        "Gh",
        "Vercel",
        "HqCli",
        "Node",
      ]) {
        expect(depsRs).toContain(`DepId::${id}`);
      }
    });

    it("exposes check_all, plan_install, get_install_command", () => {
      expect(depsRs).toContain("pub fn check_all()");
      expect(depsRs).toContain("pub fn plan_install(");
      expect(depsRs).toContain("pub fn get_install_command(");
    });

    it("rewrites sudo to pkexec on Linux for GUI polkit auth", () => {
      expect(depsRs).toContain("pub fn adapt_sudo_for_gui(");
      expect(depsRs).toContain("pkexec");
    });

    it("macOS sudo-free invariant test present", () => {
      expect(depsRs).toContain("no_macos_install_command_requires_sudo");
    });
  });

  describe("Runner module contract", () => {
    const runnerRs = readFileSync(
      join(repoRoot, "src-tauri/src/core/runner.rs"),
      "utf-8"
    );

    it("defines RunEvent enum with stdout/stderr/exit/error variants", () => {
      expect(runnerRs).toContain("pub enum RunEvent");
      expect(runnerRs).toContain("Stdout {");
      expect(runnerRs).toContain("Stderr {");
      expect(runnerRs).toContain("Exit {");
      expect(runnerRs).toContain("Error {");
    });

    it("exposes async run_streaming function", () => {
      expect(runnerRs).toContain("pub async fn run_streaming");
    });

    it("uses tokio::process::Command for async execution", () => {
      expect(runnerRs).toContain("tokio::process::Command");
    });
  });

  describe("Commands wiring", () => {
    const cmdDepsRs = readFileSync(
      join(repoRoot, "src-tauri/src/commands/deps.rs"),
      "utf-8"
    );

    it("install_dep emits events on dep-install:<dep-id> channel", () => {
      expect(cmdDepsRs).toContain("dep-install:");
      // Emits via Tauri AppHandle — either `app.emit(...)` or a cloned
      // handle like `app_for_sink.emit(...)`.
      expect(cmdDepsRs).toMatch(/\.emit\(/);
      expect(cmdDepsRs).toContain("use tauri::");
      expect(cmdDepsRs).toContain("Emitter");
    });

    it("install_dep is async", () => {
      expect(cmdDepsRs).toContain("pub async fn install_dep");
    });
  });
});
