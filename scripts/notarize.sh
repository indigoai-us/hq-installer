#!/usr/bin/env bash
# notarize.sh — Submit the universal .app to Apple notarization and staple the ticket.
#
# notarytool requires a .zip, .pkg, or .dmg as input — it will not accept a
# bare .app. We zip the .app with `ditto` (preserves xattrs + signatures),
# submit the zip, and then staple the ticket back onto the .app itself.
# The zip is a disposable submission wrapper; the stapled .app is the real
# artifact that ends up in the release .zip built by CI.
#
# Required environment variables:
#   APPLE_ID           — Apple ID email used for notarization (e.g. dev@example.com)
#   APPLE_ID_PASSWORD  — App-specific password for the Apple ID
#   APPLE_TEAM_ID      — 10-character Apple Developer Team ID
#
# The script exits non-zero on any failure.

set -euo pipefail

APP_DIR="src-tauri/target/universal-apple-darwin/release/bundle/macos"

# ---------------------------------------------------------------------------
# Validate environment variables
# ---------------------------------------------------------------------------
: "${APPLE_ID:?APPLE_ID is required}"
: "${APPLE_ID_PASSWORD:?APPLE_ID_PASSWORD is required}"
: "${APPLE_TEAM_ID:?APPLE_TEAM_ID is required}"

# ---------------------------------------------------------------------------
# Locate the .app
# ---------------------------------------------------------------------------
if [[ ! -d "$APP_DIR" ]]; then
  echo "ERROR: App bundle directory not found: $APP_DIR" >&2
  echo "       Run 'tauri build --target universal-apple-darwin' first." >&2
  exit 1
fi

APP_PATH=$(find "$APP_DIR" -maxdepth 1 -name "*.app" | head -n 1)

if [[ -z "$APP_PATH" ]]; then
  echo "ERROR: No .app bundle found in $APP_DIR" >&2
  exit 1
fi

echo "Found .app: $APP_PATH"

# ---------------------------------------------------------------------------
# Wrap the .app in a zip for notarytool submission
# ---------------------------------------------------------------------------
SUBMISSION_ZIP="$(mktemp -d)/hq-installer-notarize.zip"
echo "Wrapping .app in notarization zip: $SUBMISSION_ZIP"
ditto -c -k --keepParent --sequesterRsrc "$APP_PATH" "$SUBMISSION_ZIP"

# ---------------------------------------------------------------------------
# Submit to Apple notarization and wait for result
# ---------------------------------------------------------------------------
echo "Submitting to Apple notarization..."

NOTARIZE_OUTPUT=$(xcrun notarytool submit "$SUBMISSION_ZIP" \
  --apple-id    "$APPLE_ID" \
  --password    "$APPLE_ID_PASSWORD" \
  --team-id     "$APPLE_TEAM_ID" \
  --wait \
  --output-format plist)

echo "$NOTARIZE_OUTPUT"

# Extract submission status from plist output
STATUS=$(echo "$NOTARIZE_OUTPUT" | \
  xmllint --xpath "string(//dict/key[.='status']/following-sibling::string[1])" - 2>/dev/null || true)

if [[ "$STATUS" != "Accepted" ]]; then
  echo "ERROR: Notarization failed with status: '${STATUS:-unknown}'" >&2

  # Extract and print the submission ID for manual log retrieval
  SUBMISSION_ID=$(echo "$NOTARIZE_OUTPUT" | \
    xmllint --xpath "string(//dict/key[.='id']/following-sibling::string[1])" - 2>/dev/null || true)

  if [[ -n "$SUBMISSION_ID" ]]; then
    echo "       Retrieve full log with:" >&2
    echo "       xcrun notarytool log $SUBMISSION_ID --apple-id \$APPLE_ID --password \$APPLE_ID_PASSWORD --team-id \$APPLE_TEAM_ID" >&2
  fi

  exit 1
fi

echo "Notarization accepted."

# ---------------------------------------------------------------------------
# Staple the notarization ticket directly to the .app
# ---------------------------------------------------------------------------
echo "Stapling notarization ticket to .app..."
xcrun stapler staple "$APP_PATH"

echo "Done. $APP_PATH is notarized and stapled."
