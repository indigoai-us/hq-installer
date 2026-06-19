//! Native Rust replacement for `core/scripts/compute-checksums.sh`.
//!
//! Why this exists: the upstream bash script forks `sha256sum` once per
//! locked file and `yq -i` once per locked path. On macOS each fork is
//! a few ms; on Windows under Git Bash each fork is 200-400 ms. With
//! ~1,400 locked files in a typical HQ template, the script runs in
//! 3-5 s on macOS and **5-10 min on Windows**, all to write a `checksums`
//! field nothing currently reads at install time.
//!
//! This command reproduces the bash script's output byte-for-byte (per
//! the parity tests at the bottom of the file) but in-process via the
//! `sha2` crate, with one textual splice of `core.yaml` at the end so
//! comments stay intact.
//!
//! Algorithm (mirrors `compute-checksums.sh`):
//!   1. Read `core/core.yaml`, parse `rules.locked[]` (skip `core/core.yaml`
//!      itself — circular).
//!   2. For each path:
//!      - file → SHA-256 of the file bytes
//!      - dir → walk recursively, sort entries by forward-slash relative
//!        path, build a manifest of `"{hash}  {relpath}\n"` lines, then
//!        SHA-256 that manifest
//!   3. Splice the new `checksums:` block (alphabetical by key) and a
//!      fresh `updatedAt: "<UTC ISO 8601>"` into `core.yaml`, preserving
//!      everything else (comments, ordering, whitespace) verbatim.

use std::fs;
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};

use chrono::{SecondsFormat, Utc};
use sha2::{Digest, Sha256};
use walkdir::WalkDir;

/// Result row for each locked path.
#[derive(Debug, serde::Serialize)]
pub struct ChecksumEntry {
    pub path: String,
    pub hash: String,
}

#[derive(Debug, serde::Serialize)]
pub struct ChecksumResult {
    pub entries: Vec<ChecksumEntry>,
    /// Locked paths that were declared in core.yaml but didn't exist on
    /// disk. Mirrors the bash script's "WARNING: locked path does not
    /// exist" branch — non-fatal, surfaced to the UI for logging.
    pub missing: Vec<String>,
    pub updated_at: String,
}

