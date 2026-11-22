//! repakxtra: what changed before a crash (Settings > Crash reports' What changed?, and Copy setup report). The mod
//! operations the app saw finish (installs, Mod Updater results, on and off, deletes, loadout switches) and the app or
//! game updates it noticed, each with when and how it ended. Local and bounded (the newest MAX_EVENTS), mod names only:
//! never a folder, a user name or an id. The game sessions xtra_crash.rs keeps say when the game started and ended.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const MAX_EVENTS: usize = 2000;

/// One finished operation. `ok`: the mods it changed, `failed`: the ones it tried and could not (a partial batch has
/// both). `detail`: a loadout's name, a version, a game build.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Event {
    pub t: u64,
    pub kind: String,
    #[serde(default)]
    pub ok: Vec<String>,
    #[serde(default)]
    pub failed: Vec<String>,
    #[serde(default)]
    pub detail: String,
}

#[derive(Serialize, Deserialize, Default)]
struct Store {
    /// when recording began: before it nothing is known
    since: u64,
    #[serde(default)]
    events: Vec<Event>,
    /// the app version and game build last seen, to notice an update
    #[serde(default)]
    app: String,
    #[serde(default)]
    game: String,
}

fn store_path() -> PathBuf {
    dirs::config_dir().unwrap_or_else(|| PathBuf::from(".")).join("Repak-X").join("repakxtra-activity.json")
}

static WRITING: Mutex<()> = Mutex::new(());

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

fn load(path: &Path) -> Store {
    std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn save(path: &Path, s: &Store) {
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, serde_json::to_vec(s).unwrap_or_default()).is_ok() {
        let _ = std::fs::rename(&tmp, path);
    }
}

/// A mod's name as the Library shows it: the file name without folders, extension or priority suffix, and no user name.
pub(crate) fn mod_name(path: &str) -> String {
    let file = path.rsplit(['\\', '/']).next().unwrap_or(path);
    let stem = [".pak", ".bak_repak", ".utoc", ".ucas", ".zip", ".rar", ".7z"].iter().find_map(|x| {
        file.len().checked_sub(x.len()).filter(|&at| file[at..].eq_ignore_ascii_case(x)).map(|at| &file[..at])
    }).unwrap_or(file);
    let stem = regex_lite::Regex::new(r"(?i)(_\d+)?_P$").map(|re| re.replace(stem, "").into_owned()).unwrap_or_else(|_| stem.to_string());
    crate::xtra_crash::redact(&stem, &crate::xtra_crash::user_names())
}

fn push(path: &Path, e: Event) {
    let _one = WRITING.lock().unwrap_or_else(|e| e.into_inner());
    let mut s = load(path);
    if s.since == 0 { s.since = e.t; }
    s.events.push(e);
    let skip = s.events.len().saturating_sub(MAX_EVENTS);
    s.events.drain(..skip);
    save(path, &s);
}

/// Records an operation that finished: `ok` and `failed` are mod paths or names (kept as names only). Nothing when both
/// are empty and there is no detail (nothing changed).
pub(crate) fn record(kind: &str, ok: &[String], failed: &[String], detail: &str) {
    if ok.is_empty() && failed.is_empty() && detail.is_empty() { return; }
    let names = |v: &[String]| v.iter().map(|p| mod_name(p)).collect::<Vec<_>>();
    push(&store_path(), Event { t: now(), kind: kind.into(), ok: names(ok), failed: names(failed), detail: crate::xtra_crash::redact(detail, &crate::xtra_crash::user_names()) });
}

/// The frontend's operations (a loadout switch, a Mod Updater result): only kinds it may send.
#[tauri::command(async)]
pub fn xtra_activity_record(kind: String, ok: Vec<String>, failed: Vec<String>, detail: Option<String>) -> Result<(), String> {
    if !["loadout", "update", "update_failed"].contains(&kind.as_str()) { return Err(format!("not an activity kind: {kind}")); }
    record(&kind, &ok, &failed, detail.as_deref().unwrap_or(""));
    Ok(())
}

/// The game started: an app or game update since the last start is recorded first, so it shows before that launch.
pub(crate) fn note_versions(mods_dir: &Path) {
    let path = store_path();
    let _one = WRITING.lock().unwrap_or_else(|e| e.into_inner());
    let mut s = load(&path);
    let app = crate::xtra_update::version().to_string();
    let game = crate::xtra_broken::paks_dir(mods_dir).and_then(|p| crate::xtra_vfx::game_cl(&p)).map(|c| c.to_string()).unwrap_or_default();
    let t = now();
    if s.since == 0 { s.since = t; }
    // the first start only learns them: an update is a change from a version seen before
    if !s.app.is_empty() && s.app != app { s.events.push(Event { t, kind: "app_update".into(), ok: vec![], failed: vec![], detail: app.clone() }); }
    if !s.game.is_empty() && !game.is_empty() && s.game != game { s.events.push(Event { t, kind: "game_update".into(), ok: vec![], failed: vec![], detail: game.clone() }); }
    s.app = app;
    if !game.is_empty() { s.game = game; }
    save(&path, &s);
}

