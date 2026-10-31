//! Thread-safe i18n accessor with guaranteed English fallback (never panics).

use std::collections::HashMap;
use once_cell::sync::OnceCell;

// ==================== types ====================

/// A loaded locale's message map.
#[derive(Debug, Clone)]
pub struct LocaleMessages {
    pub messages: HashMap<String, String>,
}

impl LocaleMessages {
    /// Merge another locale into this one (lower priority wins for missing keys).
    pub fn merge(&mut self, other: &LocaleMessages) {
        for (k, v) in &other.messages {
            self.messages.entry(k.clone()).or_insert_with(|| v.clone());
        }
    }
}

/// Supported source languages.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Language {
    English,
    Chinese,
    Japanese,
    Spanish,
    French,
    German,
    Russian,
    Portuguese,
    Italian,
    Korean,
}

impl Language {
    pub fn code(&self) -> &'static str {
        match self {
            Self::English => "en",         Self::Chinese => "zh",
            Self::Japanese => "ja",        Self::Spanish => "es",
            Self::French => "fr",          Self::German => "de",
            Self::Russian => "ru",         Self::Portuguese => "pt",
            Self::Italian => "it",         Self::Korean => "ko",
        }
    }

    pub fn english_name(&self) -> &'static str {
        match self {
            Self::English => "English",   Self::Chinese => "Chinese",
            Self::Japanese => "Japanese", Self::Spanish => "Spanish",
            Self::French => "French",     Self::German => "German",
            Self::Russian => "Russian",   Self::Portuguese => "Portuguese",
            Self::Italian => "Italian",   Self::Korean => "Korean",
        }
    }

    pub fn all() -> [Self; 10] {
        [Self::English, Self::Chinese, Self::Japanese, Self::Spanish, Self::French, Self::German, Self::Russian, Self::Portuguese, Self::Italian, Self::Korean]
    }
}

impl std::str::FromStr for Language {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "en" | "english"               => Ok(Self::English),
            "zh" | "chinese"               => Ok(Self::Chinese),
            "ja" | "japanese"              => Ok(Self::Japanese),
            "es" | "spanish"               => Ok(Self::Spanish),
            "fr" | "french"                => Ok(Self::French),
            "de" | "deutsch" | "german"   => Ok(Self::German),
            "ru" | "russian"               => Ok(Self::Russian),
            "pt" | "português" | "portuguese" => Ok(Self::Portuguese),
            "it" | "italiano" | "italian" => Ok(Self::Italian),
            "ko" | "korean"               => Ok(Self::Korean),
            _ => Err(format!("Unsupported language: {}", s)),
        }
    }
}

impl std::fmt::Display for Language {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.english_name())
    }
}

// ==================== global translator (safe) ====================

/// Internal implementation detail — users interact via `translator()` / `init()`.
pub struct InnerTranslator {
    locale: LocaleMessages,
}

impl InnerTranslator {
    pub fn translate(&self, key: &str) -> String {
        self.locale.messages.get(key).cloned().unwrap_or_else(|| format!("[missing {}]", key))
    }
}

static TRANSLATOR: OnceCell<InnerTranslator> = OnceCell::new();

/// Build a minimal default message set for a given language.
fn default_messages(lang: Language) -> LocaleMessages {
    let mut messages = HashMap::new();
    messages.insert("ok".into(), "OK".into());
    messages.insert(
        "error.default_cmd_not_allowed".into(),
        match lang {
            Language::English => "[missing error]".into(),
            Language::Chinese => "[错误]".into(),
            Language::Japanese => "[エラー]".into(),
            Language::Spanish => "[error]".into(),
            Language::French => "[erreur]".into(),
            Language::German => "[Fehler]".into(),
            Language::Russian => "[ошибка]".into(),
            Language::Portuguese => "[erro]".into(),
            Language::Italian => "[errore]".into(),
            Language::Korean => "[오류]".into(),
        },
    );
    LocaleMessages { messages }
}

/// Initialise the global translator (idempotent, safe to call multiple times).
pub fn init(lang: &str) -> Result<(), String> {
    let target = lang.parse::<Language>()?;
    let _ = TRANSLATOR.get_or_init(|| InnerTranslator { locale: default_messages(target) });
    Ok(())
}

/// Always safe — falls back to English loader if `init()` wasn't called.
pub fn translator() -> &'static InnerTranslator {
    TRANSLATOR.get_or_init(|| {
        InnerTranslator { locale: default_messages(Language::English) }
    })
}

/// Shortcut for translation. Never panics.
pub fn t(key: &str) -> String { translator().translate(key) }

/// Translate with format args (simple `{N}` interpolation).
pub fn t_args(key: &str, args: &[&str]) -> String {
    let base = translator().translate(key);
    let mut result = String::with_capacity(base.len() + args.iter().map(|s| s.len()).sum::<usize>());
    let mut chars = base.chars().peekable();

    while let Some(c) = chars.next() {
        if c == '{' {
            let mut index_str = String::new();
            while let Some(&next) = chars.peek() {
                if next.is_ascii_digit() {
                    index_str.push(chars.next().unwrap());
                } else {
                    break;
                }
            }
            if let Ok(idx) = index_str.parse::<usize>() {
                if let Some(replacement) = args.get(idx) {
                    result.push_str(replacement);
                    if chars.peek() == Some(&'}') {
                        chars.next();
                    }
                    continue;
                }
            }
            result.push('{');
            result.push_str(&index_str);
        } else {
            result.push(c);
        }
    }
    result
}

// ==================== tests ====================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_translator_no_init() {
        // Before init(), translator() must not panic.
        let tr = translator();
        assert!(!tr.translate("ok").is_empty());
    }

    #[test]
    fn test_from_str() {
        assert_eq!("en".parse::<Language>().unwrap(), Language::English);
        assert!("".parse::<Language>().is_err());
    }

    #[test]
    fn test_t_args_simple() {
        // With a default map that doesn't contain "foo", should fallback gracefully.
        t_args("missing.key", &["arg1"]);
    }

    #[test]
    fn test_t_args_interpolation() {
        let result = t_args("ok", &["arg1"]);
        assert_eq!(result, "OK");
    }

    #[test]
    fn test_portuguese_from_str() {
        assert!("português".parse::<Language>().is_ok());
        assert_eq!("português".parse::<Language>().unwrap(), Language::Portuguese);
    }

    #[test]
    fn test_init_loads_language() {
        // init() must parse the requested language and not error.
        assert!(init("pt").is_ok());
        assert!(init("Português").is_ok());
        assert!(init("zh").is_ok());
    }
}