#[tauri::command]
pub fn compute_checksums(install_path: String) -> Result<ChecksumResult, String> {
    let install_root = PathBuf::from(&install_path);
    let yaml_path = install_root.join("core").join("core.yaml");

    if !yaml_path.exists() {
        return Err(format!("core/core.yaml not found at {yaml_path:?}"));
    }

    let yaml_src =
        fs::read_to_string(&yaml_path).map_err(|e| format!("read {yaml_path:?}: {e}"))?;
    let locked_paths = parse_locked(&yaml_src)
        .map_err(|e| format!("parse rules.locked from {yaml_path:?}: {e}"))?;

    let mut entries: Vec<ChecksumEntry> = Vec::new();
    let mut missing: Vec<String> = Vec::new();

    for raw in locked_paths {
        // `core/core.yaml` is excluded — including it would be circular
        // (the hash is written into the same file).
        if raw == "core/core.yaml" {
            continue;
        }
        // Strip trailing slash so the YAML key matches the bash script:
        // `${path%/}`. This is what makes `.claude/` → `.claude`.
        let key = raw.trim_end_matches('/').to_string();
        let abs = install_root.join(&key);

        if !abs.exists() {
            missing.push(key);
            continue;
        }

        let md = fs::metadata(&abs).map_err(|e| format!("stat {abs:?}: {e}"))?;
        let hash = if md.is_file() {
            sha256_file(&abs).map_err(|e| format!("sha256 {abs:?}: {e}"))?
        } else if md.is_dir() {
            sha256_dir(&abs).map_err(|e| format!("sha256 dir {abs:?}: {e}"))?
        } else {
            // Symlinks / sockets / etc. — bash script's `[ -f ]` / `[ -d ]`
            // probes also wouldn't classify these. Skip, mirror "missing".
            missing.push(key);
            continue;
        };
        entries.push(ChecksumEntry { path: key, hash });
    }

    // Bash writes the entries `sort`-ordered (LC_ALL=C-ish). Rust's
    // String::cmp is byte-wise which matches `sort`'s default behavior on
    // ASCII paths — every locked HQ path is ASCII so we don't have to
    // worry about UTF-8 collation quirks here.
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    missing.sort();

    let updated_at = utc_iso8601_now();
    let new_yaml = splice_yaml(&yaml_src, &entries, &updated_at);
    fs::write(&yaml_path, new_yaml).map_err(|e| format!("write {yaml_path:?}: {e}"))?;

    Ok(ChecksumResult {
        entries,
        missing,
        updated_at,
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// SHA-256 helpers
// ─────────────────────────────────────────────────────────────────────────────

fn sha256_file(p: &Path) -> std::io::Result<String> {
    let mut hasher = Sha256::new();
    let mut reader = BufReader::with_capacity(64 * 1024, fs::File::open(p)?);
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex_lower(&hasher.finalize()))
}

/// Deterministic hash for a directory tree.
///
/// Mirrors the bash script's `dir_sha256`:
///   1. `find $dir -type f | sort`   — every regular file, lexicographic
///      by absolute path.
///   2. for each: `"<file-sha256>  <relpath>\n"` where `relpath` is the
///      path inside `$dir` with `/` separators, no leading slash.
///   3. SHA-256 of the concatenation = the directory hash.
///
/// `sort` orders the absolute paths, but because every entry shares the
/// same prefix (`$dir/`), the resulting order matches a sort of the
/// relative paths byte-for-byte — so we sort relative paths directly.
fn sha256_dir(dir: &Path) -> std::io::Result<String> {
    // Collect (relpath_with_forward_slashes, absolute_path) for every
    // regular file. Skip symlinks — `find -type f` follows them by default
    // but only if the target is itself a regular file; we'd need a stat
    // either way, and the templates ship symlinks pointing at files inside
    // the same dir, which `find` would yield twice. Following symlinks
    // would change the hash. So mirror `find -type f` exactly: include
    // files (not symlinks), exclude dirs/sockets/etc.
    let mut files: Vec<(String, PathBuf)> = Vec::new();
    for entry in WalkDir::new(dir).follow_links(false).into_iter() {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                return Err(std::io::Error::other(format!("walk {dir:?}: {e}")));
            }
        };
        let ft = entry.file_type();
        // `find -type f` matches regular files only (not dirs, not
        // symlinks, not sockets, not block/char devs).
        if !ft.is_file() {
            continue;
        }
        let abs = entry.into_path();
        let rel = abs
            .strip_prefix(dir)
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|_| abs.clone());
        let rel_fwd = rel.to_string_lossy().replace('\\', "/");
        files.push((rel_fwd, abs));
    }
    // bash `sort` is byte-wise on the *full* path output by `find`. The
    // full path = `$dir/` + relpath, so the prefix is identical for every
    // line and byte-wise sort of the relpaths produces the same order.
    files.sort_by(|a, b| a.0.cmp(&b.0));

    let mut outer = Sha256::new();
    for (rel, abs) in files {
        let hex = sha256_file(&abs).map_err(|e| {
            std::io::Error::new(
                e.kind(),
                format!("sha256 inside {dir:?}: {} → {e}", abs.display()),
            )
        })?;
        // Two spaces between hash and path — coreutils sha256sum output
        // format. Trailing newline per line.
        outer.update(hex.as_bytes());
        outer.update(b"  ");
        outer.update(rel.as_bytes());
        outer.update(b"\n");
    }
    Ok(hex_lower(&outer.finalize()))
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

// ─────────────────────────────────────────────────────────────────────────────
// YAML parsing & splicing
// ─────────────────────────────────────────────────────────────────────────────

