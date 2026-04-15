# HQ Install Specification

**Status:** canonical — this document is the behavioral contract between the `create-hq` CLI and the `hq-installer` desktop app. Both tools MUST produce equivalent results for equivalent inputs. Divergence is a bug.

**Sources of truth mapped:**

| Phase / concept       | Upstream file                                         |
|-----------------------|-------------------------------------------------------|
| CLI entry + flags     | `indigoai-us/hq:packages/create-hq/src/index.ts`      |
| Scaffold orchestration| `indigoai-us/hq:packages/create-hq/src/scaffold.ts`   |
| Dep registry + install| `indigoai-us/hq:packages/create-hq/src/deps.ts`       |
| OS / PM detection     | `indigoai-us/hq:packages/create-hq/src/platform.ts`   |
| Template fetch        | `indigoai-us/hq:packages/create-hq/src/fetch-template.ts` |
| Git init + commit     | `indigoai-us/hq:packages/create-hq/src/git.ts`        |
| Cloud sync detection  | `indigoai-us/hq:packages/create-hq/src/cloud-sync.ts` |
| GitHub auth           | `indigoai-us/hq:packages/create-hq/src/auth.ts`       |
| Teams flow            | `indigoai-us/hq:packages/create-hq/src/teams-flow.ts` |
| TUI + banners         | `indigoai-us/hq:packages/create-hq/src/ui.ts`         |

`hq-installer` does **not** shell out to `create-hq`. The Rust core in `src-tauri/src/core/*` is a native port — identical semantics, different implementation.

---

## 1. High-Level Install Flow

```
banner
  └─ entry-mode selection
       ├─ teams-existing  → GH auth → clone team HQ → cloud sync → next steps
       ├─ teams-new       → GH auth → team creation flow → personal baseline → connect → next steps
       ├─ personal        → dep check → directory pick → cloud-sync detect → template expand → git init → optional hq-cli → optional packages → next steps
       └─ exit
```

The `hq-installer` MVP implements **personal mode only**. Teams mode is out of scope for v0 and will route to `create-hq` CLI (via a "I'm a developer" side-exit in the UI).

### 1.1 CLI flags that map to GUI toggles

| `create-hq` flag        | GUI equivalent                               | Default |
|-------------------------|----------------------------------------------|---------|
| `--skip-deps`           | (dev-only override — hidden)                 | off     |
| `--skip-cli`            | Advanced → "Skip hq-cli global install"      | off     |
| `--skip-sync`           | Advanced → "Set up cloud later"              | off     |
| `--skip-packages`       | Advanced → "Skip package discovery"          | off     |
| `--tag <version>`       | Advanced → template version                  | latest  |
| `--local-template <p>`  | Dev-only — not in shipped GUI                | —       |
| `--join <token>`        | Teams path (out of MVP scope)                | —       |
| `--invite <token>`      | Teams path (out of MVP scope)                | —       |

---

## 2. Platform Detection

Mirrors `platform.ts` exactly.

### 2.1 OS type

| `process.platform` / `uname` | `OsType` enum           |
|------------------------------|-------------------------|
| `darwin`                     | `macos`                 |
| `win32` / `windows`          | `windows`               |
| `linux` + `/etc/os-release` matches `debian`/`ubuntu` | `linux-debian` |
| `linux` + `/etc/os-release` matches `fedora`/`rhel`   | `linux-fedora` |
| `linux` + `/etc/os-release` matches `arch`            | `linux-arch`   |
| `linux` (no match)                                    | `linux`        |
| (anything else)              | `unix`                  |

### 2.2 System package manager

| OS             | Priority order                       |
|----------------|--------------------------------------|
| `macos`        | brew                                 |
| `windows`      | winget → choco                       |
| `linux-debian` | apt                                  |
| `linux-fedora` | dnf → yum                            |
| `linux-arch`   | pacman                               |
| `linux`/`unix` | apt → dnf → yum → pacman → brew      |

`yq`-style yum fallback: when the detected PM is `yum`, use `dnf` install commands.

### 2.3 npm availability

Checked independently via `which npm` (Unix) or `where npm` (Windows). `npm` is not a system PM but is the preferred fallback when the primary system PM has no entry for a given dep.

---

## 3. Dependency Registry

Mirrors `deps.ts`. Any change to this list requires a matching change in both `create-hq` and `hq-installer`.

### 3.1 Required dependencies

Install **must block** until all required deps are present.

