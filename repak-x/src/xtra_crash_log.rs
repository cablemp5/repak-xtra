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
/// Where decode puts the trailer, so summarize reads only the log before it
const TRAILER: &str = "\n----- shared memory log -----\n";
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
    // a zlib header (deflate, 0x78, header check), not just raw text that starts with "x"
    let zlib = data.len() >= 2 && data[0] == 0x78 && u16::from_be_bytes([data[0], data[1]]) % 31 == 0 && data[1] & 0x20 == 0; // no preset dictionary: "x " is text
    if !zlib {
        data.truncate(room);
        return data;
    }
    let mut text = Vec::new();
    // read_to_end keeps the bytes read before an error, so a truncated record keeps its first part
    let _ = flate2::read::ZlibDecoder::new(&data[..]).take(room as u64).read_to_end(&mut text);
    if text.is_empty() {
        // text that only looked like a zlib header ("x^...") is kept as it is
        if std::str::from_utf8(&data).is_ok() {
            data.truncate(room);
            return data;
        }
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
        // the trailer starts where the next record would, after any padding
        let pad = rest.iter().take_while(|b| b.is_ascii_whitespace() || **b == 0).count();
        if rest[pad..].starts_with(SHM_BEGIN) {
            break;
        }
        let size = i32::from_le_bytes(rest[..4].try_into().ok()?);
        if size <= 0 {
            break;
        }
        let (size, body, room) = (size as usize, &rest[4..], MAX_TEXT - out.len());
        // a whole record ends with its size again
        if body.get(size..size + 4) == Some(&(size as i32).to_le_bytes()[..]) {
            out.extend(record(&body[..size], room));
            rest = &body[size + 4..];
            continue;
        }
        // the last record, cut off by the crash: up to its size or the trailer that follows the cut, whichever is first.
        // The trailer is looked for a marker's length past the size too, so one that starts just before it is kept whole.
        let cut = body.len().min(size);
        let end = find(&body[..body.len().min(size + SHM_BEGIN.len())], SHM_BEGIN).map_or(cut, |at| at.min(cut));
        out.extend(record(&body[..end], room));
        rest = &body[end..];
        break;
    }
    if let Some(at) = find(rest, SHM_BEGIN) {
        let trailer = &rest[at + SHM_BEGIN.len()..];
        let trailer = &trailer[..find(trailer, SHM_END).unwrap_or(trailer.len())];
        out.extend_from_slice(TRAILER.as_bytes());
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
    // symlink_metadata: a link or junction named UECC-* is not followed out of the crash folder
    if std::fs::symlink_metadata(&dir).is_ok_and(|m| m.is_dir()) { Ok(dir) } else { Err("That crash folder is gone".into()) }
}

/// The decoded engine log of a crash folder, None when it has none.
fn read_log(dir: &Path) -> Option<String> {
    std::fs::read_dir(dir).ok()?.flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x.eq_ignore_ascii_case("log")))
        .filter(|p| std::fs::symlink_metadata(p).is_ok_and(|m| m.is_file()))
        .find_map(|p| decode(&crate::xtra_crash::read_capped(&p, MAX_LOG)))
}

// ---- what a crash report shows ----

#[derive(Serialize, Debug, PartialEq, Clone)]
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
    /// the last 10 seconds, oldest first, the newest MAX_EVENTS, and how many earlier ones were left out
    events: Vec<Event>,
    events_more: usize,
    /// the event the summary line names: the newest that is not a bot respawning (they respawn every few seconds)
    headline: Option<Event>,
    /// Error lines in the last 30 seconds, by kind, the most first, and how many kinds were left out
    errors: Vec<ErrorGroup>,
    errors_more: usize,
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
        // the whole object name ("1045_CharacterBP_C_2147442113"), so another of the same hero is not "you"
        Regex::new(r"SetViewTarget\(((\d{4})_CharacterBP_C_\d+)").unwrap(),
        Regex::new(r"AMarvelBaseCharacter::(OnDeath|OnReborn): .*?Name=((\d{4})_CharacterBP_C_\d+)").unwrap(),
        Regex::new(r"active_notifies (\w+)").unwrap(),
        Regex::new(r"GameplayCueNotify \S*/Cue_Ability_\w*?_(\d{4})\d*_BP\S* was not loaded").unwrap(),
        Regex::new(r"(?i)Mounted Pak file '[^']*?~mods[\\/]([^']+?)\.pak'").unwrap(),
        Regex::new(r#"(?i)Mounted IoStore container "[^"]*?~mods[\\/]([^"]+?)\.utoc""#).unwrap(),
        Regex::new(r"0x[0-9A-Fa-f]+").unwrap(),
    ])
}

