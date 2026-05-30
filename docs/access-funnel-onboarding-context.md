# Access-funnel onboarding context (installer side)

Cross-project coordination item from the **hq-access-funnel** project
(`companies/indigo/projects/hq-access-funnel`, board `in-proj-072` = HQ
Installer). The funnel is live in prod (hq-pro + hq-console); this documents the
installer half — what is implemented here, and the gap that remains.

## The contract

The funnel's post-grant handoff (hq-console `PostGrantHandoff`) routes a granted
user to the installer landing page with company context appended as query
params (existing query strings are merged, never clobbered):

```
https://install.getindigo.ai?company=<companyUid>&companySlug=<slug>&email=<inviteeEmail>&track=onboarding
```

- `company` — canonical companyUid, always present on a real funnel link.
- `companySlug` / `email` — appended when the funnel knows them.
- `track=onboarding` — fixed for the installer destination.

## What is implemented here

The landing page (`docs/download-page`, served at `install.getindigo.ai`) now
**captures and persists** the context, client-side:

- `docs/download-page/src/lib/onboarding-context.ts` — pure, unit-tested parser
  (`parseOnboardingContext` / `hasOnboardingContext` / `contextLabel`).
- `docs/download-page/src/pages/index.astro` — a bundled `<script>` reads
  `window.location.search` on load; when `company` is present it reveals a
  confirmation banner ("Setting up HQ for <company>") and writes the context to
  `localStorage` under `hq-onboarding-context`.
- Tests: `__tests__/stories/onboarding-context.test.ts`.

This makes the handoff feel continuous (the user sees they landed in the right
funnel) and preserves the context for a return visit or a future in-app pickup.

## The gap (not yet built — this is the real coordination work)

A downloaded native `.dmg` / `.zip` **cannot carry URL query params or read the
landing page's `localStorage`.** So capturing the context on the web page does
NOT, by itself, get the company context into the installed desktop app. Two
paths can bridge it, and **neither exists today**:

1. **Post-auth server resolution (recommended).** After the desktop app
   authenticates the user (Cognito), it calls hq-pro to resolve the granted
   company for that email — the gate record is keyed by `inviteeEmail` — and
   onboards into that company instead of a generic install. This needs the
   desktop app to integrate hq-pro auth + membership, which it does **not** do
   today (the app currently has no hq-pro / Cognito / membership calls; it is a
   local install wizard with GitHub OAuth + a cloud-sync panel).

2. **Deep link.** The landing page hands off to a custom URL scheme
   (e.g. `hq-installer://onboard?company=…`) that the installed app registers
   and handles. The app does not register or handle such a scheme today.

### Optional: funnel-step reporting

hq-pro exposes `POST /membership/funnel-step { inviteeEmail|personUid,
companyUid, step }` (steps `granted → installing → joined → syncing → training →
activated`, forward-only, idempotent, JWT-authorized). Reporting `installing` /
`joined` from the installer would make drop-off observable. **Not implemented
here:** the static landing page has no authenticated user token, so it cannot
make this authorized call. It belongs to the app integration in path (1) above,
where a user token exists. The hq-console handoff already reports the steps it
can see, so this is additive observability, not load-bearing.

## Deploy note

The landing page and this work live on the `feature/hq-desktop-installer`
branch, which is what deploys `install.getindigo.ai` — it is **not** merged to
`main`. Base installer-funnel work on that branch, not `main`.
