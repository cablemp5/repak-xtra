//! The update channel's names. "standard" stays in the ZIP name and its edition.json: installed copies check both.
pub const NAME: &str = "standard";
pub const APP_NAME: &str = "repakxtra";
pub const TAG_PREFIX: &str = "v";

pub fn asset_name(version: &semver::Version) -> String {
    format!("repak-xtra-{NAME}-v{version}-windows.zip")
}
