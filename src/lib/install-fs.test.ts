import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  makeInstallDir,
  relativePathFromInstallRoot,
  writeInstallTextFile,
} from "./install-fs";

const mockInvoke = vi.mocked(invoke);

beforeEach(() => {
  mockInvoke.mockClear();
  mockInvoke.mockResolvedValue(undefined);
});

describe("install-fs", () => {
  it("routes mkdir and writes for install roots outside ~/hq through custom commands", async () => {
    const root = "/Users/alice/Documents/HQ";

    await makeInstallDir(root, `${root}/core/knowledge`);
    await writeInstallTextFile(root, `${root}/README.md`, "hello");

    expect(mockInvoke).toHaveBeenCalledWith("make_dir", {
      path: "/Users/alice/Documents/HQ/core/knowledge",
      installRoot: root,
    });
    expect(mockInvoke).toHaveBeenCalledWith("write_file", {
      path: "README.md",
      contents: Array.from(new TextEncoder().encode("hello")),
      installRoot: root,
      mode: undefined,
    });
  });

  it("rejects absolute paths outside the declared install root", () => {
    expect(() =>
      relativePathFromInstallRoot(
        "/Users/alice/Documents/HQ",
        "/Users/alice/.ssh/config",
      ),
    ).toThrow("outside root");
  });

  it("rejects traversal that escapes the declared install root", () => {
    expect(() =>
      relativePathFromInstallRoot(
        "/Users/alice/Documents/HQ",
        "/Users/alice/Documents/HQ/../outside.txt",
      ),
    ).toThrow("outside root");
  });
});
