# Windows Auth Smoke Test — US-005 acceptance

Manual end-to-end validation that the Windows port's auth + storage layer
works against real services. Run this on a Windows 11 box with the dev build
of hq-installer.

## Prerequisites

- Windows 11 (ARM64 or x64) with Developer Mode enabled.
- Repo cloned to `C:\repos\hq-installer` and dev setup from
  `docs/dev-setup-windows.md` complete (`pnpm install`, `cargo check` clean).
- A working Indigo Cognito test account.

## 1. Rust keychain round-trip (offline)

Run the keychain unit tests against the real Windows Credential Manager:

```powershell
cd src-tauri
cargo test --release windows_smoke
```

The `round_trip_set_get_delete_windows_credential_manager` test stores a
secret, retrieves it, deletes it, and confirms idempotent re-delete. It
must pass.

Optionally inspect the credential store afterwards — there should be no
leftover `ai.indigo.hq-installer.test-cognito-*` entries:

```powershell
cmdkey /list:ai.indigo.hq-installer.test-cognito-*
# Expected: "* NONE *"
```

## 2. Cognito hosted-UI sign-in (online)

1. Start the dev wizard: `pnpm tauri dev`.
2. On the welcome / auth screen, click "Sign in".
3. The system default browser should open the Cognito hosted UI at
   `https://auth.indigo.ai/oauth2/authorize?...`. Watch for any browser
   blocked, firewall prompt, or "host not reachable" errors.
4. Sign in with the test account. The browser should redirect to
   `http://127.0.0.1:53682/callback?code=...` and show the "you may close
   this tab" page.
5. The wizard should advance past the auth screen within ~2 seconds of the
   redirect.

## 3. Verify token persistence

Without restarting the wizard, open another PowerShell and run:

```powershell
cmdkey /list:ai.indigo.hq-installer.cognito
```

Expected output: an entry for `ai.indigo.hq-installer.cognito` with
the test account email as the user.

## 4. Verify session survives restart

1. Close the wizard window (kill the Tauri dev process).
2. Re-run `pnpm tauri dev`.
3. The wizard should boot, detect the stored session, and SKIP the sign-in
   screen — landing directly at the post-auth wizard state.

## 5. Install screen HQ lay-down (online)

On a fresh run, complete the Install screen before signing in. Verify:

1. The default install path is `%USERPROFILE%\hq` unless you choose a
   different folder.
2. The screen downloads the latest `indigoai-us/hq-core` release and extracts
   it silently without opening another wizard screen.
3. The resulting tree exists at the chosen install path:

```powershell
Get-ChildItem -Path "$env:USERPROFILE\hq" -Directory | Select-Object Name
# Expected includes: companies, knowledge, packages, projects, repos, workspace, workers
Test-Path "$env:USERPROFILE\hq\companies\manifest.yaml"
# Expected: True
```

## 6. Path resolution

In a PowerShell terminal, verify the Install screen wrote the chosen HQ path
for the rest of the app:

```powershell
Test-Path "$env:USERPROFILE\.hq\menubar.json"
# Expected: True
(Get-Content "$env:USERPROFILE\.hq\menubar.json" | ConvertFrom-Json).hqPath
# Expected: C:\Users\<you>\hq, or the custom install path you picked
```

## 7. Cleanup

Sign out from the wizard. Confirm the credential is removed:

```powershell
cmdkey /list:ai.indigo.hq-installer.cognito
# Expected: "* NONE *"
```

## What's NOT covered here

- Real OAuth round-trip with corporate SSO interception. If `auth.indigo.ai`
  is intercepted by an enterprise proxy, sign-in will hang at the redirect
  step. Workaround: use a non-corporate network.
- ARM64 vs x64 parity — run separately on each architecture if both are
  available.
- The full Cognito refresh flow over a long idle (>1 hour). Manual: leave
  the wizard idle past the access-token expiry (default 1h) and confirm
  the next API call triggers a silent refresh without re-prompting for
  sign-in.

## Issues found?

Capture the wizard log (View → Toggle Developer Tools → Console) and the
Rust log (run with `HQ_INSTALLER_DEBUG_DEPS=1` env var) and file a story
against the PRD's open-questions list.