/// What changed before one crash: from the previous observed game launch through the crash. `coverage`: "full" (the
/// whole span was recorded), "partial" (recording began inside it, or no earlier launch is known), "none" (nothing was
/// recorded before the crash).
#[derive(Serialize, Debug, PartialEq)]
pub struct Timeline {
    pub crash: u64,
    /// the previous observed launch (the span starts here), when known
    pub from: Option<u64>,
    /// when the session that crashed started, when known
    pub started: Option<u64>,
    pub coverage: &'static str,
    /// oldest first
    pub events: Vec<Event>,
}

/// Pure: the timeline for a crash at `crash` from the sessions (start times), the store's `since`, and its events.
fn timeline_of(crash: u64, starts: &[(u64, Option<u64>)], since: u64, events: &[Event]) -> Timeline {
    // the session it crashed in: started before it and not ended long before it (xtra_crash.rs on_at's rule)
    let session = starts.iter().filter(|(s, e)| *s <= crash && crash <= e.map_or(s + 6 * 3600, |e| e + 120)).map(|(s, _)| *s).max();
    let from = starts.iter().map(|(s, _)| *s).filter(|s| *s < session.unwrap_or(crash)).max();
    let coverage = if since == 0 || since > crash { "none" } else if from.is_some_and(|f| since <= f) { "full" } else { "partial" };
    let events = events.iter().filter(|e| from.is_none_or(|f| e.t > f) && e.t <= crash).cloned().collect();
    Timeline { crash, from, started: session, coverage, events }
}

/// The timeline of the crash whose folder is `id` (xtra_recent_crashes' id): its own time, never another crash's.
#[tauri::command(async)]
pub fn xtra_crash_timeline(id: String) -> Result<Timeline, String> {
    if id.is_empty() || id.contains(['/', '\\']) || id.contains("..") { return Err("not a crash report".into()); }
    let folder = crate::crash_monitor::get_crash_log_path().join(&id);
    let crash = std::fs::metadata(&folder).and_then(|m| m.created()).map_err(|_| "That crash report is gone.".to_string())?
        .duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
    let s = load(&store_path());
    Ok(timeline_of(crash, &crate::xtra_crash::session_times(), s.since, &s.events))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(t: u64, kind: &str) -> Event { Event { t, kind: kind.into(), ok: vec!["A".into()], failed: vec![], detail: String::new() } }

    #[test]
    fn a_crash_gets_the_changes_since_the_launch_before_its_own() {
        // launches at 100 (ended 200) and 500 (crashed at 600): changes from after 100 through 600
        let starts = [(100, Some(200)), (500, None)];
        let events = [ev(50, "install"), ev(150, "enable"), ev(400, "install"), ev(550, "disable"), ev(700, "install")];
        let t = timeline_of(600, &starts, 10, &events);
        assert_eq!((t.from, t.started, t.coverage), (Some(100), Some(500), "full"));
        assert_eq!(t.events.iter().map(|e| e.t).collect::<Vec<_>>(), vec![150, 400, 550], "never after the crash, never before the earlier launch");
        // an older crash opened later still stops at its own time
        let older = timeline_of(180, &starts, 10, &events);
        assert_eq!((older.from, older.started), (None, Some(100)));
        assert_eq!(older.events.iter().map(|e| e.t).collect::<Vec<_>>(), vec![50, 150]);
        assert_eq!(older.coverage, "partial", "no earlier launch known");
    }

    #[test]
    fn coverage_says_what_was_recorded() {
        let starts = [(100, Some(200)), (500, None)];
        assert_eq!(timeline_of(600, &starts, 0, &[]).coverage, "none", "nothing recorded at all");
        assert_eq!(timeline_of(600, &starts, 700, &[]).coverage, "none", "recording began after the crash");
        assert_eq!(timeline_of(600, &starts, 300, &[]).coverage, "partial", "recording began inside the span");
        let empty = timeline_of(600, &starts, 50, &[]);
        assert_eq!((empty.coverage, empty.events.len()), ("full", 0), "covered and empty: No changes recorded");
    }

    #[test]
    fn names_carry_no_folder_or_priority() {
        assert_eq!(mod_name(r"C:\Games\Paks\~mods\Purple VFX_9999999_P.pak"), "Purple VFX");
        assert_eq!(mod_name("D:/x/Cool_P.bak_repak"), "Cool");
        assert_eq!(mod_name("Plain"), "Plain");
    }
}
