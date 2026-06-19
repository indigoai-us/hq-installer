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

Releases are automated via `.github/workflows/release.yml`. Pushing a version tag triggers platform builds, signing, update artifacts, and GitHub release publishing.

### Cutting a release

```bash
# Bump version in src-tauri/tauri.conf.json and src-tauri/Cargo.toml first, then:
git tag v1.2.3
git push origin v1.2.3
```

### macOS release path

The macOS release workflow will:

1. Build a universal binary (`x86_64` + `arm64`) via `tauri build --target universal-apple-darwin`
2. Code-sign the `.app` bundle with the Apple Developer ID certificate from GitHub secrets
3. Submit the `.app` to Apple notarization and staple the ticket
4. Archive the notarized `.app` into `hq-installer_universal.zip` with `ditto` (preserves the stapled ticket and xattrs)
5. Create a GitHub release with the signed `.zip` attached

End-user install flow: download the `.zip` -> Safari auto-extracts -> double-click the `.app` to run the installer wizard. No DMG mount, no drag-to-Applications step.

#### Required macOS GitHub Actions secrets

| Secret | Description |
|---|---|
| `APPLE_CERTIFICATE` | Base64-encoded Apple Developer ID Application `.p12` certificate |
| `APPLE_CERTIFICATE_PASSWORD` | Password for the `.p12` certificate |
| `APPLE_SIGNING_IDENTITY` | Certificate Common Name used by codesign (e.g. `Developer ID Application: Acme Inc (ABC1234DEF)`) |
| `APPLE_ID` | Apple ID email address used for notarization (e.g. `dev@example.com`) |
| `APPLE_ID_PASSWORD` | App-specific password for the Apple ID (generated at appleid.apple.com) |
| `APPLE_TEAM_ID` | 10-character Apple Developer Team ID (e.g. `ABC1234DEF`) |

### Windows release path

The Windows release workflow will:

1. Build MSI, NSIS, and updater artifacts via `tauri build --target x86_64-pc-windows-msvc --bundles msi,nsis,updater`
2. Sign installer artifacts with SignTool when a Windows signing certificate is configured
3. Sign updater artifacts with the Tauri updater minisign key
4. Attach the MSI, NSIS installer, updater archive, and updater signature to the GitHub release
5. Publish release metadata that points Windows clients at the signed updater artifact

The Windows updater minisign keypair is distinct from the macOS updater keypair. See [docs/code-signing-windows.md](docs/code-signing-windows.md) for certificate procurement, SignTool setup, updater key generation, and verification.

#### Required Windows GitHub Actions secrets

| Secret | Description |
|---|---|
| `WINDOWS_SIGNING_CERT` | Base64-encoded Authenticode `.pfx` certificate |
| `WINDOWS_SIGNING_CERT_PASSWORD` | Password for the `.pfx` certificate |
| `TAURI_SIGNING_PRIVATE_KEY` | Encrypted Tauri updater private key contents for Windows artifacts |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Passphrase for the Windows updater private key |

### Where to source the certificates

Credentials and the `.p12` certificate are stored at `companies/indigo/settings/`. See that directory for the Apple Developer account details and instructions for exporting the certificate from Keychain Access.

To base64-encode the `.p12` for the `APPLE_CERTIFICATE` secret:

```bash
base64 -i DeveloperIDApplication.p12 | pbcopy
```

Paste the clipboard output directly into the GitHub secret value. Windows certificate procurement and encoding are covered in [docs/code-signing-windows.md](docs/code-signing-windows.md).
