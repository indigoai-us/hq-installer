import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  mkdir,
  readTextFile,
  rename,
  writeTextFile,
} from "@tauri-apps/plugin-fs";

const IMPORTS_DIR = "workspace/imports";
const BREADCRUMB_PATH = `${IMPORTS_DIR}/.installer-import.json`;
export const IMPORT_PROCESS_EXIT_TIMEOUT_MS = 5 * 60 * 1000;

export interface ImportSpawnResult {
  ok: boolean;
  stdout?: string;
  stderr?: string[];
}

export interface ImportFs {
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, contents: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

export interface InstallerImportBreadcrumb {
  scanId: string;
  scanDir: string;
  ranAt: string;
  codexApplied: boolean;
  discoveryOk: boolean;
  claudeCounts: Record<string, number> | null;
  totalClaudeArtifacts: number | null;
  deferred: true;
}

export interface ExistingImportResult {
  codexApplied: boolean;
  discoveryOk: boolean;
  claudeCounts: Record<string, number> | null;
  totalClaudeArtifacts: number | null;
  scanDir: string;
  issues: string[];
}

export interface RunExistingImportOpts {
  installPath: string;
  spawn?: (
    cmd: string,
    args: string[],
    cwd: string,
  ) => Promise<ImportSpawnResult>;
  fs?: ImportFs;
  now?: () => Date;
  onLog?: (line: string) => void;
}

interface ScanSummary {
  discoveryOk: boolean;
  claudeCounts: Record<string, number> | null;
  totalClaudeArtifacts: number | null;
}

interface ScanReportEntry {
  category?: string;
}

interface ScanReport {
  discovery?: { ok?: boolean };
  categories?: Record<string, unknown> | ScanReportEntry[];
}

const defaultFs: ImportFs = {
  mkdir: (path, opts) => mkdir(path, { recursive: opts?.recursive ?? false }),
  readTextFile,
  writeTextFile,
  rename,
};

function normalizePath(path: string): string {
  return path.replace(/\/+$/, "");
}

function resolvePath(root: string, relativePath: string): string {
  const cleanRoot = normalizePath(root);
  const cleanRelative = relativePath.replace(/^\/+/, "");
  return `${cleanRoot}/${cleanRelative}`;
}

function buildScanId(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function summarizeScanReport(raw: string): ScanSummary {
  const parsed = JSON.parse(raw) as ScanReport;
  const discoveryOk = parsed?.discovery?.ok;
  if (discoveryOk !== true && discoveryOk !== false) {
    throw new Error("Import scan report is missing discovery.ok.");
  }

  if (!discoveryOk) {
    return {
      discoveryOk: false,
      claudeCounts: null,
      totalClaudeArtifacts: null,
    };
  }

  const categories = parsed.categories;
  if (!categories) {
    throw new Error("Import scan report is missing categories.");
  }

  const claudeCounts: Record<string, number> = {};

  if (Array.isArray(categories)) {
    for (const entry of categories) {
      const category =
        typeof entry?.category === "string" && entry.category.length > 0
          ? entry.category
          : "unknown";
      claudeCounts[category] = (claudeCounts[category] ?? 0) + 1;
    }
  } else {
    for (const [category, entries] of Object.entries(categories)) {
      if (!Array.isArray(entries)) {
        throw new Error(`Import scan category "${category}" is not an array.`);
      }
      claudeCounts[category] = entries.length;
    }
  }

  const totalClaudeArtifacts = Object.values(claudeCounts).reduce(
    (sum, count) => sum + count,
    0,
  );

  return { discoveryOk: true, claudeCounts, totalClaudeArtifacts };
}

async function defaultSpawn(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<ImportSpawnResult> {
  let handle: string;
  try {
    handle = await invoke<string>("spawn_process", {
      args: { cmd, args, cwd },
    });
  } catch (err) {
    return { ok: false, stderr: [getErrorMessage(err)] };
  }

  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  let stdoutUnlisten: (() => void) | null = null;
  let stderrUnlisten: (() => void) | null = null;
  let exitUnlisten: (() => void) | null = null;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let settled = false;
  let resolveExit: ((value: ImportSpawnResult) => void) | null = null;
  const exitResult = new Promise<ImportSpawnResult>((resolve) => {
    resolveExit = resolve;
  });

  const cleanup = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    stdoutUnlisten?.();
    stdoutUnlisten = null;
    stderrUnlisten?.();
    stderrUnlisten = null;
    exitUnlisten?.();
    exitUnlisten = null;
  };

  const finish = (value: ImportSpawnResult) => {
    if (settled) return;
    settled = true;
    cleanup();
    resolveExit?.(value);
  };

  try {
    timeoutId = setTimeout(() => {
      const msg = `${cmd} did not report completion within ${Math.round(
        IMPORT_PROCESS_EXIT_TIMEOUT_MS / 1000,
      )} seconds.`;
      invoke("cancel_process", { handle }).catch((err) => {
        console.warn(`[import-existing] could not cancel process ${handle}:`, err);
      });
      finish({
        ok: false,
        stdout: stdoutLines.join("\n"),
        stderr: [...stderrLines, msg],
      });
    }, IMPORT_PROCESS_EXIT_TIMEOUT_MS);

    stdoutUnlisten = await listen(
      `process://${handle}/stdout`,
      (event: { payload: unknown }) => {
        const payload = event.payload as { line?: string };
        stdoutLines.push(payload?.line ?? "");
      },
    );
    if (settled) return await exitResult;

    stderrUnlisten = await listen(
      `process://${handle}/stderr`,
      (event: { payload: unknown }) => {
        const payload = event.payload as { line?: string };
        stderrLines.push(payload?.line ?? "");
      },
    );
    if (settled) return await exitResult;

    exitUnlisten = await listen(
      `process://${handle}/exit`,
      (event: { payload: unknown }) => {
        const payload = event.payload as {
          success: boolean;
        };
        finish({
          ok: payload.success,
          stdout: stdoutLines.join("\n"),
          stderr: stderrLines,
        });
      },
    );
    if (settled) return await exitResult;

    return await exitResult;
  } catch (err) {
    cleanup();
    invoke("cancel_process", { handle }).catch((cancelErr) => {
      console.warn(`[import-existing] could not cancel process ${handle}:`, cancelErr);
    });
    return { ok: false, stderr: [getErrorMessage(err)] };
  }
}

export async function runExistingImport(
  opts: RunExistingImportOpts,
): Promise<ExistingImportResult> {
  const installPath = normalizePath(opts.installPath);
  const spawn = opts.spawn ?? defaultSpawn;
  const fs = opts.fs ?? defaultFs;
  const now = opts.now ?? (() => new Date());
  const onLog = opts.onLog ?? (() => {});
  const startedAt = now();
  const scanId = buildScanId(startedAt);
  const scanDir = `${IMPORTS_DIR}/${scanId}`;
  const reportRelativePath = `${scanDir}/report.json`;
  const reportPath = resolvePath(installPath, reportRelativePath);
  const redactedReportPath = resolvePath(
    installPath,
    `${scanDir}/report.redacted.json`,
  );
  const result: ExistingImportResult = {
    codexApplied: false,
    discoveryOk: false,
    claudeCounts: null,
    totalClaudeArtifacts: null,
    scanDir,
    issues: [],
  };

  function noteIssue(message: string): void {
    result.issues.push(message);
    onLog(`[warn] ${message}`);
  }

  onLog("Applying additive Codex parity…");
  const codexApply = await spawn(
    "bash",
    [
      "core/scripts/convert-codex.sh",
      "--apply",
      `--root=${installPath}`,
    ],
    installPath,
  );
  result.codexApplied = codexApply.ok;
  if (codexApply.ok) {
    onLog("Codex parity applied.");
  } else {
    noteIssue("Codex parity could not be applied automatically.");
  }

  try {
    await fs.mkdir(resolvePath(installPath, scanDir), { recursive: true });
  } catch (err) {
    noteIssue(`Could not prepare the import scan directory: ${getErrorMessage(err)}`);
  }

  onLog("Scanning for Claude artifacts…");
  const scan = await spawn(
    "bash",
    [
      ".claude/skills/import-claude/scan.sh",
      `--hq-root=${installPath}`,
      `--output=${reportRelativePath}`,
    ],
    installPath,
  );

  if (!scan.ok) {
    noteIssue("Claude discovery did not complete.");
  } else {
    onLog("Redacting the Claude scan report…");
    const redact = await spawn(
      "bash",
      [
        ".claude/skills/import-claude/redact.sh",
        "--json-fields",
        reportRelativePath,
      ],
      installPath,
    );

    if (
      !redact.ok ||
      typeof redact.stdout !== "string" ||
      redact.stdout.trim().length === 0
    ) {
      noteIssue("Claude discovery report could not be redacted.");
    } else {
      let redactedReportReady = false;
      try {
        await fs.writeTextFile(redactedReportPath, redact.stdout);
        await fs.rename(redactedReportPath, reportPath);
        redactedReportReady = true;
      } catch (err) {
        noteIssue(`Could not persist the redacted Claude report: ${getErrorMessage(err)}`);
      }

      if (redactedReportReady) {
        try {
          const reportRaw = await fs.readTextFile(reportPath);
          const summary = summarizeScanReport(reportRaw);
          result.discoveryOk = summary.discoveryOk;
          result.claudeCounts = summary.claudeCounts;
          result.totalClaudeArtifacts = summary.totalClaudeArtifacts;

          if (!summary.discoveryOk) {
            onLog("[warn] Claude discovery was incomplete — counts are deferred.");
          } else if (summary.totalClaudeArtifacts === 0) {
            onLog("No Claude artifacts were detected.");
          } else {
            onLog(
              `Found ${summary.totalClaudeArtifacts} Claude artifact${summary.totalClaudeArtifacts === 1 ? "" : "s"}.`,
            );
          }
        } catch (err) {
          noteIssue(`Could not read the redacted Claude report: ${getErrorMessage(err)}`);
        }
      }
    }
  }

  const breadcrumb: InstallerImportBreadcrumb = {
    scanId,
    scanDir,
    ranAt: startedAt.toISOString(),
    codexApplied: result.codexApplied,
    discoveryOk: result.discoveryOk,
    claudeCounts: result.claudeCounts,
    totalClaudeArtifacts: result.totalClaudeArtifacts,
    deferred: true,
  };

  try {
    await fs.mkdir(resolvePath(installPath, IMPORTS_DIR), { recursive: true });
    await fs.writeTextFile(
      resolvePath(installPath, BREADCRUMB_PATH),
      JSON.stringify(breadcrumb, null, 2) + "\n",
    );
  } catch (err) {
    noteIssue(`Could not write the installer import breadcrumb: ${getErrorMessage(err)}`);
  }

  return result;
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => typeof entry === "number");
}

export async function readInstallerImportBreadcrumb(
  installPath: string,
  fs: ImportFs = defaultFs,
): Promise<InstallerImportBreadcrumb | null> {
  try {
    const raw = await fs.readTextFile(
      resolvePath(installPath, BREADCRUMB_PATH),
    );
    const parsed = JSON.parse(raw) as Partial<InstallerImportBreadcrumb>;
    if (
      typeof parsed?.scanId !== "string" ||
      typeof parsed?.scanDir !== "string" ||
      typeof parsed?.ranAt !== "string" ||
      typeof parsed?.codexApplied !== "boolean" ||
      typeof parsed?.discoveryOk !== "boolean" ||
      parsed?.deferred !== true
    ) {
      return null;
    }

    const claudeCounts =
      parsed.claudeCounts === null
        ? null
        : isNumberRecord(parsed.claudeCounts)
          ? parsed.claudeCounts
          : null;
    const totalClaudeArtifacts =
      parsed.totalClaudeArtifacts === null
        ? null
        : typeof parsed.totalClaudeArtifacts === "number"
          ? parsed.totalClaudeArtifacts
          : null;

    return {
      scanId: parsed.scanId,
      scanDir: parsed.scanDir,
      ranAt: parsed.ranAt,
      codexApplied: parsed.codexApplied,
      discoveryOk: parsed.discoveryOk,
      claudeCounts,
      totalClaudeArtifacts,
      deferred: true,
    };
  } catch {
    return null;
  }
}
