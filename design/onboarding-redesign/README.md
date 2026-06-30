# Onboarding redesign — interactive prototype

A clickable, self-contained prototype for a redesigned HQ desktop onboarding,
plus the install→resident **menubar/sync** handoff. Built to be reviewed two
ways: a live link for taste review, and this folder for build review.

- **Live preview:** https://hq-onboarding-preview.indigo-hq.com
- **Run locally:** open `index.html` in any browser (no build, no server —
  assets are bundled and referenced relatively).

## What this proposes

The installer wizard and the sync menubar are presented as **one continuous
product**: a one-time full-window wizard that *graduates into* a resident
menubar sync agent. The native app's job ends at "HQ is ready" (the menubar
takes over); the remaining steps are what happens next inside Claude Code /
Codex.

### Visual language
- **Format:** every screen is a gradient top half (`assets/onboarding-bg.jpg`)
  with a graphic/mockup, over a content half (white in light mode, dark
  elevated `#2b2b2e` in dark mode — *not* pure black, per macOS dark-mode
  elevation).
- **Light/dark:** fully appearance-aware, including a macOS Sonoma desktop
  wallpaper behind the window and an NSPopover-style menubar popover that
  follows system appearance (the shipping `hq-sync` popover hardcodes dark —
  see note below).
- **Type/tokens** mirror the Figma source: Geist, heading 24/32 (−1 tracking),
  body 14/20, 40px pill-radius-8 buttons, 24px padding.

### Transitions
- Content + buttons: sequential fade-out → fade-in.
- Graphics: cross-fade between early screens; **carousel slide** (left/right by
  direction) between the Claude Code mockup screens.
- Gradient stays fixed and only **stretches** (200→240px) at the Done→Trust
  boundary.
- At **"HQ is ready,"** a macOS menu bar drops in and the **sync popover**
  springs from the top-right — the install→resident handoff.

## Screen → source mapping (for implementation)

| Prototype screen | Maps to (`src/...`) |
|---|---|
| Welcome (logo, value prop, telemetry, Google/Microsoft login) | `screens/01-welcome.tsx`, `screens/02-cognito-auth.tsx` |
| Choose where HQ lives (folder picker, breadcrumb, native `Choose…`) | `screens/06-directory.tsx` |
| Getting your HQ ready (progress ring + live substeps) | `screens/setup-progress.tsx` (substeps = the real `STAGE_LABELS`) |
| HQ is ready (handoff → menu bar + sync popover) | `screens/11-summary.tsx` |
| Trust / Settings / `/setup` / `/handoff` / build | post-handoff, happen **in Claude Code** — informational here, mirror `indigo-marketing app/install/SetupSteps.tsx` |

## Note for `hq-sync`

The menubar popover here is modeled on `hq-sync` `src/components/Popover.svelte`
(wordmark header + Sync pill + status + workspace list), with two intentional
changes worth discussing:
1. **Appearance-aware** — light vibrancy in light mode, dark in dark
   (a native `NSPopover` inherits `NSAppearance`; the current build forces dark).
2. **Sync** button is black/white (not accent blue).

## Open questions for review
- Do the post-handoff steps belong in the native app at all, or only as an
  in-Claude-Code `/setup` walkthrough + docs?
- Should `initial-sync` ("Starting cloud sync") be a visible setup substep?
- Menubar popover: ship appearance-aware, or keep dark-only?
