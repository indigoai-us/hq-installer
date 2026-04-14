# hq-installer

Native macOS installer for HQ — guided wizard with AWS Cognito auth, built on Tauri 2 + React 19 + TypeScript.

## Dev Setup

### Prerequisites

- [Rust](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) 22+
- [pnpm](https://pnpm.io/) 9+
- [Tauri CLI prerequisites](https://tauri.app/start/prerequisites/) for macOS

### Install dependencies

```bash
pnpm install
```

### Dev server (Tauri window + HMR)

```bash
pnpm tauri dev
```

This opens the native macOS window with hot reload.

## Quality Gates

All gates must pass before merging:

```bash
pnpm typecheck    # TypeScript check
pnpm lint         # ESLint
pnpm test         # Vitest unit tests
cargo check       # Rust compilation check (run from src-tauri/)
```

## Branch Workflow

- `main` — stable, tagged releases only
- `feature/*` — all development work branches off main
- Open PRs against `main`; CI must be green to merge

## Tech Stack

- **Frontend**: React 19, TypeScript, Tailwind 4
- **Backend**: Rust, Tauri 2
- **Build**: Vite 6, pnpm
- **CI**: GitHub Actions (macos-latest)
