//! repakxtra: the Nexus Mods account and downloads. Each user pastes their own personal API key (kept in Windows
//! Credential Manager, never in a file or the log). Browsing and update checks go through the public GraphQL API and need
//! no key (xtra_nexus_gql). Downloads need the key: Premium accounts get a link straight from the API, free accounts get
//! one only after clicking "Mod manager download" on nexusmods.com, which opens an nxm:// link carrying a one-time key.
//! That page opens in the app's own Nexus window (xtra_nexus_open), which catches the link; links from a normal browser
//! arrive through Windows (registered when a key is saved) and the deep link handler (on_link). The frontend gets each
//! link as a "nexus-nxm" event and downloads it with xtra_nexus_download (custom/nexus.ts).

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

const GAME: &str = "marvelrivals";
const GAME_ID: u32 = 7106; // Marvel Rivals in Nexus's picture folders
const API: &str = "https://api.nexusmods.com";
const WINDOW: &str = "nexus";

#[derive(Serialize)]
pub struct Account {
    name: String,
    premium: bool,
}

/// A "Mod manager download" link: nxm://marvelrivals/mods/<mod>/files/<file>?key=..&expires=..
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NxmLink {
    mod_id: u64,
    file_id: u64,
    key: String,
    expires: u64,
}

#[cfg(windows)]
fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new("repakxtra-nexus", "api-key").map_err(|e| e.to_string())
}

#[cfg(windows)]
fn saved_key() -> Option<String> {
    entry().ok()?.get_password().ok()
}

// shortcut: the key is stored only on Windows (Credential Manager); other systems would need their own keyring store
#[cfg(not(windows))]
fn saved_key() -> Option<String> {
    None
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(concat!("repakxtra/", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())
}

/// GET a v1 API path with the user's key. Network errors drop their URL (it can hold an nxm key or a signed link).
/// Nexus's own message on failure (it says what was wrong).
async fn get_json(path: &str, key: &str) -> Result<Value, String> {
    let r = client()?
        .get(format!("{API}{path}"))
        .header("apikey", key)
        .timeout(std::time::Duration::from_secs(8)) // small answers: offline at start is not a 30 s wait
        .header("Application-Name", "repakxtra")
        .header("Application-Version", env!("CARGO_PKG_VERSION"))
        .send()
        .await
        .map_err(|e| format!("Could not reach Nexus Mods: {}", e.without_url()))?;
    let status = r.status();
    let body: Value = r.json().await.unwrap_or(Value::Null);
    if status.is_success() {
        return Ok(body);
    }
    let said = body["message"].as_str().map(|s| s.split_whitespace().collect::<Vec<_>>().join(" "));
    Err(match status.as_u16() {
        401 => "Nexus Mods did not accept the API key. Copy it again from nexusmods.com/settings/api-keys.".into(),
        429 => "Nexus Mods says too many requests. Try again in an hour.".into(),
        _ => said.unwrap_or_else(|| format!("Nexus Mods answered {status}")),
    })
}

async fn validate(key: &str) -> Result<Account, String> {
    let v = get_json("/v1/users/validate.json", key).await?;
    Ok(Account { name: v["name"].as_str().unwrap_or_default().to_string(), premium: v["is_premium"].as_bool().unwrap_or(false) })
}

/// The account of the saved key, or None when there is none. Offline, a saved key still counts (as a free account with
/// no name yet): only Nexus saying no to the key is an error.
#[tauri::command]
pub async fn xtra_nexus_account() -> Result<Option<Account>, String> {
    let Some(key) = saved_key() else { return Ok(None) };
    match validate(&key).await {
        Err(e) if e.starts_with("Could not reach") => Ok(Some(Account { name: String::new(), premium: false })),
        r => r.map(Some),
    }
}

/// Checks the key with Nexus, saves it, and makes repakxtra the handler of nxm:// links (Mod manager download).
#[tauri::command]
pub async fn xtra_nexus_set_key(app: AppHandle, key: String) -> Result<Account, String> {
    let key = key.trim().to_string();
    if key.is_empty() {
        return Err("Paste your personal API key first.".into());
    }
    let account = validate(&key).await?;
    #[cfg(windows)]
    entry()?.set_password(&key).map_err(|e| format!("Could not save the key in Windows Credential Manager: {e}"))?;
    #[cfg(any(windows, target_os = "linux"))]
    {
        use tauri_plugin_deep_link::DeepLinkExt;
        if let Err(e) = app.deep_link().register("nxm") {
            crate::ui_log::warn("Nexus", format!("Could not take Nexus download links (nxm://): {e}"));
        }
    }
    let _ = &app;
    crate::ui_log::info("Nexus", format!("Signed in to Nexus Mods as {}", account.name));
    Ok(account)
}

/// Forgets the key and gives nxm:// links back (another mod manager takes them again when it next starts).
#[tauri::command]
pub fn xtra_nexus_forget_key(app: AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(e) => return Err(e.to_string()),
    }
    #[cfg(any(windows, target_os = "linux"))]
    {
        use tauri_plugin_deep_link::DeepLinkExt;
        if app.deep_link().is_registered("nxm").unwrap_or(false) {
            let _ = app.deep_link().unregister("nxm");
        }
    }
    let _ = &app;
    Ok(())
}