| id       | check command         | install hint URL                                | auto-installable |
|----------|-----------------------|-------------------------------------------------|------------------|
| `node`   | `node --version`      | https://nodejs.org                              | NO — manual only |
| `git`    | `git --version`       | https://git-scm.com/downloads                   | NO — manual only |
| `gh`     | `gh --version`        | https://cli.github.com                          | YES              |
| `claude` | `claude --version`    | `npm install -g @anthropic-ai/claude-code`      | YES (via npm)    |

### 3.2 Optional dependencies

Install **continues** even if these fail; user is reminded in the summary.

| id       | check command       | install hint                                     | auto-installable |
|----------|---------------------|--------------------------------------------------|------------------|
| `qmd`    | `qmd --version`     | `npm install -g @tobilu/qmd`                     | YES              |
| `yq`     | `yq --version`      | https://github.com/mikefarah/yq#install          | YES              |
| `vercel` | `vercel --version`  | `npm install -g vercel`                          | YES (via npm)    |
| `hq-cli` | `hq --version`      | `npm install -g @indigoai-us/hq-cli`             | YES (via npm)    |

### 3.3 Install commands per package manager

| Dep    | brew                | apt                  | dnf               | pacman               | winget                                  | choco                  | npm                                   |
|--------|---------------------|----------------------|-------------------|----------------------|------------------------------------------|------------------------|---------------------------------------|
| gh     | `brew install gh`   | `sudo apt install gh`| `sudo dnf install gh` | `sudo pacman -S github-cli` | `winget install --id GitHub.cli -e` | `choco install gh -y`  | —                                     |
| claude | —                   | —                    | —                 | —                    | —                                        | —                      | `npm install -g @anthropic-ai/claude-code` |
| qmd    | —                   | —                    | —                 | —                    | —                                        | —                      | `npm install -g @tobilu/qmd`          |
| yq     | `brew install yq`   | `sudo snap install yq`| `sudo dnf install yq`| `sudo pacman -S yq`  | `winget install --id MikeFarah.yq -e`    | `choco install yq -y`  | —                                     |
| vercel | —                   | —                    | —                 | —                    | —                                        | —                      | `npm install -g vercel`               |
| hq-cli | —                   | —                    | —                 | —                    | —                                        | —                      | `npm install -g @indigoai-us/hq-cli`  |

### 3.4 Selection algorithm

```
pick_install_command(dep, platform):
  pm = (platform.packageManager == "yum") ? "dnf" : platform.packageManager
  if pm != null and dep.installCommands[pm] != null:
    return dep.installCommands[pm]
  if platform.npmAvailable and dep.installCommands["npm"] != null:
    return dep.installCommands["npm"]
  return null  # no suitable install command — show manual hint
```

### 3.5 Sudo policy

- macOS: install commands MUST NOT require `sudo`. Homebrew is the only acceptable system PM on macOS.
- Linux: commands that need `sudo` go through a GUI polkit agent in `hq-installer`; never through the TTY.
- Windows: `winget` / `choco` handle their own UAC prompts.

---

## 4. Entry Mode Selection

Sourced from `scaffold.chooseEntryMode` in `scaffold.ts`.

### 4.1 Cascade

1. "Do you have an HQ Teams account?" → if YES → `teams-existing`
2. Else "Would you like to create an HQ Teams account?" → if YES → `teams-new`
3. Else "Set up a personal HQ instead?" → if YES → `personal`
4. Else → `exit`

### 4.2 Force overrides

- `--invite <token>` or `--join <token>` forces `teams-existing` and skips prompts.
- GUI for MVP: no teams branch — the welcome screen deep-links directly into `personal` mode. A "Teams onboarding" secondary action is stubbed out with a "Coming soon — use the CLI" note.

---

## 5. Personal Mode — Step by Step

### 5.1 Dep check + install

1. Call `detect_platform()` once, cache result for the session.
2. For each dep (in the order listed in §3):
   - Run `check_cmd`. If exit 0 → mark `installed`, record version string.
   - If missing and `autoInstallable` and there is a valid command for the platform → prompt user (auto-YES for required deps, auto-NO default for optional).
   - If the user accepts → run the install command, stream stdout/stderr, re-check.
   - If re-check still fails → mark `missing`; block install for required deps, continue for optional.
3. Show a summary banner (icons: ✓ installed, ✓ new just-installed, ✗ missing, ~ skipped).

### 5.2 Target directory

