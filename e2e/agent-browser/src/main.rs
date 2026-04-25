//! hq-installer E2E driver — drives the 11-screen wizard via agent-browser MCP.
//!
//! Prerequisites (all enforced at runtime — fail fast if missing):
//!   - `pnpm tauri:agent` running in another terminal (MCP on 127.0.0.1:9876).
//!   - `AWS_PROFILE` set (defaults to `indigo`) and `aws` on PATH.
//!   - `VITE_COGNITO_USER_POOL_ID` set (defaults to dev2 pool).
//!
//! Outputs:
//!   - `e2e/agent-browser/artifacts/{run-ts}/{screen-id}.png`
//!   - Exit 0 on success; non-zero with anyhow chain on failure.

use std::path::PathBuf;
use std::time::Duration;

use agent_browser_provider_tauri::TauriProvider;
use anyhow::{anyhow, bail, Context, Result};
use base64::Engine;
use chrono::Utc;
use rand::{distributions::Alphanumeric, Rng};
use serde::Deserialize;
use tokio::process::Command;
use tokio::time::sleep;

// ---------------------------------------------------------------------------
// Config (env-driven; all have sensible dev2 defaults)
// ---------------------------------------------------------------------------

const DEFAULT_POOL_ID: &str = "us-east-1_fOMM6hDMZ";
const MCP_HOST: &str = "127.0.0.1";
const MCP_PORT: u16 = 9876;

// ---------------------------------------------------------------------------
// Snapshot deserialization (mirrors shared::mcp::AccessibilityNode, but kept
// local so we don't need to pull in the `shared` crate as a dep)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct Node {
    #[serde(rename = "ref")]
    element_ref: RefId,
    #[allow(dead_code)]
    #[serde(default)]
    element_type: String,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    interactive: bool,
    #[serde(default)]
    children: Vec<Node>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum RefId {
    // The plugin's ElementRef is a tuple struct `ElementRef(String)`, which
    // serde serializes either as a bare string or a single-element sequence
    // depending on feature flags. Accept both.
    Plain(String),
    Tuple((String,)),
}

impl RefId {
    fn as_str(&self) -> &str {
        match self {
            RefId::Plain(s) => s.as_str(),
            RefId::Tuple(t) => t.0.as_str(),
        }
    }
}

#[derive(Debug, Deserialize)]
struct ScreenFixture {
    id: String,
    assert_text: String,
    cta_text: String,
    advance_timeout_secs: u64,
}

#[derive(Debug, Deserialize)]
struct Fixtures {
    screens: Vec<ScreenFixture>,
}

// ---------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------

/// Flatten a tree into a Vec for easy iteration.
fn flatten<'a>(node: &'a Node, out: &mut Vec<&'a Node>) {
    out.push(node);
    for child in &node.children {
        flatten(child, out);
    }
}

/// Find the first interactive node whose text contains `needle` (case-insensitive).
fn find_ref_by_text<'a>(root: &'a Node, needle: &str) -> Option<&'a Node> {
    let needle_lc = needle.to_lowercase();
    let mut all = Vec::new();
    flatten(root, &mut all);
    all.into_iter().find(|n| {
        n.interactive
            && n.text
                .as_deref()
                .map(|t| t.to_lowercase().contains(&needle_lc))
                .unwrap_or(false)
    })
}

/// Check whether any node in the tree has text containing `needle`.
fn tree_contains(root: &Node, needle: &str) -> bool {
    let needle_lc = needle.to_lowercase();
    let mut all = Vec::new();
    flatten(root, &mut all);
    all.into_iter().any(|n| {
        n.text
            .as_deref()
            .map(|t| t.to_lowercase().contains(&needle_lc))
            .unwrap_or(false)
    })
}

async fn take_snapshot(provider: &TauriProvider) -> Result<Node> {
    let out = provider
        .snapshot(false)
        .await
        .context("snapshot() call failed")?;
    if out.is_error {
        bail!("snapshot returned is_error: {}", out.text);
    }
    serde_json::from_str::<Node>(&out.text)
        .with_context(|| format!("snapshot JSON parse failed: {}", out.text))
}

