# hq-installer Architecture

Native macOS installer for HQ. Guided 10-step wizard built on Tauri 2 + React 19 + TypeScript.

## Stack

| Layer | Technology | Role |
|---|---|---|
| Frontend | React 19, TypeScript, Tailwind 4 | Wizard UI, auth, state |
| Backend | Rust, Tauri 2 | OS integration (Keychain, git, processes, Xcode) |
| Auth | AWS Cognito (email/password + GitHub OAuth) | Identity, session tokens |
| Build | Vite 6, pnpm | Dev server, bundling |
| CI | GitHub Actions (macos-latest) | Type-check, lint, test, release |
| E2E | Playwright | Full 10-step walkthrough |

## Rust ↔ TypeScript Boundary

All OS-level work lives in Rust (`src-tauri/src/commands/`). TypeScript calls across the bridge via `invoke("command_name", { args })`. TypeScript handles all UI, auth, template fetching, and personalization logic.

### Rust Commands

| Module | Commands | Purpose |
|---|---|---|
| `deps.rs` | `check_dep`, `install_homebrew`, `install_node`, `install_git`, `install_gh`, `install_claude_code`, `install_qmd`, `install_yq`, `cancel_install` | Homebrew-backed dependency probe + install with per-handle cancellation |
| `xcode.rs` | `xcode_clt_status`, `xcode_clt_install` | Xcode Command Line Tools detection + polling install |
| `keychain.rs` | `keychain_set`, `keychain_get`, `keychain_delete` | macOS Keychain via `keyring` crate; all services prefixed `com.indigoai.hq-installer` |
| `git.rs` | `git_init`, `git_probe_user` | git2-backed repo init + global config probe |
| `process.rs` | `spawn_process`, `cancel_process` | Streamed subprocess output (Tauri events) with cancellation; Sentry breadcrumb capture |
| `template.rs` | `fetch_template` | GitHub releases tarball fetch (wraps TS logic for Tauri resource access) |
| `directory.rs` | `pick_directory`, `detect_hq` | Native folder picker + probe for an existing HQ install (core.yaml signature) |
| `fs.rs` | `read_text_file`, `write_text_file`, `path_exists` | Sandboxed filesystem access for personalization writes |
| `menubar.rs` | `write_menubar_telemetry_pref`, `write_menubar_hq_path` | Atomic key-merge writes to `~/.hq/menubar.json` (preserves other keys) |
| `install_menubar.rs` | `install_menubar_app`, `launch_menubar_app` | Downloads + installs the HQ Sync `.app` bundle, launches it after wizard completion |
| `launch.rs` | `launch_claude_code` | Final-step "Launch Claude Code" handoff |
| `deep_link.rs` | (event handler, not a command) | Parses `hq-installer://callback` OAuth redirect URLs, emits `deep-link://received` event |

## Wizard Flow

10 steps in sequence:

