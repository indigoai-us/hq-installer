# Dev-build code signing

Running the installer in dev (`pnpm tauri dev`) otherwise triggers macOS
Keychain prompts on every auth-related operation. This doc explains why and
how the automated setup eliminates it.

## Why macOS prompts

macOS Keychain items are protected by an ACL that matches the caller's
code-signing _Designated Requirement_ (DR). The default ad-hoc signature
`cargo` produces uses the binary's CDHash as the DR — and CDHash changes on
every rebuild. macOS sees each rebuild as a different app, so the ACL stored
on the `com.indigoai.hq-installer.cognito` entry no longer matches the calling
binary, and macOS prompts for confirmation.

Shipped builds aren't affected — the release workflow signs with the team's
Developer ID cert (`APPLE_SIGNING_IDENTITY` in CI), which gives releases a
stable DR across versions. The dev ergonomics problem only exists locally.

The fix is a **self-signed dev cert** in your login keychain. Dev builds get
re-signed after each `cargo build` with that cert, so their DR is determined
by the cert identity (stable) rather than by the binary hash (churns).

## One-time setup

Runs in about 10 seconds, requires one sudo password prompt.

```bash
./scripts/setup-dev-codesign.sh
```

That script:
1. Generates a 2048-bit RSA self-signed cert with all three required
   extensions (`basicConstraints: CA:FALSE`, `keyUsage: digitalSignature`,
   `extendedKeyUsage: codeSigning`).
2. Imports the cert + private key into your **login** keychain.
3. Pre-authorizes `/usr/bin/codesign` to use the private key silently
   (the `-T` flag on `security import`).
4. Exports the cert to `/tmp/hq-installer-dev-cert.pem` and prints the one
   privileged command you still need to run — adding admin-domain trust for
   the `codeSign` policy.

Paste the printed `sudo` command into Terminal, type your macOS password,
done. Verify:

```bash
security find-identity -v -p codesigning
```

You should see `"HQ Installer Dev"` with no status suffix.

**Requirement:** OpenSSL 3 (`brew install openssl@3`). The system-provided
LibreSSL produces PKCS#12 bundles macOS's `security import` refuses to
verify — this is a known incompatibility, not a real cert problem.

## First run after setup

Run `pnpm tauri dev`. Cargo builds, the runner re-signs with the dev cert,
the binary launches. When you sign in for the first time, macOS prompts once
per Keychain item (currently `cognito` and potentially `pat`):

> hq-installer wants to use your confidential information stored in "..." in
> your keychain.

Click **Always Allow**. That binds the ACL to the cert's DR. Every future
rebuild uses the same cert → same DR → macOS grants silently forever.

If you still have old Keychain items from ad-hoc-signed builds, wipe them
before signing in so fresh ACLs get written against the new identity:

```bash
security delete-generic-password -s com.indigoai.hq-installer.cognito \
  ~/Library/Keychains/login.keychain-db
security delete-generic-password -s com.indigoai.hq-installer.pat \
  ~/Library/Keychains/login.keychain-db
```

(Either command returns non-zero if no matching item exists. Harmless.)

## How the wiring works

- `scripts/setup-dev-codesign.sh` — idempotent one-shot installer (run once
  per laptop, or to rotate the dev cert).
- `scripts/dev-codesign.sh` — cargo runner. Each `cargo run` invocation
  (which `cargo tauri dev` uses to launch the dev backend) goes through this
  script, which re-signs with the `HQ Installer Dev` identity and then
  `exec`s the binary. If the cert isn't set up yet, the script emits a
  one-time warning and falls through to ad-hoc — so the dev loop isn't
  blocked during setup.
- `src-tauri/.cargo/config.toml` — wires the runner for both
  `aarch64-apple-darwin` and `x86_64-apple-darwin`.

Verify the runner fires on a rebuild by tailing the dev log and looking for:

```
Running `.../scripts/dev-codesign.sh target/debug/hq-installer`
```

Then inspect the resulting binary:

```bash
codesign -dvvv src-tauri/target/debug/hq-installer 2>&1 | head -4
```

A correctly-signed dev binary shows:

```
Identifier=ai.indigo.hq-installer
Authority=HQ Installer Dev
```

A regression would show either `Signature=adhoc` or
`Identifier=hq_installer-<hash>` — both signals that the runner didn't fire.

## Troubleshooting

**"dev-codesign: cert ... not found"** — setup-dev-codesign.sh wasn't run or
the trust add step was skipped. Rerun setup, run the printed `sudo` command,
verify with `security find-identity -v -p codesigning`.

**`codesign --force --sign "HQ Installer Dev" <file>` returns "no identity
found"** — trust settings aren't in place. The cert and key are in your
keychain but macOS's codesign policy doesn't consider the cert valid. Re-run
the `sudo add-trusted-cert` command from setup.

**`security import` fails with "MAC verification failed"** — you're using
LibreSSL's `openssl`. Install and use `brew install openssl@3` — setup-dev
-codesign.sh already prefers it when available.

**Prompts came back after rebuild** — check the dev log for `dev-codesign:`
lines. If codesign is failing silently, inspect
`/tmp/hq-installer-codesign.err`. Most common cause: the cert's private key
has been removed or the cert has been invalidated; rerun setup.

**Shipping concern: is this dev cert used for releases?** No. CI uses
`APPLE_SIGNING_IDENTITY` (Developer ID Application) from Apple. The self-
signed dev cert lives only on your laptop and has no relationship to Apple's
trust chain. Release users see exactly one "Always Allow" dialog per
Keychain item, ever.
