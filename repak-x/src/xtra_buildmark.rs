//! repakxtra: test and dev copies mark their window (and so taskbar) icon in their color, like the "xtra" in the header
//! (custom/version.ts): green for a test build (`build.ps1 -Test` sets REPAKXTRA_BUILD=test for the Rust build), amber for
//! the standard dev copy (dev.ps1 runs a debug build). repakxploit is red for stable, purple for test, pink for dev.
//! The icon is the app's own x with its blues turned to that color.

/// How far this copy turns the icon's blues around the color wheel, in degrees, or None for the stable copy.
fn mark() -> Option<f32> {
    if cfg!(debug_assertions) {
        Some(if crate::xtra_edition::EXTENDED { 100.0 } else { 170.0 }) // repakxploit dev pink; standard dev amber
    } else if crate::xtra_edition::EXTENDED {
        Some(if option_env!("REPAKXTRA_BUILD") == Some("test") { 60.0 } else { 140.0 }) // purple test, red stable
    } else if option_env!("REPAKXTRA_BUILD") == Some("test") {
        Some(-80.0) // test, green
    } else {
        None
    }
}

/// Every pixel's hue turned by `degrees`, its saturation, brightness and alpha kept: grays stay as they are.
fn recolor(rgba: &[u8], degrees: f32) -> Vec<u8> {
    rgba.chunks_exact(4).flat_map(|px| {
        let [r, g, b] = [px[0], px[1], px[2]].map(|c| f32::from(c) / 255.0);
        let (max, min) = (r.max(g).max(b), r.min(g).min(b));
        let chroma = max - min;
        if chroma == 0.0 {
            return [px[0], px[1], px[2], px[3]];
        }
        let hue = if max == r { (g - b) / chroma } else if max == g { (b - r) / chroma + 2.0 } else { (r - g) / chroma + 4.0 };
        let h = (hue * 60.0 + degrees).rem_euclid(360.0) / 60.0;
        let x = chroma * (1.0 - (h % 2.0 - 1.0).abs());
        let (r, g, b) = match h as u8 { 0 => (chroma, x, 0.0), 1 => (x, chroma, 0.0), 2 => (0.0, chroma, x), 3 => (0.0, x, chroma), 4 => (x, 0.0, chroma), _ => (chroma, 0.0, x) };
        let byte = |c: f32| ((c + min) * 255.0).round() as u8;
        [byte(r), byte(g), byte(b), px[3]]
    }).collect()
}

/// The app's icon in this copy's colors, or None for the stable copy.
fn tinted(icon: Option<&tauri::image::Image<'_>>) -> Option<tauri::image::Image<'static>> {
    let (degrees, icon) = (mark()?, icon?);
    Some(tauri::image::Image::new_owned(recolor(icon.rgba(), degrees), icon.width(), icon.height()))
}

/// At startup, for the windows that exist then (the main one), before its page loads; the stable copy keeps its blue icon.
pub fn tint_window_icon(app: &tauri::App) {
    use tauri::Manager;
    let Some(icon) = tinted(app.default_window_icon()) else { return };
    for window in app.webview_windows().values() {
        if window.label() == "main" { let _ = window.set_title(crate::xtra_edition::APP_NAME); }
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
    fn debug_builds_use_the_correct_dev_color() {
        if cfg!(debug_assertions) {
            assert_eq!(mark(), Some(if crate::xtra_edition::EXTENDED { 100.0 } else { 170.0 }));
        }
    }

    #[test]
    fn recolor_turns_hues_and_keeps_white_and_alpha() {
        let px = [0x03, 0x4E, 0xFE, 255, 255, 255, 255, 200, 255, 0, 0, 0];
        assert_eq!(recolor(&px, 0.0), px.to_vec());
        assert_eq!(recolor(&px[8..], 120.0), vec![0, 255, 0, 0]); // red to green
        let out = recolor(&px, -80.0);
        assert_eq!(&out[4..8], &[255, 255, 255, 200]); // white and its alpha untouched
        assert!(out[1] > out[2] && out[1] > out[0], "the blue turned green: {:?}", &out[..3]);
    }

    #[test]
    fn extended_stable_and_test_have_distinct_colors() {
        let blue = [0x03, 0x4E, 0xFE, 255];
        let purple = recolor(&blue, 60.0);
        let red = recolor(&blue, 140.0);
        assert!(purple[2] > purple[0] && purple[0] > purple[1]);
        assert!(red[0] > red[1] && red[0] > red[2]);
        assert_eq!(purple[3], 255);
        assert_eq!(red[3], 255);
    }
}
