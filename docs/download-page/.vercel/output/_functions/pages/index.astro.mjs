import { f as createComponent, r as renderTemplate, h as addAttribute, k as renderHead } from '../chunks/astro/server_DMO0x14u.mjs';
import 'piccolore';
import 'clsx';
/* empty css                                 */
export { renderers } from '../renderers.mjs';

const REPO = "indigoai-us/hq-installer";
const LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
async function fetchLatestRelease() {
  try {
    const res = await fetch(LATEST_URL, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        // Identify ourselves so GitHub's rate-limit telemetry is useful
        // if we ever need to debug.
        "User-Agent": "hq-download-page"
      }
    });
    if (!res.ok) {
      if (res.status === 404) {
        return null;
      }
      console.error(
        `[release.ts] GitHub API ${res.status} ${res.statusText} for ${LATEST_URL}`
      );
      return null;
    }
    const body = await res.json();
    const assets = (body.assets ?? []).map((a) => ({
      name: a.name,
      size: a.size,
      browserDownloadUrl: a.browser_download_url
    }));
    return {
      tag: body.tag_name,
      name: body.name || body.tag_name,
      publishedAt: body.published_at,
      htmlUrl: body.html_url,
      assets,
      dmgAarch64: assets.find((a) => /aarch64.*\.dmg$/i.test(a.name)) ?? null,
      dmgX64: assets.find((a) => /(x64|x86_64).*\.dmg$/i.test(a.name)) ?? null
    };
  } catch (err) {
    console.error("[release.ts] fetchLatestRelease threw:", err);
    return null;
  }
}
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const mb = bytes / 1024 / 1024;
  return `${mb.toFixed(1)} MB`;
}
function formatDate(isoString) {
  try {
    const d = new Date(isoString);
    return d.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric"
    });
  } catch {
    return isoString;
  }
}

