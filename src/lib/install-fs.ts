import { invoke } from "@tauri-apps/api/core";

function hasUnsafePathPrefix(path: string): boolean {
  return (
    path.startsWith("/") ||
    path.startsWith("\\") ||
    path.startsWith("//") ||
    path.startsWith("\\\\") ||
    /^[A-Za-z]:/.test(path)
  );
}

function normalizeTrustedPath(path: string): string | null {
  if (!path || path.includes("\0")) return null;

  const normalized = path.replace(/\\/g, "/");
  const driveMatch = normalized.match(/^([A-Za-z]:)\/?/);
  let prefix = "";
  let rest = normalized;

  if (driveMatch) {
    prefix = driveMatch[1].toUpperCase();
    rest = normalized.slice(driveMatch[0].length);
  } else if (normalized.startsWith("//")) {
    prefix = "//";
    rest = normalized.replace(/^\/+/, "");
  } else if (normalized.startsWith("/")) {
    prefix = "/";
    rest = normalized.replace(/^\/+/, "");
  }

  const parts: string[] = [];
  for (const seg of rest.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(seg);
    }
  }

  if (prefix === "/") return parts.length > 0 ? `/${parts.join("/")}` : "/";
  if (prefix === "//") return `//${parts.join("/")}`;
  if (prefix) return parts.length > 0 ? `${prefix}/${parts.join("/")}` : `${prefix}/`;
  return parts.join("/");
}

function isPathWithinRoot(path: string, root: string): boolean {
  const caseInsensitive = /^[A-Za-z]:\//.test(root) || root.startsWith("//");
  const candidate = caseInsensitive ? path.toLowerCase() : path;
  const base = caseInsensitive ? root.toLowerCase() : root;

  if (base.endsWith("/")) return candidate.startsWith(base);
  return candidate === base || candidate.startsWith(`${base}/`);
}

export function relativePathFromInstallRoot(
  installRoot: string,
  absolutePath: string,
): string {
  const root = normalizeTrustedPath(installRoot);
  const path = normalizeTrustedPath(absolutePath);
  if (!root || !path || !hasUnsafePathPrefix(root) || !hasUnsafePathPrefix(path)) {
    throw new Error("Install filesystem paths must be absolute.");
  }
  if (!isPathWithinRoot(path, root)) {
    throw new Error(`Refusing install filesystem path outside root: ${absolutePath}`);
  }

  if (path === root) return "";
  const prefix = root.endsWith("/") ? root : `${root}/`;
  const relative = path.slice(prefix.length);
  if (!relative || relative.split("/").some((seg) => seg === "..")) {
    throw new Error(`Refusing invalid install filesystem path: ${absolutePath}`);
  }
  return relative;
}

export async function makeInstallDir(
  installRoot: string,
  path: string,
): Promise<void> {
  await invoke("make_dir", { path, installRoot });
}

export async function writeInstallFile(
  installRoot: string,
  path: string,
  contents: Uint8Array,
  mode?: number,
): Promise<void> {
  await invoke("write_file", {
    path: relativePathFromInstallRoot(installRoot, path),
    contents: Array.from(contents),
    installRoot,
    mode,
  });
}

export async function writeInstallTextFile(
  installRoot: string,
  path: string,
  contents: string,
): Promise<void> {
  await writeInstallFile(installRoot, path, new TextEncoder().encode(contents));
}

export async function readInstallTextFile(
  installRoot: string,
  path: string,
): Promise<string> {
  return await invoke<string>("read_text_file", { path, installRoot });
}
