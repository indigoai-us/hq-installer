// @ts-check
import { defineConfig } from "astro/config";
import vercel from "@astrojs/vercel";

// ISR: Astro runs the page's frontmatter on every cache miss and caches
// the rendered HTML for 60 minutes. New GitHub releases are reflected
// within an hour without a manual redeploy. First request after TTL
// expires triggers a rebuild; everything in between is served from
// Vercel's edge cache.
const ONE_HOUR = 60 * 60;

export default defineConfig({
  output: "server",
  adapter: vercel({
    isr: {
      expiration: ONE_HOUR,
    },
    webAnalytics: {
      enabled: true,
    },
  }),
  site: "https://hq.getindigo.ai",
  compressHTML: true,
});
