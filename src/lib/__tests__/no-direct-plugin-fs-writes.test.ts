// no-direct-plugin-fs-writes.test.ts
//
// The missing invariant that would have caught the original forbidden-path
// collision.
//
// Every renderer-side filesystem WRITE that targets the install tree must go
// through the install-root-guarded Rust commands (see `install-fs.ts`), never
// `@tauri-apps/plugin-fs`. Containment is enforced in Rust against the
// user-chosen install root, so a stray plugin-fs write would bypass that guard
// AND require a static capability grant we deliberately removed.
//
// This test fails the build if any module under `src/lib` or `src/screens`
// imports `mkdir`, `writeFile`, `writeTextFile`, or `rename` from
// `@tauri-apps/plugin-fs`, except an explicit whitelist of modules that
// legitimately write to FIXED $HOME/.hq locations (outside any install tree):
//
//   - src/lib/cognito.ts          — cognito-tokens handoff at $HOME/.hq
//   - src/screens/setup-progress.tsx — the $HOME/.hq/embeddings-pending.json
//                                      fallback branch
//
// Reads (`readTextFile`, `exists`) are NOT forbidden here — only the four write
// verbs above mutate the filesystem.

import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

// Write verbs that must never be imported from plugin-fs outside the whitelist.
const FORBIDDEN_WRITE_IMPORTS = ["mkdir", "writeFile", "writeTextFile", "rename"];

// Modules that may import a forbidden write verb because they target a fixed
// $HOME/.hq location that is intentionally outside any install tree. Paths are
// POSIX-relative to the repo root.
const WHITELIST = new Set(["src/lib/cognito.ts", "src/screens/setup-progress.tsx"]);

const SCAN_ROOTS = ["src/lib", "src/screens"];

/** Recursively collect non-test `.ts`/`.tsx` modules under `dir`. */
function collectSourceModules(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip test directories — they're allowed to drive plugin-fs directly.
      if (entry.name === "__tests__") continue;
      out.push(...collectSourceModules(full));
      continue;
    }
    if (!/\.tsx?$/.test(entry.name)) continue;
    // Co-located test files (e.g. manifest-writer.test.ts) live alongside
    // source under src/lib — exclude them too.
    if (/\.test\.tsx?$/.test(entry.name)) continue;
    out.push(full);
  }
  return out;
}

/** Normalize an OS path to a POSIX-style repo-relative path for matching. */
function toPosixRelative(absPath: string): string {
  return relative(process.cwd(), absPath).split(sep).join("/");
}

/**
 * Return the forbidden write verbs a module imports from
 * `@tauri-apps/plugin-fs`. Handles both single-line and multiline import
 * blocks by matching the brace-delimited specifier list that precedes the
 * `from "@tauri-apps/plugin-fs"` clause.
 */
function forbiddenPluginFsImports(source: string): string[] {
  const importBlocks = source.matchAll(
    /import\s*(?:type\s+)?\{([^}]*)\}\s*from\s*["']@tauri-apps\/plugin-fs["']/g,
  );

  const found = new Set<string>();
  for (const block of importBlocks) {
    // Each specifier may be aliased (`mkdir as makeDir`) — the imported name is
    // the token before any `as`. The local alias is irrelevant; importing the
    // write verb at all is what we forbid.
    const specifiers = block[1]
      .split(",")
      .map((spec) => spec.trim())
      .filter(Boolean)
      .map((spec) => spec.split(/\s+as\s+/)[0].trim());

    for (const name of specifiers) {
      if (FORBIDDEN_WRITE_IMPORTS.includes(name)) {
        found.add(name);
      }
    }
  }
  return [...found];
}

describe("renderer filesystem writes route through the install-root guard", () => {
  const modules = SCAN_ROOTS.flatMap((root) => collectSourceModules(root));

  it("finds the modules it intends to scan (guards against a broken glob)", () => {
    // A regex/path bug that silently scanned zero files would make this suite
    // pass vacuously. Anchor on a couple of modules we know exist.
    const relativeModules = modules.map(toPosixRelative);
    expect(relativeModules).toContain("src/lib/install-fs.ts");
    expect(relativeModules).toContain("src/screens/setup-progress.tsx");
    expect(modules.length).toBeGreaterThan(5);
  });

  it("only the whitelist imports mkdir/writeFile/writeTextFile/rename from plugin-fs", () => {
    const offenders: Record<string, string[]> = {};

    for (const modulePath of modules) {
      const rel = toPosixRelative(modulePath);
      if (WHITELIST.has(rel)) continue;

      const source = readFileSync(modulePath, "utf8");
      const forbidden = forbiddenPluginFsImports(source);
      if (forbidden.length > 0) {
        offenders[rel] = forbidden;
      }
    }

    expect(
      offenders,
      `These modules import forbidden plugin-fs write verbs and must use the ` +
        `install-root-guarded helpers in src/lib/install-fs.ts instead:\n` +
        JSON.stringify(offenders, null, 2),
    ).toEqual({});
  });

  it("keeps the whitelist tight — every whitelisted module still exists and uses plugin-fs", () => {
    // If a whitelisted module stops importing a forbidden verb (e.g. it gets
    // migrated), the entry is dead and should be removed so the whitelist never
    // silently grows stale cover for a future regression.
    for (const rel of WHITELIST) {
      const source = readFileSync(rel, "utf8");
      expect(
        forbiddenPluginFsImports(source).length,
        `${rel} is whitelisted but no longer imports a forbidden plugin-fs ` +
          `write verb — remove it from the whitelist.`,
      ).toBeGreaterThan(0);
    }
  });
});
