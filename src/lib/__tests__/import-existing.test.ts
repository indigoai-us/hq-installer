// @vitest-environment node
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  mkdir: vi.fn(),
  readTextFile: vi.fn(),
  rename: vi.fn(),
  writeTextFile: vi.fn(),
}));

import {
  IMPORT_PROCESS_EXIT_TIMEOUT_MS,
  readInstallerImportBreadcrumb,
  runExistingImport,
  type ImportFs,
} from "../import-existing.js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const INSTALL_PATH = "/tmp/hq";
const mockInvoke = vi.mocked(invoke);
const mockListen = vi.mocked(listen);

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

function resolvePath(root: string, relativePath: string): string {
  return `${root.replace(/\/+$/, "")}/${relativePath.replace(/^\/+/, "")}`;
}

function createFs(initialFiles: Record<string, string> = {}): {
  files: Map<string, string>;
  adapter: ImportFs;
  calls: string[];
} {
  const files = new Map(Object.entries(initialFiles));
  const calls: string[] = [];

  return {
    files,
    calls,
    adapter: {
      mkdir: vi.fn(async (path: string) => {
        calls.push(`mkdir:${path}`);
      }),
      readTextFile: vi.fn(async (path: string) => {
        calls.push(`read:${path}`);
        const value = files.get(path);
        if (value == null) throw new Error(`ENOENT:${path}`);
        return value;
      }),
      writeTextFile: vi.fn(async (path: string, contents: string) => {
        calls.push(`write:${path}`);
        files.set(path, contents);
      }),
      rename: vi.fn(async (from: string, to: string) => {
        calls.push(`rename:${from}->${to}`);
        const value = files.get(from);
        if (value == null) throw new Error(`ENOENT:${from}`);
        files.delete(from);
        files.set(to, value);
      }),
    },
  };
}

function loadFixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

