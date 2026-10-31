use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
struct CacheEntry {
    response: String,
    created_at: u64,
    ttl_secs: u64,
}

pub struct ResponseCache {
    dir: PathBuf,
    ttl: Duration,
}

impl ResponseCache {
    pub fn new(dir: impl Into<PathBuf>, ttl: Duration) -> Self {
        let dir = dir.into();
        fs::create_dir_all(&dir).ok();
        Self { dir, ttl }
    }

    fn key_path(key: &str) -> PathBuf {
        let mut hasher = DefaultHasher::new();
        key.hash(&mut hasher);
        let hex = format!("{:x}", hasher.finish());
        PathBuf::from(hex)
    }

    pub fn get(&self, key: &str) -> Option<String> {
        let path = self.dir.join(Self::key_path(key));
        let data = fs::read_to_string(path).ok()?;
        let entry: CacheEntry = serde_json::from_str(&data).ok()?;
        let elapsed = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .ok()?
            .as_secs()
            .saturating_sub(entry.created_at);
        if elapsed < entry.ttl_secs {
            Some(entry.response)
        } else {
            None
        }
    }

    pub fn insert(&self, key: &str, response: String) {
        let path = self.dir.join(Self::key_path(key));
        let entry = CacheEntry {
            response,
            created_at: SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
            ttl_secs: self.ttl.as_secs(),
        };
        if let Ok(json) = serde_json::to_string(&entry) {
            fs::write(path, json).ok();
        }
    }
}
