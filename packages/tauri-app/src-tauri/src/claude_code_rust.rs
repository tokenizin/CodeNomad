//! Claude Code Rust module — AI-driven coding assistant integration.
//!
//! This module provides:
//! - Safe command execution sandbox
//! - Internationalization with guaranteed English fallback
//! - Provider health checks and config validation
//! - Structured JSON logging
//! - Disk-backed response caching with TTL
//! - Ollama completion path

pub mod cache;
pub mod i18n;
pub mod logging;
pub mod ollama;
pub mod provider;
pub mod sandbox;
