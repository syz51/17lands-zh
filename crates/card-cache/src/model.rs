use serde::{Deserialize, Serialize};

pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Language {
    Zhs,
    Zht,
}
impl Language {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Zhs => "zhs",
            Self::Zht => "zht",
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FaceSide {
    Front,
    Back,
}
impl FaceSide {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Front => "front",
            Self::Back => "back",
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImageKind {
    Exact,
    Alternate,
    Unavailable,
}
impl ImageKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Exact => "exact",
            Self::Alternate => "alternate",
            Self::Unavailable => "unavailable",
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalizedFace {
    pub face: FaceSide,
    pub lang: Language,
    pub name: Option<String>,
    pub type_line: Option<String>,
    pub rules_text: Option<String>,
    pub image_url: Option<String>,
    pub image_kind: ImageKind,
    pub source: String,
    pub source_url: Option<String>,
    pub localized_printing_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CardRecord {
    pub printing_id: String,
    pub oracle_id: Option<String>,
    pub english_name: String,
    pub set_code: String,
    pub collector_number: String,
    pub layout: String,
    pub faces: Vec<LocalizedFace>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Card {
    pub printing_id: String,
    pub oracle_id: Option<String>,
    pub english_name: String,
    pub set_code: String,
    pub collector_number: String,
    pub layout: String,
    pub faces: Vec<Face>,
    pub updated_at: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Face {
    pub face: FaceSide,
    pub name_zh: Option<String>,
    pub type_line_zh: Option<String>,
    pub oracle_text_zh: Option<String>,
    pub image_url: Option<String>,
    pub image_kind: ImageKind,
    pub source: String,
    pub source_url: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Status {
    pub schema_version: u32,
    pub revision: String,
    pub ready: bool,
    pub card_count: u64,
    pub last_success_at: Option<String>,
    pub next_refresh_at: Option<String>,
    pub refresh_state: String,
    pub last_error: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CardsResponse {
    pub schema_version: u32,
    pub revision: String,
    pub cards: Vec<Card>,
    pub missing: Vec<String>,
}
/// Scryfall's canonical hyphenated UUID syntax, normalized to lowercase.
/// Syntax checking deliberately avoids a new UUID dependency.
pub fn printing_id(value: &str) -> anyhow::Result<String> {
    anyhow::ensure!(
        value.len() == 36
            && value.bytes().enumerate().all(|(i, b)| {
                if [8, 13, 18, 23].contains(&i) {
                    b == b'-'
                } else {
                    b.is_ascii_hexdigit()
                }
            }),
        "expected a canonical hyphenated UUID"
    );
    Ok(value.to_ascii_lowercase())
}