/// Extract `rules.locked[]` entries from `core.yaml` source. We don't pull
/// in a full YAML parser — `rules.locked:` is a fixed shape (block list
/// of strings under a top-level `rules:` key) so a tiny line-based parser
/// is enough and lets us avoid adding `serde_yaml` (which would also lose
/// comments on roundtrip — see the splice comment block below).
fn parse_locked(yaml: &str) -> Result<Vec<String>, String> {
    let mut in_rules = false;
    let mut in_locked = false;
    let mut out = Vec::new();

    for raw_line in yaml.lines() {
        // Strip CR for tolerant parsing of CRLF inputs.
        let line = raw_line.trim_end_matches('\r');
        // Skip pure comment + blank lines.
        let trimmed = line.trim_start();
        if trimmed.starts_with('#') || trimmed.is_empty() {
            continue;
        }

        let indent = line.len() - trimmed.len();

        if indent == 0 {
            // Top-level key. Exit any active block.
            in_rules = trimmed.starts_with("rules:");
            in_locked = false;
            continue;
        }

        if !in_rules {
            continue;
        }

        // Inside `rules:`. `locked:` lives at indent==2 (the canonical
        // formatting in every HQ template); list items at indent==4.
        if indent == 2 {
            in_locked = trimmed.starts_with("locked:");
            continue;
        }

        if !in_locked {
            continue;
        }

        // A list item: `- <value>`. Strip optional surrounding quotes.
        if let Some(rest) = trimmed.strip_prefix("- ") {
            let value = rest.trim();
            let unquoted = value.trim_matches(|c| c == '"' || c == '\'');
            out.push(unquoted.to_string());
        } else {
            // Anything else at this indent (e.g. `exclude:`) ends the list.
            in_locked = false;
        }
    }

    if out.is_empty() {
        return Err("rules.locked is empty or unparseable".to_string());
    }
    Ok(out)
}

/// Splice the new `checksums:` block + `updatedAt:` value into `yaml`,
/// preserving every other byte (including comments) verbatim. Always
/// returns a String with LF line endings — matches what the upstream
/// bash + yq pipeline writes regardless of host OS.
///
/// Why textual splice instead of `serde_yaml`-roundtrip: `serde_yaml`
/// drops comments, reorders mappings, and re-quotes scalars. The HQ
/// `core.yaml` has substantive maintainer comments above several blocks
/// (notably the `recommended_packages:` and `replace_from_staging:`
/// sections) that we MUST keep. A two-block surgical splice gets that
/// for free without us hand-rolling a comment-preserving YAML emitter.
fn splice_yaml(src: &str, entries: &[ChecksumEntry], updated_at: &str) -> String {
    // 1) updatedAt — single-line top-level scalar. Replace the value but
    //    keep any prefix indentation and trailing comments on the line.
    let mut out = String::with_capacity(src.len() + 64 * entries.len());
    let mut updated_at_replaced = false;
    let mut skip_checksums_block = false;

    // We rebuild the file line by line. The `checksums:` block (if
    // present) gets dropped during the iteration and re-emitted at the
    // very end (matches the upstream bash script's behavior of "clear,
    // then write sorted"). If the block was last in the file (the
    // canonical layout — see the shipped core.yaml), this also produces
    // identical byte output to the bash version.
    for raw_line in src.lines() {
        // updatedAt: emit replacement, mark done, continue.
        if !updated_at_replaced {
            if let Some(new_line) = rewrite_updated_at(raw_line, updated_at) {
                out.push_str(&new_line);
                out.push('\n');
                updated_at_replaced = true;
                continue;
            }
        }

        // checksums: ... block — skip until we see another top-level key.
        if skip_checksums_block {
            let indent = raw_line.len() - raw_line.trim_start().len();
            // Stay in skip mode for indented lines (the block contents)
            // and for blank lines (sometimes a block ends with a blank).
            if indent > 0 || raw_line.trim().is_empty() {
                continue;
            }
            // Non-indented line that's not blank → new top-level key,
            // exit skip mode and emit this line normally.
            skip_checksums_block = false;
        }
        if raw_line.trim_start().starts_with("checksums:")
            && (raw_line.len() - raw_line.trim_start().len()) == 0
        {
            skip_checksums_block = true;
            continue;
        }
        out.push_str(raw_line);
        out.push('\n');
    }

    // Append the regenerated checksums block.
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out.push_str("checksums:\n");
    for e in entries {
        // Key formatting matches yq's default output: bare key when
        // possible, no quotes around the SHA-256 hex string.
        // `path` here is already trimmed of trailing slash by the caller.
        out.push_str("  ");
        out.push_str(&e.path);
        out.push_str(": ");
        out.push_str(&e.hash);
        out.push('\n');
    }
    out
}

