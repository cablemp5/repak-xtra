//! repakxtra: the game's own engine log in each crash folder (<date>-<pid>.log), decrypted for Settings > Crash reports:
//! where and as whom the game crashed, its last events, the errors near the end, and which mods it mounted.
//!
//! Format from oZanderr/Rivals-Toolkit (MIT or Apache-2.0, crates/rivals-core/src/game_logs/container.rs and decode.rs,
//! notice in xtra_wem.NOTICE.md): "logversion000", then records framed as i32 LE size, payload, the same size again. Each
//! payload is AES-128-CTR (the key and IV below, a big-endian 128-bit counter starting at the IV for every record) over
//! zlib text, or raw text when compression failed. A plaintext <SHM_LOG_BEGIN> ... <SHM_LOG_END> trailer may follow.
//! A crashed process can stop mid-record: what was read is kept.

use aes::cipher::{BlockEncrypt, KeyInit};
use regex_lite::Regex;
use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const MAGIC: &[u8] = b"logversion000";
/// Build constants, the same from build 3922109 to 4042190
const KEY: &[u8; 16] = b"ezFAgrXnhBOZgFFD";
const IV: &[u8; 16] = b"_NMxNi0DK7_qHC_i";
const SHM_BEGIN: &[u8] = b"<SHM_LOG_BEGIN>";
const SHM_END: &[u8] = b"<SHM_LOG_END>";
/// Bounds: a log file over this is not read, and decoded text stops here (a long session's log is a few MB).
const MAX_LOG: usize = 64_000_000;
const MAX_TEXT: usize = 256_000_000;

/// AES-128-CTR in place, the counter starting at the IV.
fn ctr(data: &mut [u8]) {
    let cipher = aes::Aes128::new(KEY.into());
    let mut counter = u128::from_be_bytes(*IV);
    for chunk in data.chunks_mut(16) {
        let mut block = aes::Block::from(counter.to_be_bytes());
        cipher.encrypt_block(&mut block);
        chunk.iter_mut().zip(block).for_each(|(b, k)| *b ^= k);
        counter = counter.wrapping_add(1);
    }
}

/// One record's text: decrypted, then inflated when it is zlib. A cut-off stream keeps what inflated.
fn record(payload: &[u8], room: usize) -> Vec<u8> {
    let mut data = payload.to_vec();
    ctr(&mut data);
    if data.first() != Some(&0x78) {
        data.truncate(room);
        return data;
    }
    let mut text = Vec::new();
    // read_to_end keeps the bytes read before an error, so a truncated record keeps its first part
    let _ = flate2::read::ZlibDecoder::new(&data[..]).take(room as u64).read_to_end(&mut text);
    if text.is_empty() {
        text.extend_from_slice(b"[a log record would not decompress]\n");
    }
    text
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

/// The log's text, or None when the file is not an engine log.
pub(crate) fn decode(blob: &[u8]) -> Option<String> {
    let mut rest = blob.strip_prefix(MAGIC)?;
    let mut out = Vec::new();
    while rest.len() >= 4 && out.len() < MAX_TEXT {
        // the trailer starts where the next record would
        if find(&rest[..rest.len().min(32)], SHM_BEGIN).is_some() {
            break;
        }
        let size = i32::from_le_bytes(rest[..4].try_into().ok()?);
        if size <= 0 {
            break;
        }
        let size = size as usize;
        let room = MAX_TEXT - out.len();
        if rest.len() < 8 + size {
            // the last record, cut off by the crash: up to the trailer if one follows
            let tail = &rest[4..];
            out.extend(record(&tail[..find(tail, SHM_BEGIN).unwrap_or(tail.len())], room));
            break;
        }
        out.extend(record(&rest[4..4 + size], room));
        rest = &rest[8 + size..];
    }
    if let Some(at) = find(rest, SHM_BEGIN) {
        let trailer = &rest[at + SHM_BEGIN.len()..];
        let trailer = &trailer[..find(trailer, SHM_END).unwrap_or(trailer.len())];
        out.extend_from_slice(b"\n----- shared memory log -----\n");
        out.extend_from_slice(&trailer[..trailer.len().min(MAX_TEXT.saturating_sub(out.len()))]);
    }
    Some(String::from_utf8_lossy(&out).into_owned())
}

/// The crash folder a crash report names (xtra_recent_crashes `id`): a UECC folder directly in the game's crash folder.
fn crash_dir(id: &str) -> Result<PathBuf, String> {
    if !id.starts_with("UECC-") || id.contains(['/', '\\', ':']) || id.contains("..") {
        return Err("Not a crash folder".into());
    }
    let dir = crate::crash_monitor::get_crash_log_path().join(id);
    if dir.is_dir() { Ok(dir) } else { Err("That crash folder is gone".into()) }
}

/// The decoded engine log of a crash folder, None when it has none.
fn read_log(dir: &Path) -> Option<String> {
    std::fs::read_dir(dir).ok()?.flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x.eq_ignore_ascii_case("log")))
        .filter(|p| p.metadata().is_ok_and(|m| m.is_file() && m.len() <= MAX_LOG as u64))
        .find_map(|p| decode(&std::fs::read(p).ok()?))
}

