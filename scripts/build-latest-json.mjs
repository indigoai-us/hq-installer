// Invoked as `node scripts/build-latest-json.mjs …` from release.yml and
// imported directly by its vitest suite. No shebang: a `#!` line is a syntax
// error when the module is imported through Vitest's transform on Windows.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export class ReleaseManifestError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReleaseManifestError";
  }
}

function fail(message) {
  throw new ReleaseManifestError(message);
}

export function normalizeReleaseAssets(input) {
  const rawAssets = Array.isArray(input) ? input : input?.assets;
  if (!Array.isArray(rawAssets)) {
    fail("Release assets must be an array or an object with an assets array");
  }

  const names = rawAssets.map((asset, index) => {
    if (typeof asset === "string") {
      return asset;
    }
    if (asset && typeof asset.name === "string") {
      return asset.name;
    }
    fail(`Release asset at index ${index} is missing a name`);
  });

  const seen = new Set();
  const duplicates = new Set();
  for (const name of names) {
    if (seen.has(name)) {
      duplicates.add(name);
    }
    seen.add(name);
  }
  if (duplicates.size > 0) {
    fail(`Duplicate release asset names: ${[...duplicates].sort().join(", ")}`);
  }

  return names;
}

function isVersionlessAlias(name) {
  return name === "hq-installer_universal.zip" || name.startsWith("HQ-Installer_");
}

function findOneAsset(names, label, predicate) {
  const matches = names.filter(predicate);
  if (matches.length === 0) {
    fail(`Missing release asset for ${label}`);
  }
  if (matches.length > 1) {
    fail(`Multiple release assets matched ${label}: ${matches.join(", ")}`);
  }
  return matches[0];
}

function requireAsset(names, name, label) {
  if (!names.includes(name)) {
    fail(`Missing required ${label}: ${name}`);
  }
}

function readRequiredSignature(signatureName, readSignature) {
  let signature;
  try {
    signature = readSignature(signatureName);
  } catch (error) {
    fail(`Missing downloaded signature asset: ${signatureName}`);
  }

  if (typeof signature !== "string" || signature.trim() === "") {
    fail(`Signature asset is empty: ${signatureName}`);
  }
  return signature.trim();
}

function formatPubDate(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function assetDownloadUrl(repo, tag, assetName) {
  if (!repo || !tag || !assetName) {
    fail("repo, tag, and assetName are required to build a download URL");
  }
  return `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`;
}

export function buildLatestJson({
  assets,
  releaseAssets,
  version,
  tag,
  repo,
  readSignature,
  pubDate = formatPubDate(new Date()),
}) {
  if (!version) {
    fail("version is required");
  }
  if (!tag) {
    fail("tag is required");
  }
  if (!repo) {
    fail("repo is required");
  }
  if (typeof readSignature !== "function") {
    fail("readSignature callback is required");
  }

  const names = normalizeReleaseAssets(releaseAssets ?? assets);
  const darwinBundle = findOneAsset(
    names,
    "darwin universal updater tarball",
    (name) =>
      name.endsWith(".tar.gz") &&
      !name.endsWith(".tar.gz.sig") &&
      !isVersionlessAlias(name),
  );
  const darwinSigName = `${darwinBundle}.sig`;
  requireAsset(names, darwinSigName, "darwin universal updater signature");

  const darwinSignature = readRequiredSignature(darwinSigName, readSignature);
  const darwinPlatform = {
    signature: darwinSignature,
    url: assetDownloadUrl(repo, tag, darwinBundle),
  };
  const platforms = {
    "darwin-universal": darwinPlatform,
    "darwin-aarch64": darwinPlatform,
    "darwin-x86_64": darwinPlatform,
  };

  const windowsTargets = [
    ["x64", "windows-x86_64"],
    ["arm64", "windows-aarch64"],
  ];
  for (const [arch, platformKey] of windowsTargets) {
    const setupName = findOneAsset(
      names,
      `${arch} NSIS setup`,
      (name) => name.endsWith(`_${arch}-setup.exe`) && !isVersionlessAlias(name),
    );
    const sigName = `${setupName}.sig`;
    requireAsset(names, sigName, `${arch} NSIS updater signature`);
    platforms[platformKey] = {
      signature: readRequiredSignature(sigName, readSignature),
      url: assetDownloadUrl(repo, tag, setupName),
    };
  }

  return {
    version,
    notes: `See https://github.com/${repo}/releases/tag/${encodeURIComponent(tag)}`,
    pub_date: pubDate,
    platforms,
  };
}

function usage() {
  return [
    "Usage: node scripts/build-latest-json.mjs --assets release-assets.json --sig-dir release-sigs --version 1.2.3 --tag v1.2.3 --repo owner/repo --output latest.json",
    "",
    "release-assets.json may be an array of assets or an object with an assets array.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      fail(`Unexpected positional argument: ${arg}`);
    }
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      fail(`Missing value for --${key}`);
    }
    args[key] = value;
    index += 1;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  for (const key of ["assets", "sig-dir", "version", "tag", "repo", "output"]) {
    if (!args[key]) {
      fail(`Missing required argument --${key}`);
    }
  }

  const releaseAssets = JSON.parse(fs.readFileSync(args.assets, "utf8"));
  const manifest = buildLatestJson({
    releaseAssets,
    version: args.version,
    tag: args.tag,
    repo: args.repo,
    readSignature: (signatureName) =>
      fs.readFileSync(path.join(args["sig-dir"], signatureName), "utf8"),
  });

  fs.writeFileSync(args.output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  main().catch((error) => {
    const message =
      error instanceof ReleaseManifestError ? error.message : error?.stack || String(error);
    console.error(`::error::${message}`);
    process.exit(1);
  });
}
