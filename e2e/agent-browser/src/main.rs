//! hq-installer E2E driver — drives the 5-step streamlined wizard via
//! agent-browser MCP. (Renumbered in US-005..US-007.)
//!
//! Screen flow:
//!   1. Welcome ("Set up HQ" + "Get Started")
//!   2. Install ("Preparing HQ" — auto-advances after resolve_hq_path)
//!   3. Sign In ("Sign in" + "Continue with Google" — requires OAuth stub)
//!   4. Setup ("Setting up HQ" — auto-advances when every stage settles)
//!   5. Done ("HQ is ready" — terminal)
//!
//! Prerequisites (all enforced at runtime — fail fast if missing):
//!   - `pnpm tauri:agent` running in another terminal (MCP on 127.0.0.1:9876).
//!   - `HQ_E2E_OAUTH_STUB=1` in the environment, AND the running `tauri:agent`
//!     build configured to honor it. Google's real Hosted UI cannot be driven
//!     headlessly — without the stub we bail out before clicking the sign-in
//!     button rather than block forever waiting on a system-browser redirect.
//!
//! Outputs:
//!   - `e2e/agent-browser/artifacts/{run-ts}/{screen-id}.png`
//!   - Exit 0 on success; non-zero with anyhow chain on failure.
//!
//! This driver is OUT-OF-SCOPE for back-pressure: it's an interactive
//! truth-signal that requires a real Tauri build + native window. The
//! headless CI signal lives in `tests/e2e/full-walkthrough.spec.ts` and runs
//! via `pnpm e2e`.

use std::path::PathBuf;
use std::time::Duration;

use agent_browser_provider_tauri::TauriProvider;
use anyhow::{anyhow, bail, Context, Result};
use base64::Engine;
use chrono::Utc;
use serde::Deserialize;
use tokio::time::sleep;

// ---------------------------------------------------------------------------
// Config (env-driven; sensible dev defaults)
// ---------------------------------------------------------------------------

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
    #[serde(default)]
    must_not_appear: Vec<String>,
}

// ---------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------

fn flatten<'a>(node: &'a Node, out: &mut Vec<&'a Node>) {
    out.push(node);
    for child in &node.children {
        flatten(child, out);
    }
}

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
// Main flow
// ---------------------------------------------------------------------------

#[tokio::main]
async fn main() -> Result<()> {
    let ts = Utc::now().format("%Y%m%dT%H%M%S").to_string();

    let artifacts_dir = PathBuf::from(format!("e2e/agent-browser/artifacts/{ts}"));
    tokio::fs::create_dir_all(&artifacts_dir)
        .await
        .context("create artifacts dir")?;
    println!("📁 Artifacts: {}", artifacts_dir.display());

    // The Sign-In screen kicks off Google OAuth via Cognito Hosted UI. Google
    // refuses embedded webviews, so the real flow opens the system browser —
    // which an MCP-driven harness can't drive. Bail with a clear message
    // unless the `tauri:agent` build was configured with the OAuth-stub flag.
    if std::env::var("HQ_E2E_OAUTH_STUB").ok().as_deref() != Some("1") {
        bail!(
            "Google sign-in cannot be driven headlessly. Re-launch `pnpm tauri:agent` \
             with HQ_E2E_OAUTH_STUB=1 and a stubbed oauth_listen_for_code + token \
             exchange path, or run the Playwright spec instead: `pnpm e2e`."
        );
    }

    run_wizard(&artifacts_dir).await
}

async fn run_wizard(artifacts_dir: &PathBuf) -> Result<()> {
    // Load fixtures
    let fixtures_path = PathBuf::from("e2e/agent-browser/fixtures/expected-screens.json");
    let fixtures_raw = tokio::fs::read_to_string(&fixtures_path)
        .await
        .with_context(|| format!("read {}", fixtures_path.display()))?;
    let fixtures: Fixtures = serde_json::from_str(&fixtures_raw).context("parse fixtures JSON")?;

    // Connect to MCP server
    println!("🔌 Connecting to MCP {}:{}", MCP_HOST, MCP_PORT);
    let mut provider = TauriProvider::new(MCP_HOST, MCP_PORT);
    provider
        .connect()
        .await
        .context("failed to connect — is `pnpm tauri:agent` running?")?;

    // Walk the 5 screens. Each fixture asserts a heading text and, if a CTA
    // is configured, clicks it; CTA-less screens auto-advance (the install
    // step resolves ~/hq silently, setup-progress drives onNext when every
    // stage settles).
    for fixture in &fixtures.screens {
        println!("▶  screen {}", fixture.id);
        let timeout = Duration::from_secs(fixture.advance_timeout_secs);
        let snap = wait_for(&provider, timeout, |n| {
            tree_contains(n, &fixture.assert_text)
        })
        .await
        .with_context(|| {
            format!(
                "screen {} never showed '{}'",
                fixture.id, fixture.assert_text
            )
        })?;

        // PRD AC: removed-screen text must never appear at any point.
        for forbidden in &fixtures.must_not_appear {
            if tree_contains(&snap, forbidden) {
                bail!(
                    "screen {}: forbidden text '{}' appeared — a deleted screen rendered",
                    fixture.id,
                    forbidden
                );
            }
        }

        save_screenshot(&provider, artifacts_dir, &fixture.id).await?;

        if fixture.cta_text.is_empty() {
            // Auto-advance screen — no CTA to click; the next iteration will
            // wait_for the following screen's assert_text.
            continue;
        }

        // Poll for the CTA in case async work delays its render.
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

    // Close session
    let _ = provider.close().await;
    println!("✅ 5-step flow traversed");
    Ok(())
}