- Default: `~/hq`
- Prompt allows change via native file picker in the GUI (Tauri dialog).
- If the directory exists and is non-empty, require explicit confirmation ("Overwrite?" — default NO). Confirmation is hard-blocked in the GUI until the user clicks the confirm button.

### 5.3 Cloud-existing detection

Before writing any files, check if an HQ already exists in the user's cloud backends:

| Backend | Detection                                                                 |
|---------|---------------------------------------------------------------------------|
| GitHub  | `gh repo view <user>/hq` returns success; look for `README.md` signature  |
| S3      | `HEAD s3://<bucket>/hq/` + `GET s3://<bucket>/hq/manifest.yaml` succeeds  |

If an existing HQ is found, the user gets a three-way choice:

1. **Clone existing** — clones the remote into the target dir, skips template expansion.
2. **Start fresh** — archives the remote (renames to `hq-archive-<ts>`) and proceeds with a new template.
3. **Cancel** — abort the install, return to the welcome screen.

### 5.4 Template fetch

- Source: GitHub Releases on `indigoai-us/hq` (tarball of the `template/` directory at the selected tag — default: `latest`).
- `hq-installer` embeds the template in the binary via `rust-embed` (see US-004). The embedded copy is the primary source; GitHub is only a fallback when the user explicitly chooses a non-default `--tag`.
- Nightly CI job `template-parity.yml` diffs the embedded template against the latest create-hq release tarball and opens a PR if they drift.

### 5.5 Expand into target dir

- Walk the template tree.
- For each entry, copy / write into the target dir, preserving mode bits.
- Emit a per-file-group progress event so the GUI can show a progress bar.
- Target completion: < 5 s for a standard HQ template on a modern Mac.

### 5.6 Git init + initial commit

- `git init` in the target dir.
- Check global git user config. If missing, prompt the user (GUI form; CLI uses readline). Do not `git config --global`; set the values per-repo via `git config user.name` / `git config user.email`.
- `git add -A`
- `git commit -m "Initial HQ"` (exact message — see `git.ts:gitCommit`).

### 5.7 Optional: cloud sync setup

- Prompt: "Set up cloud sync?" (default YES).
- If YES → GitHub OAuth **device flow** (no callback server). Token stored in the OS keychain via `tauri-plugin-keyring`.
- Configure the backend (GitHub remote or S3 bucket).
- Initial push / upload.

**Out of scope for MVP:** Cognito or other IdPs. Cloud sync uses GitHub OAuth device flow only.

### 5.8 Optional: hq-cli global install

- Prompt: "Install the `hq` CLI globally?" (default YES).
- Runs `npm install -g @indigoai-us/hq-cli`.
- Skipped if `--skip-cli`.

### 5.9 Optional: package discovery

- Reads `packages/registry.yaml` from the template.
- Prompts the user for each optional package (out of MVP scope for the GUI — route to CLI).

### 5.10 Next-steps banner

Final screen shows:

- Target path
- Deps installed + versions
- Cloud sync status
- Primary CTA: **Open in Claude Code** (launches `claude` in the target dir via `tauri-plugin-shell`)
- Secondary CTA: **Reveal in Finder / Show in Explorer**
- Tertiary link: **Read the USER-GUIDE** (opens `knowledge/public/hq-core/USER-GUIDE.md` in default browser)

---

## 6. Error Handling

| Error class                       | create-hq behavior         | hq-installer behavior                                              |
|-----------------------------------|----------------------------|--------------------------------------------------------------------|
| Required dep install fails        | Print warning, exit 1      | Dep row turns red, "Retry" + "Skip (advanced)" + modal dialog      |
| Optional dep install fails        | Print info, continue       | Dep row turns dim, surface in summary, continue                    |
| Template fetch network error      | Retry 3× w/ backoff, abort | Retry 3× w/ backoff, then offer "Use embedded template" fallback   |
| Target dir non-empty, no force    | Refuse, exit 1             | Modal confirm ("Overwrite?"), block until answered                 |
| Git config missing                | Prompt (readline)          | GUI form, block until filled                                       |
| Cloud backend auth fails          | Print error, offer retry   | Retry button on the cloud-sync step                                |
| Cloud existing repo found         | Interactive prompt         | Three-way choice screen (§5.3)                                     |

Unrecoverable errors panic to Sentry in `hq-installer`. The GUI shows a friendly "Something went wrong" screen with a "Copy error details" button and a "Try again" button that returns to the welcome screen without losing dep-check state.

---

## 7. Analytics Events