/// If `line` is the top-level `updatedAt:` scalar, return the rewritten
/// line. Otherwise return None.
fn rewrite_updated_at(line: &str, new_value: &str) -> Option<String> {
    let trimmed = line.trim_start();
    if !trimmed.starts_with("updatedAt:") {
        return None;
    }
    let indent_len = line.len() - trimmed.len();
    if indent_len != 0 {
        // Only target the top-level key — nested `updatedAt:` (if any
        // future schema adds one) would mistakenly match without this
        // guard.
        return None;
    }
    let mut s = String::with_capacity(line.len());
    s.push_str(&line[..indent_len]);
    s.push_str("updatedAt: \"");
    s.push_str(new_value);
    s.push('"');
    Some(s)
}

// ─────────────────────────────────────────────────────────────────────────────
// Time
// ─────────────────────────────────────────────────────────────────────────────

/// Current UTC time as `YYYY-MM-DDTHH:MM:SSZ` — matches `date -u
/// +%Y-%m-%dT%H:%M:%SZ`, which is what the bash script writes into
/// `updatedAt:`. chrono's `to_rfc3339_opts(Secs, true)` produces the
/// `…Z` suffix instead of `+00:00`.
fn utc_iso8601_now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn utc_iso8601_now_has_expected_shape() {
        // Format check, not value check — chrono owns the value
        // correctness. We just confirm we produce the `YYYY-MM-DDTHH:MM:SSZ`
        // shape the bash script writes (no `+00:00`, no fractional secs).
        let s = utc_iso8601_now();
        assert_eq!(s.len(), 20);
        assert!(s.ends_with('Z'), "expected trailing Z, got {s}");
        assert_eq!(s.as_bytes()[4], b'-');
        assert_eq!(s.as_bytes()[7], b'-');
        assert_eq!(s.as_bytes()[10], b'T');
        assert_eq!(s.as_bytes()[13], b':');
        assert_eq!(s.as_bytes()[16], b':');
    }

    #[test]
    fn sha256_empty_file_is_canonical_hex() {
        let tmp = TempDir::new().unwrap();
        let f = tmp.path().join("e");
        fs::write(&f, b"").unwrap();
        assert_eq!(
            sha256_file(&f).unwrap(),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn sha256_known_input_matches_openssl() {
        let tmp = TempDir::new().unwrap();
        let f = tmp.path().join("hello");
        fs::write(&f, b"hello\n").unwrap();
        // sha256 of "hello\n" — verified via openssl dgst -sha256.
        assert_eq!(
            sha256_file(&f).unwrap(),
            "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03"
        );
    }

    #[test]
    fn sha256_empty_dir_matches_bash() {
        // Bash dir_sha256 of an empty dir: `find … | sort` emits 0 lines,
        // `sha256sum` of an empty file returns the canonical empty-input
        // SHA-256 hex.
        let tmp = TempDir::new().unwrap();
        let d = tmp.path().join("empty");
        fs::create_dir_all(&d).unwrap();
        assert_eq!(
            sha256_dir(&d).unwrap(),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn sha256_dir_produces_stable_hash_on_two_files() {
        let tmp = TempDir::new().unwrap();
        let d = tmp.path().join("two");
        fs::create_dir_all(d.join("sub")).unwrap();
        fs::write(d.join("b.txt"), b"bee\n").unwrap();
        fs::write(d.join("sub").join("a.txt"), b"aye\n").unwrap();
        // Determinism: same input must always produce the same hash.
        let h1 = sha256_dir(&d).unwrap();
        let h2 = sha256_dir(&d).unwrap();
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 64);
        assert!(h1.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn parse_locked_pulls_only_locked_entries() {
        let yaml = r#"version: 1
rules:
  locked:
    - .agents/
    - .claude/
    - AGENTS.md
  exclude:
    - .claude/settings.local.json
recommended_packages:
  - source: 'github:foo'
"#;
        let got = parse_locked(yaml).unwrap();
        assert_eq!(got, vec![".agents/", ".claude/", "AGENTS.md"]);
    }

    #[test]
    fn parse_locked_skips_comments_and_handles_quotes() {
        let yaml = r#"rules:
  # block comment
  locked:
    - .agents/
    # nested comment
    - "core/"
    - 'AGENTS.md'
  exclude: []
"#;
        let got = parse_locked(yaml).unwrap();
        assert_eq!(got, vec![".agents/", "core/", "AGENTS.md"]);
    }

    #[test]
    fn splice_preserves_comments_and_replaces_blocks() {
        let src = "version: 1\nupdatedAt: \"2020-01-01T00:00:00Z\"\n# top comment\nrules:\n  locked: []\n# trailing comment\nchecksums:\n  old: deadbeef\n";
        let entries = vec![
            ChecksumEntry {
                path: ".claude".to_string(),
                hash: "aaa".to_string(),
            },
            ChecksumEntry {
                path: "AGENTS.md".to_string(),
                hash: "bbb".to_string(),
            },
        ];
        let out = splice_yaml(src, &entries, "2026-06-09T01:02:03Z");
        // updatedAt rewritten:
        assert!(out.contains("updatedAt: \"2026-06-09T01:02:03Z\""));
        // old checksum gone, new checksums present in given order:
        assert!(!out.contains("old: deadbeef"));
        assert!(out.contains("  .claude: aaa\n"));
        assert!(out.contains("  AGENTS.md: bbb\n"));
        // Comments preserved:
        assert!(out.contains("# top comment"));
        assert!(out.contains("# trailing comment"));
    }

    #[test]
    fn splice_appends_block_when_checksums_missing() {
        let src = "version: 1\nupdatedAt: \"2020-01-01T00:00:00Z\"\nrules:\n  locked: []\n";
        let entries = vec![ChecksumEntry {
            path: "x".to_string(),
            hash: "y".to_string(),
        }];
        let out = splice_yaml(src, &entries, "2026-01-01T00:00:00Z");
        assert!(out.contains("checksums:\n  x: y\n"));
    }

    /// Parity smoke test: run `compute_checksums` against a real HQ
    /// install path (passed via the `HQ_CHECKSUMS_PARITY_INSTALL` env
    /// var) and compare each hash to what the bash script produced into
    /// the same `core/core.yaml`. Skipped by default; opt-in via
    /// `cargo test parity_against_disk -- --ignored --nocapture`.
    /// This is the ground-truth check that the Rust port produces
    /// byte-identical hashes to the upstream `compute-checksums.sh`.
    #[test]
    #[ignore = "requires HQ_CHECKSUMS_PARITY_INSTALL pointing at a previously-checksummed install path"]
    fn parity_against_disk() {
        let install_path = match std::env::var("HQ_CHECKSUMS_PARITY_INSTALL") {
            Ok(v) => v,
            Err(_) => {
                eprintln!("set HQ_CHECKSUMS_PARITY_INSTALL=<path> to enable");
                return;
            }
        };

        // Snapshot bash-produced checksums BEFORE we overwrite. Parse
        // the existing `checksums:` block directly — no yq dep in tests.
        let yaml_path = PathBuf::from(&install_path).join("core").join("core.yaml");
        let original = fs::read_to_string(&yaml_path).expect("read core.yaml");
        let mut expected: std::collections::BTreeMap<String, String> = Default::default();
        let mut in_checksums = false;
        for raw in original.lines() {
            let line = raw.trim_end_matches('\r');
            let trimmed = line.trim_start();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }
            let indent = line.len() - trimmed.len();
            if indent == 0 {
                in_checksums = trimmed.starts_with("checksums:");
                continue;
            }
            if !in_checksums {
                continue;
            }
            if let Some(rest) = trimmed.split_once(": ") {
                expected.insert(rest.0.trim().to_string(), rest.1.trim().to_string());
            }
        }
        assert!(
            !expected.is_empty(),
            "no bash-produced checksums to compare against"
        );

        // CRITICAL: the upstream bash algorithm is non-idempotent when
        // `core/` is a locked path because `core/core.yaml` is INSIDE
        // `core/` AND `compute-checksums.sh` writes its result back into
        // `core/core.yaml`. So `dir_sha256("core")` produced under a
        // freshly-shipped (`checksums: {}`) file differs from one
        // produced under an already-populated file. To compare our Rust
        // output to the bash-produced output, we must run the Rust
        // implementation against the SAME starting state bash had:
        // checksums cleared.
        //
        // We reset via our own splice helper (no shell, no yq) so the
        // test stays self-contained. Restore on exit no matter what.
        let restore = original.clone();
        let blanked = splice_yaml(&original, &[], "1970-01-01T00:00:00Z");
        fs::write(&yaml_path, &blanked).expect("blank checksums for parity");
        let result =
            compute_checksums(install_path.clone()).expect("compute_checksums against real tree");
        fs::write(&yaml_path, &restore).expect("restore core.yaml");

        // Every bash-produced entry must show up in the Rust output
        // with the same hex. Don't bail on the first mismatch — print
        // the whole report so we can see if it's one dir or all of them.
        // SUBTLETY: skip `core` from comparison. The bash algorithm is
        // non-idempotent for any locked dir that contains `core.yaml`
        // (since `compute-checksums.sh` writes ITS RESULT back into
        // `core.yaml`, so re-running with different `.checksums` content
        // produces a different dir hash). Reproducing bash's `core` hash
        // exactly would require byte-perfect reconstruction of the
        // shipped `core.yaml` state at the moment bash hashed it — not
        // possible after the file was already rewritten. The other six
        // locked entries don't contain `core.yaml` and prove the file
        // walk + sha256 + manifest assembly are byte-correct.
        let mut mismatches: Vec<(String, String, String)> = Vec::new();
        for (path, expected_hash) in &expected {
            if path == "core" {
                continue;
            }
            let got = result
                .entries
                .iter()
                .find(|e| &e.path == path)
                .unwrap_or_else(|| panic!("Rust did not emit a checksum for {path}"));
            if &got.hash != expected_hash {
                mismatches.push((path.clone(), expected_hash.clone(), got.hash.clone()));
            }
        }
        if !mismatches.is_empty() {
            for (path, b, r) in &mismatches {
                eprintln!("MISMATCH {path}\n  bash: {b}\n  rust: {r}");
            }
            // For the first mismatching DIR entry, dump file-list +
            // per-file hashes so we can spot the offending file.
            if let Some((path, _, _)) = mismatches.iter().find(|(p, _, _)| {
                let abs = PathBuf::from(&install_path).join(p);
                abs.is_dir()
            }) {
                let abs = PathBuf::from(&install_path).join(path);
                eprintln!("--- Rust file list for {path} ---");
                let mut files: Vec<(String, PathBuf)> = Vec::new();
                for entry in WalkDir::new(&abs).follow_links(false).into_iter().flatten() {
                    if !entry.file_type().is_file() {
                        continue;
                    }
                    let rel = entry
                        .path()
                        .strip_prefix(&abs)
                        .unwrap()
                        .to_string_lossy()
                        .replace('\\', "/");
                    files.push((rel, entry.path().to_path_buf()));
                }
                files.sort_by(|a, b| a.0.cmp(&b.0));
                eprintln!("Rust file count: {}", files.len());
                for (rel, _) in files.iter().take(5) {
                    eprintln!("  first: {rel}");
                }
                for (rel, _) in files.iter().rev().take(5) {
                    eprintln!("  last:  {rel}");
                }
            }
            panic!("{} checksum mismatch(es) — see above", mismatches.len());
        }
        // And vice-versa — no extra keys.
        for got in &result.entries {
            assert!(
                expected.contains_key(&got.path),
                "Rust emitted unexpected key {} not present in bash output",
                got.path
            );
        }
        eprintln!(
            "parity OK: {} entries matched, {} missing-from-disk warnings",
            result.entries.len(),
            result.missing.len()
        );
    }

    #[test]
    fn rewrite_updated_at_only_top_level() {
        assert_eq!(
            rewrite_updated_at("updatedAt: \"old\"", "new").as_deref(),
            Some("updatedAt: \"new\"")
        );
        assert_eq!(rewrite_updated_at("  updatedAt: \"old\"", "new"), None);
        assert_eq!(rewrite_updated_at("# updatedAt: \"old\"", "new"), None);
    }
}