/// Poll `check(snapshot)` until it returns true or the deadline expires.
async fn wait_for<F>(provider: &TauriProvider, timeout: Duration, mut check: F) -> Result<Node>
where
    F: FnMut(&Node) -> bool,
{
    let start = std::time::Instant::now();
    loop {
        let snap = take_snapshot(provider).await?;
        if check(&snap) {
            return Ok(snap);
        }
        if start.elapsed() >= timeout {
            bail!("timed out after {:?} waiting for condition", timeout);
        }
        sleep(Duration::from_millis(500)).await;
    }
}

// ---------------------------------------------------------------------------
// Screenshot
// ---------------------------------------------------------------------------

async fn save_screenshot(
    provider: &TauriProvider,
    artifacts_dir: &PathBuf,
    name: &str,
) -> Result<()> {
    let out = provider.screenshot().await.context("screenshot failed")?;
    let b64 = out
        .image_base64
        .ok_or_else(|| anyhow!("screenshot returned no image_base64"))?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.as_bytes())
        .context("screenshot base64 decode failed")?;
    let path = artifacts_dir.join(format!("{name}.png"));
    tokio::fs::write(&path, bytes)
        .await
        .with_context(|| format!("write {}", path.display()))?;
    println!("  📸 {}", path.display());
    Ok(())
}

// ---------------------------------------------------------------------------
// Cognito test user management (shells out to aws CLI)
// ---------------------------------------------------------------------------

async fn aws(args: &[&str]) -> Result<()> {
    let status = Command::new("aws")
        .args(args)
        .status()
        .await
        .with_context(|| format!("spawn aws {:?}", args))?;
    if !status.success() {
        bail!("aws command failed: aws {}", args.join(" "));
    }
    Ok(())
}

async fn create_test_user(pool_id: &str, email: &str, password: &str) -> Result<()> {
    println!("👤 Creating test user {email}");
    aws(&[
        "cognito-idp",
        "admin-create-user",
        "--user-pool-id",
        pool_id,
        "--username",
        email,
        "--message-action",
        "SUPPRESS",
        "--user-attributes",
        &format!("Name=email,Value={email}"),
        "Name=email_verified,Value=true",
    ])
    .await?;
    aws(&[
        "cognito-idp",
        "admin-set-user-password",
        "--user-pool-id",
        pool_id,
        "--username",
        email,
        "--password",
        password,
        "--permanent",
    ])
    .await?;
    Ok(())
}

async fn delete_test_user(pool_id: &str, email: &str) -> Result<()> {
    println!("🧹 Deleting test user {email}");
    aws(&[
        "cognito-idp",
        "admin-delete-user",
        "--user-pool-id",
        pool_id,
        "--username",
        email,
    ])
    .await
}

