//! The edition is fixed when compiled; a saved setting cannot switch update channels.
pub const EXTENDED: bool = cfg!(feature = "extended");
pub const NAME: &str = if EXTENDED { "extended" } else { "standard" };
pub const TAG_PREFIX: &str = if EXTENDED { "extended-v" } else { "v" };

pub fn features_unlocked() -> bool {
    #[cfg(feature = "extended")]
    { crate::xtra_activation::is_unlocked() }
    #[cfg(not(feature = "extended"))]
    { false }
}

pub fn asset_name(version: &semver::Version) -> String {
    format!("repak-xtra-{NAME}-v{version}-windows.zip")
}
