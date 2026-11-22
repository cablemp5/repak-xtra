//! repakxtra: what changed before a crash (Settings > Crash reports' What changed?, and Copy setup report). The mod
//! operations the app saw finish (installs, replacements, Mod Updater results, on and off, deletes, loadout switches) and
//! the app or game updates it noticed, each with when and how it ended. Local and bounded (the newest MAX_EVENTS, at most
//! MAX_NAMES names each), mod names only: never a folder, a user name or an id. The game sessions xtra_crash.rs keeps say
//! when the game started and ended.
//! Kept in memory and saved by a background writer a moment after a change, so a loadout switch of a hundred mods does
//! not rewrite the file a hundred times. A file that cannot be read (locked, damaged) is never replaced by an empty one.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const MAX_EVENTS: usize = 5000; // every mod a loadout switch turns on or off is its own event
const MAX_NAMES: usize = 50;
/// A loadout switch keeps every name it switched (up to this), so the timeline folds exactly its own toggles into it.
const MAX_LOADOUT_NAMES: usize = 1000;

/// One finished operation. `ok`: the mods it changed, `failed`: the ones it tried and could not (a partial batch has
/// both), at most MAX_NAMES each, with `n_ok`/`n_failed` the full counts. `detail`: a loadout's name, a version, a game
/// build. `from`: when a batch began (a loadout switch: its own toggles are between `from` and `t`).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct Event {
    pub t: u64,
    pub kind: String,
    #[serde(default)]
    pub ok: Vec<String>,
    #[serde(default)]
    pub failed: Vec<String>,
    #[serde(default)]
    pub n_ok: usize,
    #[serde(default)]
    pub n_failed: usize,
    #[serde(default)]
    pub detail: String,
    #[serde(default)]
    pub from: u64,
}

#[derive(Serialize, Deserialize, Default)]
struct Store {
    /// when what is kept begins: before it nothing is known (recording began, or older events were let go)
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

/// The store in memory: None until first read. `Err` when the file exists but could not be read: nothing is written then.
static STORE: Mutex<Option<Result<Store, String>>> = Mutex::new(None);
static SAVING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

fn read(path: &Path) -> Result<Store, String> {
    match std::fs::read(path) {
        Ok(b) => serde_json::from_slice(&b).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Store::default()),
        Err(e) => Err(e.to_string()),
    }
}

/// Runs `f` on the store in memory (read once). Nothing when the file could not be read: a locked or damaged file stays.
fn with_store<T>(f: impl FnOnce(&mut Store) -> T) -> Option<T> {
    let mut g = STORE.lock().unwrap_or_else(|e| e.into_inner());
    if g.is_none() { *g = Some(read(&store_path())); }
    match g.as_mut() {
        Some(Ok(s)) => Some(f(s)),
        Some(Err(e)) => { log::warn!("[activity] not recording, the history file could not be read: {e}"); None }
        None => None,
    }
}

static DIRTY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Saves the store now, off the caller's thread, from one writer at a time: changes made while it writes are saved by
/// its next pass, so a loadout switch costs a few writes, not one per mod, and nothing waits on a timer.
fn save_soon() {
    use std::sync::atomic::Ordering::SeqCst; // a store then a load on two flags: only SeqCst orders them
    DIRTY.store(true, SeqCst);
    if SAVING.swap(true, SeqCst) { return; }
    std::thread::spawn(|| loop {
        std::thread::sleep(std::time::Duration::from_millis(300)); // a switch of many mods lands in one write
        DIRTY.store(false, SeqCst);
        write_now();
        // done unless a change came meanwhile (and no other writer took over)
        SAVING.store(false, SeqCst);
        if !DIRTY.load(SeqCst) || SAVING.swap(true, SeqCst) { break; }
    });
}

fn write_now() {
    // a store that cannot be serialized is never written as an empty file
    if let Some(Ok(bytes)) = with_store(|s| serde_json::to_vec(s)) {
        let path = store_path();
        let tmp = path.with_extension("json.tmp");
        if let Some(dir) = path.parent() { let _ = std::fs::create_dir_all(dir); } // a fresh profile has no Repak-X folder yet
        if let Err(e) = std::fs::write(&tmp, bytes).and_then(|_| std::fs::rename(&tmp, &path)) {
            log::warn!("[activity] could not save the history: {e}");
        }
    }
}

