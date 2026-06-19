# Windows PATH management

How the Windows installer writes, refreshes, and (someday) cleans up the user
`PATH` environment variable.

## What gets written

Each `install_*` Tauri command (`install_node`, `install_pnpm`, `install_git`,
`install_gh`, `install_yq`, `install_qmd`, `install_claude_code`,
`install_hq_cli`) appends the relevant install directory to the user `PATH`
after the install completes. The full list of directories that may end up
on `PATH`:

| Directory | Owner |
|---|---|
| `%LOCALAPPDATA%\Microsoft\WindowsApps` | winget shims (Node, Git, gh) |
| `%LOCALAPPDATA%\IndigoHQ\toolchain\node` | managed Node fallback (long-path-aware, required for npm deep trees) |
| `%LOCALAPPDATA%\IndigoHQ\toolchain\npm-prefix` | managed npm globals (pnpm, claude, hq, qmd) |
| `%LOCALAPPDATA%\IndigoHQ\toolchain\bin` | yq + portable cwRsync (rsync.exe + cygwin DLLs) |
| `%ProgramFiles%\Git\cmd` | Git for Windows install |
| `%ProgramFiles%\GitHub CLI` | GitHub CLI install |
| `%USERPROFILE%\scoop\shims` | scoop fallback |

All entries are **user-scoped** (`HKCU\Environment\Path`). The installer
NEVER writes to `HKLM` — no admin rights, no UAC prompts, no risk of
breaking other users' environments.

## How writes propagate without a logout

After each registry write, the installer broadcasts `WM_SETTINGCHANGE` with
`lParam = "Environment"` via `SendMessageTimeoutW(HWND_BROADCAST, ..., 5000ms)`.
Explorer + any cooperative shells listen for this and refresh their cached
environment, so:

1. New PowerShell windows pick up the change immediately (without logout).
2. Already-running PowerShell windows do NOT — they snapshotted env at
   launch. Users must open a new terminal or run
   `[System.Environment]::GetEnvironmentVariable('Path','User')` to read
   the fresh value.

The `SMTO_ABORTIFHUNG` flag keeps a wedged Explorer from blocking the
install — if a window doesn't respond within 5 seconds, the broadcast
gives up and the install continues. The PATH still updates; users just
need a fresh shell.

## Why NOT `setx`

The convenient-looking `setx PATH "%PATH%;<new>"` has two showstoppers:

1. **Silently truncates `PATH` at 1024 chars** on some Windows versions.
   On modern dev boxes with ~50 PATH entries this overflows fast and
   corrupts the user PATH irreversibly.
2. **Expands `%VAR%` eagerly**, baking the current environment into the
   stored string instead of preserving the `REG_EXPAND_SZ` semantics
   the user expects.

The registry path (`winreg::Entry::set_value`) avoids both.

## Idempotency

`append_user_path` does a case-insensitive scan of the current PATH
before writing. If the target dir is already present, the write is
skipped — re-running the installer does not produce duplicate entries.

## Known limitations

### MSI uninstall does NOT remove PATH entries (yet)

The Tauri 2 WiX bundle config exposes basic MSI authoring but does not
yet hook custom actions for PATH cleanup. As a result:

- Running the MSI uninstall via **Settings → Apps → Installed apps**
  removes the wizard app and its Start Menu shortcut.
- It does **NOT** remove the PATH entries added during install.
- The actual HQ folder (`%USERPROFILE%\hq` by default) is preserved
  intentionally — user content shouldn't be deleted by an app uninstall.

Workaround for users who want a clean uninstall: open
**System Properties → Environment Variables → User PATH** and remove
the `%LOCALAPPDATA%\IndigoHQ\toolchain\*` and any other entries from
the [What gets written](#what-gets-written) table.

Programmatic fix: `commands::deps::remove_user_path` is exported and
unit-tested for exactly this purpose. A follow-up story will wire a
WiX custom action that invokes a small uninstall helper exe shipped
alongside the main app — the helper just iterates the known dirs and
calls `remove_user_path` for each. Not in this PRD's scope.

### Already-open PowerShell windows don't see the change

By Win32 design — they don't process `WM_SETTINGCHANGE`. Users must
open a fresh shell. The wizard's Summary screen mentions this so it's
not a surprise.

## Testing

Unit-tested via `deps.rs::tests::user_path_append_then_remove_round_trip`
(Windows-only). It hits the real `HKCU\Environment\Path`, appends a
unique UUID-suffixed dir, verifies idempotent re-append, removes it,
and asserts the original PATH is restored. Safe to run in parallel
because each invocation uses a unique tag.

Manual E2E coverage is in [smoke-windows-auth.md](./smoke-windows-auth.md)
steps 5-6 and the full smoke spec in tests/SMOKE_WINDOWS.md (US-010).