// ---- what a crash report shows ----

#[derive(Serialize, Debug, PartialEq)]
pub struct Event {
    /// seconds before the log's last line
    secs: f32,
    text: String,
    /// the same event in a row (three bots respawning at once)
    count: u32,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct ErrorGroup {
    text: String,
    count: u32,
}

#[derive(Serialize, Debug, Default)]
pub struct LogSummary {
    /// "Practice Range"
    map: Option<String>,
    hero_id: Option<String>,
    /// "Namor", from character_data.json
    hero: Option<String>,
    /// the last 10 seconds, oldest first
    events: Vec<Event>,
    /// Error lines in the last 30 seconds, by kind, the most first
    errors: Vec<ErrorGroup>,
    /// the ~mods paks the game mounted (paths under ~mods, without .pak), and which of them were IoStore
    mounted: Vec<String>,
    iostore: usize,
    /// mods (on_key) that were on when the game started (xtra_crash sessions) but that the game did not mount.
    /// None when that session was not saved.
    not_mounted: Option<Vec<String>>,
}

const EVENT_MS: i64 = 10_000;
const ERROR_MS: i64 = 30_000;
const MAX_EVENTS: usize = 12;
const MAX_ERRORS: usize = 6;

/// A line's time in ms ("[2026.11.17-20.07.52:311 -0500]"), only for differences inside one log.
fn stamp(line: &str) -> Option<i64> {
    let b = line.as_bytes();
    if b.len() < 24 || b[0] != b'[' {
        return None;
    }
    let n = |r: std::ops::Range<usize>| line.get(r)?.parse::<i64>().ok();
    let (y, mo, d) = (n(1..5)?, n(6..8)?, n(9..11)?);
    let (h, mi, s, ms) = (n(12..14)?, n(15..17)?, n(18..20)?, n(21..24)?);
    // days from the civil date (Howard Hinnant's algorithm), so a crash past midnight still counts right
    let (y, mo) = if mo <= 2 { (y - 1, mo + 9) } else { (y, mo - 3) };
    let days = 365 * y + y.div_euclid(4) - y.div_euclid(100) + y.div_euclid(400) + (153 * mo + 2) / 5 + d;
    Some((((days * 24 + h) * 60 + mi) * 60 + s) * 1000 + ms)
}

/// "PracticeRange_S1" is "Practice Range", "TeamLobby_0000" is "Team Lobby".
fn map_name(raw: &str) -> String {
    let last = raw.rsplit('/').next().unwrap_or(raw);
    let mut parts: Vec<&str> = last.split('_').collect();
    while parts.len() > 1 && parts.last().is_some_and(|p| p.chars().all(|c| c.is_ascii_digit()) || (p.len() >= 2 && p.starts_with('S') && p[1..].chars().all(|c| c.is_ascii_digit()))) {
        parts.pop();
    }
    words(&parts.join(" "))
}

/// CamelCase split into words: "TripleKill" is "Triple Kill".
fn words(s: &str) -> String {
    let mut out = String::new();
    let chars: Vec<char> = s.chars().collect();
    for (i, &c) in chars.iter().enumerate() {
        if i > 0 && c.is_uppercase() && (chars[i - 1].is_lowercase() || chars.get(i + 1).is_some_and(|n| n.is_lowercase()) && chars[i - 1].is_uppercase()) {
            out.push(' ');
        }
        out.push(c);
    }
    out
}

/// The first letter upper case, the rest as it is (hero names keep theirs: "Star-Lord").
fn cap(s: &str) -> String {
    let mut c = s.chars();
    c.next().map(|f| f.to_uppercase().chain(c).collect()).unwrap_or_default()
}

fn rules() -> &'static [Regex; 9] {
    static R: OnceLock<[Regex; 9]> = OnceLock::new();
    R.get_or_init(|| [
        Regex::new(r"c_select_hero_world_loaded (\S+)").unwrap(),
        Regex::new(r"Browse: (/Game/[^?\s]+)").unwrap(),
        Regex::new(r"SetViewTarget\((\d{4})_CharacterBP").unwrap(),
        Regex::new(r"AMarvelBaseCharacter::(OnDeath|OnReborn): .*?Name=(\d{4})_CharacterBP").unwrap(),
        Regex::new(r"active_notifies (\w+)").unwrap(),
        Regex::new(r"GameplayCueNotify \S*/Cue_Ability_\w*?_(\d{4})\d*_BP\S* was not loaded").unwrap(),
        Regex::new(r"Mounted Pak file '[^']*?~mods/([^']+?)\.pak'").unwrap(),
        Regex::new(r#"Mounted IoStore container "[^"]*?~mods/([^"]+?)\.utoc""#).unwrap(),
        Regex::new(r"0x[0-9A-Fa-f]+").unwrap(),
    ])
}

/// A hero's name from its id, "a bot" for the 4000s (practice and AI bots), else "hero <id>".
fn who(id: &str, names: &dyn Fn(&str) -> Option<String>) -> String {
    names(id).unwrap_or_else(|| if id.starts_with('4') { "a bot".into() } else { format!("hero {id}") })
}

/// What a crash report shows from the log's text. `on` is the session's mods (on_key), when saved. Pure.
fn summarize(text: &str, on: Option<Vec<String>>, names: &dyn Fn(&str) -> Option<String>) -> LogSummary {
    let [world, browse, view, life, notify, cue, pak, io, hex] = rules();
    let end = text.lines().rev().find_map(stamp);
    let mut s = LogSummary::default();
    let mut errors: Vec<ErrorGroup> = Vec::new();
    let mut iostore = std::collections::HashSet::new();
    let mut last_ms = None;
    for line in text.lines() {
        if let Some(t) = stamp(line) {
            last_ms = Some(t);
        }
        let ago = end.zip(last_ms).map(|(e, t)| e - t);
        if let Some(c) = pak.captures(line) {
            s.mounted.push(c[1].to_string());
        } else if let Some(c) = io.captures(line) {
            iostore.insert(c[1].to_lowercase());
        }
        let map = world.captures(line).or_else(|| browse.captures(line)).map(|c| map_name(&c[1]));
        if let Some(m) = &map {
            s.map = Some(m.clone());
        }
        if let Some(c) = view.captures(line) {
            s.hero_id = Some(c[1].to_string());
        }
        if let Some(t) = line.find(": Error: ").filter(|_| ago.is_some_and(|a| a <= ERROR_MS)) {
            let msg: String = hex.replace_all(line[t + 9..].trim(), "0x…").chars().take(200).collect();
            match errors.iter_mut().find(|e| e.text == msg) {
                Some(e) => e.count += 1,
                None => errors.push(ErrorGroup { text: msg, count: 1 }),
            }
        }
        let Some(ago) = ago.filter(|a| *a <= EVENT_MS) else { continue };
        let text = if let Some(c) = life.captures(line) {
            let mine = s.hero_id.as_deref() == Some(&c[2]);
            match (&c[1], mine) {
                ("OnDeath", true) => "You died".to_string(),
                ("OnDeath", false) => cap(&format!("{} died", who(&c[2], names))),
                (_, true) => "You respawned".to_string(),
                _ => cap(&format!("{} respawned", who(&c[2], names))),
            }
        } else if let Some(c) = notify.captures(line) {
            cap(&words(&c[1]).to_lowercase())
        } else if let Some(c) = cue.captures(line) {
            cap(&format!("{} ability effect loaded for the first time", who(&c[1], names)))
        } else if let Some(m) = map {
            format!("Loaded {m}")
        } else {
            continue;
        };
        let secs = ago as f32 / 1000.0;
        match s.events.last_mut() {
            Some(e) if e.text == text && (e.secs - secs).abs() < 0.5 => e.count += 1,
            _ => s.events.push(Event { secs, text, count: 1 }),
        }
    }
    s.hero = s.hero_id.as_deref().and_then(names);
    let skip = s.events.len().saturating_sub(MAX_EVENTS);
    s.events.drain(..skip);
    errors.sort_by(|a, b| b.count.cmp(&a.count)); // stable: first seen first among equals
    errors.truncate(MAX_ERRORS);
    s.errors = errors;
    s.mounted.sort_by_key(|m| m.to_lowercase());
    s.mounted.dedup_by(|a, b| a.eq_ignore_ascii_case(b));
    s.iostore = s.mounted.iter().filter(|m| iostore.contains(&m.to_lowercase())).count();
    let mounted: std::collections::HashSet<String> = s.mounted.iter().map(|m| m.to_lowercase().replace('\\', "/")).collect();
    s.not_mounted = on.map(|keys| keys.into_iter().filter(|k| k.split_once("/~mods/").is_some_and(|(_, rel)| !mounted.contains(rel))).collect());
    s
}

/// The values the log keeps under id-like keys (uid=732639096, "transid":"D62A..."), 6 characters or more with a digit.
/// The game also prints them bare (Saved/Config/732639096/, a dict key), so redact_log takes them out everywhere.
fn learned_ids(text: &str) -> Vec<String> {
    static KEYED: OnceLock<Regex> = OnceLock::new();
    let re = KEYED.get_or_init(|| Regex::new(r#"(?i)\b(?:\w*(?:uid|udid|token|ticket|machine_?id|device_?id|account_?id|session_?id|transid|transaction_?id|client_?id)|aid|ci)["']?\s*[:=]\s*["']?([^\s"'&,;<>(){}\[\]\\]+)"#).unwrap());
    let mut ids: Vec<String> = re.captures_iter(text).map(|c| c[1].to_string())
        .filter(|v| v.len() >= 6 && v.bytes().any(|b| b.is_ascii_digit())).collect();
    ids.sort_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b))); // longest first, so no id is cut by a shorter one
    ids.dedup();
    ids
}