fn gen_password() -> String {
    // Cognito default policy: >=8 chars, upper+lower+digit+symbol
    let rnd: String = rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(12)
        .map(char::from)
        .collect();
    format!("Aa1!{rnd}")
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------

#[tokio::main]
async fn main() -> Result<()> {
    let pool_id =
        std::env::var("VITE_COGNITO_USER_POOL_ID").unwrap_or_else(|_| DEFAULT_POOL_ID.to_string());
    let ts = Utc::now().format("%Y%m%dT%H%M%S").to_string();
    let email = format!("hq-installer-e2e+{ts}@indigo.ai");
    let password = gen_password();

    let artifacts_dir = PathBuf::from(format!("e2e/agent-browser/artifacts/{ts}"));
    tokio::fs::create_dir_all(&artifacts_dir)
        .await
        .context("create artifacts dir")?;
    println!("📁 Artifacts: {}", artifacts_dir.display());

    // 1. Pre-flight: create throwaway user
    create_test_user(&pool_id, &email, &password).await?;

    // Run the screen loop, but always try to clean up the user afterward.
    let result = run_wizard(&artifacts_dir, &email, &password).await;

    if let Err(e) = delete_test_user(&pool_id, &email).await {
        eprintln!("⚠️  user cleanup failed: {e:#}");
    }

    result
}

async fn run_wizard(artifacts_dir: &PathBuf, email: &str, password: &str) -> Result<()> {
    // 2. Load fixtures
    let fixtures_path = PathBuf::from("e2e/agent-browser/fixtures/expected-screens.json");
    let fixtures_raw = tokio::fs::read_to_string(&fixtures_path)
        .await
        .with_context(|| format!("read {}", fixtures_path.display()))?;
    let fixtures: Fixtures = serde_json::from_str(&fixtures_raw).context("parse fixtures JSON")?;

    // 3. Connect to MCP server
    println!("🔌 Connecting to MCP {}:{}", MCP_HOST, MCP_PORT);
    let mut provider = TauriProvider::new(MCP_HOST, MCP_PORT);
    provider
        .connect()
        .await
        .context("failed to connect — is `pnpm tauri:agent` running?")?;

    // 4. Screen 01 — Welcome → Get Started
    println!("▶  screen 01 — welcome");
    let snap = wait_for(&provider, Duration::from_secs(15), |n| {
        tree_contains(n, "Set up HQ")
    })
    .await
    .context("screen 01 did not load")?;
    save_screenshot(&provider, artifacts_dir, "01-welcome").await?;
    let start_btn = find_ref_by_text(&snap, "Get Started")
        .ok_or_else(|| anyhow!("screen 01: no 'Get Started' button"))?;
    provider
        .click(start_btn.element_ref.as_str())
        .await
        .context("click Get Started")?;

    // 5. Screen 02 — Sign in
    println!("▶  screen 02 — sign in");
    let snap = wait_for(&provider, Duration::from_secs(15), |n| {
        tree_contains(n, "Create your account")
    })
    .await
    .context("screen 02 did not load")?;
    save_screenshot(&provider, artifacts_dir, "02-cognito-auth").await?;

    let email_input =
        find_ref_by_text(&snap, "Email").ok_or_else(|| anyhow!("screen 02: no Email input"))?;
    provider
        .fill(email_input.element_ref.as_str(), email)
        .await
        .context("fill Email")?;

    // Re-snapshot so Password input is still addressable (refs are stable, but
    // belt-and-suspenders in case anything re-rendered).
    let snap = take_snapshot(&provider).await?;
    let pw_input = find_ref_by_text(&snap, "Password")
        .ok_or_else(|| anyhow!("screen 02: no Password input"))?;
    provider
        .fill(pw_input.element_ref.as_str(), password)
        .await
        .context("fill Password")?;

    let snap = take_snapshot(&provider).await?;
    let signin_btn = find_ref_by_text(&snap, "Sign in")
        .ok_or_else(|| anyhow!("screen 02: no Sign in button"))?;
    provider
        .click(signin_btn.element_ref.as_str())
        .await
        .context("click Sign in")?;

    // 6. Screens 03–11
    for fixture in &fixtures.screens {
        println!("▶  screen {}", fixture.id);
        let timeout = Duration::from_secs(fixture.advance_timeout_secs);
        wait_for(&provider, timeout, |n| {
            tree_contains(n, &fixture.assert_text)
        })
        .await
        .with_context(|| {
            format!(
                "screen {} never showed '{}'",
                fixture.id, fixture.assert_text
            )
        })?;
        save_screenshot(&provider, artifacts_dir, &fixture.id).await?;

        if fixture.cta_text.is_empty() {
            // Final screen — no advance
            continue;
        }
        // Poll for the CTA: some screens show it only after async work completes.
        let cta_deadline = std::time::Instant::now() + timeout;
        let mut cta_ref: Option<String> = None;
        while std::time::Instant::now() < cta_deadline {
            let s = take_snapshot(&provider).await?;
            if let Some(btn) = find_ref_by_text(&s, &fixture.cta_text) {
                cta_ref = Some(btn.element_ref.as_str().to_string());
                break;
            }
            sleep(Duration::from_millis(750)).await;
        }
        let cta_ref = cta_ref.ok_or_else(|| {
            anyhow!(
                "screen {}: CTA '{}' never appeared",
                fixture.id,
                fixture.cta_text
            )
        })?;
        provider
            .click(&cta_ref)
            .await
            .with_context(|| format!("click CTA on {}", fixture.id))?;
    }

    // 7. Close session
    let _ = provider.close().await;
    println!("✅ all screens traversed");
    Ok(())
}
