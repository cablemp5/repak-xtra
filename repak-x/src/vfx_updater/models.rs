//! VFX Updater - Data Models

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct VfxSettings {
    /// USMAP path - VFX module only (RX doesn't use this)
    pub usmap_path: Option<String>,
    /// SHA of the auto-managed USMAP (matches GitHub blob SHA)
    pub usmap_sha: Option<String>,
    /// Filename of the auto-managed USMAP
    pub usmap_filename: Option<String>,
    /// ETag from last GitHub Contents API response (for conditional requests)
    pub usmap_etag: Option<String>,
    /// repakxtra: commit date of the managed USMAP, so a check that finds it current makes no second GitHub call
    pub usmap_commit_date: Option<String>,
    // game_paks_path and aes_key grabbed from RX settings at runtime
}

impl Default for VfxSettings {
    fn default() -> Self {
        Self {
            usmap_path: None,
            usmap_sha: None,
            usmap_filename: None,
            usmap_etag: None,
            usmap_commit_date: None, // repakxtra
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VfxPipelineProgress {
    pub stage: String,
    pub step: u8,
    pub current: usize,
    pub total: usize,
    pub message: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VfxPipelineResult {
    pub success: bool,
    pub output_path: Option<String>,
    pub colors_extracted: usize,
    pub colors_applied: usize,
    pub warnings: Vec<String>,
    pub error: Option<String>,
}

impl Default for VfxPipelineResult {
    fn default() -> Self {
        Self {
            success: false,
            output_path: None,
            colors_extracted: 0,
            colors_applied: 0,
            warnings: Vec::new(),
            error: None,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AssetClassInfo {
    pub file_path: String,
    pub class_name: Option<String>,
    pub is_material_instance: bool,
    pub is_niagara: bool,
    pub is_widget: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VfxTempDirectories {
    pub base: String,
    pub mod_extract: String,
    pub mod_json: String,
    pub vanilla_extract: String,
    pub vanilla_json: String,
    pub edited_json: String,
    pub final_uassets: String,
}