/// One query to the public GraphQL API (search, a mod's files and pictures). Its data (a part that failed is null), or
/// Nexus's first error when nothing came back.
#[tauri::command]
pub async fn xtra_nexus_gql(query: String, variables: Value) -> Result<Value, String> {
    let r = client()?
        .post(format!("{API}/v2/graphql"))
        .json(&serde_json::json!({ "query": query, "variables": variables }))
        .send()
        .await
        .map_err(|e| format!("Could not reach Nexus Mods: {}", e.without_url()))?;
    let body: Value = r.json().await.map_err(|e| format!("Nexus Mods sent something unreadable: {e}"))?;
    if body["data"].is_null() {
        return Err(body["errors"][0]["message"].as_str().unwrap_or("Nexus Mods sent no answer.").to_string());
    }
    Ok(body["data"].clone())
}

/// A mod's gallery, full size, in page order: no API lists it, and Nexus's bot check turns plain requests away, so a
/// hidden copy of the Nexus window (its profile, so the check is already passed) opens the mod's Images tab and reports
/// the pictures it names (the Nexus Mods tab's hover preview). Empty after 12 s without an answer: the tab then shows the
/// main picture. One mod at a time, each in a fresh hidden window.
#[tauri::command]
pub async fn xtra_nexus_images(app: AppHandle, mod_id: u64) -> Result<Vec<String>, String> {
    static ONE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _turn = ONE.lock().await;
    let (tx, rx) = tokio::sync::oneshot::channel();
    *SCOUT.lock().unwrap() = Some((mod_id, tx));
    let url = url::Url::parse(&format!("https://www.nexusmods.com/{GAME}/mods/{mod_id}?tab=images")).map_err(|e| e.to_string())?;
    let (profile, extensions) = browser_dirs(&app)?;
    WebviewWindowBuilder::new(&app, SCOUT_WINDOW, WebviewUrl::External(url))
        .visible(false)
        .skip_taskbar(true)
        .data_directory(profile)
        .browser_extensions_enabled(true)
        .extensions_path(extensions)
        .initialization_script(SCOUT_SCRIPT)
        .on_navigation(move |u| {
            if u.host_str() != Some("repakxtra.invalid") {
                return is_nexus(u);
            }
            let found: Vec<String> = u.query_pairs().find(|(k, _)| k == "page").map(|(_, page)| gallery(&page, scout_mod())).unwrap_or_default();
            if let Some((_, tx)) = SCOUT.lock().unwrap().take() { let _ = tx.send(found); }
            false
        })
        .build()
        .map_err(|e| e.to_string())?;
    let found = tokio::time::timeout(std::time::Duration::from_secs(12), rx).await.ok().and_then(|r| r.ok()).unwrap_or_default();
    SCOUT.lock().unwrap().take();
    // gone again right away: a hidden window left open would keep the app running after its main window closes
    if let Some(w) = app.get_webview_window(SCOUT_WINDOW) { let _ = w.destroy(); }
    Ok(found)
}

const SCOUT_WINDOW: &str = "nexus-scout";
/// The mod the hidden window is reading, and where its pictures go.
static SCOUT: std::sync::Mutex<Option<(u64, tokio::sync::oneshot::Sender<Vec<String>>)>> = std::sync::Mutex::new(None);
fn scout_mod() -> u64 { SCOUT.lock().unwrap().as_ref().map(|(id, _)| *id).unwrap_or(0) }
/// In the hidden window: once a mod page (not the bot check) has loaded, its markup goes back through a navigation the
/// window's handler stops and reads (gallery picks the pictures out of it).
const SCOUT_SCRIPT: &str = r#"document.addEventListener('DOMContentLoaded', () => setTimeout(() => {
  if (!location.hostname.endsWith('nexusmods.com') || !document.querySelector('#mainContent, .modpage')) return
  const page = [...document.querySelectorAll('[href*="staticdelivery"], [src*="staticdelivery"], [data-src*="staticdelivery"]')]
    .map(e => e.getAttribute('href') || e.getAttribute('data-src') || e.getAttribute('src')).join(' ')
  location.href = 'https://repakxtra.invalid/scout?page=' + encodeURIComponent(page)
}, 300))"#;

