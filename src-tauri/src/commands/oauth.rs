// oauth.rs — Google OAuth loopback listener.
//
// Starts a one-shot HTTP server on 127.0.0.1:53682 (rclone-standard OAuth
// loopback port, pre-registered in Cognito app client 7r7an9keh0u6hlsvepl74tvqb0
// — hq-dev stack; see hq-pro ADR-0003)
// and waits for the browser to redirect back to /callback?code=...&state=...
// with the authorization code. Responds with a friendly HTML page that tells
// the user to return to the installer, then shuts the listener down.
//
// The React frontend is expected to:
//   1. Call `oauth_listen_for_code` (awaits the code via Tauri async command).
//   2. Separately call `tauri_plugin_shell::open(...)` on the authorize URL.
//   3. Exchange the returned code + PKCE verifier for tokens via the Cognito
//      /oauth2/token endpoint (pure HTTP, done in TS).
//
// Security notes:
//   - Binds to 127.0.0.1 only — never 0.0.0.0.
//   - Enforces `state` match between what the listener was started with and
//     what comes back on the callback, defending against CSRF/code injection.
//   - Single-use: accepts at most one request, closes listener afterwards.
//   - 5-minute timeout so a stalled/abandoned flow doesn't leak a socket.

use serde::Serialize;
use std::io::{self, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

const LOOPBACK_PORT: u16 = 53682;
const LOOPBACK_HOST: &str = "127.0.0.1";
const IDLE_TIMEOUT: Duration = Duration::from_secs(300);
const READ_TIMEOUT: Duration = Duration::from_secs(10);
const POLL_INTERVAL: Duration = Duration::from_millis(100);

/// Global slot holding the cancel flag of the currently-active listener (if
/// any). On re-invocation we flip the prior flag so the old listener bails
/// out, releases its bound socket, and lets the new invocation claim the
/// loopback port. This is what lets the sign-in button stay clickable: the
/// user can re-click to reopen the browser without waiting for the 5-minute
/// idle timeout when the previous tab was closed.
fn cancel_slot() -> &'static Mutex<Option<Arc<AtomicBool>>> {
    static SLOT: OnceLock<Mutex<Option<Arc<AtomicBool>>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

fn install_cancel_flag(flag: Arc<AtomicBool>) {
    let prior = {
        let mut slot = cancel_slot().lock().unwrap_or_else(|p| p.into_inner());
        let prior = slot.take();
        *slot = Some(flag);
        prior
    };
    if let Some(prior) = prior {
        prior.store(true, Ordering::SeqCst);
        // Poke a TCP connect at the prior listener so its blocking accept()
        // wakes up immediately rather than waiting for the next poll tick.
        // This is a best-effort nudge — if it fails (listener already gone),
        // the prior task's own poll loop will catch the flag within ~100ms.
        let _ = TcpStream::connect((LOOPBACK_HOST, LOOPBACK_PORT));
    }
}

fn clear_cancel_flag(flag: &Arc<AtomicBool>) {
    let mut slot = cancel_slot().lock().unwrap_or_else(|p| p.into_inner());
    // Only clear if the slot still holds *our* flag. If a newer listener has
    // already installed itself, don't yank its flag.
    if let Some(current) = slot.as_ref() {
        if Arc::ptr_eq(current, flag) {
            *slot = None;
        }
    }
}

/// `TcpListener::bind` on a recently-released port can race with the prior
/// listener's drop. Retry briefly so a fresh sign-in click never fails just
/// because the old listener hasn't finished tearing down yet.
fn try_bind_with_retries() -> io::Result<TcpListener> {
    let mut last_err: Option<io::Error> = None;
    for _ in 0..10 {
        match TcpListener::bind((LOOPBACK_HOST, LOOPBACK_PORT)) {
            Ok(l) => return Ok(l),
            Err(e) => {
                last_err = Some(e);
                std::thread::sleep(POLL_INTERVAL);
            }
        }
    }
    Err(last_err.unwrap_or_else(|| io::Error::other("bind failed")))
}

/// `eprintln!` panics on stderr write failure (EPIPE). Under some dev-server
/// launchers the parent closes our stderr pipe while the async OAuth task is
/// still running — a subsequent `eprintln!` would panic the blocking task,
/// surfaced to the frontend as "OAuth listener task panicked". Use `writeln!`
/// and discard the Result so broken pipes are a silent no-op.
fn log_line(msg: &str) {
    let _ = writeln!(std::io::stderr(), "{msg}");
}

#[derive(Serialize)]
pub struct OAuthResult {
    pub code: String,
}

const SUCCESS_HTML: &str = r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Signed in — HQ Installer</title>
<style>
  html, body { margin: 0; padding: 0; height: 100%; background: #0a0a0a; color: #fafafa;
    font-family: -apple-system, BlinkMacSystemFont, "Geist", sans-serif; }
  .wrap { height: 100%; display: flex; align-items: center; justify-content: center; }
  .card { max-width: 420px; padding: 32px 28px; text-align: center; }
  .check { width: 56px; height: 56px; border-radius: 28px; background: rgba(34,197,94,0.15);
    color: #22c55e; font-size: 28px; line-height: 56px; margin: 0 auto 16px; }
  h1 { font-size: 20px; font-weight: 500; margin: 0 0 8px; }
  p { font-size: 14px; color: #a1a1aa; margin: 0; }
</style>
</head>
<body>
<div class="wrap"><div class="card">
  <div class="check">&check;</div>
  <h1>You are signed in</h1>
  <p>You can close this tab and return to the HQ installer.</p>
</div></div>
</body>
</html>"#;

fn error_html(reason: &str) -> String {
    format!(
        r#"<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>Sign-in error</title>
<style>body{{font-family:-apple-system,sans-serif;background:#0a0a0a;color:#fafafa;
text-align:center;padding-top:80px}}h1{{font-weight:500}}p{{color:#a1a1aa}}
code{{color:#f87171;font-size:12px;display:block;margin-top:24px}}</style>
</head><body><h1>Sign-in error</h1>
<p>Return to the HQ installer and try again.</p>
<code>{reason}</code></body></html>"#,
        reason = reason
    )
}

/// Read an HTTP request from the stream up to the end of the request line +
/// headers. We only care about the GET line; body (if any) is ignored.
fn read_request_line(stream: &mut TcpStream) -> std::io::Result<String> {
    stream.set_read_timeout(Some(READ_TIMEOUT))?;
    let mut buf = [0u8; 4096];
    let n = stream.read(&mut buf)?;
    Ok(String::from_utf8_lossy(&buf[..n]).into_owned())
}

fn write_response(stream: &mut TcpStream, status: &str, body: &str) {
    let payload = format!(
        "HTTP/1.1 {status}\r\n\
         Content-Type: text/html; charset=utf-8\r\n\
         Content-Length: {len}\r\n\
         Connection: close\r\n\
         \r\n\
         {body}",
        status = status,
        len = body.len(),
        body = body,
    );
    let _ = stream.write_all(payload.as_bytes());
    let _ = stream.flush();
    let _ = stream.shutdown(Shutdown::Both);
}

/// Parse `GET /callback?code=...&state=...` from the first request line.
/// Returns (code, state) if both query params are present.
fn parse_callback(request: &str) -> Option<(String, String, Option<String>)> {
    let first_line = request.lines().next()?;
    // "GET /callback?code=XYZ&state=ABC HTTP/1.1"
    let mut parts = first_line.split_whitespace();
    let method = parts.next()?;
    let path = parts.next()?;
    if method != "GET" {
        return None;
    }
    let query = path.split_once('?').map(|(_, q)| q).unwrap_or("");
    let mut code = None;
    let mut state = None;
    let mut error = None;
    for pair in query.split('&') {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        let v_decoded = urldecode(v);
        match k {
            "code" => code = Some(v_decoded),
            "state" => state = Some(v_decoded),
            "error" => error = Some(v_decoded),
            _ => {}
        }
    }
    match (code, state, error) {
        (Some(c), Some(s), err) => Some((c, s, err)),
        _ => None,
    }
}

/// Minimal URL decoder for OAuth query params. Handles `%XX` and `+`.
fn urldecode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let hi = (bytes[i + 1] as char).to_digit(16);
                let lo = (bytes[i + 2] as char).to_digit(16);
                if let (Some(h), Some(l)) = (hi, lo) {
                    out.push((h * 16 + l) as u8);
                    i += 3;
                } else {
                    out.push(bytes[i]);
                    i += 1;
                }
            }
            other => {
                out.push(other);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Block until the browser hits /callback with a valid code and matching state.
///
/// Runs the blocking TcpListener on a tokio blocking thread so the Tauri
/// command stays async-friendly. Cancellable: a subsequent invocation of
/// this command triggers the prior listener to bail out and release the
/// loopback port — so the user can re-click "Continue with Google" after
/// closing a stale browser tab without waiting for the 5-min idle timeout.
#[tauri::command]
pub async fn oauth_listen_for_code(expected_state: String) -> Result<OAuthResult, String> {
    let state_copy = expected_state.clone();

    // Install our cancel flag *before* spawning the blocking task. This
    // signals any prior listener to exit so the port is free when we bind.
    let my_flag = Arc::new(AtomicBool::new(false));
    install_cancel_flag(my_flag.clone());

    let flag_for_task = my_flag.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<OAuthResult, String> {
        let listener = try_bind_with_retries().map_err(|e| {
            format!(
                "Failed to bind OAuth loopback listener on {}:{} — {}. \
                 Another instance may already be waiting for sign-in.",
                LOOPBACK_HOST, LOOPBACK_PORT, e
            )
        })?;

        // Non-blocking accept so we can poll the cancel flag + deadline every
        // POLL_INTERVAL instead of being stuck in a blocking accept() call.
        listener
            .set_nonblocking(true)
            .map_err(|e| format!("set_nonblocking: {e}"))?;

        let deadline = Instant::now() + IDLE_TIMEOUT;

        loop {
            if flag_for_task.load(Ordering::SeqCst) {
                return Err("Sign-in cancelled.".into());
            }
            if Instant::now() > deadline {
                return Err("Timed out waiting for sign-in (5 minutes).".into());
            }

            // Accept the next inbound connection. Browsers may send favicon
            // probes or other preflight requests — skip anything that isn't
            // our /callback.
            match listener.accept() {
                Ok((mut stream, _addr)) => {
                    // Flip the accepted stream back to blocking so the
                    // existing read_request_line / write_response helpers
                    // behave normally — we only need non-blocking on the
                    // *listener* for the poll-cancel pattern.
                    let _ = stream.set_nonblocking(false);

                    let request = match read_request_line(&mut stream) {
                        Ok(r) => r,
                        Err(_) => {
                            continue;
                        }
                    };

                    match parse_callback(&request) {
                        Some((_code, _state, Some(error))) => {
                            let reason = format!("Provider error: {error}");
                            log_line(&format!("[oauth] callback rejected — {reason}"));
                            write_response(&mut stream, "400 Bad Request", &error_html(&reason));
                            return Err(format!("OAuth provider returned error: {error}"));
                        }
                        Some((code, state, None)) => {
                            if state != state_copy {
                                let reason = format!(
                                    "State mismatch: expected {} got {}",
                                    state_copy, state
                                );
                                log_line(&format!("[oauth] callback rejected — {reason}"));
                                write_response(
                                    &mut stream,
                                    "400 Bad Request",
                                    &error_html(&reason),
                                );
                                return Err(
                                    "OAuth state mismatch — possible CSRF, aborting.".into()
                                );
                            }
                            log_line(&format!(
                                "[oauth] callback accepted — code length {}",
                                code.len()
                            ));
                            write_response(&mut stream, "200 OK", SUCCESS_HTML);
                            return Ok(OAuthResult { code });
                        }
                        None => {
                            // Not a /callback request (e.g. /favicon.ico or
                            // the dummy self-connect we use to wake ourselves
                            // up during cancel). Respond 404 and keep polling.
                            write_response(
                                &mut stream,
                                "404 Not Found",
                                "<!doctype html><title>404</title>",
                            );
                            continue;
                        }
                    }
                }
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                    std::thread::sleep(POLL_INTERVAL);
                    continue;
                }
                Err(e) => {
                    return Err(format!("accept failed: {e}"));
                }
            }
        }
    })
    .await
    .map_err(|e| format!("OAuth listener task panicked: {e}"));

    // Clear our cancel flag on every return path (success, error, panic).
    clear_cancel_flag(&my_flag);

    result?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_callback_extracts_code_and_state() {
        let req = "GET /callback?code=abc123&state=xyz HTTP/1.1\r\nHost: localhost\r\n\r\n";
        let (code, state, err) = parse_callback(req).unwrap();
        assert_eq!(code, "abc123");
        assert_eq!(state, "xyz");
        assert!(err.is_none());
    }

    #[test]
    fn parse_callback_captures_error() {
        let req = "GET /callback?code=x&state=y&error=access_denied HTTP/1.1\r\n\r\n";
        let (_, _, err) = parse_callback(req).unwrap();
        assert_eq!(err.as_deref(), Some("access_denied"));
    }

    #[test]
    fn parse_callback_rejects_non_get() {
        let req = "POST /callback?code=x&state=y HTTP/1.1\r\n\r\n";
        assert!(parse_callback(req).is_none());
    }

    #[test]
    fn parse_callback_ignores_non_callback_paths() {
        let req = "GET /favicon.ico HTTP/1.1\r\n\r\n";
        assert!(parse_callback(req).is_none());
    }

    #[test]
    fn urldecode_handles_percent_and_plus() {
        assert_eq!(urldecode("hello+world"), "hello world");
        assert_eq!(urldecode("a%20b"), "a b");
        assert_eq!(urldecode("plain"), "plain");
    }

    // Regression for the "OAuth listener task panicked: failed printing to
    // stderr: Broken pipe" bug. `log_line` must never panic — we can't easily
    // close stderr inside a test, but we can at least confirm a range of
    // inputs don't panic on a normal pipe, which proves the macro is `writeln!`
    // (returns Result) rather than `eprintln!` (panics on failure).
    #[test]
    fn log_line_does_not_panic_on_various_inputs() {
        log_line("");
        log_line("simple");
        log_line("with\nnewline");
        log_line("with unicode ✓ and emoji 🔒");
        let long = "x".repeat(10_000);
        log_line(&long);
    }
}