/// The app is closing (main_tauri.rs ExitRequested): the writer's pass finishes, and a change it has not taken yet is
/// written here, so the last change made before closing is kept. Waits at most a second.
pub(crate) fn flush() {
    use std::sync::atomic::Ordering::SeqCst;
    for _ in 0..20 {
        // only as the one writer: never beside the background one on the same temp file
        if !SAVING.swap(true, SeqCst) {
            if DIRTY.swap(false, SeqCst) { write_now(); }
            SAVING.store(false, SeqCst);
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

/// Drops events past MAX_EVENTS, moving `since` to the newest one let go: a span before it is no longer covered.
fn push_into(s: &mut Store, e: Event) {
    if s.since == 0 { s.since = e.t; }
    s.events.push(e);
    let skip = s.events.len().saturating_sub(MAX_EVENTS);
    if skip > 0 {
        s.since = s.since.max(s.events[skip - 1].t);
        s.events.drain(..skip);
    }
}

/// A text with folders taken out (a path keeps only its last part) and no user name.
fn plain(text: &str) -> String {
    if text.is_empty() { return String::new(); }
    // a network path (\\server\share\...) goes whole to the end of the line, spaces too, and a drive path keeps only its last part
    static DIRS: std::sync::OnceLock<Option<(regex_lite::Regex, regex_lite::Regex)>> = std::sync::OnceLock::new();
    let no_dirs = DIRS.get_or_init(|| Some((regex_lite::Regex::new(r"[\\/]{2}[^\\/\s][^\\/\r\n]*(?:[\\/][^\r\n]*)?").ok()?, regex_lite::Regex::new(r"[A-Za-z]:[\\/](?:[^\\/\r\n]*[\\/])*").ok()?))).as_ref()
        .map_or_else(|| text.to_string(), |(unc, drive)| drive.replace_all(&unc.replace_all(text, ""), "").into_owned());
    // any other path: a backslash means one (names rarely hold one), and slashes count only before a file name with an
    // extension, so "Tank/Support/DPS on" stays a name and "Private Client\Draft.pak" keeps only "Draft.pak"
    let no_dirs = match no_dirs.rfind('\\') {
        Some(i) => no_dirs[i + 1..].to_string(),
        None => match no_dirs.rfind('/') {
            Some(i) if no_dirs[i + 1..].split_whitespace().next().is_some_and(|f| f.rsplit_once('.').is_some_and(|(n, x)| !n.is_empty() && (2..=5).contains(&x.len()) && x.chars().all(|c| c.is_ascii_alphanumeric()))) => no_dirs[i + 1..].to_string(),
            _ => no_dirs,
        },
    };
    crate::xtra_crash::redact(&no_dirs, &crate::xtra_crash::user_names())
}

/// A mod's name as the Library shows it: the file name without folders, extension or priority suffix, and no user name.
pub(crate) fn mod_name(path: &str) -> String {
    let file = path.rsplit(['\\', '/']).next().unwrap_or(path);
    let lower = file.to_ascii_lowercase();
    // the extensions are ASCII, so where one starts is a character boundary
    let stem = [".pak", ".bak_repak", ".utoc", ".ucas", ".zip", ".rar", ".7z"].iter().find(|x| lower.ends_with(*x)).map_or(file, |x| &file[..file.len() - x.len()]);
    static PRIORITY: std::sync::OnceLock<Option<regex_lite::Regex>> = std::sync::OnceLock::new();
    let stem = PRIORITY.get_or_init(|| regex_lite::Regex::new(r"(?i)(_\d+)?_P$").ok()).as_ref().map_or_else(|| stem.to_string(), |re| re.replace(stem, "").into_owned());
    crate::xtra_crash::redact(&stem, &crate::xtra_crash::user_names())
}

fn event(t: u64, kind: &str, ok: &[String], failed: &[String], detail: &str, from: u64) -> Event {
    let cap = if kind == "loadout" { MAX_LOADOUT_NAMES } else { MAX_NAMES };
    // one name per mod: a dropped .pak, .utoc and .ucas are one mod
    let unique = |v: &[String]| { let mut seen = std::collections::HashSet::new(); v.iter().map(|p| mod_name(p)).filter(|n| seen.insert(n.to_lowercase())).collect::<Vec<_>>() };
    let (ok, failed) = (unique(ok), unique(failed));
    Event { t, kind: kind.into(), ok: ok.iter().take(cap).cloned().collect(), failed: failed.iter().take(cap).cloned().collect(), n_ok: ok.len(), n_failed: failed.len(), detail: plain(detail), from }
}

/// Records an operation that finished: `ok` and `failed` are mod paths or names (kept as names only). Nothing when both
/// are empty and there is no detail (nothing changed).
pub(crate) fn record(kind: &str, ok: &[String], failed: &[String], detail: &str) {
    record_from(kind, ok, failed, detail, 0)
}

fn record_from(kind: &str, ok: &[String], failed: &[String], detail: &str, from: u64) {
    if ok.is_empty() && failed.is_empty() && detail.is_empty() { return; }
    // a batch's outcome is known when it ends: placed then. Its own on and off events stay (each confirmed as it happened),
    // so a crash during a loadout switch shows the switches made before it, and the timeline folds them into the batch
    let t = now();
    let e = event(t, kind, ok, failed, detail, from.min(t));
    if with_store(|s| push_into(s, e)).is_some() { save_soon(); }
}

/// The frontend's operations (a loadout switch, a Mod Updater result): only kinds it may send. `started`: when its batch
/// began.
#[tauri::command(async)]
pub fn xtra_activity_record(kind: String, ok: Vec<String>, failed: Vec<String>, detail: Option<String>, started: Option<u64>) -> Result<(), String> {
    if !["loadout", "update", "update_failed"].contains(&kind.as_str()) { return Err(format!("not an activity kind: {kind}")); }
    record_from(&kind, &ok, &failed, detail.as_deref().unwrap_or(""), started.unwrap_or(0));
    Ok(())
}

/// The game started at `start` (`fresh`: a new launch, not the app opening again during one): a game update since the
/// last start is recorded just before it (a game only updates before it runs), an app update just before a new launch,
/// or when it is noticed during one.
pub(crate) fn note_versions(mods_dir: &Path, start: u64, fresh: bool) {
    let app = crate::xtra_update::version().to_string();
    let game = crate::xtra_broken::paks_dir(mods_dir).and_then(|p| crate::xtra_vfx::game_cl(&p)).map(|c| c.to_string()).unwrap_or_default();
    let before = start.saturating_sub(1);
    let app_t = if fresh { before } else { now() };
    let changed = with_store(|s| {
        // the first start only learns them: an update is a change from a version seen before
        let mut changed = false;
        if !s.game.is_empty() && !game.is_empty() && s.game != game { push_into(s, event(before, "game_update", &[], &[], &game, 0)); changed = true; }
        if !s.app.is_empty() && s.app != app { push_into(s, event(app_t, "app_update", &[], &[], &app, 0)); changed = true; }
        changed |= s.app != app || (!game.is_empty() && s.game != game) || s.since == 0;
        // recording begins at this launch when the app saw it start, else now (it may have opened mid-game)
        if s.since == 0 { s.since = if fresh && now().saturating_sub(start) <= 60 { start } else { now() }; }
        s.app = app;
        if !game.is_empty() { s.game = game; }
        changed
    });
    if changed == Some(true) { save_soon(); }
}

/// What changed before one crash: from the previous observed game launch through the crash. `coverage`: "full" (the
/// whole span was recorded and the crash fell in an observed session), "partial" (recording began inside the span, no
/// earlier launch is known, or the app did not see the session it crashed in), "none" (nothing recorded before it).
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

/// Pure: the timeline for a crash at `crash` from the sessions (start and end), the store's `since`, and its events.
fn timeline_of(crash: u64, starts: &[(u64, Option<u64>)], since: u64, events: &[Event]) -> Timeline {
    // the session it crashed in: started before it and not ended long before it (xtra_crash.rs on_at's rule)
    let matched = starts.iter().filter(|(s, e)| *s <= crash && crash <= e.map_or(s + 6 * 3600, |e| e + 120)).max_by_key(|(s, _)| *s);
    // seen running when it crashed: a crash well after the session was seen ending may be an unseen relaunch, so that
    // session is not its own (its span then runs from the newest launch before the crash)
    let seen = matched.is_some_and(|(_, e)| e.is_none_or(|e| crash <= e + 10));
    let session = matched.filter(|_| seen).map(|(s, _)| *s);
    let from = starts.iter().map(|(s, _)| *s).filter(|s| *s < session.unwrap_or(crash)).max();
    let coverage = if since == 0 || since > crash { "none" } else if seen && from.is_some_and(|f| since <= f) { "full" } else { "partial" };
    // strictly before the crash second: one finished in the same second may have come after it
    let mut events: Vec<Event> = if coverage == "none" { Vec::new() } else { events.iter().filter(|e| from.is_none_or(|f| e.t > f) && e.t < crash).cloned().collect() };
    events.sort_by_key(|e| e.t); // oldest first: an update is stored dated before its launch, after newer events
    Timeline { crash, from, started: session, coverage, events }
}

/// Copy setup report's Recent activity when there is no crash: the newest 30 events, oldest first, and `since` (0: nothing
/// recorded yet), in a Timeline with no crash or session.
#[tauri::command(async)]
pub fn xtra_recent_activity() -> Result<Timeline, String> {
    with_store(|s| {
        let mut events = s.events.clone();
        events.sort_by_key(|e| e.t);
        let events = events.split_off(events.len().saturating_sub(30));
        Timeline { crash: now(), from: None, started: None, coverage: if s.since == 0 { "none" } else { "full" }, events }
    }).ok_or_else(|| "The history could not be read.".to_string())
}

/// The timeline of the crash whose folder is `id` (xtra_recent_crashes' id): its own time, never another crash's.
#[tauri::command(async)]
pub fn xtra_crash_timeline(id: String) -> Result<Timeline, String> {
    if id.is_empty() || id.starts_with('.') || id.contains(['/', '\\', ':']) { return Err("not a crash report".into()); }
    let folder = crate::crash_monitor::get_crash_log_path().join(&id);
    // the report's own folder, never a link or a file
    let crash = std::fs::symlink_metadata(&folder).ok().filter(|m| m.is_dir()).ok_or_else(|| "That crash report is gone.".to_string())?
        .created().map_err(|_| "That crash report is gone.".to_string())?
        .duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
    with_store(|s| timeline_of(crash, &crate::xtra_crash::session_times(), s.since, &s.events)).ok_or_else(|| "The history could not be read.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(t: u64, kind: &str) -> Event { Event { t, kind: kind.into(), ok: vec!["A".into()], ..Default::default() } }

    #[test]
    fn a_crash_gets_the_changes_since_the_launch_before_its_own() {
        // launches at 100 (ended 200) and 500 (crashed at 600): changes from after 100 through 600
        let starts = [(100, Some(200)), (500, None)];
        let events = [ev(50, "install"), ev(150, "enable"), ev(400, "install"), ev(550, "disable"), ev(600, "install"), ev(700, "install")];
        let t = timeline_of(600, &starts, 10, &events);
        assert_eq!((t.from, t.started, t.coverage), (Some(100), Some(500), "full"));
        assert_eq!(t.events.iter().map(|e| e.t).collect::<Vec<_>>(), vec![150, 400, 550], "never after the crash or in its second, never before the earlier launch");
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
        // the app did not see the session it crashed in (the crash is long after the last one ended)
        assert_eq!(timeline_of(9000, &[(100, Some(200))], 50, &[]).coverage, "partial", "an unobserved session is not full coverage");
    }

    #[test]
    fn letting_go_of_old_events_moves_since() {
        let mut s = Store { since: 5, ..Default::default() };
        for t in 0..(MAX_EVENTS as u64 + 3) { push_into(&mut s, ev(10 + t, "enable")); }
        assert_eq!(s.events.len(), MAX_EVENTS);
        assert_eq!(s.since, 12, "the newest event let go");
        assert_eq!(timeline_of(30, &[(8, Some(9)), (20, None)], s.since, &s.events).coverage, "partial", "an evicted span is never full");
    }

    #[test]
    fn a_crash_after_the_session_was_seen_ending_is_not_full() {
        assert_eq!(timeline_of(205, &[(50, Some(60)), (100, Some(200))], 10, &[]).coverage, "full", "the crash folder lands as the game closes");
        assert_eq!(timeline_of(300, &[(50, Some(60)), (100, Some(200))], 10, &[]).coverage, "partial", "100 s after it ended: maybe an unseen relaunch");
    }

    #[test]
    fn names_carry_no_folder_or_priority() {
        assert_eq!(plain(r"Mine \\server\Private Share\Draft"), "Mine ", "a network path goes whole, spaces too");
        assert_eq!(plain(r"\\server\PrivateShare"), "", "a share root too");
        assert_eq!(plain("Skins // Ranked on"), "Skins // Ranked on", "a double slash between words is a name");
        assert_eq!(plain(r"Mine \Private\Paid Client\Skin.pak"), "Skin.pak", "a path from a drive's root too");
        assert_eq!(plain(r"Private Client\Draft.pak"), "Draft.pak", "and a relative one");
        assert_eq!(plain("Tank/Support/DPS on"), "Tank/Support/DPS on", "slashes in a name stay");
        assert_eq!(mod_name(r"C:\Games\Paks\~mods\Purple VFX_9999999_P.pak"), "Purple VFX");
        assert_eq!(mod_name("D:/x/Cool_P.bak_repak"), "Cool");
        assert_eq!(mod_name("Plain"), "Plain");
        assert_eq!(mod_name("猫猫猫.utoc"), "猫猫猫", "never slices through a character");
        assert_eq!(mod_name("猫"), "猫");
        assert_eq!(plain(r"Mine C:\Users\Alice\Private Client\Draft.pak on"), "Mine Draft.pak on", "a path in a loadout name keeps only its last part");
        let e = event(1, "install", &(0..MAX_NAMES + 5).map(|i| format!("m{i}")).collect::<Vec<_>>(), &[], "", 0);
        let one = event(1, "install", &["A.pak".into(), "A.utoc".into(), "A.ucas".into()], &[], "", 0);
        assert_eq!((one.ok.len(), one.n_ok), (1, 1), "a dropped .pak, .utoc and .ucas are one mod");
        assert_eq!((e.ok.len(), e.n_ok), (MAX_NAMES, MAX_NAMES + 5), "names are capped, the count is kept");
    }
}
