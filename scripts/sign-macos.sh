#!/usr/bin/env bash
#
# sign-macos.sh — local dev helper for signing + notarizing the installer.
#
# CI does this end-to-end via .github/workflows/release-macos.yml + the
# tauri-action. This script exists so a developer can reproduce the full
# sign + notarize pipeline on their own machine before cutting a release —
# much faster than push-tag-debug-repeat.
#
# Prerequisites:
#   - 1Password CLI (`op`) authenticated
#   - Apple Developer ID cert installed via 1Password item "Apple Developer ID (Indigo)"
#   - pnpm + cargo + tauri-cli already installed
#
# Usage:
#   scripts/sign-macos.sh                       # builds + signs + notarizes for host arch
#   scripts/sign-macos.sh --target aarch64      # force Apple Silicon
#   scripts/sign-macos.sh --target x86_64       # force Intel
#   scripts/sign-macos.sh --skip-notarize       # sign only (fast local smoke test)
#
# Secrets never touch disk — we use `op read` to pipe directly into env
# vars, and tauri-cli reads from env. The only file we create is the
# .p12 in /tmp, which gets scrubbed on exit.

set -euo pipefail

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly TMP_CERT="$(mktemp -t hq-installer-cert).p12"

cleanup() {
  rm -f "$TMP_CERT"
  # Don't leave a dangling keychain around
  if security list-keychains | grep -q "hq-installer-build.keychain"; then
    security delete-keychain hq-installer-build.keychain 2>/dev/null || true
  fi
}
trap cleanup EXIT

log() { printf "\033[1;34m[sign-macos]\033[0m %s\n" "$*"; }
die() { printf "\033[1;31m[sign-macos]\033[0m %s\n" "$*" >&2; exit 1; }

# ── Arg parsing ───────────────────────────────────────────────────────
TARGET=""
SKIP_NOTARIZE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      TARGET="$2"
      shift 2
      ;;
    --target=*)
      TARGET="${1#*=}"
      shift
      ;;
    --skip-notarize)
      SKIP_NOTARIZE=1
      shift
      ;;
    -h|--help)
      sed -n '/^# Usage:/,/^$/p' "$0" | sed 's/^# //'
      exit 0
      ;;
    *)
      die "Unknown argument: $1"
      ;;
  esac
done

# Default to host arch.
if [[ -z "$TARGET" ]]; then
  case "$(uname -m)" in
    arm64)  TARGET="aarch64-apple-darwin" ;;
    x86_64) TARGET="x86_64-apple-darwin" ;;
    *)      die "Unsupported host arch: $(uname -m)" ;;
  esac
elif [[ "$TARGET" == "aarch64" ]]; then
  TARGET="aarch64-apple-darwin"
elif [[ "$TARGET" == "x86_64" || "$TARGET" == "x64" ]]; then
  TARGET="x86_64-apple-darwin"
fi

log "Target: $TARGET"

# ── Preflight ────────────────────────────────────────────────────────
command -v op >/dev/null || die "1Password CLI (op) not found. Install with: brew install 1password-cli"
command -v cargo >/dev/null || die "cargo not found"
command -v pnpm >/dev/null || die "pnpm not found"

if ! op whoami >/dev/null 2>&1; then
  die "Not signed in to 1Password CLI. Run: eval \$(op signin)"
fi

cd "$REPO_ROOT"

# Ensure toolchain is available for the target.
if ! rustup target list --installed | grep -q "^$TARGET$"; then
  log "Installing Rust toolchain for $TARGET"
  rustup target add "$TARGET"
fi

# ── Pull cert + creds from 1Password ─────────────────────────────────
log "Reading Apple Developer ID material from 1Password"

# The .p12 is stored base64-encoded in the field APPLE_CERTIFICATE so CI
# can reuse the same item. We decode here and leave it in /tmp under the
# trap-cleanup guard.
APPLE_CERTIFICATE_B64="$(op read "op://Personal/Apple Developer ID (Indigo)/APPLE_CERTIFICATE")"
echo "$APPLE_CERTIFICATE_B64" | base64 -d > "$TMP_CERT"

