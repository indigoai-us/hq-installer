// commands/directory.rs — US-015
//
// Native folder picker + HQ marker detection.
//
// `pick_directory` opens an NSOpenPanel via tauri-plugin-dialog and returns
// the selected absolute path (or null on cancel). It is an ASYNC Tauri
// command that drives the non-blocking `pick_folder(callback)` API and
// bridges the result via a oneshot channel. This is the macOS-safe pattern:
// `blocking_pick_folder` on macOS requires the AppKit main thread, and when
// called from a sync command worker thread it deadlocks — particularly after
// the user moves focus away from the app window.
//
// `detect_hq` returns whether the supplied path exists and whether it looks
// like an HQ install. The marker check is intentionally loose: the presence
// of `companies/manifest.yaml` OR `.claude/CLAUDE.md` is enough to call it HQ.
// Server-side per the test contract (06-directory.test.tsx) — frontend MUST
// NOT do inline file checks.

use std::path::PathBuf;

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use tokio::sync::oneshot;

/// Expand a leading `~/` or bare `~` into `$HOME`. Falls back to the literal
/// string if `$HOME` is not set, which on macOS effectively never happens.
fn expand_tilde(s: &str) -> PathBuf {
    if s == "~" {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home);
        }
    }
    if let Some(rest) = s.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(s)
}

