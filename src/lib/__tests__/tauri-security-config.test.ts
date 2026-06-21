import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type AllowEntry = { path?: string; url?: string };
type Permission =
  | string
  | {
      identifier: string;
      allow?: AllowEntry[];
    };

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(path), "utf8")) as T;
}

function objectPermission(permissions: Permission[], identifier: string) {
  const permission = permissions.find(
    (entry) => typeof entry !== "string" && entry.identifier === identifier,
  );
  expect(permission).toBeTruthy();
  return permission as Extract<Permission, { identifier: string }>;
}

function allowedPaths(permissions: Permission[], identifier: string): string[] {
  return objectPermission(permissions, identifier).allow?.map((entry) => entry.path ?? "") ?? [];
}

function allowedUrls(permissions: Permission[], identifier: string): string[] {
  return objectPermission(permissions, identifier).allow?.map((entry) => entry.url ?? "") ?? [];
}

function cspDirective(csp: string, name: string): string[] {
  const directive = csp
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name} `));
  expect(directive).toBeTruthy();
  return directive!.split(/\s+/).slice(1);
}

function originFromCapabilityUrl(url: string): string {
  return url.replace(/\/\*$/, "");
}

describe("Tauri renderer security config", () => {
  const tauriConfig = readJson<{
    app: { withGlobalTauri?: boolean; security?: { csp?: string | null } };
  }>("src-tauri/tauri.conf.json");
  const capability = readJson<{ permissions: Permission[] }>(
    "src-tauri/capabilities/default.json",
  );

  it("uses a real CSP and disables the legacy global Tauri bridge", () => {
    expect(tauriConfig.app.withGlobalTauri).toBe(false);

    const csp = tauriConfig.app.security?.csp;
    expect(typeof csp).toBe("string");
    expect(csp).not.toContain("'unsafe-inline';");
    expect(cspDirective(csp!, "default-src")).toEqual(["'self'"]);
    expect(cspDirective(csp!, "script-src")).toEqual(["'self'"]);
    expect(cspDirective(csp!, "img-src")).toEqual(["'self'", "data:"]);
    expect(cspDirective(csp!, "style-src")).toEqual(["'self'", "'unsafe-inline'"]);
  });

  it("keeps connect-src aligned to the narrowed plugin-http allowlist", () => {
    const httpUrls = allowedUrls(capability.permissions, "http:default");
    expect(httpUrls).toEqual([
      "https://*.execute-api.us-east-1.amazonaws.com/*",
      "https://hqapi.getindigo.ai/*",
      "https://*.auth.us-east-1.amazoncognito.com/*",
      "https://cognito-idp.us-east-1.amazonaws.com/*",
      "https://api.github.com/*",
      "https://codeload.github.com/*",
      "https://*.s3.amazonaws.com/*",
      "https://*.s3.us-east-1.amazonaws.com/*",
      "https://s3.us-east-1.amazonaws.com/*",
      "https://telemetry.getindigo.ai/*",
    ]);
    expect(httpUrls).not.toContain("https://*.amazonaws.com/*");

    const csp = tauriConfig.app.security?.csp;
    expect(cspDirective(csp!, "connect-src")).toEqual([
      "'self'",
      ...httpUrls.map(originFromCapabilityUrl),
    ]);
  });

  it("grants the renderer only the genuine $HOME/.hq carve-outs, not the install tree", () => {
    // The install tree now lives at a USER-CHOSEN root (default ~/hq, but
    // anywhere — including outside $HOME). Containment there is enforced in
    // Rust against the chosen root by the install-root-guarded fs commands, so
    // NO static `$HOME/hq*` capability grant exists anymore. The only remaining
    // plugin-fs grants are the fixed $HOME/.hq/* locations that legitimately
    // bypass the install tree (cognito-tokens handoff + the embeddings-pending
    // fallback) plus the bundled-template read grant. See
    // `no-direct-plugin-fs-writes.test.ts` for the companion source invariant.
    expect(allowedPaths(capability.permissions, "fs:allow-mkdir")).toEqual([
      "$HOME/.hq",
    ]);

    expect(allowedPaths(capability.permissions, "fs:allow-write-file")).toEqual([
      "$HOME/.hq/cognito-tokens.json",
      "$HOME/.hq/.cognito-tokens.json.tmp.*",
    ]);

    expect(allowedPaths(capability.permissions, "fs:allow-write-text-file")).toEqual([
      "$HOME/.hq/embeddings-pending.json",
    ]);

    expect(allowedPaths(capability.permissions, "fs:allow-exists")).toEqual([
      "$HOME/.hq",
      "$HOME/.hq/cognito-tokens.json",
      "$HOME/.hq/.cognito-tokens.json.tmp.*",
    ]);

    expect(allowedPaths(capability.permissions, "fs:allow-read-text-file")).toEqual([
      "$RESOURCE/templates/**",
    ]);

    expect(allowedPaths(capability.permissions, "fs:allow-rename")).toEqual([
      "$HOME/.hq/cognito-tokens.json",
      "$HOME/.hq/.cognito-tokens.json.tmp.*",
    ]);
  });

  it("retires every install-tree ($HOME/hq*) and broad ($HOME/**) fs grant", () => {
    // Defense-in-depth on top of the exact-match assertions above: no fs
    // capability — across every verb — may grant any `$HOME/hq*` path (the old
    // static install-tree allowlist) or a broad `$HOME/**`. A regression that
    // re-adds one would re-open the forbidden-path surface this refactor closed.
    const fsIdentifiers = [
      "fs:allow-mkdir",
      "fs:allow-write-file",
      "fs:allow-write-text-file",
      "fs:allow-exists",
      "fs:allow-read-text-file",
      "fs:allow-rename",
      "fs:allow-remove",
    ];

    for (const identifier of fsIdentifiers) {
      const paths = allowedPaths(capability.permissions, identifier);
      for (const path of paths) {
        expect(
          path.startsWith("$HOME/hq"),
          `${identifier} must not grant install-tree path ${path}`,
        ).toBe(false);
        expect(
          path === "$HOME/**" || path === "$HOME" || path === "$HOME/*",
          `${identifier} must not grant a broad home path ${path}`,
        ).toBe(false);
      }
    }
  });
});
