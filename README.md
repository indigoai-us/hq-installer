# hq-installer

Native cross-platform installer for HQ (macOS + Windows) - guided wizard with AWS Cognito auth, built on Tauri 2 + React 19 + TypeScript.

## Dev Setup

### Prerequisites

#### macOS

- [Rust](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) 22+
- [pnpm](https://pnpm.io/) 9+
- [Tauri CLI prerequisites](https://tauri.app/start/prerequisites/) for macOS

#### Windows

- Windows 11
- [Rust](https://rustup.rs/) (stable) with `x86_64-pc-windows-msvc` and `aarch64-pc-windows-msvc` targets
- [Node.js](https://nodejs.org/) 22+
- [pnpm](https://pnpm.io/) 9+
- Visual Studio Build Tools 2022 with the "Desktop development with C++" workload
- WebView2 Runtime (ships with Windows 11)

See [docs/dev-setup-windows.md](docs/dev-setup-windows.md) for the full Windows toolchain setup, including MSVC linker discovery and ARM64 host notes.

### Install dependencies

```bash
pnpm install
```

### Dev server (Tauri window + HMR)

macOS:

```bash
pnpm tauri dev
```

Windows:

```powershell
pnpm tauri dev
```

On Windows, the committed `.cargo/config.toml` sources the MSVC linker path so a plain PowerShell works after the prerequisite setup.

## Quality Gates

All gates must pass before merging. They run automatically on every commit (husky + lint-staged) and on every PR (`.github/workflows/ci.yml`).

macOS:

```bash
pnpm typecheck    # TypeScript check
pnpm lint         # ESLint
pnpm test         # Vitest unit tests
cargo check       # Rust compilation check (run from src-tauri/)
cargo fmt --check # Rustfmt drift check (run from src-tauri/)
cargo clippy      # Rust linter, deny warnings (run from src-tauri/)
cargo test        # Rust unit tests (run from src-tauri/)
```

Windows:

```powershell
pnpm typecheck
pnpm lint
pnpm test
cd src-tauri
cargo check
cargo fmt --check
cargo clippy -- -D warnings
cargo test
```

**Pre-commit gate:** `.husky/pre-commit` runs `lint-staged` (TS files) + the full Rust gate (`fmt --check` + `clippy -- -D warnings` + `cargo test`). Bypass only for true emergencies with `git commit --no-verify` and fix forward.

**CI gate:** `.github/workflows/ci.yml` runs the same gates on clean `macos-latest` and `windows-latest` runners. Branch protection blocks merges on red CI.

## Branch Workflow

- `main` - stable, tagged releases only
- `feature/*` - all development work branches off main
- Open PRs against `main`; CI must be green to merge

## Tech Stack

- **Frontend**: React 19, TypeScript, Tailwind 4
- **Backend**: Rust, Tauri 2
- **Build**: Vite 6, pnpm
- **CI**: GitHub Actions (`macos-latest`, `windows-latest`)

## Release Process

Releases are automated via `.github/workflows/release.yml`. Pushing a version tag triggers macOS and Windows builds, platform signing, Tauri updater signing, a combined GitHub-hosted `latest.json`, and final GitHub release publishing.

### Cutting a release

```bash
# Bump version in package.json, src-tauri/tauri.conf.json,
# src-tauri/Cargo.toml, and src-tauri/Cargo.lock first, then:
git tag v1.2.3
git push origin v1.2.3
```

The release workflow validates that the tag matches `vX.Y.Z` and that the tag version matches all four version files before building.

### macOS release path

The macOS release workflow will:

1. Build a universal binary (`x86_64` + `arm64`) via `tauri build --target universal-apple-darwin`
2. Code-sign the `.app` bundle with the Apple Developer ID certificate from GitHub secrets
3. Submit the `.app` to Apple notarization and staple the ticket
4. Archive the notarized `.app` into `hq-installer_universal.zip` with `ditto` (preserves the stapled ticket and xattrs)
5. Create a draft GitHub release with the signed `.zip` and updater tarball attached

End-user install flow: download the `.zip` -> Safari auto-extracts -> double-click the `.app` to run the installer wizard. No DMG mount, no drag-to-Applications step.

### Windows release path

The Windows release workflow will:

1. Build MSI, NSIS, and updater artifacts for `x86_64-pc-windows-msvc` and `aarch64-pc-windows-msvc`
2. Authenticate to Azure via GitHub OIDC from the `release` environment
3. Sign MSI and NSIS installers with Azure Trusted Signing
4. Verify `Get-AuthenticodeSignature` is `Valid` for every staged `.msi` and `*-setup.exe`
5. Regenerate Tauri updater signatures after Authenticode signing mutates the installer bytes
6. Attach versioned installers, `.sig` sidecars, and stable versionless installer aliases to the draft release

Unsigned Windows installers are allowed only for CI smoke builds, or for an explicit manual dispatch with `allow_unsigned=true` as a non-production exception. Normal tag releases fail if the Azure Trusted Signing variables are missing.

### Updater metadata

macOS and Windows use one Tauri updater keypair. The public key is committed in `src-tauri/tauri.conf.json`; the private key and passphrase live in GitHub Actions secrets. The finalize job generates one combined `latest.json` and uploads it to:

```text
https://github.com/indigoai-us/hq-installer/releases/latest/download/latest.json
```

That manifest contains `darwin-universal`, `darwin-aarch64`, `darwin-x86_64`, `windows-x86_64`, and `windows-aarch64` platform entries.

### Required release configuration

GitHub Actions environment:

| Environment | Purpose |
|---|---|
| `release` | Required on the Windows build job so the OIDC subject is `repo:indigoai-us/hq-installer:environment:release` for the Azure federated credential |

Repository variables:

| Variable | Description |
|---|---|
| `AZURE_CLIENT_ID` | Azure application/client ID for Trusted Signing OIDC |
| `AZURE_TENANT_ID` | Azure tenant ID |
| `AZURE_SUBSCRIPTION_ID` | Azure subscription ID that owns the Trusted Signing account |

Repository secrets:

| Secret | Description |
|---|---|
| `APPLE_CERTIFICATE` | Base64-encoded Apple Developer ID Application `.p12` certificate |
| `APPLE_CERTIFICATE_PASSWORD` | Password for the `.p12` certificate |
| `APPLE_ID` | Apple ID email address used for notarization |
| `APPLE_PASSWORD` | App-specific password for the Apple ID |
| `APPLE_TEAM_ID` | 10-character Apple Developer Team ID |
| `TAURI_SIGNING_PRIVATE_KEY` | Encrypted Tauri updater private key contents used for both macOS and Windows artifacts |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Passphrase for the Tauri updater private key |
| `VITE_COGNITO_USER_POOL_ID` | Cognito user pool ID inlined into the Vite bundle |
| `VITE_COGNITO_CLIENT_ID` | Cognito client ID inlined into the Vite bundle |
| `VITE_COGNITO_DOMAIN` | Cognito hosted UI domain inlined into the Vite bundle |
| `HQ_INSTALLER_SENTRY_DSN` | Rust/native Sentry DSN compiled into the Tauri binary |
| `VITE_HQ_INSTALLER_WEB_SENTRY_DSN` | React/webview Sentry DSN inlined into the Vite bundle |
| `SENTRY_AUTH_TOKEN` | Token used to create Sentry releases and upload source maps/debug symbols |

### Where to source the Apple certificate

Credentials and the `.p12` certificate are stored at `companies/indigo/settings/`. See that directory for the Apple Developer account details and instructions for exporting the certificate from Keychain Access.

To base64-encode the `.p12` for the `APPLE_CERTIFICATE` secret:

```bash
base64 -i DeveloperIDApplication.p12 | pbcopy
```

Paste the clipboard output directly into the GitHub secret value. Windows signing setup is covered in [docs/code-signing-windows.md](docs/code-signing-windows.md).