#[tauri::command]
pub async fn pick_directory(
    app: AppHandle,
    default_path: Option<String>,
) -> Result<Option<String>, String> {
    let mut builder = app.dialog().file();

    // Seed the dialog with the suggested starting directory if it exists.
    // NSOpenPanel rejects paths that don't exist, so we silently skip them
    // rather than erroring — the user just gets the system default.
    if let Some(p) = default_path.as_deref() {
        let expanded = expand_tilde(p);
        if expanded.exists() {
            builder = builder.set_directory(expanded);
        }
    }

    // Non-blocking `pick_folder` hands the result to the supplied callback
    // on the plugin's main-thread dispatcher. We forward it through a
    // oneshot channel so this async command can await it without ever
    // blocking a worker thread on AppKit.
    let (tx, rx) = oneshot::channel();
    builder.pick_folder(move |file_path| {
        let _ = tx.send(file_path);
    });

    match rx.await {
        Ok(Some(fp)) => fp
            .into_path()
            .map(|p| Some(p.to_string_lossy().into_owned()))
            .map_err(|e| format!("invalid path returned from dialog: {e}")),
        Ok(None) => Ok(None),
        Err(_) => Err("dialog channel closed before a result was delivered".to_string()),
    }
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct ExistingCompany {
    pub slug: String,
    pub name: String,
}

#[derive(serde::Deserialize)]
struct CompanyYaml {
    slug: Option<String>,
    name: Option<String>,
}

/// Enumerate existing companies in `{hq_path}/companies/` by parsing each
/// immediate child dir's `company.yaml` for `slug` + `name`. Dirs without
/// a readable/parseable yaml — or yaml missing either field — are silently
/// skipped rather than errored. This is intentional: HQ folders may carry
/// stray subdirs (scaffolding artifacts, template skeletons), and US-001's
/// contract is best-effort enumeration, not validation.
fn enumerate_existing_companies(hq_path: &std::path::Path) -> Vec<ExistingCompany> {
    let companies_dir = hq_path.join("companies");
    let Ok(entries) = std::fs::read_dir(&companies_dir) else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for entry in entries.flatten() {
        let dir_path = entry.path();
        if !dir_path.is_dir() {
            continue;
        }
        let yaml_path = dir_path.join("company.yaml");
        let Ok(contents) = std::fs::read_to_string(&yaml_path) else {
            continue;
        };
        let Ok(parsed) = serde_yaml::from_str::<CompanyYaml>(&contents) else {
            continue;
        };
        match (parsed.slug, parsed.name) {
            (Some(slug), Some(name)) if !slug.is_empty() && !name.is_empty() => {
                out.push(ExistingCompany { slug, name });
            }
            _ => continue,
        }
    }
    // Deterministic order — directory iteration order is not guaranteed
    // across filesystems, but tests + UI benefit from stable output.
    out.sort_by(|a, b| a.slug.cmp(&b.slug));
    out
}

#[derive(Serialize)]
pub struct DetectHqResult {
    pub exists: bool,
    #[serde(rename = "isHq")]
    pub is_hq: bool,
    #[serde(rename = "existingCompanies")]
    pub existing_companies: Vec<ExistingCompany>,
}

#[tauri::command]
pub fn detect_hq(path: String) -> DetectHqResult {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return DetectHqResult {
            exists: false,
            is_hq: false,
            existing_companies: Vec::new(),
        };
    }
    // Either marker is sufficient. `companies/manifest.yaml` is the strongest
    // signal (HQ-specific); `.claude/CLAUDE.md` covers older HQ trees that
    // didn't yet ship a manifest.
    let is_hq = p.join("companies/manifest.yaml").exists()
        || p.join(".claude/CLAUDE.md").exists();
    let existing_companies = enumerate_existing_companies(&p);
    DetectHqResult {
        exists: true,
        is_hq,
        existing_companies,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn detect_hq_missing_path_returns_exists_false() {
        let r = detect_hq("/definitely/does/not/exist/9f8a7b6c".to_string());
        assert!(!r.exists);
        assert!(!r.is_hq);
    }

    #[test]
    fn detect_hq_existing_non_hq_dir() {
        let dir = tempdir().unwrap();
        let r = detect_hq(dir.path().to_string_lossy().into_owned());
        assert!(r.exists);
        assert!(!r.is_hq);
    }

    #[test]
    fn detect_hq_recognizes_manifest_marker() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join("companies")).unwrap();
        fs::write(dir.path().join("companies/manifest.yaml"), "").unwrap();
        let r = detect_hq(dir.path().to_string_lossy().into_owned());
        assert!(r.exists);
        assert!(r.is_hq);
    }

    #[test]
    fn detect_hq_recognizes_claude_marker() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join(".claude")).unwrap();
        fs::write(dir.path().join(".claude/CLAUDE.md"), "").unwrap();
        let r = detect_hq(dir.path().to_string_lossy().into_owned());
        assert!(r.exists);
        assert!(r.is_hq);
    }

    // -----------------------------------------------------------------
    // US-001: existing_companies enumeration
    // -----------------------------------------------------------------

    #[test]
    fn detect_hq_missing_path_returns_empty_companies() {
        let r = detect_hq("/definitely/does/not/exist/9f8a7b6c".to_string());
        assert!(r.existing_companies.is_empty());
    }

    #[test]
    fn detect_hq_no_companies_dir_returns_empty() {
        let dir = tempdir().unwrap();
        // Mark it as HQ via the CLAUDE.md marker so is_hq is true, but no
        // `companies/` subtree exists at all.
        fs::create_dir_all(dir.path().join(".claude")).unwrap();
        fs::write(dir.path().join(".claude/CLAUDE.md"), "").unwrap();
        let r = detect_hq(dir.path().to_string_lossy().into_owned());
        assert!(r.is_hq);
        assert!(r.existing_companies.is_empty());
    }

    #[test]
    fn detect_hq_empty_companies_dir_returns_empty() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join("companies")).unwrap();
        let r = detect_hq(dir.path().to_string_lossy().into_owned());
        assert!(r.existing_companies.is_empty());
    }

    #[test]
    fn detect_hq_enumerates_two_valid_companies() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join("companies/acme")).unwrap();
        fs::write(
            dir.path().join("companies/acme/company.yaml"),
            "slug: acme\nname: Acme\n",
        )
        .unwrap();
        fs::create_dir_all(dir.path().join("companies/beta")).unwrap();
        fs::write(
            dir.path().join("companies/beta/company.yaml"),
            "slug: beta\nname: Beta Corp\n",
        )
        .unwrap();

        let r = detect_hq(dir.path().to_string_lossy().into_owned());
        assert_eq!(
            r.existing_companies,
            vec![
                ExistingCompany {
                    slug: "acme".to_string(),
                    name: "Acme".to_string(),
                },
                ExistingCompany {
                    slug: "beta".to_string(),
                    name: "Beta Corp".to_string(),
                },
            ]
        );
    }

    #[test]
    fn detect_hq_skips_broken_yaml_without_panic() {
        let dir = tempdir().unwrap();
        // One valid company
        fs::create_dir_all(dir.path().join("companies/acme")).unwrap();
        fs::write(
            dir.path().join("companies/acme/company.yaml"),
            "slug: acme\nname: Acme\n",
        )
        .unwrap();
        // One broken yaml (unclosed bracket / invalid syntax)
        fs::create_dir_all(dir.path().join("companies/broken")).unwrap();
        fs::write(
            dir.path().join("companies/broken/company.yaml"),
            "slug: [unterminated\nname: ???:\n  - not valid",
        )
        .unwrap();
        // One dir missing company.yaml entirely
        fs::create_dir_all(dir.path().join("companies/stray")).unwrap();
        // One company.yaml missing required fields
        fs::create_dir_all(dir.path().join("companies/partial")).unwrap();
        fs::write(
            dir.path().join("companies/partial/company.yaml"),
            "description: missing slug and name\n",
        )
        .unwrap();

        let r = detect_hq(dir.path().to_string_lossy().into_owned());
        assert_eq!(
            r.existing_companies,
            vec![ExistingCompany {
                slug: "acme".to_string(),
                name: "Acme".to_string(),
            }]
        );
    }

    #[test]
    fn expand_tilde_handles_prefix() {
        std::env::set_var("HOME", "/Users/test");
        assert_eq!(expand_tilde("~/hq"), PathBuf::from("/Users/test/hq"));
        assert_eq!(expand_tilde("~"), PathBuf::from("/Users/test"));
        assert_eq!(expand_tilde("/abs/path"), PathBuf::from("/abs/path"));
    }
}
