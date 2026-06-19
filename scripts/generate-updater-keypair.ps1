# generate-updater-keypair.ps1
#
# Generate the Tauri updater minisign keypair for the unified hq-installer repo.
#
# The unified app uses ONE updater keypair for every updater artifact listed in
# latest.json: darwin-universal, darwin-aarch64, darwin-x86_64,
# windows-x86_64, and windows-aarch64. Tauri verifies every platform entry
# against the single plugins.updater.pubkey committed in src-tauri/tauri.conf.json.
# Prefer keeping the existing macOS keypair when configuring the unified repo;
# generating a new one is a rotation for all platforms.
#
# Prerequisites: pnpm + Tauri CLI installed (pnpm install in repo root).
#
# Usage:
#   PS> .\scripts\generate-updater-keypair.ps1 -OutDir "$env:USERPROFILE\.hq-installer\keys"
#
# What this script does:
#   1. Calls `pnpm tauri signer generate` to produce a minisign keypair.
#   2. Writes the private key (encrypted with a passphrase you supply) to
#      $OutDir\hq-installer-updater.key — KEEP THIS FILE SECRET and OUT OF
#      GIT. Add it to a password manager and the CI secret store.
#   3. Writes the public key to $OutDir\hq-installer-updater.pub.
#   4. Prints the base64-wrapped pubkey blob to paste into
#      src-tauri/tauri.conf.json under plugins.updater.pubkey.
#   5. Prints the two GitHub Actions secrets you must set on
#      indigoai-us/hq-installer:
#        - TAURI_SIGNING_PRIVATE_KEY        (the .key file contents)
#        - TAURI_SIGNING_PRIVATE_KEY_PASSWORD (the passphrase)
#
# Rotation:
# Re-running rotates the keypair. Bumping the pubkey in tauri.conf.json
# BREAKS auto-update for any existing user on either macOS or Windows already
# running a build with the OLD pubkey. They will have to download the next
# version manually. Rotate sparingly.

[CmdletBinding()]
param(
    [Parameter(Mandatory=$false)]
    [string]$OutDir = "$env:USERPROFILE\.hq-installer\keys"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $OutDir)) {
    New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
}

$keyBase = Join-Path $OutDir "hq-installer-updater"

Write-Host "Generating Tauri updater minisign keypair into $OutDir..." -ForegroundColor Cyan
Write-Host ""

# `tauri signer generate` will prompt for a passphrase interactively.
# The -w flag writes the private key to the supplied path; the public key
# is printed to stdout AND written to <path>.pub.
pnpm tauri signer generate -w "$keyBase.key"

if (-not (Test-Path "$keyBase.key")) {
    Write-Error "Key generation failed — $keyBase.key was not created."
    exit 1
}

$pubKeyFile = "$keyBase.key.pub"
if (-not (Test-Path $pubKeyFile)) {
    Write-Error "Public key file not found at $pubKeyFile."
    exit 1
}

$pubKeyContent = Get-Content $pubKeyFile -Raw
$pubKeyBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($pubKeyContent))

Write-Host ""
Write-Host "Keypair generated:" -ForegroundColor Green
Write-Host "  Private key (KEEP SECRET): $keyBase.key"
Write-Host "  Public key:                $pubKeyFile"
Write-Host ""
Write-Host "----- PASTE INTO src-tauri/tauri.conf.json plugins.updater.pubkey -----" -ForegroundColor Yellow
Write-Host $pubKeyBase64
Write-Host "------------------------------------------------------------------------" -ForegroundColor Yellow
Write-Host ""
Write-Host "GitHub Actions secrets to set on indigoai-us/hq-installer:" -ForegroundColor Cyan
Write-Host "  TAURI_SIGNING_PRIVATE_KEY          = <contents of $keyBase.key>"
Write-Host "  TAURI_SIGNING_PRIVATE_KEY_PASSWORD = <the passphrase you just entered>"
Write-Host ""
Write-Host "Set them via the GitHub UI or:" -ForegroundColor Cyan
Write-Host "  gh secret set TAURI_SIGNING_PRIVATE_KEY --repo indigoai-us/hq-installer < `"$keyBase.key`""
Write-Host "  gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo indigoai-us/hq-installer --body `"<passphrase>`""
Write-Host ""
Write-Host "Done. Update tauri.conf.json and bump the version before the next release." -ForegroundColor Green
