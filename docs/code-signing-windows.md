# Code signing on Windows

Authoritative reference for Azure Trusted Signing + Tauri 2 updater signing for
the Windows target of `hq-installer`. CI wiring lives in
`.github/workflows/release.yml`.

## The two independent signatures

### 1. Azure Trusted Signing - Authenticode

What it signs: `*.msi` and `*-setup.exe` bundle artifacts.

Why: Windows SmartScreen and Defender check the publisher signature when a user
launches the installer. A production release must not publish unsigned Windows
installers.

The release workflow signs with `azure/trusted-signing-action` after logging in
with `azure/login` through GitHub OIDC. There is no checked-in PFX and no
certificate blob secret in GitHub Actions.

Required GitHub configuration:

| Kind | Name | Purpose |
|---|---|---|
| Environment | `release` | Applied to the `build-windows` job so the OIDC subject is `repo:indigoai-us/hq-installer:environment:release` |
| Repository variable | `AZURE_CLIENT_ID` | Azure application/client ID for the Trusted Signing federated credential |
| Repository variable | `AZURE_TENANT_ID` | Azure tenant ID |
| Repository variable | `AZURE_SUBSCRIPTION_ID` | Azure subscription ID that owns the Trusted Signing account |

Azure-side configuration:

- Trusted Signing endpoint: `https://eus.codesigning.azure.net/`
- Signing account: `indigosigning`
- Certificate profile: `indigo-codesign`
- Federated credential subject:
  `repo:indigoai-us/hq-installer:environment:release`

The release job fails before publishing unless all three `AZURE_*` variables are
present. The only exception is a manual `workflow_dispatch` with
`allow_unsigned=true`, which is intended for a non-production emergency build.
CI smoke builds remain unsigned by design.

After signing, CI verifies every staged `.msi` and `*-setup.exe`:

```powershell
$sig = Get-AuthenticodeSignature "HQ Installer_1.2.3_x64-setup.exe"
if ($sig.Status -ne 'Valid') { throw "Bad signature: $($sig.Status)" }
```

### 2. Tauri updater minisign - auto-update integrity

What it signs: the Tauri updater artifacts and installer bytes referenced by
the GitHub-hosted `latest.json`.

Why: the Tauri auto-updater downloads an artifact from the GitHub release,
verifies its `.sig` against the embedded public key, and only applies the update
if the signature checks out.

macOS and Windows use one updater keypair. The public key is committed in
`src-tauri/tauri.conf.json` under `plugins.updater.pubkey`. The matching private
key must be stored in GitHub Actions secrets:

| Secret | Purpose |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | Encrypted Tauri updater private key contents |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Passphrase for the private key |

Generate the keypair with:

```powershell
.\scripts\generate-updater-keypair.ps1 -OutDir "$env:USERPROFILE\.hq-installer\keys"
```

Paste the printed public key into `src-tauri/tauri.conf.json`, then store the
private key contents and passphrase in the two GitHub secrets above.

Important: Authenticode signing mutates Windows installer bytes. The release
workflow regenerates each Tauri updater `.sig` after Azure Trusted Signing so
the updater verifies the exact bytes shipped to users.

## Combined latest.json

The final release job generates and uploads:

```text
https://github.com/indigoai-us/hq-installer/releases/latest/download/latest.json
```

The manifest is built from the GitHub release asset list and downloaded `.sig`
files by `scripts/build-latest-json.mjs`. It includes:

- `darwin-universal`, `darwin-aarch64`, and `darwin-x86_64`, all pointing at the
  universal macOS updater tarball
- `windows-x86_64`, pointing at the versioned x64 NSIS setup `.exe`
- `windows-aarch64`, pointing at the versioned ARM64 NSIS setup `.exe`

Versionless aliases such as `HQ-Installer_x64-setup.exe` are only stable
download links for humans and onboarding pages. They are intentionally ignored
when building updater metadata.

## Release inputs

The Windows release job also consumes the same build-time secrets as macOS:

| Secret | Purpose |
|---|---|
| `VITE_COGNITO_USER_POOL_ID` | Cognito user pool ID inlined into the Vite bundle |
| `VITE_COGNITO_CLIENT_ID` | Cognito client ID inlined into the Vite bundle |
| `VITE_COGNITO_DOMAIN` | Cognito hosted UI domain inlined into the Vite bundle |
| `HQ_INSTALLER_SENTRY_DSN` | Rust/native Sentry DSN compiled into the Tauri binary |
| `VITE_HQ_INSTALLER_WEB_SENTRY_DSN` | React/webview Sentry DSN inlined into the Vite bundle |
| `SENTRY_AUTH_TOKEN` | Token used by Sentry release/source-map upload |

The macOS job additionally requires:

| Secret | Purpose |
|---|---|
| `APPLE_CERTIFICATE` | Base64-encoded Apple Developer ID Application `.p12` certificate |
| `APPLE_CERTIFICATE_PASSWORD` | Password for the `.p12` certificate |
| `APPLE_ID` | Apple ID email address used for notarization |
| `APPLE_PASSWORD` | App-specific password for the Apple ID |
| `APPLE_TEAM_ID` | 10-character Apple Developer Team ID |

## Local Windows builds

Local Windows builds can produce unsigned MSI/NSIS bundles for smoke testing:

```powershell
pnpm tauri build --target x86_64-pc-windows-msvc --bundles msi,nsis --config src-tauri/tauri.smoke.conf.json
```

Production Authenticode signing happens in GitHub Actions through Azure Trusted
Signing. Do not add local PFX-based signing secrets back to the workflow.

## When the updater keypair rotates

Do not rotate the updater keypair unless it is compromised. Rotating the public
key breaks auto-update for every user already on a build with the old key; those
users need a manual download of the next release.

If the private key is leaked:

1. Re-run `scripts/generate-updater-keypair.ps1`.
2. Update `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`.
3. Update `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
4. Ship a release.
5. Notify existing users that they need to download the next release manually.

## Verifying a signed release

End-user check:

1. Right-click the versioned installer, for example
   `HQ Installer_1.2.3_x64-setup.exe`.
2. Click the "Digital Signatures" tab.
3. Expect a valid Indigo AI publisher signature.

Programmatic check:

```powershell
Get-AuthenticodeSignature "HQ Installer_1.2.3_x64-setup.exe" |
  Select-Object Status, StatusMessage, SignerCertificate
```

The Tauri updater `.sig` files are verified by the Tauri runtime before an
update is applied.
