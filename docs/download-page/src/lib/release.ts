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
  /** universal DMG (works on both arches), or null if missing.
   * When present the page shows a single primary button instead of
   * the arch-split pair — v0.1.11+ ships universal only. */
  dmgUniversal: ReleaseAsset | null;
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
      // Prefer the unversioned `hq-installer_universal.dmg` (evergreen
      // filename) when multiple universal DMGs exist — keeps the URL
      // stable across releases. Falls back to any *universal*.dmg.
      dmgUniversal:
        assets.find((a) => /^hq-installer_universal\.dmg$/i.test(a.name)) ??
        assets.find((a) => /universal.*\.dmg$/i.test(a.name)) ??
        null,
    };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[release.ts] fetchLatestRelease threw:", err);
    return null;
  }
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
