import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, statSync } from "fs";
import { join } from "path";

const repoRoot = process.cwd();

/**
 * US-004: Rust core — HQ scaffold from embedded template.
 *
 * Cargo unit + integration tests (`core::scaffold`,
 * `src-tauri/tests/scaffold_test.rs`) are the authoritative proof. This
 * vitest suite is a structural smoke test that runs in `pnpm test` so the
 * renderer-side CI signals US-004 status.
 */
describe("US-004: Rust core — HQ scaffold from embedded template", () => {
  describe("Module layout", () => {
    it("scaffold core module exists", () => {
      expect(
        existsSync(join(repoRoot, "src-tauri/src/core/scaffold.rs"))
      ).toBe(true);
    });

    it("scaffold command wrapper exists", () => {
      expect(
        existsSync(join(repoRoot, "src-tauri/src/commands/scaffold.rs"))
      ).toBe(true);
    });

    it("scaffold integration test exists", () => {
      expect(
        existsSync(join(repoRoot, "src-tauri/tests/scaffold_test.rs"))
      ).toBe(true);
    });

    it("template parity script exists and is executable", () => {
      const script = join(repoRoot, "scripts/check-template-parity.sh");
      expect(existsSync(script)).toBe(true);
      const mode = statSync(script).mode & 0o111;
      expect(mode).toBeGreaterThan(0);
    });

    it("template parity workflow exists", () => {
      expect(
        existsSync(
          join(repoRoot, ".github/workflows/template-parity.yml")
        )
      ).toBe(true);
    });
  });

  describe("Embedded template tree", () => {
    const templateRoot = "src-tauri/templates/hq";

    it("template root directory exists", () => {
      expect(existsSync(join(repoRoot, templateRoot))).toBe(true);
    });

    it("contains README.md + CLAUDE.md + USER-GUIDE.md", () => {
      expect(existsSync(join(repoRoot, templateRoot, "README.md"))).toBe(true);
      expect(existsSync(join(repoRoot, templateRoot, "CLAUDE.md"))).toBe(true);
      expect(
        existsSync(join(repoRoot, templateRoot, "USER-GUIDE.md"))
      ).toBe(true);
    });

    it("contains .gitignore and .claude/settings.json", () => {
      expect(existsSync(join(repoRoot, templateRoot, ".gitignore"))).toBe(true);
      expect(
        existsSync(join(repoRoot, templateRoot, ".claude/settings.json"))
      ).toBe(true);
    });

    it("contains companies/manifest.yaml + workers/registry.yaml", () => {
      expect(
        existsSync(join(repoRoot, templateRoot, "companies/manifest.yaml"))
      ).toBe(true);
      expect(
        existsSync(join(repoRoot, templateRoot, "workers/registry.yaml"))
      ).toBe(true);
    });

    it("knowledge + workspace directories exist with placeholders", () => {
      expect(
        existsSync(join(repoRoot, templateRoot, "knowledge/public/.gitkeep"))
      ).toBe(true);
      expect(
        existsSync(join(repoRoot, templateRoot, "knowledge/private/.gitkeep"))
      ).toBe(true);
      expect(
        existsSync(
          join(repoRoot, templateRoot, "workspace/threads/.gitkeep")
        )
      ).toBe(true);
    });
  });

  describe("Cargo dependencies", () => {
    const cargo = readFileSync(
      join(repoRoot, "src-tauri/Cargo.toml"),
      "utf-8"
    );

    it("include_dir declared", () => {
      expect(cargo).toMatch(/^include_dir\s*=/m);
    });

    it("tempfile declared for integration tests", () => {
      expect(cargo).toMatch(/^tempfile\s*=/m);
    });

    it("tokio retains process + io-util + fs features", () => {
      expect(cargo).toContain("\"process\"");
      expect(cargo).toContain("\"io-util\"");
      expect(cargo).toContain("\"fs\"");
    });
  });

  describe("Scaffold module contract", () => {
    const scaffoldRs = readFileSync(
      join(repoRoot, "src-tauri/src/core/scaffold.rs"),
      "utf-8"
    );

    it("embeds template via include_dir! macro against templates/hq", () => {
      expect(scaffoldRs).toContain("include_dir!");
      expect(scaffoldRs).toContain("templates/hq");
    });

    it("exposes scaffold_hq(target_dir, force, progress)", () => {
      expect(scaffoldRs).toContain("pub fn scaffold_hq");
    });

    it("defines ScaffoldEvent enum with required variants", () => {
      expect(scaffoldRs).toContain("pub enum ScaffoldEvent");
      expect(scaffoldRs).toContain("Started {");
      expect(scaffoldRs).toContain("FileGroup {");
      expect(scaffoldRs).toContain("GitInit");
      expect(scaffoldRs).toContain("GitCommit {");
      expect(scaffoldRs).toContain("Completed {");
    });

    it("defines ScaffoldError with TargetNotEmpty variant", () => {
      expect(scaffoldRs).toContain("pub enum ScaffoldError");
      expect(scaffoldRs).toContain("TargetNotEmpty");
    });

    it("uses exact initial commit message 'Initial HQ'", () => {
      expect(scaffoldRs).toContain("\"Initial HQ\"");
    });

    it("runs git init and rev-parse HEAD", () => {
      expect(scaffoldRs).toContain("init");
      expect(scaffoldRs).toContain("rev-parse");
      expect(scaffoldRs).toContain("HEAD");
    });
  });

  describe("Scaffold command wiring", () => {
    const cmdScaffoldRs = readFileSync(
      join(repoRoot, "src-tauri/src/commands/scaffold.rs"),
      "utf-8"
    );

    it("scaffold_hq is async + marked #[tauri::command]", () => {
      expect(cmdScaffoldRs).toContain("pub async fn scaffold_hq");
      expect(cmdScaffoldRs).toContain("#[tauri::command]");
    });

    it("emits progress via AppHandle on scaffold:<id> channel", () => {
      expect(cmdScaffoldRs).toContain("scaffold:");
      expect(cmdScaffoldRs).toMatch(/\.emit\(/);
      expect(cmdScaffoldRs).toContain("use tauri::");
      expect(cmdScaffoldRs).toContain("Emitter");
    });

    it("runs core scaffold on spawn_blocking", () => {
      expect(cmdScaffoldRs).toContain("spawn_blocking");
    });

    it("template_file_count command is registered", () => {
      expect(cmdScaffoldRs).toContain("pub fn template_file_count");
    });
  });

  describe("Tauri invoke registration", () => {
    const libRs = readFileSync(
      join(repoRoot, "src-tauri/src/lib.rs"),
      "utf-8"
    );

    it("registers scaffold_hq invoke command", () => {
      expect(libRs).toContain("commands::scaffold::scaffold_hq");
    });

    it("registers template_file_count invoke command", () => {
      expect(libRs).toContain("commands::scaffold::template_file_count");
    });
  });
});