APPLE_CERTIFICATE_PASSWORD="$(op read 'op://Personal/Apple Developer ID (Indigo)/APPLE_CERTIFICATE_PASSWORD')"
APPLE_SIGNING_IDENTITY="$(op read 'op://Personal/Apple Developer ID (Indigo)/APPLE_SIGNING_IDENTITY')"

if [[ $SKIP_NOTARIZE -eq 0 ]]; then
  APPLE_ID="$(op read 'op://Personal/Apple Developer ID (Indigo)/APPLE_ID')"
  APPLE_PASSWORD="$(op read 'op://Personal/Apple Developer ID (Indigo)/APPLE_PASSWORD')"
  APPLE_TEAM_ID="$(op read 'op://Personal/Apple Developer ID (Indigo)/APPLE_TEAM_ID')"
fi

# ── Import cert into an ephemeral keychain ───────────────────────────
# We use a dedicated build keychain so we don't clutter the user's
# login keychain and so cleanup is a single `security delete-keychain`.

log "Importing certificate into temporary keychain"

KEYCHAIN_PASSWORD="$(openssl rand -base64 24)"
security create-keychain -p "$KEYCHAIN_PASSWORD" hq-installer-build.keychain
security set-keychain-settings -lut 3600 hq-installer-build.keychain
security unlock-keychain -p "$KEYCHAIN_PASSWORD" hq-installer-build.keychain

security import "$TMP_CERT" \
  -k hq-installer-build.keychain \
  -P "$APPLE_CERTIFICATE_PASSWORD" \
  -T /usr/bin/codesign

security set-key-partition-list \
  -S apple-tool:,apple:,codesign: \
  -s \
  -k "$KEYCHAIN_PASSWORD" \
  hq-installer-build.keychain >/dev/null

# Put our build keychain first in the search list so codesign picks it up.
security list-keychains -d user -s hq-installer-build.keychain "$(security default-keychain -d user | tr -d \")"

# ── Build via tauri ──────────────────────────────────────────────────
log "Running tauri build (release, target=$TARGET)"

APPLE_SIGNING_IDENTITY="$APPLE_SIGNING_IDENTITY" \
APPLE_CERTIFICATE="" \
APPLE_CERTIFICATE_PASSWORD="" \
  pnpm tauri build --target "$TARGET"

BUNDLE_DIR="$REPO_ROOT/src-tauri/target/$TARGET/release/bundle"
DMG_PATH="$(find "$BUNDLE_DIR/dmg" -maxdepth 1 -name "*.dmg" | head -n 1)"

if [[ -z "${DMG_PATH:-}" || ! -f "$DMG_PATH" ]]; then
  die "Build succeeded but no DMG found under $BUNDLE_DIR/dmg"
fi

log "Built: $DMG_PATH"

# ── Notarize + staple ────────────────────────────────────────────────
if [[ $SKIP_NOTARIZE -eq 1 ]]; then
  log "Skipping notarization (--skip-notarize)."
  log "DMG is signed but NOT notarized — Gatekeeper will still warn."
  log "Output: $DMG_PATH"
  exit 0
fi

log "Submitting DMG to Apple notary service (this usually takes 2-5 min)"

# Store a one-shot notary profile in the build keychain so notarytool
# can auth without prompts.
xcrun notarytool store-credentials hq-installer-notary \
  --apple-id "$APPLE_ID" \
  --team-id "$APPLE_TEAM_ID" \
  --password "$APPLE_PASSWORD" \
  --keychain "$HOME/Library/Keychains/hq-installer-build.keychain-db" >/dev/null

xcrun notarytool submit "$DMG_PATH" \
  --keychain-profile hq-installer-notary \
  --keychain "$HOME/Library/Keychains/hq-installer-build.keychain-db" \
  --wait

log "Stapling notarization ticket to DMG"
xcrun stapler staple "$DMG_PATH"

log "Verifying Gatekeeper will accept the DMG"
spctl --assess --type open --context context:primary-signature --verbose=2 "$DMG_PATH"

log "Done. Signed + notarized DMG: $DMG_PATH"
