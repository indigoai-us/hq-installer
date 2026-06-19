# Dev Setup — Windows

Step-by-step setup for building `hq-installer` on Windows 11. Targets both x64 and ARM64 hosts (Stefan's primary dev box is Win 11 ARM64).

## 1. Install base tooling

| Tool | Recommended install |
|------|---------------------|
| Rust | `winget install --id Rustlang.Rustup` then `rustup default stable` |
| Node 22+ | `winget install --id OpenJS.NodeJS.LTS` |
| pnpm 9+ | After Node: `npm install -g pnpm` |
| Visual Studio Build Tools 2022 | `winget install --id Microsoft.VisualStudio.2022.BuildTools` then add the **"Desktop development with C++"** workload via the Visual Studio Installer (this pulls in `link.exe`, the Windows SDK, CMake) |
| Git | `winget install --id Git.Git` (Git Bash is fine, but read the [`link` shadow](#git-bash-link-shadow) note) |
| GitHub CLI (optional) | `winget install --id GitHub.cli` |

WebView2 Runtime ships with Windows 11 by default — no install needed.

## 2. Add Rust targets

Tauri builds per target triple:

```powershell
rustup target add x86_64-pc-windows-msvc
rustup target add aarch64-pc-windows-msvc
```

### ARM64 host-specific override

On a Windows 11 ARM64 dev machine, the default Rust toolchain installed by `rustup` is `aarch64-pc-windows-msvc`. Building Tauri (and many crates that pull in MSVC-linked C deps) defaults to the host triple, which means ARM64 binaries. For day-to-day dev we want x64 binaries (matches the wider test surface and matches the primary release target). Per the lesson learned from `hq-docs-windows` (project PRD US-003), set an explicit override inside `src-tauri/`:

```powershell
cd C:\repos\hq-installer\src-tauri
rustup override set stable-x86_64-pc-windows-msvc
```

This pins all `cargo` invocations made from `src-tauri/` (and its subdirs) to the x64 toolchain regardless of the global default, without affecting other repos.

## 3. MSVC environment — `link.exe` discovery

Cargo invokes `link.exe` (MSVC linker) for the build. `link.exe` is part of the VS Build Tools but is **not** on `PATH` by default. There are three ways to make it discoverable:

### Option A (recommended): trust `.cargo/config.toml`

This repo ships a [`.cargo/config.toml`](../.cargo/config.toml) that explicitly points cargo at the MSVC linker, so a plain PowerShell session works. You do not need a Developer PowerShell for normal development. If you change Visual Studio versions or install path, update the `linker = "..."` entry to match.

### Option B: Developer PowerShell for VS 2022

Launch *"Developer PowerShell for VS 2022"* from the Start Menu. This sources `vcvarsall.bat` and adds `link.exe`, `cl.exe`, the Windows SDK, etc. to `PATH` for the lifetime of that shell.

### Option C: source vcvars manually

In a plain PowerShell:

```powershell
& 'C:\Program Files\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat'
```

(or `vcvarsamd64_arm64.bat` for ARM64 cross-compile; `vcvars64.bat` is x64-native).

## 4. Git Bash `link` shadow

If you build from Git Bash (MINGW64), be aware that `/usr/bin/link` (a POSIX `ln` symlink utility) shadows MSVC's `link.exe`. When cargo invokes `link`, it picks up the Git Bash one first and the build fails with cryptic errors.

**Fix:** either build from PowerShell (recommended), or rename the Git Bash `link`:

```bash
mv /usr/bin/link /usr/bin/link.gitbash
```

Or prepend the MSVC linker path to `PATH` *before* `/usr/bin` in your Bash profile.

## 5. Verify the toolchain

From the repo root in a plain PowerShell session:

```powershell
pnpm install
cd src-tauri
cargo check
```

`cargo check` should complete with exit code 0 and no linker errors. If it fails, double-check:

1. Are you in `src-tauri/`? (The `rustup override` is scoped to that dir.)
2. Is the `.cargo/config.toml` linker path pointing to your actual MSVC install? Visual Studio Installer may have placed it under `Community`, `Professional`, `Enterprise`, or `BuildTools` — the path differs.
3. Run `where link` — is `/usr/bin/link.exe` (Git Bash) coming up first?

## 6. Run the dev wizard

```powershell
pnpm tauri dev
```

This opens the native Windows window with HMR. The wizard auth flow opens a Cognito hosted UI in your default browser — make sure no enterprise SSO is intercepting `https://auth.indigo.ai/*`.

## 7. Build a local installer

```powershell
pnpm tauri build --target x86_64-pc-windows-msvc
```

Output:
- MSI: `src-tauri\target\x86_64-pc-windows-msvc\release\bundle\msi\*.msi`
- NSIS: `src-tauri\target\x86_64-pc-windows-msvc\release\bundle\nsis\*.exe`

(Both targets are configured in `src-tauri/tauri.conf.json` `bundle.targets`. See PRD US-003 for the Windows bundle config story.)

## 8. Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `error: linking with link.exe failed` | MSVC linker not found | Verify `.cargo/config.toml` path, or open Developer PowerShell |
| `error: Microsoft Visual C++ 14.0 or greater is required` | VS Build Tools missing the C++ workload | Open Visual Studio Installer → modify → add "Desktop development with C++" |
| `Could not find WebView2` at runtime | WebView2 runtime missing | Install Edge WebView2 Runtime, or rely on the bundle's `embedBootstrapper` (configured in `tauri.conf.json`) |
| `cargo` builds ARM64 binaries on ARM64 host when you wanted x64 | Missing `rustup override` in `src-tauri/` | See [step 2](#arm64-host-specific-override) above |
| Cryptic errors mentioning `link` symlink | Git Bash `/usr/bin/link` shadows MSVC | See [step 4](#4-git-bash-link-shadow) above |

## References

- Tauri 2 Windows prerequisites: <https://tauri.app/start/prerequisites/>
- Rustup overrides: <https://rust-lang.github.io/rustup/overrides.html>
- MSVC vcvars: <https://learn.microsoft.com/en-us/cpp/build/building-on-the-command-line>
- Sibling project precedent: `projects/hq-docs-windows/prd.json` (HQ docs Tauri port — same toolchain lessons)
