# hq-download-page

Public landing page for HQ Installer. Fetches the latest GitHub release at build/ISR time and offers OS-appropriate download buttons.

## Stack

- **Astro 5** (`output: "server"` + ISR via `@astrojs/vercel`)
- **Zero client JS frameworks** — a single inline script handles OS detection
- **No CSS framework** — plain `<style>` block in `index.astro`
- **ISR** — GitHub release URL refreshes hourly without redeploy

## Local dev

```bash
cd docs/download-page
pnpm install
pnpm dev
```

Open http://localhost:4321.

The dev server runs the page's frontmatter live, so every reload re-fetches the GitHub API. If you hit rate limits (60/hr unauthenticated), set `GITHUB_TOKEN` in your shell and it'll bump to 5000/hr — but not in production; production uses unauthenticated reads.

## Build

```bash
pnpm build
```

Output goes to `dist/` + a `.vercel/output/` directory that the Vercel CLI uses to deploy the ISR routes.

## Deploy

This page lives on the **Indigo** Vercel team. Follow `companies/indigo/policies/account-mapping.md`:

```bash
# 1. Pull the Vercel token from 1Password
op item get "Vercel Indigo" --format json > /tmp/.vercel-indigo.json
VERCEL_TOKEN=$(python3 -c "
import json
d = json.load(open('/tmp/.vercel-indigo.json'))
print([f['value'] for f in d['fields'] if f.get('label') == 'API_KEY'][0])
")

# 2. Link with Indigo scope (first deploy only)
cd docs/download-page
npx vercel link \
  --yes \
  --scope team_aTFxF7CXe0vdU3ngAs3SveDg \
  --project hq-download-page \
  --token "$VERCEL_TOKEN"

# 3. Deploy
npx vercel deploy --prod --yes --token "$VERCEL_TOKEN"

# 4. Clean up
rm -f /tmp/.vercel-indigo.json
```

## Production domain

Target: `hq.getindigo.ai` — requires a Route 53 CNAME to the Vercel deployment. Until DNS is configured, the page is accessible at its Vercel preview URL.

To attach the custom domain after DNS propagates:

```bash
npx vercel domains add hq.getindigo.ai hq-download-page --token "$VERCEL_TOKEN"
```

## How ISR works here

1. First request after deploy → Vercel runs the page frontmatter, which hits GitHub's `/releases/latest` API.
2. Rendered HTML is cached in Vercel's edge.
3. Subsequent requests serve from the cache for up to 60 minutes (`expiration` in `astro.config.mjs`).
4. First request after TTL expires → backend re-runs the frontmatter (fresh GitHub fetch), updates the cache.

This means a brand-new release is live on the page within an hour of publishing, no manual redeploy needed.

## Graceful pre-release state

`fetchLatestRelease()` returns `null` on any error, including the 404 you'll see before the first tag is pushed. The page detects that and renders a "coming soon" state instead of crashing.
