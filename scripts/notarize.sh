#!/usr/bin/env bash
# notarize.sh — Submit the universal .dmg to Apple notarization and staple the ticket.
#
# Required environment variables:
#   APPLE_ID           — Apple ID email used for notarization (e.g. dev@example.com)
#   APPLE_ID_PASSWORD  — App-specific password for the Apple ID
#   APPLE_TEAM_ID      — 10-character Apple Developer Team ID
#
# The script exits non-zero on any failure.

set -euo pipefail

DMG_DIR="src-tauri/target/universal-apple-darwin/release/bundle/dmg"

# ---------------------------------------------------------------------------
# Validate environment variables
# ---------------------------------------------------------------------------
: "${APPLE_ID:?APPLE_ID is required}"
: "${APPLE_ID_PASSWORD:?APPLE_ID_PASSWORD is required}"
: "${APPLE_TEAM_ID:?APPLE_TEAM_ID is required}"

# ---------------------------------------------------------------------------
# Locate the .dmg
# ---------------------------------------------------------------------------
if [[ ! -d "$DMG_DIR" ]]; then
  echo "ERROR: DMG directory not found: $DMG_DIR" >&2
  echo "       Run 'tauri build --target universal-apple-darwin' first." >&2
  exit 1
fi

DMG_PATH=$(find "$DMG_DIR" -name "*.dmg" -maxdepth 1 | head -n 1)

if [[ -z "$DMG_PATH" ]]; then
  echo "ERROR: No .dmg file found in $DMG_DIR" >&2
  exit 1
fi

echo "Found DMG: $DMG_PATH"

# ---------------------------------------------------------------------------
# Submit to Apple notarization and wait for result
# ---------------------------------------------------------------------------
echo "Submitting to Apple notarization..."

NOTARIZE_OUTPUT=$(xcrun notarytool submit "$DMG_PATH" \
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
# Staple the notarization ticket to the .dmg
# ---------------------------------------------------------------------------
echo "Stapling notarization ticket..."
xcrun stapler staple "$DMG_PATH"

echo "Done. $DMG_PATH is notarized and stapled."