describe("runExistingImport", () => {
  it("applies convert-codex, scans Claude artifacts, redacts before reading, and writes the breadcrumb", async () => {
    const fixture = loadFixture("import-scan.report.json");
    const { files, adapter, calls } = createFs();

    const spawn = vi.fn(
      async (cmd: string, args: string[], cwd: string) => {
        calls.push(`spawn:${args[0]}`);
        expect(cmd).toBe("bash");
        expect(cwd).toBe(INSTALL_PATH);

        if (args[0] === "core/scripts/convert-codex.sh") {
          return { ok: true };
        }

        if (args[0] === ".claude/skills/import-claude/scan.sh") {
          const outputArg = args.find((arg) => arg.startsWith("--output="));
          const outputPath = outputArg?.slice("--output=".length);
          if (!outputPath) throw new Error("missing --output");
          files.set(resolvePath(INSTALL_PATH, outputPath), '{"secret":"sk-ant-12345678901234567890"}');
          return { ok: true };
        }

        if (args[0] === ".claude/skills/import-claude/redact.sh") {
          return { ok: true, stdout: fixture };
        }

        throw new Error(`unexpected spawn: ${args.join(" ")}`);
      },
    );

    const result = await runExistingImport({
      installPath: INSTALL_PATH,
      spawn,
      fs: adapter,
      now: () => new Date("2026-06-18T12:34:56.000Z"),
    });

    expect(spawn).toHaveBeenNthCalledWith(1, "bash", [
      "core/scripts/convert-codex.sh",
      "--apply",
      "--root=/tmp/hq",
    ], INSTALL_PATH);
    expect(spawn).toHaveBeenNthCalledWith(2, "bash", [
      ".claude/skills/import-claude/scan.sh",
      "--hq-root=/tmp/hq",
      "--output=workspace/imports/2026-06-18T12-34-56-000Z/report.json",
    ], INSTALL_PATH);

    const redactCall = spawn.mock.calls.find(
      ([, args]) => args[0] === ".claude/skills/import-claude/redact.sh",
    );
    expect(redactCall).toEqual([
      "bash",
      [
        ".claude/skills/import-claude/redact.sh",
        "--json-fields",
        "workspace/imports/2026-06-18T12-34-56-000Z/report.json",
      ],
      INSTALL_PATH,
    ]);

    const reportPath = resolvePath(
      INSTALL_PATH,
      "workspace/imports/2026-06-18T12-34-56-000Z/report.json",
    );
    const readIndex = calls.indexOf(`read:${reportPath}`);
    const renameIndex = calls.indexOf(
      `rename:${resolvePath(
        INSTALL_PATH,
        "workspace/imports/2026-06-18T12-34-56-000Z/report.redacted.json",
      )}->${reportPath}`,
    );
    const redactIndex = calls.indexOf(
      "spawn:.claude/skills/import-claude/redact.sh",
    );
    expect(redactIndex).toBeGreaterThan(-1);
    expect(renameIndex).toBeGreaterThan(-1);
    expect(renameIndex).toBeGreaterThan(redactIndex);
    expect(readIndex).toBeGreaterThan(renameIndex);

    expect(result).toEqual({
      codexApplied: true,
      discoveryOk: true,
      claudeCounts: {
        plans: 1,
        commands: 2,
        skills: 1,
        hooks: 0,
        policies: 1,
        agents: 0,
        claude_md: 1,
        settings_fragments: 1,
        mcp_servers: 1,
        knowledge_dirs: 0,
        claude_repos: 1,
      },
      totalClaudeArtifacts: 9,
      scanDir: "workspace/imports/2026-06-18T12-34-56-000Z",
      issues: [],
    });

    const breadcrumb = await readInstallerImportBreadcrumb(INSTALL_PATH, adapter);
    expect(breadcrumb).toEqual({
      scanId: "2026-06-18T12-34-56-000Z",
      scanDir: "workspace/imports/2026-06-18T12-34-56-000Z",
      ranAt: "2026-06-18T12:34:56.000Z",
      codexApplied: true,
      discoveryOk: true,
      claudeCounts: {
        plans: 1,
        commands: 2,
        skills: 1,
        hooks: 0,
        policies: 1,
        agents: 0,
        claude_md: 1,
        settings_fragments: 1,
        mcp_servers: 1,
        knowledge_dirs: 0,
        claude_repos: 1,
      },
      totalClaudeArtifacts: 9,
      deferred: true,
    });
  });

  it("returns a non-fatal result when a spawn step fails", async () => {
    const { adapter } = createFs();
    const spawn = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "core/scripts/convert-codex.sh") return { ok: false };
      if (args[0] === ".claude/skills/import-claude/scan.sh") return { ok: false };
      return { ok: false };
    });

    const result = await runExistingImport({
      installPath: INSTALL_PATH,
      spawn,
      fs: adapter,
      now: () => new Date("2026-06-18T12:34:56.000Z"),
    });

    expect(result.codexApplied).toBe(false);
    expect(result.discoveryOk).toBe(false);
    expect(result.claudeCounts).toBeNull();
    expect(result.totalClaudeArtifacts).toBeNull();
    expect(result.issues).toContain(
      "Codex parity could not be applied automatically.",
    );
    expect(result.issues).toContain("Claude discovery did not complete.");

    const breadcrumb = await readInstallerImportBreadcrumb(INSTALL_PATH, adapter);
    expect(breadcrumb).toEqual({
      scanId: "2026-06-18T12-34-56-000Z",
      scanDir: "workspace/imports/2026-06-18T12-34-56-000Z",
      ranAt: "2026-06-18T12:34:56.000Z",
      codexApplied: false,
      discoveryOk: false,
      claudeCounts: null,
      totalClaudeArtifacts: null,
      deferred: true,
    });
  });

  it("times out and cancels default spawns when an exit event is missed", async () => {
    vi.useFakeTimers();
    const { adapter } = createFs();
    let handleCounter = 0;
    mockInvoke.mockImplementation(async (command: string) => {
      if (command === "spawn_process") return `handle-${++handleCounter}`;
      if (command === "cancel_process") return true;
      return undefined;
    });
    mockListen.mockResolvedValue(() => {});

    const resultPromise = runExistingImport({
      installPath: INSTALL_PATH,
      fs: adapter,
      now: () => new Date("2026-06-18T12:34:56.000Z"),
    });

    await vi.advanceTimersByTimeAsync(IMPORT_PROCESS_EXIT_TIMEOUT_MS + 1);
    await vi.advanceTimersByTimeAsync(IMPORT_PROCESS_EXIT_TIMEOUT_MS + 1);
    const result = await resultPromise;

    expect(result.codexApplied).toBe(false);
    expect(result.discoveryOk).toBe(false);
    expect(result.issues).toContain(
      "Codex parity could not be applied automatically.",
    );
    expect(result.issues).toContain("Claude discovery did not complete.");
    expect(mockInvoke).toHaveBeenCalledWith("cancel_process", {
      handle: "handle-1",
    });
    expect(mockInvoke).toHaveBeenCalledWith("cancel_process", {
      handle: "handle-2",
    });
  });

  it("treats discovery.ok=false as unknown counts instead of claiming zero", async () => {
    const incomplete = JSON.stringify({
      discovery: { ok: false, errors: ["find failed"] },
      categories: { commands: [] },
    });
    const { files, adapter } = createFs();

    const spawn = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === ".claude/skills/import-claude/scan.sh") {
        const outputArg = args.find((arg) => arg.startsWith("--output="));
        const outputPath = outputArg?.slice("--output=".length);
        if (!outputPath) throw new Error("missing --output");
        files.set(resolvePath(INSTALL_PATH, outputPath), '{"secret":"sk-ant-12345678901234567890"}');
        return { ok: true };
      }
      if (args[0] === ".claude/skills/import-claude/redact.sh") {
        return { ok: true, stdout: incomplete };
      }
      return { ok: true };
    });

    const result = await runExistingImport({
      installPath: INSTALL_PATH,
      spawn,
      fs: adapter,
      now: () => new Date("2026-06-18T12:34:56.000Z"),
    });

    expect(result.discoveryOk).toBe(false);
    expect(result.claudeCounts).toBeNull();
    expect(result.totalClaudeArtifacts).toBeNull();
  });
});

describe("readInstallerImportBreadcrumb", () => {
  it("returns null for an unparseable breadcrumb", async () => {
    const { adapter } = createFs({
      [resolvePath(INSTALL_PATH, "workspace/imports/.installer-import.json")]:
        "{not-json",
    });

    await expect(
      readInstallerImportBreadcrumb(INSTALL_PATH, adapter),
    ).resolves.toBeNull();
  });
});
