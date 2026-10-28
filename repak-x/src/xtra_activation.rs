//! Offline shared-code gate. The receipt holds H = sha256(code), so it contains no plaintext code. The build holds
//! only sha256(H) (build.rs), so the receipt cannot be copied out of the exe.
use sha2::{Digest, Sha256};

fn expected() -> &'static str { option_env!("REPAKXTRA_UNLOCK_HASH").unwrap_or("") }
fn receipt() -> std::path::PathBuf { crate::app_dir().join("extended-unlock.sha256") }
fn hex(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }

/// The receipt for `code`, when it is the build's code.
fn accepts(code: &str, bundled: &str) -> Option<String> {
    let code = code.trim();
    let receipt = hex(code.as_bytes());
    (!code.is_empty() && code.len() <= 1024 && bundled.len() == 64 && hex(receipt.as_bytes()) == bundled).then_some(receipt)
}

pub fn is_unlocked() -> bool {
    receipt_matches(&receipt(), expected())
}

fn receipt_matches(path: &std::path::Path, bundled: &str) -> bool {
    bundled.len() == 64 && std::fs::read_to_string(path).is_ok_and(|saved| hex(saved.trim().to_ascii_lowercase().as_bytes()) == bundled)
}

pub fn require() -> Result<(), String> {
    if is_unlocked() { Ok(()) } else { Err("Enter the shared code to unlock repakxploit.".into()) }
}

#[tauri::command]
pub fn extended_access_status() -> bool { is_unlocked() }

#[tauri::command]
pub fn extended_unlock(code: String, app: tauri::AppHandle) -> Result<(), String> {
    unlock_then(&code, expected(), &receipt(), || crate::xtra_project::on_open(&app))
}

pub(crate) fn unlock_then(code: &str, bundled: &str, receipt: &std::path::Path, after: impl FnOnce()) -> Result<(), String> {
    let Some(saved) = accepts(code, bundled) else { return Err("Code not recognized.".into()) };
    std::fs::create_dir_all(receipt.parent().ok_or("Missing unlock folder")?).map_err(|e| format!("Could not save unlock: {e}"))?;
    std::fs::write(receipt, saved).map_err(|e| format!("Could not save unlock: {e}"))?;
    after();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    /// What build.rs embeds for the code "fixture-only".
    fn bundled() -> String { hex(hex(b"fixture-only").as_bytes()) }

    #[test]
    fn only_the_matching_nonempty_code_is_accepted() {
        let bundled = bundled();
        assert_eq!(accepts("fixture-only", &bundled), Some(hex(b"fixture-only")));
        assert!(accepts(" fixture-only ", &bundled).is_some());
        assert!(accepts("wrong", &bundled).is_none());
        assert!(accepts("", &bundled).is_none());
        assert!(accepts("fixture-only", "").is_none());
        assert!(accepts(&"a".repeat(1025), &bundled).is_none());
    }

    #[test]
    fn an_unlock_persists_only_for_the_same_build_code() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("receipt");
        let bundled = bundled();
        assert!(!receipt_matches(&path, &bundled));
        // Receipts saved before the bundled value was hashed again hold the same H, so they stay unlocked.
        std::fs::write(&path, hex(b"fixture-only").to_uppercase()).unwrap();
        assert!(receipt_matches(&path, &bundled));
        assert!(!receipt_matches(&path, &hex(hex(b"new-fixture").as_bytes())));
        assert!(!receipt_matches(&path, ""));
        // The value inside the exe is not a receipt.
        std::fs::write(&path, &bundled).unwrap();
        assert!(!receipt_matches(&path, &bundled));
        assert!(!std::fs::read_to_string(path).unwrap().contains("fixture-only"));
    }
}