/// A hero's name from its id, "a bot" for the 4000s (practice and AI bots), else "hero <id>".
fn who(id: &str, names: &dyn Fn(&str) -> Option<String>) -> String {
    names(id).unwrap_or_else(|| if id.starts_with('4') { "a bot".into() } else { format!("hero {id}") })
}

/// What a crash report shows from the log's text. `on` is the session's mods (on_key), when saved. `clean` redacts an
/// error line before it is cut and grouped, so lines that differ only by a hidden id are one group. Pure.
fn summarize(text: &str, on: Option<Vec<String>>, names: &dyn Fn(&str) -> Option<String>, clean: &dyn Fn(&str) -> String) -> LogSummary {
    let [world, browse, view, life, notify, cue, pak, io, hex] = rules();
    // the shared memory trailer repeats lines from before, with its own times: only the log itself counts
    let text = text.split(TRAILER).next().unwrap_or(text);
    let end = text.lines().rev().find_map(stamp);
    let mut s = LogSummary::default();
    let (mut errors, mut error_at): (Vec<ErrorGroup>, std::collections::HashMap<String, usize>) = Default::default();
    let mut cleaned: std::collections::HashMap<String, String> = Default::default();
    let mut paks: Vec<String> = Vec::new();
    let mut iostore = std::collections::HashSet::new();
    let (mut last_ms, mut me): (Option<i64>, Option<String>) = (None, None);
    for line in text.lines() {
        if let Some(t) = stamp(line) {
            last_ms = Some(t);
        }
        // lines a thread wrote a moment late can sort after the last one: no negative times
        let ago = end.zip(last_ms).map(|(e, t)| (e - t).max(0));
        if let Some(c) = pak.captures(line) {
            paks.push(c[1].replace('\\', "/"));
        } else if let Some(c) = io.captures(line) {
            let rel = c[1].replace('\\', "/");
            iostore.insert(rel.to_lowercase());
            paks.push(rel); // an IoStore mod counts as loaded even if its .pak line is missing
        }
        let map = world.captures(line).or_else(|| browse.captures(line)).map(|c| map_name(&c[1]));
        if let Some(m) = &map {
            if s.map.as_ref() != Some(m) {
                (s.hero_id, me) = (None, None); // a new map: the hero is picked again
            }
            s.map = Some(m.clone());
        }
        if let Some(c) = view.captures(line) {
            (me, s.hero_id) = (Some(c[1].to_string()), Some(c[2].to_string()));
        }
        // "Invalid Pak file ... recorded" is printed for every working legacy pak: never a problem
        if let Some(t) = line.find(": Error: ").filter(|_| ago.is_some_and(|a| a <= ERROR_MS) && !(line.contains("Invalid Pak file") && line.trim_end().ends_with("recorded"))) {
            // an error printed every frame is redacted once, not once per line
            let raw = hex.replace_all(line[t + 9..].trim(), "0x…").into_owned();
            let msg = cleaned.entry(raw).or_insert_with_key(|r| clean(r).chars().take(200).collect()).clone();
            match error_at.get(&msg) {
                Some(&i) => errors[i].count += 1,
                None => {
                    error_at.insert(msg.clone(), errors.len());
                    errors.push(ErrorGroup { text: msg, count: 1 });
                }
            }
        }
        let Some(ago) = ago.filter(|a| *a <= EVENT_MS) else { continue };
        let text = if let Some(c) = life.captures(line) {
            let mine = me.as_deref() == Some(&c[2]);
            match (&c[1], mine) {
                ("OnDeath", true) => "You died".to_string(),
                ("OnDeath", false) => cap(&format!("{} died", who(&c[3], names))),
                (_, true) => "You respawned".to_string(),
                _ => cap(&format!("{} respawned", who(&c[3], names))),
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
            // one level load logs Browse and then world_loaded: one event
            Some(e) if e.text == text && text.starts_with("Loaded ") => {}
            Some(e) if e.text == text && (e.secs - secs).abs() < 0.5 => e.count += 1,
            _ => s.events.push(Event { secs, text, count: 1 }),
        }
    }
    s.hero = s.hero_id.as_deref().and_then(names);
    s.headline = s.events.iter().rev().find(|e| e.text != "A bot respawned").or(s.events.last()).cloned();
    s.events_more = s.events.len().saturating_sub(MAX_EVENTS);
    s.events.drain(..s.events_more);
    errors.sort_by(|a, b| b.count.cmp(&a.count)); // stable: first seen first among equals
    s.errors_more = errors.len().saturating_sub(MAX_ERRORS);
    errors.truncate(MAX_ERRORS);
    s.errors = errors;
    paks.sort_by_key(|m| m.to_lowercase());
    paks.dedup_by(|a, b| a.eq_ignore_ascii_case(b));
    s.iostore = paks.iter().filter(|m| iostore.contains(&m.to_lowercase())).count();
    let mounted: std::collections::HashSet<String> = paks.iter().map(|m| m.to_lowercase()).collect();
    s.mounted = paks;
    s.not_mounted = on.map(|keys| keys.into_iter().filter(|k| k.split_once("/~mods/").is_some_and(|(_, rel)| !mounted.contains(rel))).collect());
    s
}

/// The values the log keeps under id-like keys (uid=732639096, "transid":"D62A..."), 6 characters or more with a digit.
/// The game also prints them bare (Saved/Config/732639096/, a dict key), so redact_log takes them out everywhere.
fn learned_ids(text: &str) -> Vec<String> {
    static KEYED: OnceLock<Regex> = OnceLock::new();
    let re = KEYED.get_or_init(|| Regex::new(r#"(?i)\b(?:\w*(?:uid|udid|token|ticket|machine_?id|device_?id|account_?id|session_?id|transid|transaction_?id|client_?id|player_?id|user_?id|role_?id|open_?id)|aid|ci)\\?["']?\s*[:=]\s*\\?["']?([^\s"'&,;<>(){}\[\]\\]+)"#).unwrap());
    let mut ids: Vec<String> = re.captures_iter(text)
        // "732639096." at the end of a sentence is the id "732639096", so its bare uses match too
        .map(|c| c[1].trim_end_matches(|ch: char| !ch.is_ascii_alphanumeric()).to_string())
        .filter(|v| v.len() >= 6 && v.bytes().any(|b| b.is_ascii_digit())).collect();
    ids.sort_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b))); // longest first, so no id is cut by a shorter one
    ids.dedup();
    ids
}