var __freeze = Object.freeze;
var __defProp = Object.defineProperty;
var __template = (cooked, raw) => __freeze(__defProp(cooked, "raw", { value: __freeze(cooked.slice()) }));
var _a;
const $$Index = createComponent(async ($$result, $$props, $$slots) => {
  const release = await fetchLatestRelease();
  const aarch64Url = release?.dmgAarch64?.browserDownloadUrl ?? null;
  const x64Url = release?.dmgX64?.browserDownloadUrl ?? null;
  const aarch64Size = release?.dmgAarch64 ? formatBytes(release.dmgAarch64.size) : null;
  const x64Size = release?.dmgX64 ? formatBytes(release.dmgX64.size) : null;
  const releaseDate = release ? formatDate(release.publishedAt) : null;
  return renderTemplate(_a || (_a = __template([`<html lang="en" data-theme="dark" data-astro-cid-j7pv25f6> <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="description" content="HQ \u2014 Personal OS for orchestrating work across companies, workers, and AI. Download the native macOS installer."><meta name="theme-color" content="#0a0e1a"><title>HQ \u2014 Download</title><link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><text y='50' font-size='48'>HQ</text></svg>"><link rel="canonical" href="https://hq.getindigo.ai"><meta property="og:title" content="HQ \u2014 Download"><meta property="og:description" content="Personal OS for orchestrating work across companies, workers, and AI."><meta property="og:type" content="website">`, '</head> <body data-astro-cid-j7pv25f6> <main class="root" data-astro-cid-j7pv25f6> <header class="hero" data-astro-cid-j7pv25f6> <div class="logo" data-astro-cid-j7pv25f6>HQ</div> <h1 data-astro-cid-j7pv25f6>Your own personal OS for getting things done.</h1> <p class="tagline" data-astro-cid-j7pv25f6>\nOrchestrate work across companies, workers, and AI \u2014 from one place,\n          on your machine, with Claude Code driving.\n</p> </header> <section class="download-card" aria-labelledby="download-heading" data-astro-cid-j7pv25f6> <h2 id="download-heading" data-astro-cid-j7pv25f6>Download HQ Installer</h2> ', ' <div class="buttons" id="buttons" data-astro-cid-j7pv25f6> <a id="btn-aarch64" class="btn btn-primary"', ' data-arch="aarch64"', "", ' data-astro-cid-j7pv25f6> <span class="btn-arch" data-astro-cid-j7pv25f6>Apple Silicon</span> <span class="btn-os" data-astro-cid-j7pv25f6>macOS \xB7 M1 / M2 / M3 / M4</span> ', ' </a> <a id="btn-x64" class="btn btn-secondary"', ' data-arch="x64"', "", ' data-astro-cid-j7pv25f6> <span class="btn-arch" data-astro-cid-j7pv25f6>Intel Mac</span> <span class="btn-os" data-astro-cid-j7pv25f6>macOS \xB7 x86_64</span> ', ` </a> </div> <p class="os-hint" id="os-hint" aria-live="polite" data-astro-cid-j7pv25f6></p> <p class="also" data-astro-cid-j7pv25f6>
Also available for:
<span class="soon" data-astro-cid-j7pv25f6>Windows (soon)</span> \xB7
<span class="soon" data-astro-cid-j7pv25f6>Linux (soon)</span> </p> <p class="security-note" data-astro-cid-j7pv25f6>
Signed with Indigo's Apple Developer ID and notarized by Apple.
          No Gatekeeper warnings.
</p> </section> <section class="devs" aria-labelledby="devs-heading" data-astro-cid-j7pv25f6> <h3 id="devs-heading" data-astro-cid-j7pv25f6>For developers</h3> <p data-astro-cid-j7pv25f6>
Comfortable in a terminal? Skip the installer and bootstrap HQ with
          one command:
</p> <pre class="code" data-astro-cid-j7pv25f6><code data-astro-cid-j7pv25f6>npx create-hq</code></pre> </section> <footer class="footer" data-astro-cid-j7pv25f6> <p data-astro-cid-j7pv25f6> `, ` </p> <p class="copyright" data-astro-cid-j7pv25f6>\xA9 2026 Indigo. HQ is open source.</p> </footer> </main> <script>
      // OS detection \u2014 client-side only. Runs after HTML is cached, so
      // ISR doesn't need to re-render per-visitor. We enhance the
      // already-rendered download buttons with an emphasized state +
      // an inline hint above the buttons.
      (function () {
        try {
          const ua = navigator.userAgent || "";
          const platform = navigator.platform || "";

          const isMac = /Mac/i.test(platform) || /Mac/i.test(ua);
          const isWindows = /Win/i.test(platform) || /Windows/i.test(ua);
          const isLinux = /Linux/i.test(platform) || /Linux/i.test(ua);

          // Modern AS Macs report "MacIntel" in platform, but we can
          // still infer Apple Silicon via the "Mac OS X" token in UA
          // combined with a WebKit device memory probe. Browsers try
          // to hide this \u2014 fallback is to highlight aarch64 since that's
          // ~80% of new Macs sold and the safer default.
          const isAppleSilicon = (() => {
            if (!isMac) return false;
            // Chrome 91+ ships navigator.userAgentData \u2014 arm64 reports
            // architecture "arm" here.
            const uaData = /** @type {{architecture?: string}} */ (
              /** @type {unknown} */ (navigator).userAgentData
            );
            if (uaData && uaData.architecture) {
              return uaData.architecture === "arm";
            }
            // Fallback: default to aarch64 for any Mac newer than 2020.
            return true;
          })();

          const hint = document.getElementById("os-hint");
          const btnA = document.getElementById("btn-aarch64");
          const btnX = document.getElementById("btn-x64");

          if (isMac) {
            if (isAppleSilicon) {
              btnA && btnA.classList.add("btn-featured");
              hint && (hint.textContent = "Detected: macOS on Apple Silicon \u2014 the top button is the one you want.");
            } else {
              btnX && btnX.classList.add("btn-featured");
              hint && (hint.textContent = "Detected: macOS on Intel \u2014 use the Intel Mac button.");
            }
          } else if (isWindows) {
            hint && (hint.textContent = "Detected: Windows. Native installer coming soon \u2014 for now, try npx create-hq.");
            btnA && btnA.classList.add("btn-dim");
            btnX && btnX.classList.add("btn-dim");
          } else if (isLinux) {
            hint && (hint.textContent = "Detected: Linux. Native installer coming soon \u2014 for now, try npx create-hq.");
            btnA && btnA.classList.add("btn-dim");
            btnX && btnX.classList.add("btn-dim");
          }
        } catch {
          // Silently no-op on any runtime error \u2014 the static HTML still
          // works fine without JS.
        }
      })();
    <\/script>  </body> </html>`])), renderHead(), release ? renderTemplate`<div class="release-meta" data-astro-cid-j7pv25f6> <span class="tag" data-astro-cid-j7pv25f6>${release.tag}</span> <span class="published" data-astro-cid-j7pv25f6>Released ${releaseDate}</span> </div>` : renderTemplate`<div class="release-meta release-meta--pending" data-astro-cid-j7pv25f6> <span class="tag tag--pending" data-astro-cid-j7pv25f6>coming soon</span> <span class="published" data-astro-cid-j7pv25f6>The first public release is being prepared.</span> </div>`, addAttribute(aarch64Url ?? "#", "href"), addAttribute(!aarch64Url, "aria-disabled"), addAttribute(aarch64Url ? "ready" : "pending", "data-state"), aarch64Size && renderTemplate`<span class="btn-size" data-astro-cid-j7pv25f6>${aarch64Size}</span>`, addAttribute(x64Url ?? "#", "href"), addAttribute(!x64Url, "aria-disabled"), addAttribute(x64Url ? "ready" : "pending", "data-state"), x64Size && renderTemplate`<span class="btn-size" data-astro-cid-j7pv25f6>${x64Size}</span>`, release ? renderTemplate`<a${addAttribute(release.htmlUrl, "href")} data-astro-cid-j7pv25f6>View all releases on GitHub →</a>` : renderTemplate`<a href="https://github.com/indigoai-us/hq-installer" data-astro-cid-j7pv25f6>View the source on GitHub →</a>`);
}, "/Users/stefanjohnson/hq/repos/private/hq-installer/docs/download-page/src/pages/index.astro", void 0);

const $$file = "/Users/stefanjohnson/hq/repos/private/hq-installer/docs/download-page/src/pages/index.astro";
const $$url = "";

const _page = /*#__PURE__*/Object.freeze(/*#__PURE__*/Object.defineProperty({
  __proto__: null,
  default: $$Index,
  file: $$file,
  url: $$url
}, Symbol.toStringTag, { value: 'Module' }));

const page = () => _page;

export { page };