/// The full-size gallery pictures named in a mod page, each once (thumbnails live in another folder).
fn gallery(page: &str, mod_id: u64) -> Vec<String> {
    let re = regex_lite::Regex::new(&format!(r"https://staticdelivery\.nexusmods\.com/mods/{GAME_ID}/images/{mod_id}/[A-Za-z0-9._-]+")).unwrap();
    let mut out: Vec<String> = Vec::new();
    for m in re.find_iter(page) {
        if !out.iter().any(|u| u == m.as_str()) {
            out.push(m.as_str().to_string());
        }
    }
    out
}

/// Downloads one file into the app's cache under Nexus's own file name (xtra_nexus.rs reads its id, version and upload
/// time from it) and returns the path. `key` and `expires` come from an nxm:// link; without them only Premium works.
#[tauri::command]
pub async fn xtra_nexus_download(app: AppHandle, mod_id: u64, file_id: u64, key: Option<String>, expires: Option<u64>) -> Result<String, String> {
    let api = saved_key().ok_or("Add your Nexus Mods API key in Settings first.")?;
    let info = get_json(&format!("/v1/games/{GAME}/mods/{mod_id}/files/{file_id}.json"), &api).await?;
    // only the name part: a name with folders in it never leaves the download folder
    let name = info["file_name"].as_str().and_then(|n| std::path::Path::new(n).file_name()).map(|n| n.to_owned())
        .ok_or("Nexus Mods did not say the file's name.")?;
    let mut link = format!("/v1/games/{GAME}/mods/{mod_id}/files/{file_id}/download_link.json");
    if let (Some(k), Some(e)) = (&key, expires) {
        link.push_str(&format!("?key={}&expires={e}", urlencoding::encode(k)));
    }
    let links = get_json(&link, &api).await.map_err(|e| {
        if e.contains("premium") { "Nexus Mods lets only Premium accounts download from the app directly. Use Mod manager download on the mod's page.".into() } else { e }
    })?;
    let uri = links[0]["URI"].as_str().ok_or("Nexus Mods gave no download link.")?.to_string();

    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("nexus-downloads");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    prune(&dir);
    let dest = dir.join(&name);
    let part = dir.join(format!("{}.part", name.to_string_lossy()));
    let mut r = client()?.get(&uri).timeout(std::time::Duration::from_secs(60 * 30)).send().await
        .and_then(|r| r.error_for_status()).map_err(|e| format!("Download failed: {}", e.without_url()))?;
    let total = r.content_length().unwrap_or(0);
    let mut file = std::fs::File::create(&part).map_err(|e| e.to_string())?;
    let (mut got, mut shown) = (0u64, 0u64);
    while let Some(chunk) = r.chunk().await.map_err(|e| format!("Download failed: {}", e.without_url()))? {
        std::io::Write::write_all(&mut file, &chunk).map_err(|e| e.to_string())?;
        got += chunk.len() as u64;
        let pct = if total > 0 { got * 100 / total } else { 0 };
        if pct != shown {
            shown = pct;
            let _ = app.emit("nexus_download_progress", serde_json::json!({ "fileId": file_id, "percent": pct }));
        }
    }
    drop(file);
    std::fs::rename(&part, &dest).map_err(|e| e.to_string())?;
    crate::ui_log::info("Nexus", format!("Downloaded {}", name.to_string_lossy()));
    Ok(dest.to_string_lossy().into_owned())
}

