# Windows 11 End-to-End Smoke Test — US-010

The V1 acceptance gate for hq-installer dogfood. Run this on every
release candidate (RC) before tagging. Runs against the signed MSI from
the GitHub release artifacts.

**Owner:** Stefan (primary Windows 11 ARM64 dev host).
**Frequency:** Every RC + after any change to deps.rs / process.rs /
oauth.rs / keychain.rs / template.rs.

## Per-run header (fill in for each smoke pass)

```
Date:            YYYY-MM-DD HH:MM (local)
RC version:      vX.Y.Z
RC commit SHA:   abc1234
Host arch:       [ARM64 | x64]
Host OS build:   Windows 11 Pro 22631.xxxx
Prior HQ state:  [clean VM | leftover %USERPROFILE%\hq from a prior install]
Network:         [home / wired | corp / VPN]
Tester:          Stefan
```

## 0. Pre-flight cleanup (if reusing a host)

If this isn't a clean VM, reset state so signals aren't masked by
leftover files / PATH entries / Credential Manager entries.

```powershell
# Remove leftover HQ folder (keeps user-content separation intact — only
# do this on a test box, never on a real dev workstation).
Remove-Item -Path "$env:USERPROFILE\hq" -Recurse -Force -ErrorAction SilentlyContinue

# Remove leftover managed toolchain.
Remove-Item -Path "$env:LOCALAPPDATA\IndigoHQ" -Recurse -Force -ErrorAction SilentlyContinue

# Remove leftover Credential Manager entries (cmdkey deletes by name).
cmdkey /list:ai.indigo.hq-installer.* | Select-String "Target:" | ForEach-Object {
  $target = ($_ -split ': ')[1].Trim()
  cmdkey /delete:$target
}

# Remove leftover PATH entries (cleanup what the MSI uninstaller can't yet).
$current = [System.Environment]::GetEnvironmentVariable('Path', 'User')
$cleaned = ($current -split ';' | Where-Object {
  $_ -notmatch '\\IndigoHQ\\toolchain\\' -and $_ -notmatch '\\Microsoft\\WindowsApps$'
}) -join ';'
[System.Environment]::SetEnvironmentVariable('Path', $cleaned, 'User')
```

Verify clean state:

```powershell
Test-Path "$env:USERPROFILE\hq"        # Expected: False
Test-Path "$env:LOCALAPPDATA\IndigoHQ"  # Expected: False
cmdkey /list:ai.indigo.hq-installer.*  # Expected: '* NONE *'
```

## 1. MSI install via double-click

| Step | Expected | Actual |
|---|---|---|
| Download `hq-installer_vX.Y.Z_x64_en-US.msi` from the GitHub release. | File ~25-30 MB. | ☐ |
| Double-click the MSI in Explorer. | UAC prompt does NOT appear (per-user install). | ☐ |
| WiX dialog appears titled "HQ Installer". | Walks through standard welcome + install location pages. | ☐ |
| Click through Install. | Progress bar runs to completion, no console window flashes during install. | ☐ |
| Click Finish. | Dialog closes cleanly. | ☐ |
| Open **Settings → Apps → Installed apps** and search "HQ Installer". | Entry exists, Publisher = "Indigo AI", Version = X.Y.Z, Size populated. | ☐ |

