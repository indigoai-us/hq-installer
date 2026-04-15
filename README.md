# hq-installer

Native macOS installer for HQ — guided wizard with AWS Cognito auth, built on Tauri 2 + React 19 + TypeScript.

## Dev Setup

### Prerequisites

- [Rust](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) 22+
- [pnpm](https://pnpm.io/) 9+
- [Tauri CLI prerequisites](https://tauri.app/start/prerequisites/) for macOS

### Install dependencies

```bash
pnpm install
```

### Dev server (Tauri window + HMR)

```bash
pnpm tauri dev
```

This opens the native macOS window with hot reload.

## Quality Gates

All gates must pass before merging:

```bash
pnpm typecheck    # TypeScript check
pnpm lint         # ESLint
pnpm test         # Vitest unit tests
cargo check       # Rust compilation check (run from src-tauri/)
```

## Branch Workflow

- `main` — stable, tagged releases only
- `feature/*` — all development work branches off main
- Open PRs against `main`; CI must be green to merge

## Tech Stack

- **Frontend**: React 19, TypeScript, Tailwind 4
- **Backend**: Rust, Tauri 2
- **Build**: Vite 6, pnpm
- **CI**: GitHub Actions (macos-latest)

## Release Process

Releases are automated via `.github/workflows/release.yml`. Pushing a version tag triggers a full build, code signing, notarization, and GitHub release.

### Cutting a release

```bash
# Bump version in src-tauri/tauri.conf.json and src-tauri/Cargo.toml first, then:
git tag v1.2.3
git push origin v1.2.3
```

The release workflow will:
1. Build a universal binary (`x86_64` + `arm64`) via `tauri build --target universal-apple-darwin`
2. Code-sign the `.app` bundle with the Apple Developer ID certificate from GitHub secrets
3. Submit the `.dmg` to Apple notarization and staple the ticket
4. Create a GitHub release with the signed `.dmg` attached

### Required GitHub Actions secrets

| Secret | Description |
|---|---|
| `APPLE_CERTIFICATE` | Base64-encoded Apple Developer ID Application `.p12` certificate |
| `APPLE_CERTIFICATE_PASSWORD` | Password for the `.p12` certificate |
| `APPLE_SIGNING_IDENTITY` | Certificate Common Name used by codesign (e.g. `Developer ID Application: Acme Inc (ABC1234DEF)`) |
| `APPLE_ID` | Apple ID email address used for notarization (e.g. `dev@example.com`) |
| `APPLE_ID_PASSWORD` | App-specific password for the Apple ID (generated at appleid.apple.com) |
| `APPLE_TEAM_ID` | 10-character Apple Developer Team ID (e.g. `ABC1234DEF`) |

### Where to source the certificates

Credentials and the `.p12` certificate are stored at `companies/indigo/settings/`. See that directory for the Apple Developer account details and instructions for exporting the certificate from Keychain Access.

To base64-encode the `.p12` for the `APPLE_CERTIFICATE` secret:

```bash
base64 -i DeveloperIDApplication.p12 | pbcopy
```

Paste the clipboard output directly into the GitHub secret value.
