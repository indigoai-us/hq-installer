// Vitest setup file
import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

// ──────────────────────────────────────────────────────────────────────────
// Tauri `invoke` mock
// ──────────────────────────────────────────────────────────────────────────
//
// Components that use `@/lib/tauri-invoke` end up calling `invoke()` from
// `@tauri-apps/api/core`. Inside jsdom that module resolves to an ESM file
// which expects the Tauri runtime bridge — so every test that renders a
// Tauri-aware component needs a mock. We install one global fallback here
// with sensible defaults; individual tests can override a single call via
// `vi.mocked(invoke).mockResolvedValueOnce(...)`.

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    switch (cmd) {
      case "detect_platform":
        return { os: "macos", packageManager: "brew", npmAvailable: true };
      case "dep_registry":
        return [
          {
            id: "node",
            name: "Node.js",
            check_cmd: "node --version",
            required: true,
            auto_installable: true,
            install_hint: "Install Node.js via nvm",
            install_commands: { brew: "brew install node" },
          },
          {
            id: "git",
            name: "Git",
            check_cmd: "git --version",
            required: true,
            auto_installable: false,
            install_hint: "Install Xcode Command Line Tools",
            install_commands: {},
          },
          {
            id: "gh",
            name: "GitHub CLI",
            check_cmd: "gh --version",
            required: true,
            auto_installable: true,
            install_hint: "Install gh",
            install_commands: { brew: "brew install gh" },
          },
          {
            id: "claude",
            name: "Claude Code",
            check_cmd: "claude --version",
            required: true,
            auto_installable: true,
            install_hint: "Install Claude Code",
            install_commands: { npm: "npm install -g @anthropic-ai/claude-code" },
          },
          {
            id: "qmd",
            name: "qmd (search)",
            check_cmd: "qmd --version",
            required: false,
            auto_installable: true,
            install_hint: "Install qmd",
            install_commands: { brew: "brew install tobi/qmd/qmd" },
          },
          {
            id: "yq",
            name: "yq (YAML)",
            check_cmd: "yq --version",
            required: false,
            auto_installable: true,
            install_hint: "Install yq",
            install_commands: { brew: "brew install yq" },
          },
          {
            id: "vercel",
            name: "Vercel CLI",
            check_cmd: "vercel --version",
            required: false,
            auto_installable: true,
            install_hint: "Install Vercel CLI",
            install_commands: { npm: "npm install -g vercel" },
          },
          {
            id: "hq-cli",
            name: "HQ CLI",
            check_cmd: "hq --version",
            required: false,
            auto_installable: true,
            install_hint: "Install HQ CLI",
            install_commands: { npm: "npm install -g @indigo/hq-cli" },
          },
        ];
      case "check_deps":
        return [
          { dep_id: "node", installed: true, detected_version: "v20.11.0" },
          { dep_id: "git", installed: true, detected_version: "2.41.0" },
          { dep_id: "gh", installed: true, detected_version: "2.42.0" },
          { dep_id: "claude", installed: true, detected_version: "1.0.0" },
          { dep_id: "qmd", installed: true, detected_version: "0.5.0" },
          { dep_id: "yq", installed: true, detected_version: "4.40.0" },
          { dep_id: "vercel", installed: true, detected_version: "33.0.0" },
          { dep_id: "hq-cli", installed: true, detected_version: "0.1.0" },
        ];
      case "install_dep":
        return { result: "auto", command: "brew install node", exit_code: 0 };
      case "template_file_count":
        return 14;
      case "scaffold_hq":
        return {
          result: "ok",
          summary: {
            target_dir: "/tmp/hq-test",
            file_count: 14,
            duration_ms: 42,
            commit_sha: "abc1234",
          },
        };
      case "check_cloud_existing":
        return {
          result: "ok",
          info: {
            exists: false,
            last_modified: null,
            estimated_size: null,
          },
        };
      case "clone_cloud_existing":
        return {
          result: "ok",
          summary: {
            target_dir: "/tmp/hq-test",
            backend: "github",
            duration_ms: 123,
          },
        };
      default:
        return null;
    }
  }),
}));

// Tauri event listener mock — the Install wizard subscribes to
// `dep-install:<dep-id>` events. jsdom has no backend, so `listen` is a
// no-op that returns a no-op unsubscribe function.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

// Shell plugin — used by NodeManualModal to open nodejs.org in the system
// browser. The real package exports `open(path, openWith?)`.
vi.mock("@tauri-apps/plugin-shell", () => ({
  open: vi.fn(async () => {}),
}));

// Clipboard API is absent in jsdom — provide a minimal stub so the
// "copy CLI command" path in Welcome doesn't throw.
Object.defineProperty(navigator, "clipboard", {
  value: { writeText: vi.fn(async () => {}) },
  writable: true,
  configurable: true,
});
