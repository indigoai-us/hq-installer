# hq-installer — Design Direction

style-pack: goclaw-admin
scope: docs/download-page

## Surface

A single-page Astro landing at [install.getindigo.ai](https://install.getindigo.ai) that advertises the native macOS installer and links to `npx create-hq` for terminal users. Scope is **one page** — no shell, no sidebar, no data tables.

The rest of this repo (the Tauri installer itself) has its own retro-TUI aesthetic and is NOT governed by this pack.

## Pack

Consumes `goclaw-admin` (`knowledge/public/design-styles/packs/goclaw-admin/`).

The pack ships with a Next.js 15 + Tailwind v4 implementation guide, but the download page is a plain Astro page. The pack contract that applies is the **tokens** (`--ga-*`) and the **visual rules** in `style-guide.md` §1–§3:

- Background: `--ga-zinc-950` (`#09090b`) everywhere.
- Structural borders: `rgba(255,255,255,0.06)` hairlines only. No solid 1px borders. No drop shadows.
- Corners: flat (`--ga-radius-0`). Cards, buttons, code blocks, badges — all square.
- Color: status-only. The download page has two status slots — "ready" (info / blue-400) and "coming soon" (warning / amber-400). No brand cyan.
- Typography:
  - **Display** (Barlow Condensed 600/700, uppercase, `tracking-[0.2em]`): the "HQ" wordmark, section headings ("Download HQ Installer", "For developers").
  - **Body** (Inter 400–600, `tracking-body` 0.01em): H1, tagline, paragraph copy, button labels.
  - **Mono** (IBM Plex Mono 400/500): version tag, file size, `npx create-hq` code block.
- Section heading size: 9 px uppercase at `tracking-[0.2em]`, color `--ga-fg-dim` / `--ga-fg-dimmer`.

## Consumption

Tokens are **copy-pasted** into `docs/download-page/src/styles/goclaw-admin-tokens.css` (pack rule: no symlinks across repo boundaries — Vercel build constraint).

Fonts are loaded in `<head>` via `<link rel="preconnect">` + Google Fonts CSS (single request, `display=swap`). Self-hosting via `@fontsource/*` is a follow-up if the pack moves to that pattern.

The Astro page `<style>` block consumes tokens via `var(--ga-*)` — no utility classes, no Tailwind.

## Quality gate

Before landing any change to the download page, run the `goclaw-admin/implementation.md` §12 checklist. The applicable items for a single-page landing:

- [ ] Background is `bg-zinc-950`.
- [ ] Every border is `border-white/[0.06]`. No solid 1px colors. No shadows.
- [ ] Color appears only on status affordances (`tag` / `tag--pending`).
- [ ] Numbers, sizes, version strings render in mono (IBM Plex Mono).
- [ ] Section headings are display-family 9 px uppercase at `tracking-[0.2em]`.
- [ ] No rounded corners on cards, buttons, or code blocks.
- [ ] Focus-visible rings present on every interactive element.

## Off-pack moments (documented, not violations)

- The "HQ" logo in the hero is styled as a display wordmark (Barlow Condensed 700 uppercase `tracking-[0.15em]`) rather than the pack's mono-numerals default — logos get display treatment per §2.1.
- The featured-button highlight uses `bg-white/[0.06]` inset rather than a colored glow. This matches goclaw-admin's active-row treatment (`implementation.md` §4) rather than introducing brand color.

## Related

- Pack: [`knowledge/public/design-styles/packs/goclaw-admin/`](../../knowledge/public/design-styles/packs/goclaw-admin/)
- Sibling consumer: `hq-console` (`repos/private/hq-console/`) — the canonical data-dense implementation.
- Divergent sibling: `hq-onboarding` (`repos/private/hq-onboarding/`) — uses `hq-cinematic` deliberately (different job-to-be-done: immersive onboarding flow vs. a console or a download utility).
