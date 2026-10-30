//! repakxtra switches no project loader: Project Sigeon lists in the Library as an ordinary mod, and the Project Galacta
//! loader is Setup's. Another app sharing ~mods may switch them itself. The launch, start and focus hooks still call in.

/// Nothing to switch: never a reason to refuse Play. Ok(true) would mean files moved.
pub fn select(_mods: &std::path::Path) -> Result<bool, String> {
    Ok(false)
}

pub fn on_open(_app: &tauri::AppHandle) {}