/// Takes out what the engine log holds about the player besides redact()'s rules: login tokens (JWTs, base64 JSON), platform
/// handles ("name@steam"), NetEase account fields, and every `known` id (learned_ids of the whole log) wherever it stands.
fn redact_log(text: &str, users: &[String], known: &[String]) -> String {
    static RULES: OnceLock<[(Regex, &'static str); 3]> = OnceLock::new();
    let rules = RULES.get_or_init(|| [
        // base64 of '{"': JWTs and the login JSON the SDK logs encoded
        (Regex::new(r"eyJ[\w+/=.-]{6,}").unwrap(), "<token>"),
        (Regex::new(r#"(?i)(["']?\b(?:aid|nick_?name|role_?name|user_?name|open_?id|login_?name|phone)["']?\s*[:=]\s*["']?)[^\s"'&,;<>)]+"#).unwrap(), "${1}<redacted>"),
        (Regex::new(r"[\w.+-]+@[A-Za-z][\w-]*").unwrap(), "<handle>"),
    ]);
    // redact() first: its email rule takes dotted addresses whole before the handle rule
    let mut out = crate::xtra_crash::redact(text, users);
    for (re, with) in rules {
        out = re.replace_all(&out, *with).into_owned();
    }
    if !known.is_empty() {
        let any = known.iter().map(|v| regex_lite::escape(v)).collect::<Vec<_>>().join("|");
        if let Ok(re) = Regex::new(&any) {
            out = crate::xtra_crash::replace_words(&out, &re, "<id>");
        }
    }
    out
}

fn summary_of(id: &str) -> Result<Option<LogSummary>, String> {
    let dir = crash_dir(id)?;
    let Some(text) = read_log(&dir) else { return Ok(None) };
    let time = dir.metadata().and_then(|m| m.created()).ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs());
    let on = time.and_then(crate::xtra_crash::xtra_mods_on_at);
    let mut s = summarize(&text, on, &crate::character_data::get_character_name_from_id);
    let (users, known) = (crate::xtra_crash::user_names(), learned_ids(&text));
    for e in &mut s.errors {
        e.text = redact_log(&e.text, &users, &known);
    }
    Ok(Some(s))
}

/// Settings > Crash reports: what a crash's engine log says (None when the folder holds none).
#[tauri::command]
pub async fn xtra_crash_log_summary(id: String) -> Result<Option<LogSummary>, String> {
    tauri::async_runtime::spawn_blocking(move || summary_of(&id)).await.map_err(|e| e.to_string())?
}

/// Settings > Crash reports Copy log and Save log: the decrypted log, redacted for sharing.
#[tauri::command]
pub async fn xtra_crash_log_text(id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let text = read_log(&crash_dir(&id)?).ok_or("This crash has no engine log")?;
        Ok(redact_log(&text, &crate::xtra_crash::user_names(), &learned_ids(&text)))
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn zlib(text: &str) -> Vec<u8> {
        let mut z = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        z.write_all(text.as_bytes()).unwrap();
        z.finish().unwrap()
    }

    fn framed(plain: &[u8]) -> Vec<u8> {
        let mut payload = plain.to_vec();
        ctr(&mut payload); // CTR is its own inverse
        let size = (payload.len() as i32).to_le_bytes();
        [&size[..], &payload, &size].concat()
    }

    #[test]
    fn decodes_zlib_and_raw_records_a_cut_record_and_the_trailer() {
        let long: String = (0..2000).map(|i| format!("line {i}\n")).collect();
        let mut log = MAGIC.to_vec();
        log.extend(framed(&zlib("first\n")));
        log.extend(framed(b"raw text\n"));
        let mut cut = framed(&zlib(&long));
        cut.truncate(cut.len() / 2); // the crash stopped writing halfway
        log.extend(cut);
        let text = decode(&log).unwrap();
        assert!(text.starts_with("first\nraw text\nline 0\n"), "{}", &text[..40]);
        assert!(text.len() > 100 && !text.contains("line 1999"), "the cut record keeps its first part only");

        let mut with_trailer = MAGIC.to_vec();
        with_trailer.extend(framed(&zlib("a\n")));
        with_trailer.extend(b"<SHM_LOG_BEGIN>ring text<SHM_LOG_END>");
        assert_eq!(decode(&with_trailer).unwrap(), "a\n\n----- shared memory log -----\nring text");
        assert_eq!(decode(b"not a log"), None);
        assert_eq!(decode(MAGIC).unwrap(), "", "no records");
    }

    #[test]
    fn the_counter_runs_big_endian_from_the_iv_for_each_record() {
        // the first keystream block is AES(IV), the second AES(IV + 1)
        let cipher = aes::Aes128::new(KEY.into());
        let mut zeros = [0u8; 32];
        ctr(&mut zeros);
        let mut b0 = aes::Block::from(*IV);
        cipher.encrypt_block(&mut b0);
        let mut b1 = aes::Block::from((u128::from_be_bytes(*IV) + 1).to_be_bytes());
        cipher.encrypt_block(&mut b1);
        assert_eq!(&zeros[..16], &b0[..]);
        assert_eq!(&zeros[16..], &b1[..]);
    }

    const LOG: &str = "\
LogPakFile: Display: Mounted Pak file '../../../Marvel/Content/Paks/~mods/Cool_9999999_P.pak', mount point: '../../../'
LogPakFile: Display: Mounted Pak file '../../../Marvel/Content/Paks/~mods/Sub/Io_9999999_P.pak', mount point: '../../../'
LogPakFile: Display: Mounted IoStore container \"../../../Marvel/Content/Paks/~mods/Sub/Io_9999999_P.utoc\"
LogPakFile: Display: Mounted Pak file '../../../Marvel/Content/Paks/pakchunk0-Windows.pak', mount point: '../../../'
LogPakFile: Warning: Invalid Pak file ../../../Marvel/Content/Paks/~mods/Cool_9999999_P.pak recorded
[2026.11.17-23.59.10:000 -0500][  1][Bid:1]LogPyLevelLoadSubsystem: Display: c_select_hero_world_loaded PracticeRange_S1
[2026.11.17-23.59.20:000 -0500][  2][Bid:1]LogTeamVisualEffect: Error: old error, 0x1234
[2026.11.17-23.59.45:000 -0500][  3][Bid:1]LogPlayerView: Display: PracticeRange MarvelPlayerCameraManager::SetViewTarget(1045_CharacterBP_C_2147442113)
[2026.11.17-23.59.52:000 -0500][  4][Bid:1]LogAbilitySystem: Display: GameplayCueNotify /Game/Marvel/Characters/1045/1045001/Cues/104501/Cue_Ability_Loop_10450101_BP.Cue_Ability_Loop_10450101_BP_C was not loaded when GameplayCue was invoked.
[2026.11.17-23.59.55:000 -0500][  5][Bid:1]LogCharacter: Display: AMarvelBaseCharacter::OnDeath: UID:30, Name=4016_CharacterBP_C_1, bDeathReplay=false
[2026.11.17-23.59.55:002 -0500][  5][Bid:1]LogPyCommonAudioComponent: Display: active_notifies TripleKill
[2026.11.17-23.59.56:000 -0500][  6][Bid:1]LogTeamVisualEffect: Error: FTeamVisual::GetEnemyParam called without CachedSubsystem, returning 0.
[2026.11.17-23.59.57:000 -0500][  7][Bid:1]LogCharacter: Display: AMarvelBaseCharacter::OnReborn: UID:18, Name=4016_CharacterBP_C_2, bDeathReplay=false
[2026.11.17-23.59.57:001 -0500][  7][Bid:1]LogCharacter: Display: AMarvelBaseCharacter::OnReborn: UID:20, Name=4016_CharacterBP_C_3, bDeathReplay=false
[2026.11.17-23.59.58:000 -0500][  8][Bid:1]LogTeamVisualEffect: Error: FTeamVisual::GetEnemyParam called without CachedSubsystem, returning 0.
[2026.11.18-00.00.01:000 -0500][  9][Bid:1]LogCharacter: Display: AMarvelBaseCharacter::OnDeath: UID:1, Name=1045_CharacterBP_C_2147442113, bDeathReplay=false
[2026.11.18-00.00.02:000 -0500][ 10][Bid:1]LogCore: Warning: Panic Mode
";

    #[test]
    fn summarizes_where_who_the_last_seconds_errors_and_mounts() {
        let names = |id: &str| (id == "1045").then(|| "Namor".to_string());
        let on = Some(vec!["c:/game/paks/~mods/cool_9999999_p".into(), "c:/game/paks/~mods/sub/io_9999999_p".into(), "c:/game/paks/~mods/gone_9999999_p".into()]);
        let s = summarize(LOG, on, &names);
        assert_eq!(s.map.as_deref(), Some("Practice Range"));
        assert_eq!((s.hero_id.as_deref(), s.hero.as_deref()), (Some("1045"), Some("Namor")));
        let ev: Vec<(String, u32)> = s.events.iter().map(|e| (format!("{:.1} {}", e.secs, e.text), e.count)).collect();
        assert_eq!(ev, [
            ("10.0 Namor ability effect loaded for the first time".into(), 1),
            ("7.0 A bot died".into(), 1),
            ("7.0 Triple kill".into(), 1),
            ("5.0 A bot respawned".into(), 2),
            ("1.0 You died".into(), 1),
        ], "the last 10 s across midnight, repeats folded, the player's own hero is you");
        assert_eq!(s.errors, [ErrorGroup { text: "FTeamVisual::GetEnemyParam called without CachedSubsystem, returning 0.".into(), count: 2 }],
            "only the last 30 s, grouped");
        assert_eq!(s.mounted, ["Cool_9999999_P", "Sub/Io_9999999_P"], "only ~mods, Invalid Pak lines are no problem");
        assert_eq!(s.iostore, 1);
        assert_eq!(s.not_mounted, Some(vec!["c:/game/paks/~mods/gone_9999999_p".to_string()]));
        assert_eq!(summarize(LOG, None, &names).not_mounted, None, "no saved session: no comparison");
    }

    #[test]
    fn names_maps_and_events_in_plain_words() {
        assert_eq!(map_name("PracticeRange_S1"), "Practice Range");
        assert_eq!(map_name("/Game/Marvel/Maps/TeamLobby/TeamLobby_0000"), "Team Lobby");
        assert_eq!(map_name("ClientEntry"), "Client Entry");
        assert_eq!(cap(&words("DoubleKill").to_lowercase()), "Double kill");
        assert_eq!(cap(&format!("{} died", who("1014", &|_| Some("Star-Lord".into())))), "Star-Lord died", "a hero keeps its own capitals");
        assert_eq!(cap(&format!("{} died", who("4016", &|_| None))), "A bot died");
        assert_eq!(words("UIPanel"), "UI Panel");
        assert_eq!(stamp("[2026.11.17-20.07.52:311 -0500][ 1]x").unwrap() - stamp("[2026.11.17-20.07.51:300 -0500]x").unwrap(), 1011);
        assert_eq!(stamp("LogCore: no time"), None);
    }

    #[test]
    fn the_shared_log_has_no_login_secrets() {
        let line = r#"{"uid":"76561199866094042","aid":46466993,"sdkuid":"1294405327","account_app_channel":"x20naxx2gb@steam","access_token":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.abc","nickname":"Bob","login_json":"eyJhaWQiOiI0NjQ2Njk5MyJ9","x":"AAAA-eyJhdHAiOiA3fQ==-3b"} C:\Users\Alice\AppData uid=732639096 mail a.b@example.com"#;
        let line = format!("{line} 'member_info': {{732639096: {{}}}} path='/Saved/Config/732639096/x' fetch_id='11001_732639096_17' \"transid\":\"D62AD1B59865\",\"ci\":\"D62AD1B59865\" UID:30");
        let out = redact_log(&line, &["Alice".to_string()], &learned_ids(&line));
        for secret in ["76561199866094042", "46466993", "1294405327", "x20naxx2gb", "eyJ", "Bob", "Alice", "732639096", "a.b@example", "D62AD1B59865"] {
            assert!(!out.contains(secret), "{secret} left in {out}");
        }
        assert!(out.contains(r"C:\Users\<user>\AppData"), "{out}");
        assert_eq!(redact_log("PracticeRange_S1 TripleKill 7326390961", &[], &["732639096".into()]), "PracticeRange_S1 TripleKill 7326390961", "only whole ids");
    }

    #[test]
    fn only_uecc_folders_in_the_crash_folder() {
        for bad in ["..", "UECC-..\\x", "UECC-a/b", "C:\\Windows", "other", "UECC-x:y"] {
            assert!(crash_dir(bad).is_err(), "{bad}");
        }
    }

    /// cargo test -p repak-x --bin REPAK-X real_crash_logs -- --ignored --nocapture
    /// Every crash folder on this PC: the summary, and the shared text without the user name or a login secret.
    #[test]
    #[ignore]
    fn real_crash_logs() {
        let users = crate::xtra_crash::user_names();
        for e in std::fs::read_dir(crate::crash_monitor::get_crash_log_path()).unwrap().flatten() {
            let id = e.file_name().to_string_lossy().into_owned();
            let Ok(Some(s)) = summary_of(&id) else { println!("{id}: no log"); continue };
            println!("{id}: {}", serde_json::to_string_pretty(&s).unwrap());
            let raw = read_log(&e.path()).unwrap();
            let known = learned_ids(&raw);
            let text = redact_log(&raw, &users, &known);
            println!("{} ids learned", known.len());
            for bad in users.iter().map(String::as_str).chain(["eyJ", "7656119"]).chain(known.iter().map(String::as_str)) {
                assert!(!text.to_lowercase().contains(&bad.to_lowercase()), "{bad} in the shared log of {id}");
            }
            println!("{} lines shared", text.lines().count());
        }
    }
}
