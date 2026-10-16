//! repakxtra: test and dev copies mark their window (and so taskbar) icon in their color, like the "xtra" in the header
//! (custom/version.ts): green for a test build (`build.ps1 -Test` sets REPAKXTRA_BUILD=test for the Rust build), amber for
//! the dev copy (dev.ps1 runs a debug build). The icon is the app's own x glyph, recolored, so no extra icon files exist.

/// "test" or "dev" and its color, or None for the stable copy.
fn mark() -> Option<[u8; 3]> {
    if cfg!(debug_assertions) {
        Some([0xF5, 0xA5, 0x24]) // dev, amber
    } else if option_env!("REPAKXTRA_BUILD") == Some("test") {
        Some([0x3E, 0xCF, 0x6E]) // test, green
    } else {
        None
    }
}

/// Every pixel takes the color and keeps its own alpha: the icon is one color on transparency.
fn recolor(rgba: &[u8], [r, g, b]: [u8; 3]) -> Vec<u8> {
    rgba.chunks_exact(4).flat_map(|px| [r, g, b, px[3]]).collect()
}

/// The app's icon in this copy's color, or None for the stable copy.
fn tinted(icon: Option<&tauri::image::Image<'_>>) -> Option<tauri::image::Image<'static>> {
    let (color, icon) = (mark()?, icon?);
    Some(tauri::image::Image::new_owned(recolor(icon.rgba(), color), icon.width(), icon.height()))
}

/// At startup, for the windows that exist then (the main one), before its page loads; the stable copy keeps its blue icon.
pub fn tint_window_icon(app: &tauri::App) {
    use tauri::Manager;
    let Some(icon) = tinted(app.default_window_icon()) else { return };
    for window in app.webview_windows().values() {
        let _ = window.set_icon(icon.clone());
    }
}

/// Each window asks for its own when it loads (custom/buildMark.ts), so the VFX Updater and Asset Explorer, opened
/// later, get it too.
#[tauri::command]
pub fn xtra_buildmark_tint(window: tauri::WebviewWindow) {
    use tauri::Manager;
    if let Some(icon) = tinted(window.app_handle().default_window_icon()) {
        let _ = window.set_icon(icon);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recolor_keeps_alpha() {
        let px = [0x34, 0x6B, 0xF1, 255, 0, 0, 0, 0, 0x34, 0x6B, 0xF1, 128];
        assert_eq!(recolor(&px, [1, 2, 3]), vec![1, 2, 3, 255, 1, 2, 3, 0, 1, 2, 3, 128]);
    }
}
