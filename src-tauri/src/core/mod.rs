//! Core installer logic.
//!
//! Pure Rust modules ported from `create-hq` (TypeScript). Each module is
//! testable in isolation and does not depend on the Tauri runtime.
//!
//! See `docs/hq-install-spec.md` for the canonical behavior contract.

pub mod deps;
pub mod platform;
pub mod runner;
