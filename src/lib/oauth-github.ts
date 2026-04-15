/**
 * GitHub OAuth device flow for the location picker's cloud sync panel.
 *
 * # Why a module and not a hook
 *
 * The cloud sync panel needs to:
 *   1. Know whether the user is "signed in" (has a GH token we can use to
 *      talk to a repo on their behalf).
 *   2. Start a device flow if not.
 *   3. Get back a repo spec (`owner/name`) the user wants to treat as
 *      their HQ mirror.
 *
 * Keeping this as a thin module with injectable fetch lets US-008 tests
 * drive the flow deterministically without stubbing network layers.
 *
 * # MVP disclaimer
 *
 * Indigo has **not** registered a GitHub OAuth app for the installer yet
 * (that's a deploy-time setup task for US-010/US-011). So for the initial
 * ship, `signIn()` short-circuits to a "manual mode" — the UI collects an
 * `owner/repo` spec the user types in and we treat that as the signed-in
 * state without a real token.
 *
 * When we wire in a real OAuth app, the shape below is the natural
 * extension point:
 *
 *   1. `startDeviceFlow()` → POST /login/device/code → `{ user_code,
 *      verification_uri, device_code, interval, expires_in }`
 *   2. Open verification_uri in the system browser via plugin-shell.
 *   3. Poll /login/oauth/access_token every `interval` seconds until
 *      `access_token` comes back (or we hit expiry).
 *   4. Persist `access_token` in the OS keychain (Tauri keyring plugin).
 *
 * The device flow is preferred over a hosted callback server: no public
 * URL required, no local port negotiation, works behind NAT.
 */

/** A repo target the user wants to treat as their HQ mirror. */
export interface GithubRepoSpec {
  /** `<owner>/<repo>` — e.g. `indigoai-us/hq`. */
  full_name: string;
  /** Cached bearer token — null in MVP manual mode. */
  token: string | null;
}

/** Result of an attempted sign-in. */
export type SignInResult =
  | { ok: true; spec: GithubRepoSpec }
  | { ok: false; error: string };

// Regex lifted straight from GitHub's name rules: owner/repo where both
// halves are 1-100 chars of [A-Za-z0-9._-]. This is the one validation
// we actually enforce in MVP mode.
const REPO_SPEC_RE = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;

/**
 * Validate a user-entered `owner/repo` string.
 *
 * Returns `null` if the spec parses, otherwise a human-readable error.
 */
export function validateRepoSpec(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return "Repo is required";
  if (!trimmed.includes("/")) {
    return "Use owner/repo format (e.g. indigoai-us/hq)";
  }
  if (!REPO_SPEC_RE.test(trimmed)) {
    return "Invalid characters — allowed: letters, digits, dot, underscore, dash";
  }
  return null;
}

/**
 * MVP manual sign-in: accept a plain `owner/repo` string, validate it,
 * and return a `GithubRepoSpec` without a token. The cloud sync panel
 * uses this shape to wire into `check_cloud_existing({ backend: "github",
 * repo })`.
 *
 * When the real device flow lands, the signature will grow a `FetchLike`
 * seam so tests can inject a deterministic fetch without touching the
 * network. Keeping the MVP one-arg is intentional — adding a parameter
 * we don't use yet would drag YAGNI into the reviewer's face.
 */
export async function signInManual(repoSpec: string): Promise<SignInResult> {
  const err = validateRepoSpec(repoSpec);
  if (err) return { ok: false, error: err };
  return {
    ok: true,
    spec: { full_name: repoSpec.trim(), token: null },
  };
}