/// Takes out what the engine log holds about the player besides redact()'s rules: login tokens (JWTs, base64 JSON), platform
/// handles ("name@steam"), NetEase account fields, and every `known` id (learned_ids of the whole log) wherever it stands.
/// Fails rather than hand back text with ids left in it.
fn redact_log(text: &str, users: &[String], known: &[String]) -> Result<String, String> {
    static NAMES: OnceLock<Regex> = OnceLock::new();
    static RULES: OnceLock<[(Regex, &'static str); 2]> = OnceLock::new();
    // names first and whole, quoted ones with their spaces ("nickname":"Jane Doe"), before redact() cuts them at a space
    let names = NAMES.get_or_init(|| Regex::new(r#"(?i)(\\?["']?\b(?:aid|nick_?name|role_?name|user_?name|player_?name|open_?id|login_?name|phone)\\?["']?\s*[:=]\s*)(?:\\"(?:\\\\\\"|[^"\n])*(?:\\")?|"(?:[^"\\\n]|\\.)*"?|'[^'\n]*'?|[^\s"'&,;<>)}\]\\]+)"#).unwrap());
    let rules = RULES.get_or_init(|| [
        // base64 of '{"', '{ "', '{\n': JWTs and the login JSON the SDK logs encoded
        // only at a word start: "GameFramework.cpp" holds "ewo" and stays
        (Regex::new(r"\b(?:eyJ|eyAi|eyAg|ewo[\w+/]|ew0K)[\w+/=.-]{6,}").unwrap(), "<token>"),
        (Regex::new(r"[\w.+-]+@[A-Za-z][\w-]*").unwrap(), "<handle>"),
    ]);
    let out = names.replace_all(text, "${1}<redacted>");
    // redact() before the handle rule: its email rule takes dotted addresses whole
    let mut out = crate::xtra_crash::redact(&out, users);
    for (re, with) in rules {
        out = re.replace_all(&out, *with).into_owned();
    }
    // in batches, so a log with many ids stays under the regex size limit
    for batch in known.chunks(64) {
        out = replace_ids(&out, batch)?;
    }
    Ok(out)
}

/// Every id of `ids` that stands as a whole word (no ASCII letter or digit next to it) replaced by "<id>". The edges are
/// part of the pattern, so where a longer id fails its edge a shorter one at the same place still matches.
fn replace_ids(text: &str, ids: &[String]) -> Result<String, String> {
    let any = ids.iter().map(|v| regex_lite::escape(v)).collect::<Vec<_>>().join("|");
    let re = Regex::new(&format!("(?i)(?:^|[^A-Za-z0-9])({any})(?:[^A-Za-z0-9]|$)")).map_err(|e| format!("Could not take the ids out of the log: {e}"))?;
    let (mut out, mut last) = (String::with_capacity(text.len()), 0);
    // resume at the id's end, so the edge after it can be the edge before the next one
    while let Some(id) = re.captures_at(text, last).and_then(|c| c.get(1)) {
        out.push_str(&text[last..id.start()]);
        out.push_str("<id>");
        last = id.end();
    }
    out.push_str(&text[last..]);
    Ok(out)
}

fn summary_of(id: &str) -> Result<Option<LogSummary>, String> {
    let dir = crash_dir(id)?;
    let Some(text) = read_log(&dir) else { return Ok(None) };
    let time = dir.metadata().and_then(|m| m.created()).ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs());
    let on = time.and_then(crate::xtra_crash::xtra_mods_on_at);
    let (users, known) = (crate::xtra_crash::user_names(), learned_ids(&text));
    let clean = |line: &str| redact_log(line, &users, &known).unwrap_or_else(|_| "[hidden: it may name you]".into());
    Ok(Some(summarize(&text, on, &crate::character_data::get_character_name_from_id, &clean)))
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
        redact_log(&text, &crate::xtra_crash::user_names(), &learned_ids(&text))
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
    fn a_cut_record_never_eats_the_trailer_or_its_own_size_bytes() {
        let ring = b"<SHM_LOG_BEGIN>ring<SHM_LOG_END>";
        // the crash cut a raw record; its size says it runs past the trailer
        let mut log = MAGIC.to_vec();
        let mut cut = framed(b"0123456789abcdefghijklmnopqrstuvwxyz0123456789");
        cut.truncate(4 + 30);
        log.extend(cut);
        log.extend(ring);
        assert_eq!(decode(&log).unwrap(), format!("0123456789abcdefghijklmnopqrst{TRAILER}ring"));
        // a size of 40 with the trailer after 20 or 35 bytes: those bytes, and the trailer whole
        let payload: Vec<u8> = (b'a'..=b'z').chain(b'A'..=b'N').collect(); // 40 bytes
        for at in [20, 35] {
            let mut log = MAGIC.to_vec();
            let mut rec = framed(&payload);
            rec.truncate(4 + at);
            log.extend(rec);
            log.extend(ring);
            assert_eq!(decode(&log).unwrap(), format!("{}{TRAILER}ring", String::from_utf8_lossy(&payload[..at])), "trailer after {at} bytes");
        }
        // only the closing size is missing (two of its four bytes written): the payload, none of those bytes
        let mut log = MAGIC.to_vec();
        let mut rec = framed(b"raw line\n");
        rec.truncate(rec.len() - 2);
        log.extend(rec);
        assert_eq!(decode(&log).unwrap(), "raw line\n");
        // a short whole record right before the trailer is still a record
        let mut log = MAGIC.to_vec();
        log.extend(framed(b"hi\n"));
        log.extend(b"\n");
        log.extend(ring);
        assert_eq!(decode(&log).unwrap(), format!("hi\n{TRAILER}ring"));
        // raw text that starts with "x" is text, not a failed zlib stream ("x " passes the header check alone)
        for raw in ["xyz\n", "x marks\n", "x^ not zlib\n"] {
            let mut log = MAGIC.to_vec();
            log.extend(framed(raw.as_bytes()));
            assert_eq!(decode(&log).unwrap(), raw);
        }
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
        let same = |t: &str| t.to_string();
        // a trailer that repeats lines with a later time must change nothing
        let log = format!("{LOG}{TRAILER}[2026.11.18-00.00.09:000 -0500][ 11][Bid:1]LogCharacter: Display: AMarvelBaseCharacter::OnDeath: UID:1, Name=1045_CharacterBP_C_2147442113, bDeathReplay=false\n");
        let s = summarize(&log, on, &names, &same);
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
        assert_eq!(s.headline.map(|e| e.text).as_deref(), Some("You died"));
        assert_eq!(summarize(LOG, None, &names, &same).not_mounted, None, "no saved session: no comparison");
    }

    #[test]
    fn edge_lines_are_read_the_safe_way() {
        let names = |id: &str| (id == "1045").then(|| "Namor".to_string());
        let t = |s: &str| format!("[2026.11.17-20.00.{s}:000 -0500][ 1][Bid:1]");
        let log = [
            "LogPakFile: Display: Mounted Pak file '../../../Marvel/Content/Paks/~MODS\\Sub\\Skin_9999999_P.PAK', mount point: '../../../'".to_string(),
            "LogPakFile: Display: Mounted IoStore container \"../../../Marvel/Content/Paks/~mods/OnlyIo_9999999_P.utoc\"".to_string(),
            format!("{}LogPlayerView: Display: SetViewTarget(1045_CharacterBP_C_1)", t("01")),
            format!("{}LogCharacter: Display: AMarvelBaseCharacter::OnDeath: UID:2, Name=1045_CharacterBP_C_2, bDeathReplay=false", t("02")),
            format!("{}LogPakFile: Error: Invalid Pak file ../../../Marvel/Content/Paks/~mods/Skin_9999999_P.pak recorded", t("03")),
            format!("{}LogX: Error: login failed for uid 111111111", t("04")),
            format!("{}LogX: Error: login failed for uid 222222222", t("05")),
            format!("{}LogPyLevelLoadSubsystem: Display: c_select_hero_world_loaded TeamLobby_0000", t("06")),
        ].join("\n");
        let hide = |s: &str| regex_lite::Regex::new(r"\d{9}").unwrap().replace_all(s, "<id>").into_owned();
        let s = summarize(&log, Some(vec!["c:/p/~mods/sub/skin_9999999_p".into(), "c:/p/~mods/onlyio_9999999_p".into()]), &names, &hide);
        assert_eq!(s.events[0].text, "Namor died", "another Namor's death is not yours");
        assert_eq!(s.errors, [ErrorGroup { text: "login failed for uid <id>".into(), count: 2 }], "grouped after redaction, no Invalid Pak line");
        assert_eq!((s.map.as_deref(), s.hero.as_deref()), (Some("Team Lobby"), None), "a new map: the hero from before is not named");
        assert_eq!(s.mounted, ["OnlyIo_9999999_P", "Sub/Skin_9999999_P"], "case, backslashes, and an IoStore line alone");
        assert_eq!(s.not_mounted, Some(vec![]));
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
        let line = format!(r#"{line} "nickname":"Jane Doe" playerId=ABC123456 again ABC123456 uid:987654321. Saved/Config/987654321/ d62ad1b59865 {}"#, "eyAiYWlkIjoiMSJ9");
        let out = redact_log(&line, &["Alice".to_string()], &learned_ids(&line)).unwrap();
        for secret in ["76561199866094042", "46466993", "1294405327", "x20naxx2gb", "eyJ", "Bob", "Alice", "732639096", "a.b@example", "D62AD1B59865", "d62ad1b59865", "Jane", "Doe", "ABC123456", "987654321", "eyAi"] {
            assert!(!out.contains(secret), "{secret} left in {out}");
        }
        assert!(out.contains(r"C:\Users\<user>\AppData"), "{out}");
        assert_eq!(redact_log(r#"{"aid":46466993}"#, &[], &[]).unwrap(), r#"{"aid":<redacted>}"#, "the closing brace stays");
        let escaped = r#"msg={\"nickname\":\"Jane Doe\",\"uid\":\"123456789\"}"#;
        let out = redact_log(escaped, &[], &learned_ids(escaped)).unwrap();
        assert!(!out.contains("Jane") && !out.contains("123456789"), "JSON inside a logged string: {out}");
        let cut = r#"x "nickname":"Jane Doe"#;
        assert!(!redact_log(cut, &[], &[]).unwrap().contains("Jane"), "a name cut off by the crash");
        let quoted = r#""nickname":"Jane \"Ace\" Doe", next"#;
        assert_eq!(redact_log(quoted, &[], &[]).unwrap(), r#""nickname":<redacted>, next"#, "escaped quotes inside a name");
        let both = vec!["tag.ABC123456".to_string(), "ABC123456".to_string()];
        assert_eq!(redact_log("Saved/Config/Xtag.ABC123456/ and ABC123456/ABC123456", &[], &both).unwrap(),
            "Saved/Config/Xtag.<id>/ and <id>/<id>", "a longer id failing its edge leaves the shorter one to match, side by side too");
        let inner = r#"msg={\"nickname\":\"Jane \\\"Ace\\\" Doe\",\"x\":1} ewoJImFpZCI6IjEifQ== {\"role_name\":\"\\u5f20\\u4e09\"} ew0KCSJhaWQiOiIxIn0="#;
        let out = redact_log(inner, &[], &[]).unwrap();
        for part in ["Jane", "Ace", "Doe", "ewoJ", "u5f20", "u4e09", "ew0K"] {
            assert!(!out.contains(part), "{part} left in {out}");
        }
        let paths = "Runtime/Engine/Private/GameFramework/Character.cpp KeyAimAssist";
        assert_eq!(redact_log(paths, &[], &[]).unwrap(), paths, "no token inside a word");
        assert_eq!(redact_log("PracticeRange_S1 TripleKill 7326390961", &[], &["732639096".into()]).unwrap(), "PracticeRange_S1 TripleKill 7326390961", "only whole ids");
        let many: Vec<String> = (0..500).map(|i| format!("id{i:07}x")).collect();
        assert_eq!(redact_log("id0000499x", &[], &many).unwrap(), "<id>", "many ids still all go");
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
            let started = std::time::Instant::now();
            let text = redact_log(&raw, &users, &known).unwrap();
            println!("{} ids learned, redacted in {} ms", known.len(), started.elapsed().as_millis());
            for bad in users.iter().map(String::as_str).chain(["eyJ", "7656119"]).chain(known.iter().map(String::as_str)) {
                assert!(!text.to_lowercase().contains(&bad.to_lowercase()), "{bad} in the shared log of {id}");
            }
            println!("{} lines shared", text.lines().count());
        }
    }
}
