/**
 * Access-funnel onboarding context (hq-access-funnel, in-proj-072 installer side).
 *
 * CANONICAL, unit-tested parser (see __tests__/stories/onboarding-context.test.ts).
 * The download page keeps a byte-identical mirror at
 * `docs/download-page/src/lib/onboarding-context.ts` because it is a separate
 * Astro/Vercel build unit that cannot import across the repo boundary. When the
 * desktop app gains hq-pro auth + membership resolution (the real context
 * bridge — see docs/access-funnel-onboarding-context.md), it imports THIS copy.
 *
 * The hq-access-funnel post-grant handoff (hq-console `PostGrantHandoff`) routes
 * a granted user to this download page with company context appended as query
 * params:
 *
 *   https://install.getindigo.ai?company=<companyUid>&companySlug=<slug>&email=<email>&track=onboarding
 *
 * `company` (canonical companyUid) is always present on a real funnel link;
 * `companySlug` / `email` are appended when known; `track` is fixed to
 * `onboarding` for the installer destination. Existing query strings on the
 * base URL are merged by the funnel, never clobbered.
 *
 * This module is the PURE parser — no DOM, no globals — so it is unit-testable
 * (see `__tests__/stories/onboarding-context.test.ts`). The client-side capture
 * + persistence lives in `index.astro`'s inline `<script>`, which calls these.
 *
 * Scope note: a downloaded native `.dmg`/`.zip` cannot carry these params, so
 * this page can only CAPTURE + PERSIST the context (confirmation banner +
 * localStorage) — it cannot inject it into the installed desktop app. Bridging
 * the context into the app requires the app to resolve the granted company from
 * hq-pro by the authenticated email post-login (the desktop app has no hq-pro
 * membership integration today). See
 * `docs/access-funnel-onboarding-context.md`.
 */

export interface OnboardingContext {
  /** Canonical companyUid the access request was keyed by. */
  company: string | null;
  /** Human-readable company slug, when the funnel knew it. */
  companySlug: string | null;
  /** Invitee email the gate record is keyed by, when known. */
  email: string | null;
  /** Funnel track — `onboarding` for the installer destination. */
  track: string | null;
}

/** localStorage key the captured context is persisted under. */
export const ONBOARDING_CONTEXT_STORAGE_KEY = "hq-onboarding-context";

function normalize(value: string | null): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Parse the funnel onboarding context from a URL query string (e.g.
 * `window.location.search`). Pure + deterministic. Unknown/empty params
 * normalize to `null`; never throws on malformed input.
 */
export function parseOnboardingContext(search: string): OnboardingContext {
  const params = new URLSearchParams(search ?? "");
  return {
    company: normalize(params.get("company")),
    companySlug: normalize(params.get("companySlug")),
    email: normalize(params.get("email")),
    track: normalize(params.get("track")),
  };
}

/**
 * True when the context carries the load-bearing field (`company`). A link
 * without `company` is a plain visit, not a funnel handoff.
 */
export function hasOnboardingContext(context: OnboardingContext): boolean {
  return context.company !== null;
}

/** Display label for a confirmation banner — prefer the slug, fall back to uid. */
export function contextLabel(context: OnboardingContext): string | null {
  return context.companySlug ?? context.company;
}