**FAIL conditions:** UAC prompt (means we accidentally elevated to
machine-scope install), console flash (means windows_subsystem attr
missing from main.rs), missing Publisher (means tauri.conf.json
bundle.publisher wasn't picked up).

**Screenshots to capture:** Add/Remove Programs entry, install dir
contents under `%LOCALAPPDATA%\Programs\HQ Installer\`.

## 2. Start Menu launch

| Step | Expected | Actual |
|---|---|---|
| Press Start, type "HQ Installer". | Entry appears in results. | ☐ |
| Click it. | Wizard window opens within 2-3s. | ☐ |
| Wizard lands on the welcome / auth screen. | "Sign in" button visible. | ☐ |

**FAIL conditions:** wizard doesn't open, opens but is blank (means
WebView2 runtime missing — note + skip ahead to verify
bundle.windows.webviewInstallMode handled it), opens at wrong screen.

## 3. Cognito hosted-UI sign-in

| Step | Expected | Actual |
|---|---|---|
| Click "Sign in". | Default system browser opens to `https://auth.indigo.ai/oauth2/authorize?...`. | ☐ |
| Sign in with a test Cognito account. | Browser redirects to `http://127.0.0.1:53682/callback?code=...` and shows "You may close this tab". | ☐ |
| Within ~2s of redirect, wizard advances past auth screen. | Next wizard screen visible. | ☐ |

Verify token persistence in another PowerShell window:

```powershell
cmdkey /list:ai.indigo.hq-installer.cognito
# Expected: an entry exists, User = test account email
```

| Step | Expected | Actual |
|---|---|---|
| Close the wizard window (X). | Process exits. | ☐ |
| Re-launch from Start Menu. | Wizard skips auth screen, lands directly at post-auth state. | ☐ |

**FAIL conditions:** browser doesn't open (firewall blocking
tauri-plugin-shell), redirect URI shows "site can't be reached"
(loopback listener didn't bind — port 53682 occupied by another app),
wizard hangs after redirect (oauth.rs deadlock), `cmdkey` shows no
entry (keyring write silently failed).

## 4. Setup orchestrator screen

After sign-in, the wizard uses one Setup screen with auto-advancing stages:
dependency install -> initial cloud sync -> default packs -> git init ->
personalization -> qmd indexing -> HQ Sync menubar app install. Do not expect
separate deps, git-init, personalize, indexing, or menubar screens.

| Step | Expected | Actual |
|---|---|---|
| Setup screen appears after auth. | Stage progress is visible and begins with dependency checks. | ☐ |
| Let the dependency stage run. | Missing tools install via winget/scoop/direct-download or npm as appropriate; terminal output streams without hanging. | ☐ |
| Continue through the auto-advancing stages. | Initial cloud sync, default packs, git init, personalization, qmd indexing, and HQ Sync menubar install each complete without manual navigation. | ☐ |
| After Setup completes, open a fresh PowerShell window. | Run `node --version`, `pnpm --version`, `git --version`, `gh --version`, `yq --version`, `qmd --version`, `claude --version`, `hq --version`. Each prints a version, none error. | ☐ |

Verify managed toolchain was created:

```powershell
Get-ChildItem -Path "$env:LOCALAPPDATA\IndigoHQ\toolchain" -Recurse | Select-Object FullName -First 20
```

| Step | Expected | Actual |
|---|---|---|
| Output shows nested dirs under managed toolchain. | At least `npm-prefix\` and the per-tool bin files exist. | ☐ |

**FAIL conditions:** dep install hangs (winget might be stuck waiting
for input — check that --silent + --accept-source-agreements +
--accept-package-agreements all made it onto the command line),
cancellation doesn't work (means Job Object termination broke —
re-verify the cmd /c timeout test from US-004), `claude --version`
fails in fresh shell (PATH broadcast didn't propagate; user PATH
write check via `[System.Environment]::GetEnvironmentVariable('Path', 'User')`).

## 5. Install screen HQ lay-down + output verification

The Install screen runs before Sign In in the shared 5-step flow. It chooses
the HQ path and silently downloads/extracts the `indigoai-us/hq-core` release
there; Setup later adds git, personalization, indexing, and menubar state.

| Step | Expected | Actual |
|---|---|---|
| On the Install screen, accept the default path or choose another folder. | Defaults to `C:\Users\<you>\hq`. | ☐ |
| Continue from Install. | The hq-core tree is extracted to the chosen folder without opening another wizard screen. | ☐ |
| After Setup completes, inspect the chosen folder. | Core tree, personalized files, git repo, indexes, and menubar path metadata exist. | ☐ |

Verify the resulting HQ install:

```powershell
Get-ChildItem -Path "$env:USERPROFILE\hq" -Directory | Select Name
# Expected: companies, knowledge, packages, projects, repos, workspace, workers, .claude, .obsidian
Test-Path "$env:USERPROFILE\hq\companies\manifest.yaml"
# Expected: True
Test-Path "$env:USERPROFILE\hq\.claude\CLAUDE.md"
# Expected: True
Test-Path "$env:USERPROFILE\.hq\menubar.json"
# Expected: True
(Get-Content "$env:USERPROFILE\.hq\menubar.json" | ConvertFrom-Json).hqPath
# Expected: C:\Users\<you>\hq, or the custom install path you picked
```

**FAIL conditions:** hq-core extract fails (likely `fs.rs` symlink
fails with `ERROR_PRIVILEGE_NOT_HELD` — point user at Developer Mode
toggle), profile / voice-style render fails, git init fails, indexing
hangs, or HQ Sync menubar install fails.

## 6. Summary screen — Launch Claude Code

| Step | Expected | Actual |
|---|---|---|
| At the Summary screen, click "Launch Claude Code". | A new Windows Terminal window opens. | ☐ |
| In the new terminal, working dir is `C:\Users\<you>\hq`. | `Get-Location` confirms. | ☐ |
| `claude` is running and shows the Claude Code prompt. | Interactive prompt visible. | ☐ |
| Type a quick prompt + Enter to verify. | Claude responds, can see + read HQ files. | ☐ |

Verify Claude Desktop probe (if Claude Desktop is installed):

| Step | Expected | Actual |
|---|---|---|
| Summary screen renders "Launch Claude Desktop" CTA. | Button visible. | ☐ |
| Click it. | Claude Desktop window opens. | ☐ |

If Claude Desktop is NOT installed:

| Step | Expected | Actual |
|---|---|---|
| Summary screen renders "Download Claude Desktop" CTA. | Link visible, opens download page in browser. | ☐ |

**FAIL conditions:** wt.exe not found AND PowerShell fallback also
fails (means launch.rs misdetected wt.exe presence); Terminal opens
in wrong directory (-d flag dropped); `claude` doesn't auto-run
(quoting bug in launch.rs).

## 7. MSI uninstall

| Step | Expected | Actual |
|---|---|---|
| Open **Settings → Apps → Installed apps**, find "HQ Installer", click ... → Uninstall. | Confirmation prompt. | ☐ |
| Confirm. | Uninstall runs, completes in <30s. | ☐ |
| Re-search "HQ Installer" in Settings. | Entry gone. | ☐ |
| Re-search in Start Menu. | Shortcut gone. | ☐ |
| Re-check `Test-Path "$env:USERPROFILE\hq"`. | Returns True — user content preserved. | ☐ |
| Re-check `[System.Environment]::GetEnvironmentVariable('Path', 'User') -split ';' \| Select-String 'IndigoHQ'`. | **KNOWN LIMITATION (US-008):** PATH entries are NOT removed. Document the leftover entries. | ☐ |

**FAIL conditions:** uninstall errors (WiX rollback issue), removes
%USERPROFILE%\hq (we should never delete user content), removes
%LOCALAPPDATA%\IndigoHQ\toolchain (also user content — managed
toolchain stays).

## 8. Rerun on x64 hardware (if available)

Repeat sections 1-7 on a Win 11 x64 VM. Record any deltas from the
ARM64 run.

| Section | ARM64 result | x64 result |
|---|---|---|
| Install | ☐ | ☐ |
| Start Menu | ☐ | ☐ |
| Cognito auth | ☐ | ☐ |
| Deps | ☐ | ☐ |
| Install + Setup | ☐ | ☐ |
| Launch Claude Code | ☐ | ☐ |
| Uninstall | ☐ | ☐ |

If no x64 hardware available, document the gap here and rely on CI's
x64 release build.

## 9. Issues found

| ID | Severity | Section | Description | Status |
|---|---|---|---|---|
| 1 | | | | |

For any FAIL: file as a follow-up story against
`companies/indigo/projects/hq-installer/` with link to this smoke
report's commit + screenshots.

## 10. Overall verdict

```
RC vX.Y.Z verdict: [PASS | FAIL | PASS WITH NOTES]
Tester sign-off:   Stefan, YYYY-MM-DD
Next action:       [tag for release | open follow-up stories before tagging]
```

---

## Smoke history

Append a new section every time this template is run. Don't delete
prior entries — the history is the audit trail for "did v0.4.x ever
pass on ARM64?".

### v0.4.1 - 2026-MM-DD - ARM64 - placeholder

Not yet run — pending first signed RC build via the US-009 release
workflow.
