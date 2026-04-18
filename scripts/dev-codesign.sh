#!/usr/bin/env bash
# dev-codesign.sh — Cargo runner that re-signs dev builds with a stable identity.
#
# Why this exists:
#   macOS Keychain items are ACL-protected. The ACL matches the calling
#   process's code-signing Designated Requirement (DR). For an ad-hoc-signed
#   binary — which is what `cargo build` produces by default — the DR is
#   essentially the binary's CDHash. Every rebuild changes the hash, so the
#   Keychain treats each rebuild as a different app and prompts the user.
#
#   Signing each dev build with a stable self-signed cert gives us a stable
#   DR (certificate-leaf–based, not hash-based). After the user clicks
#   "Always Allow" on a Keychain prompt once, subsequent rebuilds match the
#   same DR and macOS grants silently.
#
# How it's wired:
#   Registered via `src-tauri/.cargo/config.toml`:
#     [target.aarch64-apple-darwin]
#     runner = "../scripts/dev-codesign.sh"
#
#   Cargo invokes:    runner <binary-path> [args...]
#   We pass through:  exec "$@"
#
# Cert setup (one-time, interactive):
#   Keychain Access.app → Certificate Assistant → Create a Certificate
#     Name:              HQ Installer Dev
#     Identity Type:     Self Signed Root
#     Certificate Type:  Code Signing
#   See docs/dev-codesign.md for the full walkthrough.
#
# Graceful degradation:
#   If the cert doesn't exist yet (user hasn't set it up), we warn once and
#   run the binary ad-hoc-signed. That keeps `tauri dev` working during
#   setup rather than blocking the user on a cert-creation detour.

set -euo pipefail

readonly CERT_NAME="HQ Installer Dev"
readonly IDENTIFIER="ai.indigo.hq-installer"
readonly BINARY="${1:-}"

if [[ -z "$BINARY" ]]; then
  echo "dev-codesign: no binary path supplied by cargo — bailing" >&2
  exit 64
fi

# Check whether our dev cert exists in the login keychain.
if security find-identity -v -p codesigning | grep -qF "\"$CERT_NAME\""; then
  # Sign silently. -f overrides the existing ad-hoc signature.
  # --identifier pins the signature's bundle ID so the DR is stable across rebuilds.
  if ! codesign --force --sign "$CERT_NAME" --identifier "$IDENTIFIER" "$BINARY" 2>/tmp/hq-installer-codesign.err; then
    echo "dev-codesign: codesign failed — see /tmp/hq-installer-codesign.err" >&2
    cat /tmp/hq-installer-codesign.err >&2
    # Fall through to exec anyway — a signing failure shouldn't wedge dev.
  fi
else
  # Cert not set up yet. Warn once per shell so the user sees it but isn't spammed.
  if [[ -z "${HQ_DEV_CODESIGN_WARNED:-}" ]]; then
    cat >&2 <<EOF

dev-codesign: cert "$CERT_NAME" not found in login keychain.
              Running binary ad-hoc-signed (you'll keep getting Keychain prompts).
              To set up: see docs/dev-codesign.md

EOF
    export HQ_DEV_CODESIGN_WARNED=1
  fi
fi

# Hand off — replace this process with the binary so Ctrl-C in tauri-cli
# propagates correctly and we don't leak a wrapper process.
exec "$@"
