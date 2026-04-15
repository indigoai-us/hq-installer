# hq-installer

**Native desktop installer for [HQ by Indigo](https://github.com/indigoai-us/hq)** — a Tauri 2 + React 19 wizard that installs HQ end-to-end for non-technical users. Zero terminal required.

Full feature parity with the [`create-hq`](https://www.npmjs.com/package/create-hq) CLI: OS-aware dependency install, HQ scaffold, cloud sync, git init — wrapped in a retro-TUI-inspired GUI.

## Who is this for?

| You are | Use |
|---------|-----|
| A developer comfortable with `npm` and a terminal | **`npx create-hq`** — faster, scriptable, the same semantics |
| A non-technical user | **Download the installer DMG** from the [Releases page](https://github.com/indigoai-us/hq-installer/releases) |
| A team onboarder (first-time HQ user) | **Download the installer DMG** — guided wizard, no terminal |

## Architecture — fork & share

`hq-installer` is a **Rust port** of `create-hq` (TypeScript CLI) wrapped in a [Tauri 2](https://tauri.app) desktop app. It lives as a **standalone repo** (not inside `indigo-nx`) for three reasons:

1. **Isolated release cadence.** DMG builds are driven by tag pushes here. The main monorepo ships whenever it ships.
2. **Isolated Rust + macOS signing CI.** Rust toolchain, Xcode, and Apple notarization credentials only matter to this repo.
3. **Public source for trust + provenance.** Non-technical users are downloading signed binaries; an auditable public repo is table stakes.

### Fork & share contract

The behavior contract between `create-hq` (CLI) and `hq-installer` (GUI) is pinned in
[`docs/hq-install-spec.md`](docs/hq-install-spec.md). Both tools must produce equivalent
results for equivalent inputs — **divergence is a bug**.

Template parity is enforced by a nightly CI job (see [US-004](../hq/companies/indigo/projects/hq-desktop-installer/prd.json)) that diffs the embedded HQ template against the latest `create-hq` release tarball and opens a PR on drift.

```
┌──────────────────────────┐      ┌─────────────────────────────┐
│  indigoai-us/hq          │      │  indigoai-us/hq-installer   │
│  (TypeScript monorepo)   │      │  (this repo — Rust + React) │
│                          │      │                             │
│  packages/create-hq/     │─────▶│  docs/hq-install-spec.md    │
│    src/platform.ts       │ spec │  ── canonical behavior ──   │
│    src/deps.ts           │─────▶│                             │
│    src/scaffold.ts       │      │  src-tauri/src/core/        │
│    src/cloud-sync.ts     │      │    platform.rs              │
│                          │      │    deps.rs                  │
│  template/               │─────▶│    scaffold.rs              │
│    (canonical HQ content)│embed │    cloud.rs                 │
│                          │      │  src-tauri/templates/hq/    │
│  Published as            │      │    (embedded via rust-embed)│
│  npx create-hq           │      │                             │
│                          │      │  Published as signed DMG    │
└──────────────────────────┘      └─────────────────────────────┘
```

## Dev setup

### Prerequisites

- [Rust](https://rustup.rs/) (stable — `rustc 1.80+`)
- [Node.js](https://nodejs.org/) 22+
- [pnpm](https://pnpm.io/) 9+
- [Tauri macOS prerequisites](https://tauri.app/start/prerequisites/) (Xcode Command Line Tools)

### Install

```bash
pnpm install
```

### Dev server

```bash
pnpm tauri dev
```

Opens the native macOS window with Vite HMR wired to the Rust shell. First run compiles the Rust side, which can take a minute.

### Production build (unsigned)

```bash
pnpm tauri build
```

Produces an unsigned `.dmg` in `src-tauri/target/release/bundle/dmg/`. Signing and notarization are handled by the release pipeline (see `US-010` in the project PRD).

## Quality gates

All gates must pass before a PR can merge:

```bash
pnpm typecheck    # TypeScript
pnpm lint         # ESLint
pnpm test         # Vitest unit + story tests
cargo test --manifest-path src-tauri/Cargo.toml   # Rust
```

CI (`.github/workflows/ci.yml`) runs the same suite on `macos-latest` on every PR.

## Branch workflow

- `main` — stable, tagged releases only
- `feature/*` — all development work branches off main; open PRs against main
- CI must be green to merge
- Releases are cut by pushing a `v*` tag on `main`, which triggers the signed-DMG workflow (US-010)

## Tech stack

- **Frontend:** React 19, TypeScript 5.6, [Tailwind 4](https://tailwindcss.com), [shadcn/ui](https://ui.shadcn.com) (zinc theme, monochrome dark)
- **Backend:** Rust (stable), [Tauri 2](https://tauri.app), [tokio](https://tokio.rs), [rust-embed](https://crates.io/crates/rust-embed)
- **Build:** [Vite 6](https://vitejs.dev), pnpm
- **CI:** GitHub Actions on `macos-latest`
- **Release:** tag-driven builds → Apple-notarized DMG → GitHub Releases

## Project spec

This repo implements the 12-story PRD at
`companies/indigo/projects/hq-desktop-installer/prd.json` in the HQ monorepo.
Key documents:

- [`docs/hq-install-spec.md`](docs/hq-install-spec.md) — canonical install behavior contract
- [`LICENSE`](LICENSE) — MIT
- [`.github/workflows/ci.yml`](.github/workflows/ci.yml) — PR quality gates

## License

MIT — see [LICENSE](LICENSE). Built by [Indigo AI](https://github.com/indigoai-us).