| Step | File | Key action |
|---|---|---|
| 1 — Welcome | `01-welcome.tsx` | Intro + telemetry opt-in |
| 2 — Sign In | `02-cognito-auth.tsx` | Sign in / sign up (email+pw or GitHub OAuth) |
| 3 — Prerequisites | `04-deps.tsx` | Probe + install system deps |
| 4 — Install | `06-directory.tsx` | Native directory picker for HQ install path |
| 5 — Templates | `07-template.tsx` | Download + extract HQ tarball from GitHub releases. Persists chosen install path to `~/.hq/menubar.json` `hqPath` (Priority 1 input for HQ Sync's folder resolver) |
| 6 — Workspace | `08-git-init.tsx` | `git_init` command + initial commit |
| 7 — Personalize | `09-personalize.tsx` | Name + detect cloud companies (lists user's HQ-Cloud memberships, seeds `team` + `connectedCompanyCount` in wizard state) |
| 8 — Verify | `10-indexing.tsx` | `qmd update` via `spawn_process` |
| 9 — HQ Sync | `InstallMenubarStep.tsx` | Always installs the HQ Sync menu bar app (universal install — no longer gated on `connectedCompanyCount`). Even users with no cloud-connected companies get personal HQ sync |
| 10 — Done | `11-summary.tsx` | Launch Claude Code |

Navigation is managed by `wizard-router.ts` (plain JS state machine, no React context). Step 3 (Prerequisites) is auth-gated: no back navigation allowed once the user has signed in. Wizard session data (team, installPath, gitIdentity, personalized flag, connectedCompanyCount) is held in the `wizard-state.ts` module singleton.

Two screens were removed from the earlier 12-step flow: the old Step 3 (`03-team.tsx`, "create/join team") was folded into Step 7 — Personalize auto-lists the user's HQ-Cloud companies on mount instead. The old Step 8 (`08b-sync.tsx`, "S3 sync") was removed entirely because the HQ-Sync menu bar app (installed in Step 9) now owns continuous S3 reconciliation post-install.

## Auth Architecture

`src/lib/cognito.ts` wraps `@aws-sdk/client-cognito-identity-provider` and the Cognito hosted UI OAuth flow.

### Email/Password flow
1. `signUp()` → Cognito `SignUpCommand` (sends verification code)
2. `confirmSignUp()` → Cognito `ConfirmSignUpCommand`
3. `signIn()` → Cognito `InitiateAuthCommand` (`USER_PASSWORD_AUTH`)
4. Tokens stored to macOS Keychain (4 keys under service `com.indigoai.hq-installer.cognito`)

### GitHub OAuth flow
1. Open Cognito hosted UI URL with `identity_provider=GitHub`, `redirect_uri=hq-installer://callback`
2. Deep link handler (Rust `deep_link.rs`) parses callback URL, emits `deep-link://received`
3. TS listener receives auth code, exchanges for tokens via `/oauth2/token`
4. Tokens stored to Keychain

### Token lifecycle
- `getCurrentUser()` loads from Keychain and auto-refreshes if within 30s of expiry
- `refreshSession()` uses `REFRESH_TOKEN_AUTH` flow, preserves existing refresh token if Cognito doesn't issue a new one
- `signOut()` calls `GlobalSignOutCommand` then clears Keychain

## Personalization Output

`personalize-writer.ts` writes to the chosen install directory:

```
knowledge/{name}/profile.md          ← Handlebars template (name, about, goals)
knowledge/{name}/voice-style.md      ← Handlebars template (name, customizations)
companies/personal/projects/{starter}/** ← Starter project files from bundled templates
companies/personal/settings/cognito.json ← Empty {}
companies/personal/settings/.gitkeep
companies/personal/workers/.gitkeep
```

Templates are bundled Tauri resources (`templates/`). The `loadTemplate()` helper supports injected strings for unit testing without a real Tauri runtime.

In addition to the install directory, the wizard writes one path back to the user's home dir:

```
~/.hq/menubar.json                   ← { "hqPath": "<chosen install dir>" }
```

This is written via `write_menubar_hq_path` after template extraction succeeds. HQ Sync (a separate menubar app, no IPC with this installer) reads it as Priority 1 in its folder resolver. The write is a key-merge — existing keys (`telemetryEnabled`, `machineId`, etc.) are preserved. It's best-effort: a failed write logs a warning but doesn't fail the install (HQ Sync's core.yaml discovery covers the gap).

## Template Fetching

`src/lib/template-fetcher.ts` fetches the latest non-prerelease, non-draft GitHub release from `indigoai-us/hq-core`, downloads the tarball, decompresses with `fflate` (gunzip), and extracts the tar in-memory using a manual parser — all in the browser context. hq-core is a standalone template repo (the repo root IS the template), so extraction strips only the GitHub tarball wrapper. Progress events are throttled to 60fps. A `TemplateFetchError` class carries a `retriable` flag for UI retry logic.

## Auto-Update

`src/lib/updater.ts` checks `VITE_UPDATE_MANIFEST_URL` (S3 presigned URL) on launch. Manifest format:

```json
{
  "version": "1.2.3",
  "pub_date": "2026-04-14T00:00:00Z",
  "url": "https://...",
  "signature": "...",
  "notes": "..."
}
```

`tauri-plugin-updater` handles download and install. The release workflow uploads the manifest to S3 and generates a fresh presigned URL on each release.

## Dependency Management

`deps.rs` manages these system dependencies:

| Dep | Probe method | Install method |
|---|---|---|
| Homebrew | `which brew` | Shell script from brew.sh |
| Node.js | `which node` | `brew install node` |
| git | `which git` (post-Xcode CLT) | `brew install git` |
| gh (GitHub CLI) | `which gh` | `brew install gh` |
| Claude Code | `which claude` | `npm install -g @anthropic-ai/claude-code` |
| qmd | `which qmd` | `brew install tobi/tap/qmd` |
| yq | `which yq` | `brew install yq`, with direct binary download fallback (`github.com/mikefarah/yq/releases/latest`) when brew fails — covers cases where the user's brew tap is broken or rate-limited |

All installs stream stdout lines to the frontend via `install:progress` Tauri events and support cancellation via a per-handle cancel registry.

## Observability (Sentry)

Sentry is wired into both layers:

- **Frontend (React webview):** `@sentry/react` initialized in `src/main.tsx`. Source maps uploaded to Sentry on each release via the `@sentry/vite-plugin` (release workflow step is non-blocking — sourcemap upload failures don't fail the release).
- **Backend (Rust):** `sentry` crate initialized in `src-tauri/src/lib.rs` with a custom event scrubber in `src-tauri/src/sentry_scrub.rs`. The scrubber strips Cognito tokens, refresh tokens, file paths under `~/`, and any string matching the AWS access-key prefix pattern before events leave the process.

Both layers share the same DSN, set via `VITE_SENTRY_DSN` (frontend) / `SENTRY_DSN` (Rust).

## Release Pipeline

`.github/workflows/release.yml` triggers on version tags (`v*`):

1. Build universal macOS binary (`x86_64` + `arm64`) via `tauri build --target universal-apple-darwin`
2. Code-sign `.app` with Apple Developer ID certificate
3. Notarize `.app` via Apple notarytool, staple ticket
4. Archive the notarized `.app` into `hq-installer_universal.zip` with `ditto --sequesterRsrc` so the stapled ticket + xattrs survive
5. Create GitHub release with signed `.zip` attached
6. Upload auto-update manifest to S3, generate presigned URL

Distribution format is a zipped, notarized `.app` rather than a `.dmg` so the user experience is "download → Safari auto-extracts → double-click the app" with no mount-and-drag-to-Applications step.

Required GitHub Actions secrets: `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_ID_PASSWORD`, `APPLE_TEAM_ID`. Certificate sourced from `companies/indigo/settings/`.

## Testing

| Layer | Tool | Coverage |
|---|---|---|
| Unit | Vitest | cognito.ts, template-fetcher.ts, personalize-writer.ts, updater.ts |
| Regression | Vitest (`vitest.config.regression.ts`) | Installer output vs canonical `create-hq + /setup` layout |
| E2E | Playwright | Full 10-step walkthrough on macOS CI |

Unit tests use dependency injection for Tauri APIs (injected template strings, stub `invoke`) — no real Tauri runtime required.

## Environment Variables

| Var | Required | Purpose |
|---|---|---|
| `VITE_COGNITO_USER_POOL_ID` | Yes | Pool ID (also encodes region: `us-east-1_XXXX`) |
| `VITE_COGNITO_CLIENT_ID` | Yes | App client ID |
| `VITE_COGNITO_DOMAIN` | Yes | Cognito hosted UI domain |
| `VITE_UPDATE_MANIFEST_URL` | Yes | S3 presigned URL for auto-update manifest |
| `VITE_HQ_OPS_API_URL` | Yes | hq-ops base URL for team registration |

Set in `.env.local` for dev; injected as GitHub Actions secrets for CI/release builds.
