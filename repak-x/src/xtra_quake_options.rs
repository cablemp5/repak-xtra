//! Saved options schema shared for compatibility; generation lives in Extended only.
use serde::{Deserialize, Serialize};

/// The saved options (Settings of the built-in's card). A change rebuilds.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Options {
    /// hex RGB, "5d7a80"
    pub base: String,
    pub sky: String,
    pub hide_plants: bool,
    /// the lobby, MVP and showcase scenes too
    pub lobby: bool,
}

impl Default for Options {
    fn default() -> Self {
        Options { base: "5d7a80".into(), sky: "82c6ed".into(), hide_plants: false, lobby: true }
    }
}
