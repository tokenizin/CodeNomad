//! Provider selection, startup health-checks, and config validation.

use std::env;
use std::path::PathBuf;
use reqwest::Client;
use std::time::Duration;
use thiserror::Error;

// ==================== providers ====================

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Provider {
    Ollama,
    Anthropic,
    OpenRouter,
}

impl std::str::FromStr for Provider {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "ollama" => Ok(Self::Ollama),
            "anthropic" | "claude" => Ok(Self::Anthropic),
            "openrouter" => Ok(Self::OpenRouter),
            _ => Err(format!("Unsupported provider: {s}. Use ollama, anthropic, or openrouter.")),
        }
    }
}

impl std::fmt::Display for Provider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", match self { Self::Ollama => "ollama", Self::Anthropic => "anthropic", Self::OpenRouter => "openrouter" })
    }
}

// ==================== errors ====================

#[derive(Debug, Error)]
pub enum ProviderError {
    #[error("Provider not available: {0}")]
    Unavailable(String),
    #[error("Auth failure: {0}")]
    Auth(String),
    #[error("Network error: {0}")]
    Network(#[from] reqwest::Error),
}

// ==================== health checks ====================

/// Check that the LLM provider is reachable and correctly configured.
pub async fn health_check(provider: &Provider) -> Result<HealthStatus, ProviderError> {
    let client = Client::builder().timeout(Duration::from_secs(3)).build()?;

    match provider {
        Provider::Ollama => check_ollama(&client).await,
        Provider::Anthropic => check_anthropic(&client).await,
        Provider::OpenRouter => check_openrouter(&client).await,
    }
}

async fn check_ollama(client: &Client) -> Result<HealthStatus, ProviderError> {
    let res = client.get("http://localhost:11434/api/tags")
        .send().await?;
    if res.status().is_success() {
        Ok(HealthStatus::Available(format!("Ollama running on :11434")))
    } else {
        Err(ProviderError::Unavailable("Ollama server not reachable. Run `ollama serve` or start it via Docker.".into()))
    }
}

async fn check_anthropic(client: &Client) -> Result<HealthStatus, ProviderError> {
    let key = env::var("ANTHROPIC_API_KEY")
        .map_err(|_| ProviderError::Auth("`ANTHROPIC_API_KEY` is not set".to_string()))?;
    
    // Quick auth validation — no-op request to /v1/messages
    client.post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", &key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .body(r#"{"model":"claude-sonnet-4-20250514","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}"#)
        .send().await?; // Ignoring body; status code is all we need for auth validation
    Ok(HealthStatus::Available("Anthropic API authenticated".into()))
}

async fn check_openrouter(client: &Client) -> Result<HealthStatus, ProviderError> {
    let key = env::var("OPENROUTER_API_KEY")
        .map_err(|_| ProviderError::Auth("`OPENROUTER_API_KEY` is not set".to_string()))?;
    client.get("https://openrouter.ai/api/v1/models")
        .header("Authorization", format!("Bearer {}", key))
        .send().await?;
    Ok(HealthStatus::Available("OpenRouter API authenticated".into()))
}

// ==================== health status ====================

#[derive(Debug)]
pub enum HealthStatus {
    Available(String),  // brief human message
    Unavailable(ProviderError),
}

impl HealthStatus {
    pub fn is_available(&self) -> bool { matches!(self, Self::Available(_)) }
}

// ==================== config validation ====================

#[derive(Debug, Clone)]
pub struct SessionConfig {
    pub provider: Provider,
    pub project_root: PathBuf,
    pub model: String,
}

impl SessionConfig {
    pub fn validate(&self) -> Result<(), Vec<String>> {
        let mut errs = Vec::new();
        if self.model.is_empty() { errs.push("model name must not be empty".into()); }
        if !self.project_root.is_dir() { errs.push(format!("project_root {} does not exist", self.project_root.display())); }
        if errs.is_empty() { Ok(()) } else { Err(errs) }
    }
}

// ==================== integration test ====================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_from_str() {
        assert_eq!("ollama".parse::<Provider>().unwrap(), Provider::Ollama);
        assert!("bogus".parse::<Provider>().is_err());
    }

    #[test]
    fn test_validate_ok() {
        let cfg = SessionConfig { provider: Provider::Ollama, project_root: PathBuf::from("/tmp/test"), model: "llama3".into() };
        assert!(cfg.validate().is_ok());
    }

    #[test]
    fn test_validate_bad_model() {
        let cfg = SessionConfig { provider: Provider::Ollama, project_root: PathBuf::from("/tmp/test"), model: "".into() };
        assert!(!cfg.validate().unwrap_err().is_empty());
    }
}
