//! Deep-link handler for hq-installer:// OAuth callbacks.
//!
//! Parses `hq-installer://callback?code=X&state=Y` URLs received from the OS
//! and forwards `{code, state}` to the frontend via a `deep-link://received` event.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct OAuthCallback {
    pub code: String,
    pub state: String,
}

/// Parse the query string from a deep-link URL into an OAuthCallback.
///
/// Returns `None` if either `code` or `state` is missing.
pub fn parse_oauth_callback(url: &str) -> Option<OAuthCallback> {
    let query = url.split('?').nth(1)?;
    let params: HashMap<_, _> = query
        .split('&')
        .filter_map(|kv| {
            let mut parts = kv.splitn(2, '=');
            Some((parts.next()?, parts.next()?))
        })
        .collect();

    let code = params.get("code")?.to_string();
    let state = params.get("state")?.to_string();
    Some(OAuthCallback { code, state })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_valid_callback() {
        let url = "hq-installer://callback?code=abc123&state=xyz789";
        let result = parse_oauth_callback(url).expect("should parse");
        assert_eq!(result.code, "abc123");
        assert_eq!(result.state, "xyz789");
    }

    #[test]
    fn returns_none_when_code_missing() {
        let url = "hq-installer://callback?state=xyz789";
        assert!(parse_oauth_callback(url).is_none());
    }

    #[test]
    fn returns_none_when_state_missing() {
        let url = "hq-installer://callback?code=abc123";
        assert!(parse_oauth_callback(url).is_none());
    }

    #[test]
    fn returns_none_when_no_query_string() {
        let url = "hq-installer://callback";
        assert!(parse_oauth_callback(url).is_none());
    }

    #[test]
    fn handles_extra_params() {
        let url = "hq-installer://callback?foo=bar&code=mycode&state=mystate&extra=val";
        let result = parse_oauth_callback(url).expect("should parse");
        assert_eq!(result.code, "mycode");
        assert_eq!(result.state, "mystate");
    }
}
