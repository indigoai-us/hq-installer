/**
 * Thin wrapper over the install-root-guarded Rust filesystem commands.
 *
 * Every renderer-side write that targets the install tree must go through these
 * helpers (not `@tauri-apps/plugin-fs`), so containment is enforced in Rust
 * against the user-chosen install root rather than a static capability
 * allowlist. The Rust guards expect a ROOT-RELATIVE path; this module converts
 * absolute paths to that form via `toInstallRelative`.
 */

import { invoke } from "@tauri-apps/api/core";

/**
 * Strip the install-root prefix from `abs`, yielding the root-relative path the
 * Rust guard expects.
 *
 * Mirrors the convention in `s3-sync.ts`: normalize backslashes to forward
 * slashes, and if `abs` starts with `<root>/`, slice that prefix off. If `abs`
 * is not under `root` (already relative), return it as-is.
 */
export function toInstallRelative(root: string, abs: string): string {
  const normalizedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedAbs = abs.replace(/\\/g, "/");
  if (normalizedRoot && normalizedAbs.startsWith(`${normalizedRoot}/`)) {
    return normalizedAbs.slice(normalizedRoot.length + 1);
  }
  // Already relative (no leading slash and not under root): return as-is.
  return normalizedAbs.replace(/^\/+/, "");
}

/** Write raw bytes to a file under the install root, optionally setting unix mode. */
export async function writeInstallFile(
  root: string,
  abs: string,
  bytes: Uint8Array,
  mode?: number,
): Promise<void> {
  await invoke("write_file", {
    path: toInstallRelative(root, abs),
    contents: Array.from(bytes),
    installRoot: root,
    mode: mode ?? null,
  });
}

/** Write a UTF-8 text file under the install root, optionally setting unix mode. */
export async function writeInstallText(
  root: string,
  abs: string,
  text: string,
  mode?: number,
): Promise<void> {
  await writeInstallFile(root, abs, new TextEncoder().encode(text), mode);
}

/** Create a directory (recursively) under the install root. */
export async function makeInstallDir(root: string, abs: string): Promise<void> {
  await invoke("create_dir", {
    path: toInstallRelative(root, abs),
    installRoot: root,
  });
}

/** Rename a path under the install root. Both endpoints must stay within it. */
export async function renameInstall(
  root: string,
  absFrom: string,
  absTo: string,
): Promise<void> {
  await invoke("rename", {
    from: toInstallRelative(root, absFrom),
    to: toInstallRelative(root, absTo),
    installRoot: root,
  });
}

/** Read a UTF-8 text file from under the install root. */
export async function readInstallText(root: string, abs: string): Promise<string> {
  return invoke("read_text_file", {
    path: toInstallRelative(root, abs),
    installRoot: root,
  });
}

/** Check whether a path under the install root exists. */
export async function installPathExists(root: string, abs: string): Promise<boolean> {
  return invoke("path_exists", {
    path: toInstallRelative(root, abs),
    installRoot: root,
  });
}
