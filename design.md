# hq-installer — Design Direction

style: getindigo.ai monochrome authority (no style-pack)
scope: docs/download-page

## Surface

A single-page Astro landing at [install.getindigo.ai](https://install.getindigo.ai)
that advertises the native macOS installer and links to `npx create-hq` for
terminal users. Scope is **one page** — no shell, no sidebar, no data tables.

The rest of this repo (the Tauri installer itself) has its own retro-TUI
aesthetic and is NOT governed by this direction.

## Direction

The download page is aligned to the **getindigo.ai marketing-site language**
(`repos/private/indigo-marketing`) so the install surface reads as part of the
same product family as `www.getindigo.ai` and the `hq-console` (`hq.getindigo.ai`).
That family is **dark monochrome authority**: near-black surfaces, a single
indigo accent used as punctuation (never as a surface), white primary CTAs, and
Geist / Geist Mono type. The page does **not** consume a `hq-cinematic` style
pack — the prior rainbow-spectrum / prism-beam treatment was removed on
2026-06-03 because it was the only HQ surface running full spectrum and clashed
with both getindigo.ai (monochrome + single indigo) and hq-console (minimal
Vercel-dark).

## Tokens

Defined inline in `src/pages/index.astro` under the page `<style>` `:root`,
mirroring `indigo-marketing/app/globals.css`:

| Token | Value | Use |
|-------|-------|-----|
| `--bg` | `#09090b` | Page background |
| `--bg-card` | `#111113` | Cards, terminal surfaces |
| `--bg-elevated` | `#18181b` | Raised surfaces |
| `--border` | `rgba(255,255,255,0.06)` | Hairline borders |
| `--border-accent` | `rgba(255,255,255,0.12)` | Secondary-button outline |
| `--text-primary` | `#fafafa` | Headings, primary CTA fill |
| `--text-secondary` | `#a1a1aa` | Body copy |
| `--text-muted` | `#52525b` | Metadata, mono labels |
| `--accent` | `#818cf8` | **Accents only** — brackets, badge, glow, link arrows |
| `--cyan` | `#22d3ee` | `npx create-hq` command echo |
| `--green` / `--amber` / `--rose` | — | Terminal traffic-light dots (ornamental) |

## Hero mark

The hero uses the **canonical HQ logomark** — the geometric white "HQ"
letterform shared with `hq-console` (`src/app/icon.svg`). Asset:
`public/hq-logomark.svg` (white, transparent), sourced from the brand
`HQ.svg`. The page favicon (`public/favicon.svg`) wraps the same mark on a
`#09090b` rounded square. **Do not** reintroduce a text-rendered "HQ" with a
gradient text-mask — the mark is a real asset, not a font treatment.

## Button system

**Primary download → white, not periwinkle.** This is the indigo-marketing
brand rule (2026-04-24): every primary download / sign-up is white
(`--text-primary` fill, `--bg` text), never `--accent`. Reference:
`indigo-marketing/components/sections/hero.tsx`.

- Primary (`.btn-primary`): white fill, near-black text, soft white glow.
- Secondary (`.btn-secondary`): transparent, hairline `--border-accent` outline,
  ghost hover.
- Featured (`.btn-featured`, applied by OS-detection JS): keeps the white fill,
  adds an indigo accent rim + glow so the matched build reads as "the one for
  you" without breaking the white-CTA rule.

## Structural motifs

Both lifted from `indigo-marketing/components/hq/`:

- **Corner brackets** — indigo `/30` tick marks at the four corners of the
  download card (`.bracket--{tl,tr,bl,br}`). From `corner-brackets.tsx`.
- **Terminal card** — the "for developers" section uses the fake-mac-terminal
  chrome: rose/amber/green traffic-light dots, mono title bar, `$`-prefixed
  command in cyan. From `terminal-card.tsx`.

## Type

- **Geist** (body) + **Geist Mono** (metadata, labels, CTAs, code) — the family
  `hq-console` and `www.getindigo.ai` share. One Google Fonts request loads both.
- No display-weight rainbow wordmark, no Inter-900, no JetBrains Mono (the prior
  page's fonts are gone).

## Quality gate

Before landing any change to the download page:

- [ ] Background is `--bg` / `--bg-card`. No navy, no light surfaces.
- [ ] **No rainbow spectrum** anywhere. The only chroma is the single indigo
      accent (brackets, badge, hero glow, link arrows) + the cyan command echo +
      the ornamental terminal dots.
- [ ] Hero shows the real HQ logomark asset, not gradient-masked text.
- [ ] Primary download button is white, never `--accent`.
- [ ] Display + body type is Geist; metadata/labels/code are Geist Mono.
- [ ] Numerals (version tag, file size, dates) read in Geist Mono.
- [ ] Every animation has a `prefers-reduced-motion: reduce` collapse path
      (the `rise` entrance animations and all transitions are disabled).
- [ ] Focus-visible rings present on every interactive element (indigo accent
      against near-black).

## Off-direction moments (documented, not violations)

- **Soft indigo hero glow.** A single low-opacity radial bloom
  (`--accent-glow`, no animation) sits behind the wordmark. It is the one
  accent "moment" — replacing the old animated prism beam — and stays a single
  hue, not a spectrum.
- **Cyan on the `npx create-hq` command.** Mirrors the marketing-site create-hq
  card, where the secondary install path uses a cyan tint to read as obviously
  secondary to the white primary download.

## Related

- Reference site: `indigo-marketing` (`repos/private/indigo-marketing`,
  `www.getindigo.ai`) — `design.md` + `app/globals.css` are the source of truth
  for tokens, the white-CTA rule, and the bracket/terminal motifs.
- Brand: `companies/indigo/knowledge/brand/brand-guidelines.md`.
- Sibling surface: `hq-console` (`repos/private/hq-console`, `hq.getindigo.ai`) —
  minimal Vercel-dark; shares the Geist family and near-black palette.
- History: this page previously consumed `goclaw-admin` (monochrome admin),
  then `hq-cinematic` (navy + spectrum, 2026-04-21), then was realigned to the
  getindigo.ai monochrome language on 2026-06-03 to match the marketing site and
  console rather than the cinematic onboarding surface.
