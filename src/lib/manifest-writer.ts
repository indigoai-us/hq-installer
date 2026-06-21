import { parse, stringify } from "yaml";
import { readInstallTextFile, writeInstallTextFile } from "./install-fs";

export interface ManifestEntrySeed {
  /** Slug used as the key in `companies.{slug}`. */
  slug: string;
  /** Display name written to the entry. */
  name: string;
  /** Cloud entity UID — included in the entry when present. */
  cloudUid?: string;
  /** S3 bucket name — included in the entry when present. */
  bucketName?: string;
}

export interface ManifestWriteResult {
  added: string[];
  skipped: string[];
}

interface CompanyEntry {
  name?: string;
  goal?: string;
  path?: string;
  sources?: string[];
  repos?: string[];
  knowledge?: string;
  qmd_collections?: string[];
  cloud_uid?: string;
  bucket_name?: string;
  [k: string]: unknown;
}

interface ManifestShape {
  companies?: Record<string, CompanyEntry>;
  [k: string]: unknown;
}

/**
 * Read-modify-write `companies/manifest.yaml` to ensure each seed has a
 * matching entry. Idempotent: existing slugs are never overwritten — they
 * are reported via `skipped`. Used by the installer's personalize step
 * after scaffolding company directories.
 *
 * Behaviour:
 *  - Missing manifest file → create one with `companies: {}` and proceed.
 *  - Missing `companies` key → create it as an empty mapping.
 *  - Existing slug → skip (preserves user-edited fields).
 *  - New slug → append entry mirroring the hq-core template schema.
 *
 * Atomic write: routed through the install `write_file` command, which writes
 * a temp sibling and renames it inside Rust after root validation.
 */
export async function ensureManifestEntries(
  installPath: string,
  seeds: ManifestEntrySeed[],
): Promise<ManifestWriteResult> {
  const result: ManifestWriteResult = { added: [], skipped: [] };
  if (seeds.length === 0) return result;

  const manifestPath = `${installPath}/companies/manifest.yaml`;

  let manifest: ManifestShape;
  try {
    const raw = await readInstallTextFile(installPath, manifestPath);
    const parsed = parse(raw) as unknown;
    manifest =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as ManifestShape)
        : {};
  } catch {
    manifest = {};
  }

  if (!manifest.companies || typeof manifest.companies !== "object") {
    manifest.companies = {};
  }

  let mutated = false;
  for (const seed of seeds) {
    const slug = seed.slug.trim();
    if (!slug) continue;
    if (manifest.companies[slug]) {
      result.skipped.push(slug);
      continue;
    }

    const entry: CompanyEntry = {
      name: seed.name,
      goal: "",
      path: `companies/${slug}`,
      sources: [],
      repos: [],
      knowledge: `companies/${slug}/knowledge/`,
      qmd_collections: [slug],
    };
    if (seed.cloudUid) entry.cloud_uid = seed.cloudUid;
    if (seed.bucketName) entry.bucket_name = seed.bucketName;

    manifest.companies[slug] = entry;
    result.added.push(slug);
    mutated = true;
  }

  if (!mutated) return result;

  const serialized = stringify(manifest, { indent: 2, lineWidth: 0 });
  await writeInstallTextFile(installPath, manifestPath, serialized);

  return result;
}

/**
 * Pure helper — exposed for tests. Given a parsed manifest object and
 * seeds, return the mutated manifest plus the add/skip report. Does not
 * touch the filesystem.
 */
export function mergeManifestEntries(
  manifest: ManifestShape,
  seeds: ManifestEntrySeed[],
): { manifest: ManifestShape; result: ManifestWriteResult } {
  const result: ManifestWriteResult = { added: [], skipped: [] };
  const next: ManifestShape = { ...manifest };
  next.companies = { ...(manifest.companies ?? {}) };

  for (const seed of seeds) {
    const slug = seed.slug.trim();
    if (!slug) continue;
    if (next.companies[slug]) {
      result.skipped.push(slug);
      continue;
    }
    const entry: CompanyEntry = {
      name: seed.name,
      goal: "",
      path: `companies/${slug}`,
      sources: [],
      repos: [],
      knowledge: `companies/${slug}/knowledge/`,
      qmd_collections: [slug],
    };
    if (seed.cloudUid) entry.cloud_uid = seed.cloudUid;
    if (seed.bucketName) entry.bucket_name = seed.bucketName;
    next.companies[slug] = entry;
    result.added.push(slug);
  }

  return { manifest: next, result };
}
