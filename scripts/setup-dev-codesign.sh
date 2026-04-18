#!/usr/bin/env bash
# setup-dev-codesign.sh — one-shot installer for the dev code-signing identity.
#
# Generates a self-signed code-signing certificate, imports it into the login
# keychain, pre-authorizes /usr/bin/codesign to use it silently, and prints the
# one remaining privileged command (trust-add) that you need to run in Terminal.
#
# Why: without a stable code-signing identity, every dev rebuild produces a
# new CDHash, macOS sees a different app each time, and Keychain items written
# by prior builds no longer match the ACL — so you get a prompt every auth.
# See docs/dev-codesign.md for the full story.
#
# Usage:
#   ./scripts/setup-dev-codesign.sh
#
# Idempotency: safe to re-run. If an "HQ Installer Dev" identity already exists
# it's removed before recreating — this rotates the cert cleanly.

set -euo pipefail

readonly CERT_NAME="HQ Installer Dev"
readonly CERT_CN="HQ Installer Dev"
readonly LOGIN_KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"
readonly CERT_EXPORT_PATH="/tmp/hq-installer-dev-cert.pem"
# Intermediate PKCS#12 passphrase. Not a secret — macOS's `security import`
# has a known bug with empty passphrases ("MAC verification failed") so we use
# a trivial placeholder. The key is protected by keychain ACLs, not this string.
readonly PKCS12_PW='hqdev'

# --- Preflight -------------------------------------------------------------

# LibreSSL (macOS system default) emits PKCS#12 bundles that `security import`
# can't verify. OpenSSL 3 with -legacy produces a compatible format.
if [[ -x /opt/homebrew/opt/openssl@3/bin/openssl ]]; then
  readonly OPENSSL=/opt/homebrew/opt/openssl@3/bin/openssl
elif [[ -x /usr/local/opt/openssl@3/bin/openssl ]]; then
  readonly OPENSSL=/usr/local/opt/openssl@3/bin/openssl
else
  echo "ERROR: openssl@3 not found. Install with:  brew install openssl@3" >&2
  exit 1
fi

# --- Clean slate (if re-running) -------------------------------------------

if security find-identity -p codesigning | grep -qF "\"$CERT_NAME\""; then
  echo "→ Removing existing $CERT_NAME identity before recreating"
  while security find-identity -p codesigning | grep -qF "\"$CERT_NAME\""; do
    security delete-identity -c "$CERT_NAME" "$LOGIN_KEYCHAIN" >/dev/null 2>&1 || break
  done
fi

# --- Cert generation -------------------------------------------------------

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT
cd "$TMPDIR"

# Inline OpenSSL config — set all three extensions macOS's codeSign policy
# requires. Certificate Assistant.app sets these by default; openssl's `-addext`
# flag only covers extendedKeyUsage, so we use a config file to be complete.
#   basicConstraints  CA:FALSE       — this is a leaf cert, not an intermediate
#   keyUsage          digitalSignature — required for code signing
#   extendedKeyUsage  codeSigning    — authorizes the private key for codesign
cat > req.cnf <<EOF
[ req ]
distinguished_name = dn
prompt             = no
req_extensions     = v3_req
x509_extensions    = v3_req

[ dn ]
CN = $CERT_CN

[ v3_req ]
basicConstraints   = critical, CA:FALSE
keyUsage           = critical, digitalSignature
extendedKeyUsage   = critical, codeSigning
EOF

echo "→ Generating 2048-bit RSA cert valid for 10 years"
"$OPENSSL" req -x509 -newkey rsa:2048 -nodes \
  -keyout dev.key -out dev.crt -days 3650 \
  -config req.cnf -extensions v3_req 2>/dev/null

# --lesson learned-- use -legacy so macOS's `security import` accepts the MAC.
"$OPENSSL" pkcs12 -export \
  -inkey dev.key -in dev.crt \
  -out dev.p12 -passout "pass:$PKCS12_PW" -name "$CERT_NAME" \
  -legacy

# --- Import ---------------------------------------------------------------

echo "→ Importing cert + key into login keychain"
# -T /usr/bin/codesign pre-grants codesign access to the private key. Without
# it, the first `codesign` call would pop a "codesign wants to use your
# confidential information" dialog.
security import dev.p12 \
  -k "$LOGIN_KEYCHAIN" \
  -P "$PKCS12_PW" \
  -T /usr/bin/codesign \
  >/dev/null

# Export the cert PEM so the user's sudo command has a stable file to read.
cp dev.crt "$CERT_EXPORT_PATH"

# --- Done ----------------------------------------------------------------

echo
echo "✓ Cert imported. SHA-1 fingerprint:"
security find-identity -p codesigning | grep -F "\"$CERT_NAME\"" | head -1
echo
echo "Cert status: untrusted (fresh self-signed). One more step to finish."
echo
echo "Run this in Terminal — it needs your macOS password once:"
echo
echo "    sudo security add-trusted-cert -d -r trustRoot -p codeSign \\"
echo "      -k /Library/Keychains/System.keychain \\"
echo "      $CERT_EXPORT_PATH"
echo
echo "After that, verify with:"
echo "    security find-identity -v -p codesigning"
echo "and confirm \"HQ Installer Dev\" appears with no error suffix."
echo
echo "Then restart pnpm tauri dev — rebuilds will auto-sign and Keychain"
echo "prompts stop after the next Always-Allow click per item."
