# e2e tests

End-to-end tests for hq-installer using [tauri-driver](https://v2.tauri.app/develop/tests/webdriver/) and [WebdriverIO](https://webdriver.io).

## What these cover

- **happy-path** — all deps already installed, scaffold fresh HQ, land on success, click "Open in Claude Code".
- **missing-deps** — four required deps missing, first install fails, retry succeeds, advance to location.
- **cloud-clone** — clone an existing HQ from a mocked GitHub backend, Success screen shows clone mode.

Every spec gets its own throwaway `HOME` directory under `$TMPDIR/hq-installer-e2e-<uuid>` so nothing touches the real `~/hq`.

## Running locally (macOS)

```sh
# 1. Install the Rust WebDriver bridge once.
cargo install tauri-driver --locked

# 2. Build the debug binary the tests will drive.
pnpm tauri build --debug

# 3. Run the suite.
pnpm e2e
```

The `pnpm e2e` script starts `tauri-driver` on port 4444 as a background process, runs wdio, and tears down the driver when done.

## How mocks work

The specs don't build and exercise the real Rust backends — they install a `window.__HQ_E2E__.invoke` table that the installer's TS invoke wrappers check first. Every mock returns a canned response so tests are deterministic and fast.

Handlers live in [`fixtures/mock-backends.ts`](./fixtures/mock-backends.ts). New specs should compose a mock table from the exported helpers rather than reinventing them.

## Platform support

| Platform | tauri-driver | Status |
|----------|--------------|--------|
| macOS    | WKWebView    | supported |
| Linux    | WebKitGTK    | supported |
| Windows  | —            | not supported (known gap — no Windows tauri-driver binary yet) |

CI runs on `macos-14` only.

## Troubleshooting

- **"tauri-driver: command not found"** — install it: `cargo install tauri-driver --locked`.
- **Binary missing at `src-tauri/target/debug/hq-installer`** — run `pnpm tauri build --debug` first.
- **wdio connection refused on :4444** — something else is using the port. Kill stray `tauri-driver` with `pkill -f tauri-driver`.
- **Tests hang on welcome screen** — the mock table wasn't installed before reload. Check `__HQ_E2E__.invoke` exists in devtools console.
