# hq-installer — Design Direction

style-pack: hq-cinematic
scope: docs/download-page

## Surface

A single-page Astro landing at [install.getindigo.ai](https://install.getindigo.ai) that advertises the native macOS installer and links to `npx create-hq` for terminal users. Scope is **one page** — no shell, no sidebar, no data tables.

The rest of this repo (the Tauri installer itself) has its own retro-TUI aesthetic and is NOT governed by this pack.

## Pack

Consumes `hq-cinematic` (`knowledge/public/design-styles/packs/hq-cinematic/`).

The pack ships as a tokens + keyframes bundle with nine exported React primitives (in `hq-onboarding`). This download page is plain Astro, so the contract that applies is the **tokens** (`--bg-navy-*`, `--spectrum-*`, `--warm-*`), the **keyframes** (`prism-sweep`, `beam-drift`, `bloom-pulse`, etc.), and the **Do/Don't list** in `README.md`:

- Background: `--bg-navy-500` (`#080F24`) as the default; a fixed radial vignette lifts the center toward `--bg-navy-400` and deepens the corners toward `--bg-navy-900`.
- Chroma: **one hero moment per screen.** A single `--gradient-spectrum-linear` beam sits behind the "HQ" wordmark, blurred and drift-animated. The wordmark itself uses the same gradient as a text mask. No other surface in the page uses the full spectrum.
- Counterweights: warm-yellow / warm-brown tints carry hairlines, body text, tags, and code glyphs. Status affordances use `--spectrum-gold` (ready) and `--warm-pink` (pending) — single hues, not gradients.
- Corners: 2 px — minimal radius, not flat-square. Keeps the cinematic softness; still reads industrial.
- Typography: **Inter 800/900 only** for display (pack rule). Body copy inherits the same family at 400–600. No new font dependencies; one Google Fonts `<link>` request.
- Motion: `prism-sweep` on wordmark entrance (1.4 s, once). `beam-drift` infinitely alternating on the hero beam (8 s). `bloom-pulse` on featured-button focus (900 ms, once). All collapse to end-state under `prefers-reduced-motion: reduce` per the pack's hard-cut overrides in `keyframes.css`.

## Consumption

Tokens and keyframes are **copy-pasted** into `docs/download-page/src/styles/hq-cinematic-{tokens,keyframes}.css` (pack rule: no symlinks across repo boundaries — Vercel build constraint). Refreshed when the pack version bumps.

Fonts are loaded in `<head>` via `<link rel="preconnect">` + Google Fonts CSS (single request, `display=swap`). Self-hosting via `@fontsource/*` is a follow-up if the pack moves to that pattern.

The Astro page `<style>` block consumes tokens via `var(--bg-navy-*)`, `var(--spectrum-*)`, `var(--warm-*)`, and motion primitives via `var(--motion-*)` — no utility classes, no Tailwind.

## Quality gate

Before landing any change to the download page, confirm against the hq-cinematic pack `README.md` Do/Don't list:

- [ ] Background is navy-500 or navy-900. No light surfaces, no zinc/slate.
- [ ] **Exactly one** spectrum beam on screen (hero). No stacked beams, no dust layer (this page doesn't need it).
- [ ] Spectrum-gold / warm-yellow / warm-brown are the only accent hues on body surfaces. No cyan-cyberpunk, no synthwave neon.
- [ ] Display type is Inter 800 or 900. No Barlow, no Space Grotesk, no display-serif.
- [ ] Numerals (version tag, file size, dates) use `font-variant-numeric: tabular-nums` for column alignment.
- [ ] Every animation has a `prefers-reduced-motion: reduce` collapse path. Beam stops drifting. Wordmark renders static-gradient.
- [ ] Focus-visible rings present on every interactive element (warm-yellow, AAA contrast against navy).

## Off-pack moments (documented, not violations)

- **Card radius 2 px.** The pack itself is silent on border-radius. `hq-onboarding` uses `rounded-md` for cards; we pick a tighter 2 px to match the utility-tool register of a download page. Still rounded (not flat), just restrained.
- **Wordmark with gradient text mask + prism sweep on entrance.** The pack ships a `SpectrumText` React primitive for exactly this, but we're on plain Astro — we inline the `background: var(--gradient-spectrum-linear); background-clip: text;` pattern directly and rely on the pack's `@supports not (background-clip: text)` fallback in `keyframes.css`. Same contract, no React dependency.
- **Featured-button glow uses warm-yellow + violet drop-shadow mix, not a full spectrum halo.** Keeps the hero beam as the single chroma moment and leaves the CTA reading as warm confident neutral.
- **Tabular-nums everywhere instead of a dedicated mono family.** Pack rule: "no new font dependencies." Inter's tabular-nums feature carries version strings, sizes, and dates — no IBM Plex Mono loaded.

## Related

- Pack: [`knowledge/public/design-styles/packs/hq-cinematic/`](../../knowledge/public/design-styles/packs/hq-cinematic/)
- Sibling consumer: `hq-onboarding` (`repos/private/hq-onboarding/`) — the canonical React primitive implementation. Watch for drift: when the pack rev's, both consumers need a token refresh.
- Former consumer: this page previously consumed `goclaw-admin` (monochrome industrial admin register). Swapped to `hq-cinematic` on 2026-04-21 to align the marketing surface with `onboarding.getindigo.ai` rather than the internal `hq-console`.
