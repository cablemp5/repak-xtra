//! Offline shared-code gate. The build contains a hash; the receipt contains no plaintext code.
use sha2::{Digest, Sha256};

fn expected() -> &'static str { option_env!("REPAKXTRA_UNLOCK_HASH").unwrap_or("") }
fn receipt() -> std::path::PathBuf { crate::app_dir().join("extended-unlock.sha256") }

fn accepts(code: &str, hash: &str) -> bool {
    let code = code.trim();
    !code.is_empty() && code.len() <= 1024 && hash.len() == 64 && format!("{:x}", Sha256::digest(code.as_bytes())) == hash
}

pub fn is_unlocked() -> bool {
    receipt_matches(&receipt(), expected())
}

fn receipt_matches(path: &std::path::Path, hash: &str) -> bool {
    hash.len() == 64 && std::fs::read_to_string(path).is_ok_and(|saved| saved.trim() == hash)
}

pub fn require() -> Result<(), String> {
    if is_unlocked() { Ok(()) } else { Err("Enter the shared code to unlock repakxploit.".into()) }
}

#[tauri::command]
pub fn extended_access_status() -> bool { is_unlocked() }

#[tauri::command]
pub fn extended_unlock(code: String) -> Result<(), String> {
    if !accepts(&code, expected()) { return Err("Code not recognized.".into()); }
    std::fs::create_dir_all(crate::app_dir()).map_err(|e| format!("Could not save unlock: {e}"))?;
    std::fs::write(receipt(), expected()).map_err(|e| format!("Could not save unlock: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_the_matching_nonempty_code_is_accepted() {
        let hash = format!("{:x}", Sha256::digest(b"fixture-only"));
        assert!(accepts("fixture-only", &hash));
        assert!(accepts(" fixture-only ", &hash));
        assert!(!accepts("wrong", &hash));
        assert!(!accepts("", &hash));
        assert!(!accepts("fixture-only", ""));
        assert!(!accepts(&"a".repeat(1025), &hash));
    }

    #[test]
    fn an_unlock_persists_only_for_the_same_build_code() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("receipt");
        let hash = format!("{:x}", Sha256::digest(b"fixture-only"));
        assert!(!receipt_matches(&path, &hash));
        std::fs::write(&path, &hash).unwrap();
        assert!(receipt_matches(&path, &hash));
        assert!(!receipt_matches(&path, &format!("{:x}", Sha256::digest(b"new-fixture"))));
        assert!(!receipt_matches(&path, ""));
        assert!(!std::fs::read_to_string(path).unwrap().contains("fixture-only"));
    }
}