/// Removes downloads older than a day: each one is installed within moments of landing (the install reads it after the
/// command returns, so it cannot go right away).
fn prune(dir: &std::path::Path) {
    let day_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(24 * 60 * 60);
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        if e.metadata().and_then(|m| m.modified()).is_ok_and(|t| t < day_ago) {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

/// Opens a nexusmods.com page in the app's own Nexus window (one window, reused). A Mod manager download clicked there
/// is caught before Windows sees it.
#[tauri::command]
pub async fn xtra_nexus_open(app: AppHandle, url: String) -> Result<(), String> {
    let url = url::Url::parse(&url).map_err(|e| e.to_string())?;
    if !is_nexus(&url) {
        return Err("Only nexusmods.com pages open here.".into());
    }
    if let Some(w) = app.get_webview_window(WINDOW) {
        w.navigate(url).map_err(|e| e.to_string())?;
        let _ = w.unminimize();
        let _ = w.set_focus();
        return Ok(());
    }
    let handle = app.clone();
    let loader = app.clone();
    let (profile, extensions) = browser_dirs(&app)?;
    WebviewWindowBuilder::new(&app, WINDOW, WebviewUrl::External(url))
        .title("Nexus Mods")
        .inner_size(1180.0, 860.0)
        // its own browser profile: extensions need a WebView2 environment of their own, and the app's window has none
        .data_directory(profile)
        .browser_extensions_enabled(true)
        .extensions_path(extensions)
        .initialization_script(theme_script())
        .on_navigation(move |u| {
            if u.scheme() == "nxm" {
                return !on_link(u.as_str(), &handle);
            }
            // a link in a mod's description to another site opens in the browser, not in this window (signing in to
            // Nexus with another account stays here, so the sign-in lands in this window's profile)
            if u.scheme() == "https" && !is_nexus(u) && !u.host_str().is_some_and(|h| SIGN_IN.contains(&h)) {
                #[allow(deprecated)] // the shell plugin's open, as the frontend uses it
                let _ = tauri_plugin_shell::ShellExt::shell(&handle).open(u.as_str(), None);
                return false;
            }
            true
        })
        // a plain download (a Manual download, or a file link outside the Files tab) still installs through the app:
        // it lands in the app's Nexus cache, then the main window gets it like a Mod manager download
        .on_download(move |_, event| {
            match event {
                tauri::webview::DownloadEvent::Requested { destination, .. } => {
                    let name = destination.file_name().map(|n| n.to_owned());
                    if let (Ok(dir), Some(name)) = (loader.path().app_cache_dir().map(|d| d.join("nexus-downloads")), name) {
                        let _ = std::fs::create_dir_all(&dir);
                        *destination = dir.join(name);
                    }
                }
                tauri::webview::DownloadEvent::Finished { path: Some(path), success: true, .. } => {
                    let _ = loader.emit_to("main", "nexus-file", path.to_string_lossy().into_owned());
                    if let Some(w) = loader.get_webview_window(WINDOW) { let _ = w.close(); }
                }
                _ => {}
            }
            true
        })
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// uBlock Origin Lite for Edge, bundled (resources/ubol, its license beside it), unpacked once per version for the
/// Nexus window. A new version replaces the old folder.
const UBOL_ZIP: &[u8] = include_bytes!("../resources/ubol/uBOLite.edge.zip");
const UBOL_VERSION: &str = "2026.1026.1812";

/// repakxtra's look on nexusmods.com (resources/nexus-theme.css), put on each page of the Nexus window and inside its
/// web components by resources/nexus-theme.js, which runs before the page's own scripts.
fn theme_script() -> String {
    let css = include_str!("../resources/nexus-theme.css");
    include_str!("../resources/nexus-theme.js")
        .replace("__CSS__", &serde_json::to_string(&css).unwrap_or_default())
        .replace("__APP__", &serde_json::to_string(crate::xtra_edition::APP_NAME).unwrap_or_default())
}

/// The Nexus window's profile folder and its extensions folder (uBOL unpacked in it).
fn browser_dirs(app: &AppHandle) -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
    let base = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("nexus-browser");
    let extensions = base.join("extensions");
    let ubol = extensions.join(format!("ubol-{UBOL_VERSION}"));
    if !ubol.join("manifest.json").is_file() {
        let _ = std::fs::remove_dir_all(&extensions); // an older version
        let part = base.join("ubol.part");
        let _ = std::fs::remove_dir_all(&part);
        zip::ZipArchive::new(std::io::Cursor::new(UBOL_ZIP))
            .and_then(|mut z| z.extract(&part))
            .map_err(|e| format!("The ad blocker could not be unpacked: {e}"))?;
        std::fs::create_dir_all(&extensions).map_err(|e| e.to_string())?;
        std::fs::rename(&part, &ubol).map_err(|e| e.to_string())?;
    }
    Ok((base.join("profile"), extensions))
}

/// Links that came before the window listened; None once it does.
static HELD: std::sync::Mutex<Option<Vec<NxmLink>>> = std::sync::Mutex::new(Some(Vec::new()));

/// The window listens now: the links that came before it, and every later one as a "nexus-nxm" event.
#[tauri::command]
pub fn xtra_nexus_pending() -> Vec<NxmLink> {
    HELD.lock().unwrap().take().unwrap_or_default()
}

/// Sign-in pages Nexus sends people to (its Google, Discord, Steam, Apple and Facebook options, and its bot check).
const SIGN_IN: &[&str] = &["accounts.google.com", "discord.com", "steamcommunity.com", "appleid.apple.com", "www.facebook.com", "challenges.cloudflare.com"];

fn is_nexus(url: &url::Url) -> bool {
    url.scheme() == "https" && url.host_str().is_some_and(|h| h == "nexusmods.com" || h.ends_with(".nexusmods.com"))
}

/// At start, with a key saved: nxm:// links come to this copy again (the one that saved the key may be gone).
pub fn reclaim_nxm(app: &AppHandle) {
    #[cfg(any(windows, target_os = "linux"))]
    if saved_key().is_some() {
        use tauri_plugin_deep_link::DeepLinkExt;
        let _ = app.deep_link().register("nxm");
    }
    let _ = app;
}

fn parse_nxm(url: &str) -> Option<NxmLink> {
    let u = url::Url::parse(url).ok()?;
    if u.scheme() != "nxm" || !u.host_str()?.eq_ignore_ascii_case(GAME) {
        return None;
    }
    let parts: Vec<&str> = u.path_segments()?.collect();
    let [m, mod_id, f, file_id] = parts.as_slice() else { return None };
    if *m != "mods" || *f != "files" {
        return None;
    }
    let q = |name: &str| u.query_pairs().find(|(k, _)| k == name).map(|(_, v)| v.into_owned());
    Some(NxmLink { mod_id: mod_id.parse().ok()?, file_id: file_id.parse().ok()?, key: q("key")?, expires: q("expires")?.parse().ok()? })
}

/// The deep link handler's hook: true when `url` is an nxm:// link (handed to the window as "nexus-nxm", or ignored when
/// it is for another game). The link's key never reaches the log.
pub fn on_link(url: &str, app: &AppHandle) -> bool {
    if !url.to_ascii_lowercase().starts_with("nxm://") {
        return false;
    }
    match parse_nxm(url) {
        Some(link) => {
            // before the window listens (a link that started the app): kept until it asks (xtra_nexus_pending)
            let mut held = HELD.lock().unwrap();
            match held.as_mut() {
                Some(queue) => queue.push(link),
                None => { let _ = app.emit_to("main", "nexus-nxm", link); }
            }
            drop(held);
            if let Some(main) = app.get_webview_window("main") {
                let _ = main.unminimize();
                let _ = main.set_focus();
            }
            // off this thread: the Nexus window may be the one asking (its navigation handler)
            let h = app.clone();
            std::thread::spawn(move || if let Some(w) = h.get_webview_window(WINDOW) { let _ = w.close(); });
        }
        None => crate::ui_log::warn("Nexus", "Ignored a Nexus download link that is not for Marvel Rivals"),
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gallery_reads_full_size_pictures_once() {
        let page = r#"<img src="https://staticdelivery.nexusmods.com/mods/7106/images/thumbnails/2940/2940-1-2.png">
            <a href="https://staticdelivery.nexusmods.com/mods/7106/images/2940/2940-1746281003-494200017.png">
            <img src="https://staticdelivery.nexusmods.com/mods/7106/images/2940/2940-1746281003-494200017.png">
            <img src="https://staticdelivery.nexusmods.com/mods/7106/images/29401/29401-1-1.png">
            <img src="https://staticdelivery.nexusmods.com/mods/7106/images/2940/2940-1746392615-1299286637.jpg">"#;
        assert_eq!(gallery(page, 2940), vec![
            "https://staticdelivery.nexusmods.com/mods/7106/images/2940/2940-1746281003-494200017.png",
            "https://staticdelivery.nexusmods.com/mods/7106/images/2940/2940-1746392615-1299286637.jpg",
        ]);
    }

    #[test]
    fn reads_mod_manager_links() {
        let link = parse_nxm("nxm://marvelrivals/mods/12890/files/34857?key=a%2Bb&expires=1789340510&user_id=5");
        assert_eq!(link, Some(NxmLink { mod_id: 12890, file_id: 34857, key: "a+b".into(), expires: 1789340510 }));
        assert_eq!(parse_nxm("nxm://MarvelRivals/mods/1/files/2?key=k&expires=3").map(|l| l.file_id), Some(2), "any case");
        assert_eq!(parse_nxm("nxm://skyrimspecialedition/mods/1/files/2?key=k&expires=3"), None, "another game");
        assert_eq!(parse_nxm("nxm://marvelrivals/mods/1/files/2"), None, "no key");
        assert_eq!(parse_nxm("nxm://marvelrivals/collections/abc/revisions/2"), None, "a collection");
        assert_eq!(parse_nxm("repakx://install?file=x"), None);
    }
}
