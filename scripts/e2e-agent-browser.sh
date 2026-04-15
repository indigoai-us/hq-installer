#!/usr/bin/env bash
# E2E harness: builds the installer with the `agent-test` feature, starts
# Vite + the prebuilt binary as *separate* backgrounded processes (skipping
# `tauri dev` entirely — it doesn't survive being backgrounded from a
# non-interactive shell), waits for the MCP server to bind, runs the Rust
# driver, then cleans everything up.
#
# Usage: bash scripts/e2e-agent-browser.sh
#
# Env:
#   AWS_PROFILE  — defaults to `indigo` (required for admin-create-user)
#   MCP_HOST     — default 127.0.0.1
#   MCP_PORT     — default 9876

set -euo pipefail

cd "$(dirname "$0")/.."

export AWS_PROFILE="${AWS_PROFILE:-indigo}"
MCP_HOST="${MCP_HOST:-127.0.0.1}"
MCP_PORT="${MCP_PORT:-9876}"

VITE_PORT=1420
VITE_LOG=/tmp/hq-installer-e2e-vite.log
BIN_LOG=/tmp/hq-installer-e2e-bin.log
BIN_PATH=src-tauri/target/debug/hq-installer

kill_port() {
  local port="$1"
  local pids
  pids=$(lsof -ti:"$port" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "▶ killing pids on :$port ($pids)"
    echo "$pids" | xargs -r kill -9 2>/dev/null || true
  fi
}

# Pre-flight: make sure nothing is holding 1420 or 9876 from a prior run.
kill_port "$VITE_PORT"
kill_port "$MCP_PORT"

VITE_PID=""
BIN_PID=""

cleanup() {
  echo "▶ cleanup"
  [ -n "$BIN_PID" ]  && kill "$BIN_PID"  2>/dev/null || true
  [ -n "$VITE_PID" ] && kill "$VITE_PID" 2>/dev/null || true
  kill_port "$VITE_PORT"
  kill_port "$MCP_PORT"
  # Belt-and-suspenders: anything we missed.
  pkill -9 -f "node .*vite.*hq-installer"   2>/dev/null || true
  pkill -9 -f "target/debug/hq-installer"   2>/dev/null || true
}
trap cleanup EXIT INT TERM

# 1. Build the binary with the agent-test feature. Foreground so cargo
#    errors surface immediately.
echo "▶ building hq-installer (agent-test feature)"
( cd src-tauri && cargo build --features agent-test )

if [ ! -x "$BIN_PATH" ]; then
  echo "✖ build produced no binary at $BIN_PATH"
  exit 1
fi

# 2. Start Vite (dev server only — no tauri wrapper).
echo "▶ starting Vite on :$VITE_PORT"
: >"$VITE_LOG"
pnpm dev >"$VITE_LOG" 2>&1 &
VITE_PID=$!

echo "▶ waiting for Vite (up to 30s)"
for _ in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:$VITE_PORT" -o /dev/null --max-time 1; then
    echo "▶ Vite up"
    break
  fi
  sleep 1
done
if ! curl -sf "http://127.0.0.1:$VITE_PORT" -o /dev/null --max-time 1; then
  echo "✖ Vite never started — last 40 lines of $VITE_LOG:"
  tail -n 40 "$VITE_LOG" || true
  exit 1
fi

# 3. Launch the prebuilt binary directly.
echo "▶ launching $BIN_PATH"
: >"$BIN_LOG"
RUST_BACKTRACE=1 "$BIN_PATH" >"$BIN_LOG" 2>&1 &
BIN_PID=$!

# 4. Wait for MCP server.
echo "▶ waiting for MCP on $MCP_HOST:$MCP_PORT (up to 60s)"
for _ in $(seq 1 60); do
  if curl -sf "http://$MCP_HOST:$MCP_PORT/sse" -o /dev/null --max-time 1; then
    echo "▶ MCP up"
    break
  fi
  # Detect early binary crash.
  if ! kill -0 "$BIN_PID" 2>/dev/null; then
    echo "✖ hq-installer died before MCP bound — last 40 lines of $BIN_LOG:"
    tail -n 40 "$BIN_LOG" || true
    exit 1
  fi
  sleep 1
done
if ! curl -sf "http://$MCP_HOST:$MCP_PORT/sse" -o /dev/null --max-time 1; then
  echo "✖ MCP never started — last 40 lines of $BIN_LOG:"
  tail -n 40 "$BIN_LOG" || true
  exit 1
fi

# 5. Run the driver.
echo "▶ running Rust driver"
cargo run --manifest-path e2e/agent-browser/Cargo.toml --release
