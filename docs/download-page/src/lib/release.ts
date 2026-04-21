/**
 * GitHub release fetcher for the HQ Installer download page.
 *
 * Called from `src/pages/index.astro` frontmatter on every ISR
 * revalidation (hourly per `astro.config.mjs`). Returns `null` on any
 * failure — caller should render a graceful "coming soon" state rather
 * than crashing the build. This matters because the very first deploy
 * of this page happens BEFORE the first release is tagged, so the
 * initial fetch will 404.
 */

export interface ReleaseAsset {
  /** e.g. `hq-installer_0.1.0_aarch64.dmg` */
  name: string;
  /** size in bytes */
  size: number;
  /** direct GitHub download URL */
  browserDownloadUrl: string;
}

/** Distribution format of a macOS universal artifact. */
export type MacFormat = "zip" | "dmg" | "app.tar.gz";

export interface MacUniversal {
  asset: ReleaseAsset;
  /** Which distribution format this artifact is. The UI uses this to
   *  show an accurate subtitle ("Notarized .zip" vs "Notarized .dmg"). */
  format: MacFormat;
}

export interface Release {
  /** git tag, e.g. `v0.1.0` */
  tag: string;
  /** release display name */
  name: string;
  /** ISO-8601 */
  publishedAt: string;
  /** GitHub release HTML URL */
  htmlUrl: string;
  /** all assets, in the order GitHub returns them */
  assets: ReleaseAsset[];
  /** canonical Apple Silicon DMG, or null if missing */
  dmgAarch64: ReleaseAsset | null;
  /** canonical Intel DMG, or null if missing */
  dmgX64: ReleaseAsset | null;
  /** universal macOS artifact (works on both arches) with its format.
   *  Preference order: .zip → .dmg → .app.tar.gz. When present the page
   *  shows a single primary button instead of the arch-split pair.
   *
   *  v0.1.12+ ships `.zip` (notarized .app archived with `ditto`, auto-
   *  extracts in Safari, double-click to run — no drag-to-Applications).
   *  v0.1.11 shipped `.dmg`. We keep both branches so either format
   *  works if the release pipeline ever flips back.
   *
   *  `.app.tar.gz` is the Tauri updater format — accepted last because
   *  it requires users to `tar -xzf` by hand; only surfaces as a button
   *  target if neither `.zip` nor `.dmg` is present. */
  macUniversal: MacUniversal | null;
}

const REPO = "indigoai-us/hq-installer";
const LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`;

/**
 * Fetch the latest release. Returns `null` on any error (404, network,
 * rate-limit, malformed response) — never throws.
 *
 * Uses the public GitHub API — no auth needed for read access to a
 * public repo, rate-limited to 60/hr/IP which is comfortably above
 * our ISR cadence (24/day).
 */
export async function fetchLatestRelease(): Promise<Release | null> {
  try {
    const res = await fetch(LATEST_URL, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        // Identify ourselves so GitHub's rate-limit telemetry is useful
        // if we ever need to debug.
        "User-Agent": "hq-download-page",
      },
    });

    if (!res.ok) {
      if (res.status === 404) {
        // No releases yet — this is the normal state before the first
        // tag-push. Caller renders a "first release coming" message.
        return null;
      }
      // eslint-disable-next-line no-console
      console.error(
        `[release.ts] GitHub API ${res.status} ${res.statusText} for ${LATEST_URL}`,
      );
      return null;
    }

    const body = (await res.json()) as GhRelease;
    const assets: ReleaseAsset[] = (body.assets ?? []).map((a) => ({
      name: a.name,
      size: a.size,
      browserDownloadUrl: a.browser_download_url,
    }));

    return {
      tag: body.tag_name,
      name: body.name || body.tag_name,
      publishedAt: body.published_at,
      htmlUrl: body.html_url,
      assets,
      dmgAarch64:
        assets.find((a) => /aarch64.*\.dmg$/i.test(a.name)) ?? null,
      dmgX64:
        assets.find((a) => /(x64|x86_64).*\.dmg$/i.test(a.name)) ?? null,
      // Universal macOS artifact — preference order: .zip → .dmg → .app.tar.gz.
      // Within each format we prefer the unversioned evergreen filename
      // (`hq-installer_universal.<ext>`) over versioned copies so the
      // download URL stays stable across releases.
      macUniversal: pickMacUniversal(assets),
    };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[release.ts] fetchLatestRelease threw:", err);
    return null;
  }
}

/**
 * Select the best universal macOS artifact from a release's asset list.
 *
 * Preference order (each tier falls through to the next if empty):
 *   1. `.zip`           — v0.1.12+ canonical; Safari auto-extracts, no mount
 *   2. `.dmg`           — v0.1.11 canonical; classic mount-and-drag flow
 *   3. `.app.tar.gz`    — Tauri updater format; accepted as a last resort
 *
 * Within each tier, the unversioned evergreen name (`hq-installer_universal.ext`)
 * wins over versioned copies (`hq-installer_0.1.12_universal.ext`) — keeps
 * the external download URL stable across releases so marketing links
 * don't need re-editing every bump.
 *
 * Exported for unit testing; the page only consumes `Release.macUniversal`.
 */
export function pickMacUniversal(
  assets: readonly ReleaseAsset[],
): MacUniversal | null {
  const byPattern = (pattern: RegExp) => assets.find((a) => pattern.test(a.name));

  // .zip tier
  const zipEvergreen = byPattern(/^hq-installer_universal\.zip$/i);
  const zipAny = byPattern(/universal.*\.zip$/i);
  if (zipEvergreen) return { asset: zipEvergreen, format: "zip" };
  if (zipAny) return { asset: zipAny, format: "zip" };

  // .dmg tier
  const dmgEvergreen = byPattern(/^hq-installer_universal\.dmg$/i);
  const dmgAny = byPattern(/universal.*\.dmg$/i);
  if (dmgEvergreen) return { asset: dmgEvergreen, format: "dmg" };
  if (dmgAny) return { asset: dmgAny, format: "dmg" };

  // .app.tar.gz tier — Tauri updater format; match *after* `.sig` exclusion
  // (the updater ships a signature file that also ends in .tar.gz in name
  // prefix; we only want the archive itself).
  const tarGz = assets.find(
    (a) =>
      /universal.*\.app\.tar\.gz$/i.test(a.name) && !/\.sig$/i.test(a.name),
  );
  if (tarGz) return { asset: tarGz, format: "app.tar.gz" };

  return null;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const mb = bytes / 1024 / 1024;
  return `${mb.toFixed(1)} MB`;
}

export function formatDate(isoString: string): string {
  try {
    const d = new Date(isoString);
    return d.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return isoString;
  }
}

// ──────────────────────────────────────────────────────────────────────
// GitHub response shape — we only type the fields we actually read.
// ──────────────────────────────────────────────────────────────────────

interface GhAsset {
  name: string;
  size: number;
  browser_download_url: string;
}

interface GhRelease {
  tag_name: string;
  name: string | null;
  published_at: string;
  html_url: string;
  assets?: GhAsset[];
}
