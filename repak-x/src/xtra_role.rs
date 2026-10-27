//! repakxtra: Claim role on cable's Discord card (custom/discordClaim.ts). The app opens Discord's consent page in the
//! browser, the member authorizes repakxtra, and a Cloudflare Worker (kept outside this repo) gives the "repakxtra user"
//! role, then sends the browser to repakx://role-claimed?state=...&result=... . The app checks the state is the one it
//! made in the last 10 minutes and tells the card. The state is 32 random bytes from the OS, kept only in memory.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use rand::RngCore;
use tauri::Emitter;

/// repakxtra's Discord application (public, already in the app's presence code).
const CLIENT_ID: &str = "1563325728416604231";
/// The Worker's address, set once it is deployed (docs kept outside the repo, the setup steps). None: not set up yet.
const WORKER: Option<&str> = None;
const MAX_AGE: Duration = Duration::from_secs(10 * 60);
const RESULTS: [&str; 4] = ["ok", "not_member", "denied", "error"];

static PENDING: Mutex<Option<(String, Instant)>> = Mutex::new(None);

/// The consent page for `state`. Pure.
fn consent_url(worker: &str, state: &str) -> String {
    let redirect = format!("{}/callback", worker.trim_end_matches('/'));
    let mut url = url::Url::parse("https://discord.com/oauth2/authorize").expect("a fixed address");
    url.query_pairs_mut()
        .append_pair("client_id", CLIENT_ID)
        .append_pair("response_type", "code")
        .append_pair("scope", "identify")
        .append_pair("prompt", "consent")
        .append_pair("redirect_uri", &redirect)
        .append_pair("state", state);
    url.into()
}

/// Whether Claim role can work in this build (the Worker's address is set): the card disables it otherwise.
#[tauri::command]
pub fn xtra_role_ready() -> bool {
    WORKER.is_some()
}

/// Starts a claim: a new state (any older one stops counting) and the consent page to open.
#[tauri::command]
pub fn xtra_role_claim_start() -> Result<String, String> {
    let worker = WORKER.ok_or("Claim role is not set up yet")?;
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    let state: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    *PENDING.lock().unwrap_or_else(|e| e.into_inner()) = Some((state.clone(), Instant::now()));
    Ok(consent_url(worker, &state))
}

/// The result a role-claimed link carries, if it answers the claim in `pending` (same state, under 10 minutes old).
/// None for anything else: someone else's link, an old one, or a result the Worker never sends. Pure. The card also
/// matches the state, so an answer to an earlier claim never settles a newer one (discordClaim.ts answers).
fn accept(url: &str, pending: &Option<(String, Instant)>, now: Instant) -> Option<&'static str> {
    let parsed = url::Url::parse(url).ok()?;
    if parsed.scheme() != "repakx" || parsed.host_str() != Some("role-claimed") {
        return None;
    }
    let (want, made) = pending.as_ref()?;
    if now.saturating_duration_since(*made) > MAX_AGE {
        return None;
    }
    let get = |k: &str| parsed.query_pairs().find(|(key, _)| key == k).map(|(_, v)| v.into_owned());
    if get("state")? != *want {
        return None;
    }
    let result = get("result")?;
    RESULTS.iter().copied().find(|r| *r == result)
}

/// The deep link handler's hook: true when `url` is a role-claimed link (handled here, answered or ignored).
pub fn on_link(url: &str, app: &tauri::AppHandle) -> bool {
    if !url::Url::parse(url).is_ok_and(|u| u.scheme() == "repakx" && u.host_str() == Some("role-claimed")) {
        return false;
    }
    let mut pending = PENDING.lock().unwrap_or_else(|e| e.into_inner());
    match accept(url, &pending, Instant::now()) {
        Some(result) => {
            let state = pending.take().map(|(s, _)| s).unwrap_or_default(); // one answer per claim
            log::info!("[role] claim answered: {result}");
            let _ = app.emit("xtra-role-claimed", serde_json::json!({ "state": state, "result": result }));
        }
        None => log::info!("[role] ignored a role-claimed link that does not answer this app's claim"),
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    const S: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn pending() -> Option<(String, Instant)> {
        Some((S.to_string(), Instant::now()))
    }

    #[test]
    fn a_matching_state_answers() {
        let now = Instant::now();
        for r in RESULTS {
            assert_eq!(accept(&format!("repakx://role-claimed?state={S}&result={r}"), &pending(), now), Some(r));
        }
        assert_eq!(accept(&format!("repakx://role-claimed/?result=ok&state={S}&utm=x"), &pending(), now), Some("ok"), "order and extra junk do not matter");
    }

    #[test]
    fn anything_else_is_ignored() {
        let now = Instant::now();
        assert_eq!(accept(&format!("repakx://role-claimed?state={}&result=ok", "f".repeat(64)), &pending(), now), None, "wrong state");
        assert_eq!(accept(&format!("repakx://role-claimed?state={S}&result=ok"), &None, now), None, "no claim started");
        assert_eq!(accept(&format!("repakx://role-claimed?state={S}"), &pending(), now), None, "missing result");
        assert_eq!(accept(&format!("repakx://role-claimed?state={S}&result=admin"), &pending(), now), None, "unknown result");
        assert_eq!(accept(&format!("repakx://install?state={S}&result=ok"), &pending(), now), None, "another link");
        assert_eq!(accept("not a url", &pending(), now), None);
        let old = Some((S.to_string(), now));
        assert_eq!(accept(&format!("repakx://role-claimed?state={S}&result=ok"), &old, now + MAX_AGE + Duration::from_secs(1)), None, "expired");
        assert_eq!(accept(&format!("repakx://role-claimed?state={S}&result=ok"), &old, now + MAX_AGE - Duration::from_secs(1)), Some("ok"), "just in time");
    }

    #[test]
    fn the_consent_page_asks_for_identify_only() {
        let u = url::Url::parse(&consent_url("https://repakxtra-role.example.workers.dev/", S)).unwrap();
        let q: std::collections::HashMap<String, String> = u.query_pairs().into_owned().collect();
        assert_eq!(u.host_str(), Some("discord.com"));
        assert_eq!(q["scope"], "identify");
        assert_eq!(q["redirect_uri"], "https://repakxtra-role.example.workers.dev/callback");
        assert_eq!((q["state"].as_str(), q["prompt"].as_str(), q["response_type"].as_str()), (S, "consent", "code"));
    }

    #[test]
    fn a_claim_needs_the_worker_set() {
        assert_eq!(xtra_role_claim_start().is_err(), WORKER.is_none());
    }
}