Emitted by both `create-hq` (if telemetry opt-in) and `hq-installer`. PostHog events:

- `install.started`
- `install.scan.completed` — `{ deps_total, deps_missing }`
- `install.dep.install.started` — `{ dep_id }`
- `install.dep.install.completed` — `{ dep_id, duration_ms }`
- `install.dep.install.failed` — `{ dep_id, error_class }`
- `install.scaffold.started`
- `install.scaffold.completed` — `{ duration_ms, file_count }`
- `install.cloud.detected` — `{ backend, exists }`
- `install.cloud.clone.completed` — `{ backend, duration_ms }`
- `install.completed` — `{ total_duration_ms, deps_installed, scaffold_method }`
- `install.abandoned` — `{ last_step, elapsed_ms }`

Distinct ID: anonymous `install_id` (UUID v4, persisted to `~/.hq-install-id` after first run). Opt-in checkbox on the welcome screen; default OFF on first launch.

---

## 8. Rust Port Constraints

The Rust core in `src-tauri/src/core/*` MUST:

1. **Not shell out to `create-hq`.** Every function is a native Rust reimplementation.
2. **Use the `which` crate** for binary detection instead of `execSync("which ...")`.
3. **Use `tokio::process::Command`** for async install runs. Stream stdout/stderr line-by-line via Tauri events so the renderer can show a live log.
4. **Expose commands via `#[tauri::command]`.** The renderer NEVER has direct FS or process access — everything bridged through commands.
5. **Match the TypeScript data shapes 1:1** via `serde`. The same `PlatformInfo`, `DepResult`, `InstallCommands` shapes serialize to JSON identically in both tools.
6. **Embed the template** via `rust-embed` or `include_dir!` — no network fetch on the happy path.

### 8.1 Module layout (target)

```
src-tauri/src/
  core/
    mod.rs
    platform.rs      # US-002 — OS + PM detection
    deps.rs          # US-003 — dep registry + selection algorithm
    runner.rs        # US-003 — async install runner w/ event streaming
    scaffold.rs      # US-004 — template expansion + git init
    cloud.rs         # US-005 — CloudBackend trait
    cloud/
      github.rs      # US-005 — GitHub backend (gh CLI + API)
      s3.rs          # US-005 — S3 backend (s3 crate, no AWS CLI dep)
  commands/
    mod.rs
    platform.rs      # #[tauri::command] detect_platform
    deps.rs          # #[tauri::command] check_deps, install_dep
    scaffold.rs      # #[tauri::command] scaffold_hq
    cloud.rs         # #[tauri::command] check_existing, clone_to
    launch.rs        # #[tauri::command] open_in_claude_code (US-009)
  main.rs            # tauri::Builder::default().invoke_handler(...)
```

---

## 9. Template Parity

See US-004 for the parity job. The contract: **embedded template and `create-hq` published tarball must be byte-equivalent** (modulo metadata files the build process injects).

The nightly `template-parity.yml` workflow:

1. `curl` the latest tarball from `https://github.com/indigoai-us/hq/releases/latest/download/template.tar.gz`
2. `diff -r` against `src-tauri/templates/hq/`
3. On drift → open a PR titled `chore: sync embedded template to <tag>`
4. PR includes the diff as the body + a link to the upstream release notes

Manual override: developers can run `scripts/check-template-parity.sh` locally to verify before committing.

---

## 10. Non-Goals (explicit)

- **Node.js auto-install.** The installer opens `https://nodejs.org` in the user's default browser and polls for availability. No bundled Node runtime, no nvm shim, no brew cast fallback.
- **Linux support for MVP.** `hq-installer` ships macOS-first. Windows follows. Linux is TBD.
- **Teams flow in GUI.** Teams mode routes to `create-hq` CLI until a Teams-shaped GUI is designed.
- **Non-GitHub/S3 cloud backends.** No Dropbox, no iCloud, no custom Git hosts.
- **Replacing `create-hq`.** The CLI stays as the developer path and CI building block. GUI is for non-technical users.

---

## Appendix A — Upstream version pin

Referenced create-hq commit range: `v10.9.0` through `v10.9.1`. When upstream ships a new release, bump the range here and verify §3, §5, §6 against the new source files.

## Appendix B — Change log

| Date       | Who                      | Change                                                                 |
|------------|--------------------------|------------------------------------------------------------------------|
| 2026-04-14 | hq-desktop-installer PRD | Initial spec, US-001. Derived from create-hq v10.9.1.                  |
