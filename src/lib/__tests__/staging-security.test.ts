import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("staging IPC security", () => {
  it("does not register get_github_token as a renderer-invokable command", () => {
    const libRs = readFileSync(resolve("src-tauri/src/lib.rs"), "utf8");
    const invokeHandlerBody = libRs.slice(libRs.indexOf(".invoke_handler"));

    expect(invokeHandlerBody).not.toContain("commands::staging::get_github_token");
    expect(invokeHandlerBody).toContain("commands::staging::download_staging_tarball");
  });
});
