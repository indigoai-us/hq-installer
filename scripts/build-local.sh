#!/usr/bin/env bash
# build-local.sh — produce a signed .app + .zip for VM testing without
# publishing a GitHub release.
#
# Why this exists:
#   The normal release pipeline tags a commit, pushes, and waits for
#   .github/workflows/release.yml to cross-compile a universal binary and
#   upload it. That's right for shipping; it's wrong for "I just want to
#   smoke-test a UX tweak on the dev VM."
#
# What it does:
#   1. Runs `pnpm tauri build --target aarch64-apple-darwin` (fast, host arch).
#      Override with `BUILD_TARGET=universal-apple-darwin` to match release.
#   2. Locates the bundled .app under src-tauri/target/.../bundle/macos/.
#   3. Zips the .app to dist-local/hq-installer-local-<version>-<target>.zip
#      (uses ditto so the zip round-trips through macOS without losing the
#      codesign signature — a plain `zip -r` strips xattrs and breaks Gatekeeper).
#   4. Prints the zip path so you can scp/AirDrop it to the VM.
#
# Requirements:
#   - Tauri signing keychain already set up (the release build uses the same).
#   - `pnpm`, `cargo tauri` on PATH.
#
# Usage:
#   ./scripts/build-local.sh                         # host arch (fast)
#   BUILD_TARGET=universal-apple-darwin ./scripts/build-local.sh  # release-shape

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

BUILD_TARGET="${BUILD_TARGET:-aarch64-apple-darwin}"
VERSION="$(node -p "require('./package.json').version")"
OUT_DIR="$REPO_ROOT/dist-local"
ZIP_NAME="hq-installer-local-v${VERSION}-${BUILD_TARGET}.zip"
ZIP_PATH="$OUT_DIR/$ZIP_NAME"

echo "→ Building hq-installer v${VERSION} for ${BUILD_TARGET}"
# Disable updater artifact signing locally — the minisign private key lives in
# CI secrets (TAURI_SIGNING_PRIVATE_KEY), and updater artifacts aren't needed
# to launch the .app on a test VM. The --config override is deep-merged into
# tauri.conf.json for this invocation only.
pnpm tauri build --target "$BUILD_TARGET" \
  --config '{"bundle":{"createUpdaterArtifacts":false}}'

APP_PATH="$(find "src-tauri/target/${BUILD_TARGET}/release/bundle/macos" -maxdepth 1 -name "*.app" | head -1)"
if [[ -z "$APP_PATH" || ! -d "$APP_PATH" ]]; then
  echo "build-local: could not find .app under src-tauri/target/${BUILD_TARGET}/release/bundle/macos" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
rm -f "$ZIP_PATH"

# `ditto` preserves extended attributes + signatures; plain `zip` does not.
echo "→ Packing $(basename "$APP_PATH") → $ZIP_NAME"
ditto -c -k --sequesterRsrc --keepParent "$APP_PATH" "$ZIP_PATH"

echo ""
echo "✓ Done."
echo "  App:  $APP_PATH"
echo "  Zip:  $ZIP_PATH"
echo ""
echo "Copy to VM:"
echo "  scp '$ZIP_PATH' <vm>:~/Downloads/"
echo ""
echo "On VM, unzip and first-launch bypass Gatekeeper with:"
echo "  xattr -dr com.apple.quarantine ~/Downloads/hq-installer.app"
