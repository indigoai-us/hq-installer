// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildLatestJson } from "../build-latest-json.mjs";

const repo = "indigoai-us/hq-installer";
const tag = "v1.2.3";
const version = "1.2.3";
const pubDate = "2026-01-02T03:04:05Z";

const darwin = "HQ Installer_1.2.3_universal.app.tar.gz";
const x64 = "HQ Installer_1.2.3_x64-setup.exe";
const arm64 = "HQ Installer_1.2.3_arm64-setup.exe";

function asset(name: string) {
  return { name };
}

function fullAssetList(overrides: string[] = []) {
  return [
    darwin,
    `${darwin}.sig`,
    x64,
    `${x64}.sig`,
    arm64,
    `${arm64}.sig`,
    "hq-installer_universal.zip",
    "HQ-Installer_x64-setup.exe",
    "HQ-Installer_arm64-setup.exe",
    ...overrides,
  ].map(asset);
}

function signatures(overrides: Record<string, string> = {}) {
  return {
    [`${darwin}.sig`]: "darwin-signature",
    [`${x64}.sig`]: "x64-signature",
    [`${arm64}.sig`]: "arm64-signature",
    ...overrides,
  };
}

function build(
  assets = fullAssetList(),
  sigs: Record<string, string> = signatures(),
) {
  return buildLatestJson({
    assets,
    version,
    tag,
    repo,
    pubDate,
    readSignature: (name: string) => {
      if (!(name in sigs)) {
        throw new Error(`missing ${name}`);
      }
      return sigs[name];
    },
  });
}

describe("buildLatestJson", () => {
  it("builds the complete darwin and windows platform matrix", () => {
    expect(build()).toEqual({
      version,
      notes: `See https://github.com/${repo}/releases/tag/${tag}`,
      pub_date: pubDate,
      platforms: {
        "darwin-universal": {
          signature: "darwin-signature",
          url: `https://github.com/${repo}/releases/download/${tag}/HQ%20Installer_1.2.3_universal.app.tar.gz`,
        },
        "darwin-aarch64": {
          signature: "darwin-signature",
          url: `https://github.com/${repo}/releases/download/${tag}/HQ%20Installer_1.2.3_universal.app.tar.gz`,
        },
        "darwin-x86_64": {
          signature: "darwin-signature",
          url: `https://github.com/${repo}/releases/download/${tag}/HQ%20Installer_1.2.3_universal.app.tar.gz`,
        },
        "windows-x86_64": {
          signature: "x64-signature",
          url: `https://github.com/${repo}/releases/download/${tag}/HQ%20Installer_1.2.3_x64-setup.exe`,
        },
        "windows-aarch64": {
          signature: "arm64-signature",
          url: `https://github.com/${repo}/releases/download/${tag}/HQ%20Installer_1.2.3_arm64-setup.exe`,
        },
      },
    });
  });

  it("ignores versionless download aliases when matching updater assets", () => {
    const manifest = build(
      fullAssetList(["HQ-Installer_x64-setup.exe.sig", "HQ-Installer_arm64-setup.exe.sig"]),
    );

    expect(manifest.platforms["windows-x86_64"].url).toContain(
      "HQ%20Installer_1.2.3_x64-setup.exe",
    );
    expect(manifest.platforms["windows-aarch64"].url).toContain(
      "HQ%20Installer_1.2.3_arm64-setup.exe",
    );
  });

  it("errors when a required signature asset is missing", () => {
    expect(() =>
      build(fullAssetList().filter(({ name }) => name !== `${arm64}.sig`)),
    ).toThrow(`Missing required arm64 NSIS updater signature: ${arm64}.sig`);
  });

  it("errors when duplicate release asset names are present", () => {
    expect(() => build(fullAssetList([x64]))).toThrow(
      `Duplicate release asset names: ${x64}`,
    );
  });

  it("errors when more than one versioned asset matches a platform", () => {
    const secondX64 = "HQ Installer Backup_1.2.3_x64-setup.exe";
    expect(() =>
      build(
        fullAssetList([secondX64, `${secondX64}.sig`]),
        signatures({ [`${secondX64}.sig`]: "second-x64-signature" }),
      ),
    ).toThrow("Multiple release assets matched x64 NSIS setup");
  });

  it("encodes spaces and special characters in download URLs", () => {
    const specialX64 = "HQ Installer #prod_1.2.3_x64-setup.exe";
    const assets = fullAssetList()
      .filter(({ name }) => name !== x64 && name !== `${x64}.sig`)
      .concat(asset(specialX64), asset(`${specialX64}.sig`));

    const manifest = build(
      assets,
      signatures({ [`${specialX64}.sig`]: "special-x64-signature" }),
    );

    expect(manifest.platforms["windows-x86_64"]).toEqual({
      signature: "special-x64-signature",
      url: `https://github.com/${repo}/releases/download/${tag}/HQ%20Installer%20%23prod_1.2.3_x64-setup.exe`,
    });
  });
});
