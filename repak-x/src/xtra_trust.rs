//! repakxtra: Settings > Help & Community > Is it safe? (custom/TrustSection.tsx): the SHA-256 of the running exe, which
//! names its VirusTotal page.

/// The exe is tens of MB: hashed off the main thread.
#[tauri::command]
pub async fn xtra_self_sha256() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || crate::xtra_update::sha256_file(&exe)).await.map_err(|e| e.to_string())?
}
