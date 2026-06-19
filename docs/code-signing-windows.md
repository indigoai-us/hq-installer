# Code signing on Windows

Authoritative reference for SignTool + Tauri 2 updater signing for the
Windows target of `hq-installer`. CI wiring lives in `.github/workflows/release.yml`.

## The two independent signatures

### 1. SignTool — Authenticode (binary trust)

What it signs: `*.msi` and `*-setup.exe` bundle artifacts.
Why: Windows SmartScreen + Defender check the publisher signature when
the user double-clicks the installer. An unsigned or self-signed binary
triggers the orange "Windows protected your PC" prompt and a "Don't run"
default button — terrible first-launch UX.

Cert authorities (pick one):

| Authority | Type | Cost / year | SmartScreen reputation |
|---|---|---|---|
| Sectigo OV | Organization-validated | ~$200 | Builds over weeks of installs |
| DigiCert OV | Organization-validated | ~$600 | Builds over weeks of installs |
| Sectigo EV | Extended-validation | $300-1000 + USB token | **Instant** SmartScreen trust |
| Self-signed | n/a | $0 | Triggers SmartScreen forever |
| Unsigned | n/a | $0 | Triggers SmartScreen forever |

**V1 (dogfood) recommendation**: ship unsigned. Internal users can click
through SmartScreen. Real cert procurement is a separate ops decision —
see the PRD's `openQuestions` block.

**Pre-external-rollout recommendation**: get an EV cert. The USB token
sucks for CI, but the instant-trust UX is worth it for first-impression
installs.

### 2. Tauri updater minisign — auto-update integrity

What it signs: `*.msi.zip` and `*.msi.zip.sig` updater artifacts.
Why: the Tauri auto-updater downloads the `.msi.zip` from the GitHub
release, verifies its `.sig` against the embedded pubkey, and only
applies the update if the signature checks out. Without a valid
keypair, the updater is effectively disabled.

The pubkey is committed in `src-tauri/tauri.conf.json` under
`plugins.updater.pubkey`. The matching private key MUST be:

- Generated via `pnpm tauri signer generate` (see
  `scripts/generate-updater-keypair.ps1`).
- Stored OUTSIDE the repo, in a password manager.
- Pasted into GitHub Actions secrets as `TAURI_SIGNING_PRIVATE_KEY`
  (the encrypted key file contents) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
  (the passphrase you set at generation time).

## CI secret setup

One-time setup on `indigoai-us/hq-installer`. All commands run from
a local checkout with `gh` authenticated.

### SignTool cert (when available)

```powershell
# 1. Export the cert from Sectigo / DigiCert as a PFX with a strong password.
# 2. Base64-encode it (avoids binary upload pitfalls in `gh secret set`):
$pfx = "C:\path\to\hq-installer.pfx"
$b64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($pfx))
gh secret set WINDOWS_SIGNING_CERT --repo indigoai-us/hq-installer --body "$b64"
gh secret set WINDOWS_SIGNING_CERT_PASSWORD --repo indigoai-us/hq-installer --body "<the pfx password>"
```

The release workflow decodes the base64 back into a `.pfx` on the runner
under `$env:RUNNER_TEMP` and points SignTool at it.

### Tauri updater keypair

```powershell
# Generate the keypair using the Tauri CLI:
.\scripts\generate-updater-keypair.ps1 -OutDir "$env:USERPROFILE\.hq-installer\keys"
# The script prints the GitHub Actions commands at the end. Run them.
```

You'll also need to paste the printed `pubkey` blob into
`src-tauri/tauri.conf.json` under `plugins.updater.pubkey` and commit.

## Local signed builds (rare)

For pre-release validation:

```powershell
$env:SIGNING_CERT_PATH = "C:\path\to\hq-installer.pfx"
$env:WINDOWS_SIGNING_CERT_PASSWORD = "<password>"
$env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content "$env:USERPROFILE\.hq-installer\keys\hq-installer-updater.key" -Raw)
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "<passphrase>"
pnpm tauri build --target x86_64-pc-windows-msvc --bundles msi,nsis,updater
```

Then manually sign with SignTool:

```powershell
$signTool = Get-ChildItem "C:\Program Files (x86)\Windows Kits\10\bin\10.*\x64\signtool.exe" | Select -Last 1
& $signTool sign /fd SHA256 /f $env:SIGNING_CERT_PATH /p $env:WINDOWS_SIGNING_CERT_PASSWORD /tr http://timestamp.digicert.com /td SHA256 "src-tauri\target\x86_64-pc-windows-msvc\release\bundle\msi\*.msi"
```

Verify with: `Get-AuthenticodeSignature <file.msi>` — status should be
`Valid`, signer should match the cert subject.

## When the cert changes

Procuring a new cert (annual renewal, switching CAs):

1. Generate / receive the new PFX.
2. Re-run the `gh secret set WINDOWS_SIGNING_CERT` flow with the new
   base64 blob.
3. Update `WINDOWS_SIGNING_CERT_PASSWORD` if the password changed.
4. Cut a fresh release — old binaries keep their existing signature; only
   new builds use the new cert.
5. If SmartScreen reputation reset: be ready for a few weeks of
   "Windows protected your PC" warnings until reputation re-establishes
   (OV certs only; EV certs avoid this).

## When the updater keypair rotates

**Don't, unless compromised.** Rotating the pubkey breaks auto-update
for every user already on a build with the old pubkey — they'll need
to download the next release manually. If the private key is leaked:

1. Re-run `scripts/generate-updater-keypair.ps1`.
2. Update `plugins.updater.pubkey` in `tauri.conf.json`.
3. Update GitHub Actions secrets (`TAURI_SIGNING_PRIVATE_KEY` +
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`).
4. Ship a release.
5. Email / Slack existing users that they need to download the next
   release manually.

## Verifying a signed release

End-user check:

1. Right-click `hq-installer_<version>_x64_en-US.msi` → Properties.
2. Click the "Digital Signatures" tab.
3. Expect a signature from "Indigo AI" (or whatever your cert subject
   is) with status "This digital signature is OK."

Programmatic check on the CI runner:

```powershell
$sig = Get-AuthenticodeSignature "hq-installer_*.msi"
if ($sig.Status -ne 'Valid') { throw "Bad signature: $($sig.Status)" }
```

Tauri updater check:

The `*.msi.zip.sig` file alongside the `*.msi.zip` must base64-decode to
a valid minisign signature that verifies against the `pubkey` in
`tauri.conf.json`. The Tauri runtime does this verification before
applying any update — no manual step needed.

## Open questions / known limitations

- **EV cert + GitHub Actions**: EV certs require a hardware token, which
  doesn't work cleanly with cloud CI. Options: (a) ship OV signatures
  in V1 and accept the SmartScreen ramp, (b) sign locally on a developer
  box with the EV token for each release. PRD US-009 ships with OV / no
  cert; revisit before external rollout.
- **Timestamp server**: `timestamp.digicert.com` is the default; if it
  goes down (rare), DigiCert provides alternates. Tauri signed builds
  WITHOUT a timestamp expire when the cert expires (~1 year). Timestamp
  means the signature stays valid forever for binaries signed during the
  cert's validity window.
- **Cross-signing for older Windows**: no longer required — Win 10 1607+
  and all of Win 11 trust SHA-256 Authenticode without the SHA-1
  cross-signature. We don't support Win 10 below 1607 (per PRD non-goals).
