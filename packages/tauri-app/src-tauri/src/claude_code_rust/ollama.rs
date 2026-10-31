//! Ollama completion path with disk-backed response caching.

use reqwest::Client;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::time::Duration;
use crate::claude_code_rust::cache::ResponseCache;

const OLLAMA_URL: &str = "http://localhost:11434/api/generate";

#[allow(dead_code)]
#[derive(Debug)]
pub enum CompletionError {
    Network(reqwest::Error),
    Provider(String),
}

impl From<reqwest::Error> for CompletionError {
    fn from(value: reqwest::Error) -> Self {
        Self::Network(value)
    }
}

pub async fn generate_completion(
    client: &Client,
    model: &str,
    prompt: &str,
    cache_dir: PathBuf,
    ttl: Duration,
) -> Result<String, CompletionError> {
    let cache = ResponseCache::new(cache_dir, ttl);
    let key = cache_key(model, prompt);

    if let Some(cached) = cache.get(&key) {
        return Ok(cached);
    }

    let body = serde_json::json!({
        "model": model,
        "prompt": prompt,
        "stream": false
    });

    let response = client
        .post(OLLAMA_URL)
        .json(&body)
        .send()
        .await?;

    if !response.status().is_success() {
        return Err(CompletionError::Provider(format!(
            "Ollama returned status {}",
            response.status()
        )));
    }

    let json: serde_json::Value = response.json().await?;
    let text = json["response"]
        .as_str()
        .unwrap_or_default()
        .to_string();

    cache.insert(&key, text.clone());
    Ok(text)
}

fn cache_key(model: &str, prompt: &str) -> String {
    let mut hasher = DefaultHasher::new();
    format!("{}:{}", model, prompt).hash(&mut hasher);
    format!("{:x}", hasher.finish())
}
