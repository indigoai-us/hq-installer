#!/usr/bin/env bash
# check-template-parity.sh
#
# Diffs the embedded HQ template at src-tauri/templates/hq/ against the
# latest create-hq release tarball from GitHub.
#
# Exit codes:
#   0  — in sync (embedded matches latest upstream)
#   1  — drift detected (embedded differs from upstream)
#   2  — tooling / network failure (no verdict possible)
#
# Environment:
#   UPSTREAM_TAG           — Override the release tag to diff against. Default: latest.
#   TEMPLATE_TARBALL_URL   — Override the tarball URL. Default: GitHub Releases.
#   EMBEDDED_TEMPLATE_DIR  — Path to the embedded template dir. Default:
#                             src-tauri/templates/hq (relative to repo root).
#
# Usage:
#   scripts/check-template-parity.sh
#   UPSTREAM_TAG=v10.9.0 scripts/check-template-parity.sh

set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
embedded_dir="${EMBEDDED_TEMPLATE_DIR:-$repo_root/src-tauri/templates/hq}"
upstream_tag="${UPSTREAM_TAG:-latest}"
tarball_url="${TEMPLATE_TARBALL_URL:-}"

if [ ! -d "$embedded_dir" ]; then
  echo "check-template-parity: embedded template missing at $embedded_dir" >&2
  exit 2
fi

# Resolve the tarball URL if not explicitly provided.
if [ -z "$tarball_url" ]; then
  if [ "$upstream_tag" = "latest" ]; then
    tarball_url="https://github.com/indigoai-us/hq/releases/latest/download/template.tar.gz"
  else
    tarball_url="https://github.com/indigoai-us/hq/releases/download/${upstream_tag}/template.tar.gz"
  fi
fi

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

echo "check-template-parity: upstream = $tarball_url"
echo "check-template-parity: embedded = $embedded_dir"

if ! curl -fsSL "$tarball_url" -o "$work_dir/template.tar.gz"; then
  echo "check-template-parity: failed to download $tarball_url" >&2
  echo "check-template-parity: treating as tooling failure (exit 2)" >&2
  exit 2
fi

mkdir "$work_dir/upstream"
if ! tar -xzf "$work_dir/template.tar.gz" -C "$work_dir/upstream"; then
  echo "check-template-parity: failed to extract tarball" >&2
  exit 2
fi

# The tarball may or may not have a top-level dir — normalize.
upstream_root="$work_dir/upstream"
if [ "$(ls "$upstream_root" | wc -l)" -eq 1 ]; then
  only="$(ls "$upstream_root")"
  if [ -d "$upstream_root/$only" ]; then
    upstream_root="$upstream_root/$only"
  fi
fi

# Full recursive diff, ignoring a small set of expected metadata drift.
diff_out="$work_dir/diff.txt"
if diff -r \
  --exclude='.DS_Store' \
  --exclude='.git' \
  "$embedded_dir" "$upstream_root" > "$diff_out"; then
  echo "check-template-parity: OK — embedded template matches upstream $upstream_tag"
  exit 0
fi

echo "check-template-parity: DRIFT detected against $upstream_tag"
echo "----- diff -----"
cat "$diff_out"
echo "----- /diff -----"
exit 1
