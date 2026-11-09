//! repakxtra: the sound mod merger (Settings > Sounds, off by default). Since the September 2026 game update the game
//! loads one copy of each Wwise sound bank, so two sound mods that change the same bank (two emote songs in
//! bnk_display_1026001) cannot both play: only the higher-priority pak's bank loads [modding-kb sound.md; the two-mod
//! case is not tested in game yet, so this stays off until it is]. With it on, every bank two or more enabled sound mods
//! ship is rebuilt from the game's own bank with each mod's changed sounds in it, the higher-priority mod winning a
//! sound both change, and packed as ~mods\.repakxtra-sounds\repakxtra-merged-sounds_21000000_P.pak. Its _21000000_P
//! puts it above every _9999999_P mod in the game's pak order (and under the int32 limit _99999999_P would pass), so
//! its banks load; the mods themselves are never changed, and off deletes the pak. The .repakxtra- folder is one the
//! library scan skips, so the pak never shows as a mod. The bank format follows the KB's tools\sound\bnk.py rebuild
//! (BKHD, DIDX entries of id, offset, size into DATA, HIRC, any other section copied byte for byte).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::State;

use crate::install_mod::AES_KEY_HEX;

const FOLDER: &str = ".repakxtra-sounds";
const PAK: &str = "repakxtra-merged-sounds_21000000_P.pak";

fn setting() -> PathBuf {
    crate::app_dir().join("sound-merge.json")
}

fn on() -> bool {
    std::fs::read_to_string(setting()).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v["on"].as_bool()).unwrap_or(false)
}

#[tauri::command]
pub fn sound_merge_get() -> bool {
    on()
}

/// Turns the merger on or off. Off removes the merged pak at once (the mods' own banks load again as before).
#[tauri::command]
pub fn sound_merge_set(on: bool, state: State<'_, Arc<Mutex<crate::AppState>>>) -> Result<(), String> {
    std::fs::write(setting(), serde_json::json!({ "on": on }).to_string()).map_err(|e| format!("Could not save the setting: {e}"))?;
    if !on {
        if let Some(dir) = out_dir(&state) {
            if crate::xtra_vfx::game_running() && dir.join(PAK).exists() {
                return Err("Saved. The merged sound pak goes when the game is closed (the game holds it now).".into());
            }
            let _ = std::fs::remove_dir_all(dir);
        }
    }
    Ok(())
}

fn out_dir(state: &State<'_, Arc<Mutex<crate::AppState>>>) -> Option<PathBuf> {
    let mods = state.lock().unwrap().game_path.clone();
    crate::xtra_broken::paks_dir(&mods).map(|p| p.join("~mods").join(FOLDER))
}

/// The game's priority for a pak from its name (Unreal's pak order, the preview kit's pak_order): 3, plus 100 x (n + 1)
/// for a name ending _<n>_P with n of 1 or more, plus 100 for any other _P name. Higher wins.
fn pak_order(name: &str) -> u64 {
    let lower = name.to_lowercase();
    let stem = [".pak", ".bak_repak"].iter().find_map(|x| lower.strip_suffix(x)).unwrap_or(&lower);
    let Some(rest) = stem.strip_suffix("_p") else { return 3 };
    let n = rest.rsplit_once('_').map(|(_, n)| n).filter(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|n| n.parse::<u64>().ok()).unwrap_or(0);
    3 + 100 * if n >= 1 { n + 1 } else { 1 }
}

/// Sections of a bank: (tag, body range). Err when a section runs past the end or bytes trail the last one.
fn sections(b: &[u8]) -> Result<Vec<([u8; 4], std::ops::Range<usize>)>, String> {
    let (mut out, mut o) = (Vec::new(), 0usize);
    while o + 8 <= b.len() {
        let tag: [u8; 4] = b[o..o + 4].try_into().unwrap();
        let size = u32::from_le_bytes(b[o + 4..o + 8].try_into().unwrap()) as usize;
        if size > b.len() - o - 8 {
            return Err(format!("section {} runs past the end", String::from_utf8_lossy(&tag)));
        }
        out.push((tag, o + 8..o + 8 + size));
        o += 8 + size;
    }
    if o != b.len() {
        return Err("bytes after the last section".into());
    }
    Ok(out)
}

/// A bank's media by id (its DIDX entries into DATA), in DIDX order.
fn media(b: &[u8]) -> Result<Vec<(u32, &[u8])>, String> {
    let secs = sections(b)?;
    let get = |t: &[u8; 4]| secs.iter().find(|(tag, _)| tag == t).map(|(_, r)| r.clone());
    let (Some(didx), Some(data)) = (get(b"DIDX"), get(b"DATA")) else { return Ok(Vec::new()) };
    let mut out = Vec::new();
    for e in b[didx].chunks_exact(12) {
        let (id, off, size) = (u32::from_le_bytes(e[0..4].try_into().unwrap()), u32::from_le_bytes(e[4..8].try_into().unwrap()) as usize,
                               u32::from_le_bytes(e[8..12].try_into().unwrap()) as usize);
        if off + size > data.len() {
            return Err(format!("media {id} points past DATA"));
        }
        out.push((id, &b[data.start + off..data.start + off + size]));
    }
    Ok(out)
}

fn section<'a>(b: &'a [u8], tag: &[u8; 4]) -> Option<&'a [u8]> {
    sections(b).ok()?.into_iter().find(|(t, _)| t == tag).map(|(_, r)| &b[r])
}

/// The strictest power of two that reproduces every DIDX offset of the game's bank (bnk.py _infer_alignment).
fn alignment(entries: &[(u32, &[u8])], b: &[u8]) -> usize {
    let Some(didx) = section(b, b"DIDX") else { return 16 };
    let offs: Vec<(usize, usize)> = didx.chunks_exact(12).map(|e| (u32::from_le_bytes(e[4..8].try_into().unwrap()) as usize, u32::from_le_bytes(e[8..12].try_into().unwrap()) as usize)).collect();
    if entries.len() < 2 {
        return 16;
    }
    [1usize, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096].into_iter()
        .filter(|a| { let mut cur: usize = 0; offs.iter().all(|&(o, s)| { let ok = cur.div_ceil(*a) * a == o; cur = o + s; ok }) })
        .max().unwrap_or(16)
}

/// One sound a mod changed that another mod's version replaces in the merged bank.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
pub struct Loss {
    /// the mod whose version does not play, and the one that plays instead (file paths)
    pub loser: String,
    pub winner: String,
    /// the bank (or loose .wem) path inside the paks, and how many of its sounds
    pub file: String,
    pub sounds: usize,
}

/// The game's bank with each mod's changed media in it: `mods` (path, bank bytes) lowest priority first, so a later
/// mod's version of a media both changed wins. HIRC (the bank's sound structure) comes from the highest-priority mod
/// that changed it. A mod that lacks media the game's bank has was made for another game version: left out, with a reason.
fn merge_bank(file: &str, game: &[u8], mods: &[(String, Vec<u8>)]) -> Result<(Vec<u8>, Vec<Loss>, Vec<(String, String)>), String> {
    let base = media(game)?;
    let base_map: BTreeMap<u32, &[u8]> = base.iter().copied().collect();
    let mut pick: BTreeMap<u32, (&[u8], Option<usize>)> = base.iter().map(|&(id, d)| (id, (d, None))).collect();
    let mut hirc: Option<(usize, &[u8])> = None;
    let (mut losses, mut skipped) = (Vec::<Loss>::new(), Vec::new());
    let mut lost = |loser: usize, winner: usize, losses: &mut Vec<Loss>| {
        let (l, w) = (mods[loser].0.clone(), mods[winner].0.clone());
        match losses.iter_mut().find(|x| x.loser == l && x.winner == w) {
            Some(x) => x.sounds += 1,
            None => losses.push(Loss { loser: l, winner: w, file: file.to_string(), sounds: 1 }),
        }
    };
    for (i, (path, bytes)) in mods.iter().enumerate() {
        let theirs = match media(bytes) {
            Ok(m) => m,
            Err(e) => { skipped.push((path.clone(), format!("its {file} could not be read ({e})"))); continue }
        };
        let ids: std::collections::HashSet<u32> = theirs.iter().map(|(id, _)| *id).collect();
        if base.iter().any(|(id, _)| !ids.contains(id)) {
            skipped.push((path.clone(), format!("its {file} was made for another game version (sounds the game's bank has are missing)")));
            continue;
        }
        for (id, data) in theirs {
            if base_map.get(&id) == Some(&data) {
                continue;
            }
            if let Some((_, Some(prev))) = pick.get(&id) {
                lost(*prev, i, &mut losses);
            }
            pick.insert(id, (data, Some(i)));
        }
        if let Some(h) = section(bytes, b"HIRC").filter(|h| Some(*h) != section(game, b"HIRC")) {
            if let Some((prev, _)) = hirc {
                lost(prev, i, &mut losses);
            }
            hirc = Some((i, h));
        }
    }
    let align = alignment(&base, game);
    let (mut didx, mut data) = (Vec::new(), Vec::new());
    for (id, (bytes, _)) in &pick {   // DIDX sorted by id: Wwise binary-searches it
        data.resize(data.len().div_ceil(align) * align, 0);
        didx.extend_from_slice(&id.to_le_bytes());
        didx.extend_from_slice(&(data.len() as u32).to_le_bytes());
        didx.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
        data.extend_from_slice(bytes);
    }
    let mut out = Vec::with_capacity(game.len() + data.len());
    for (tag, r) in sections(game)? {
        let body: &[u8] = match &tag {
            b"DIDX" => &didx,
            b"DATA" => &data,
            b"HIRC" => hirc.map(|(_, h)| h).unwrap_or(&game[r]),
            _ => &game[r],
        };
        out.extend_from_slice(&tag);
        out.extend_from_slice(&(body.len() as u32).to_le_bytes());
        out.extend_from_slice(body);
    }
    Ok((out, losses, skipped))
}

/// One file out of a pak (the bundled UAssetTool's extract_pak_file), as bytes; None when the pak has no such file.
fn extract(pak: &Path, inner: &str, tmp: &Path) -> Option<Vec<u8>> {
    let out = tmp.join(format!("x{}.bin", rand_id()));
    let req = serde_json::json!({ "action": "extract_pak_file", "file_path": pak.to_string_lossy(), "internal_path": inner,
                                  "output_path": out.to_string_lossy(), "aes_key": AES_KEY_HEX });
    let ok = uasset_toolkit::invoke_json(&req.to_string()).ok()
        .and_then(|r| serde_json::from_str::<serde_json::Value>(&r).ok())
        .is_some_and(|v| v["success"].as_bool().or(v["Success"].as_bool()).unwrap_or(false));
    let bytes = if ok { std::fs::read(&out).ok() } else { None };
    let _ = std::fs::remove_file(&out);
    bytes
}

fn rand_id() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    N.fetch_add(1, Ordering::Relaxed)
}

/// The game's own copy of a bank: its patch paks first (newest build first: the game's bnk_ui_battle sits in a
/// Patch_-Windows pak, not pakchunkWwise), then pakchunkWwise-Windows.pak. Its paks mount deeper than a mod's
/// (pakchunkWwise at ../../../Marvel/Content/WwiseAudio/), so the file is asked for under each shorter spelling too.
fn game_file(paks: &Path, inner: &str, tmp: &Path) -> Option<Vec<u8>> {
    let mut patches: Vec<PathBuf> = std::fs::read_dir(paks).ok()?.flatten().map(|e| e.path())
        .filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.to_lowercase().starts_with("patch_") && n.to_lowercase().ends_with(".pak")))
        .collect();
    patches.sort_by_key(|p| std::cmp::Reverse(p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()));
    // the game's pak lists its entries with a leading slash after its mount point (/bnk_display_1026001.bnk)
    let names: Vec<String> = ["Marvel/Content/WwiseAudio/", "Marvel/Content/", ""].iter().filter_map(|pre| inner.strip_prefix(pre))
        .flat_map(|n| [format!("/{n}"), n.to_string()]).collect();
    patches.into_iter().chain([paks.join("pakchunkWwise-Windows.pak")]).find_map(|p| names.iter().find_map(|n| extract(&p, n, tmp)))
}

/// What the last build did: shown in a sound mod's details (custom/SoundMergeNote.tsx).
#[derive(serde::Serialize, serde::Deserialize, Default, Clone)]
pub struct Report {
    pub on: bool,
    /// files merged: (path inside the paks, the mods merged into it)
    pub merged: Vec<(String, Vec<String>)>,
    pub losses: Vec<serde_json::Value>,
    /// mods left out of a file, and why
    pub skipped: Vec<(String, String)>,
}

/// Rebuilds the merged pak for the enabled sound mods among `mod_paths` (legacy paks with sound banks or loose .wem
/// files and no .utoc). Off: removes it. Nothing two mods share: removes it. Unchanged inputs (stamp.json): keeps it.
/// Never while the game runs (it holds the pak): Err, and the next list change or Launch tries again.
#[tauri::command]
pub async fn sound_merge_rebuild(mod_paths: Vec<String>, state: State<'_, Arc<Mutex<crate::AppState>>>) -> Result<Report, String> {
    let Some(dir) = out_dir(&state) else { return Ok(Report::default()) };
    tauri::async_runtime::spawn_blocking(move || rebuild(&dir, &mod_paths)).await.map_err(|e| e.to_string())?
}

fn rebuild(dir: &Path, mod_paths: &[String]) -> Result<Report, String> {
    if !on() {
        if dir.join(PAK).exists() && !crate::xtra_vfx::game_running() {
            let _ = std::fs::remove_dir_all(dir);
        }
        return Ok(Report::default());
    }
    if crate::xtra_vfx::game_running() {
        return Err("The game is running: sound mods are merged once it is closed.".into());
    }
    let paks = dir.parent().and_then(Path::parent).ok_or("no Paks folder")?.to_path_buf();
    // enabled legacy sound paks, lowest priority first (ties: by name, the later name winning [inference])
    let mut mods: Vec<(PathBuf, Vec<String>)> = mod_paths.iter().map(PathBuf::from)
        .filter(|p| p.extension().is_some_and(|x| x.eq_ignore_ascii_case("pak")) && !p.with_extension("utoc").exists())
        .filter_map(|p| {
            let files = uasset_toolkit::list_pak_files(&p.to_string_lossy(), Some(AES_KEY_HEX)).ok()?;
            let sounds: Vec<String> = files.into_iter().filter(|f| { let l = f.to_lowercase(); l.contains("wwiseaudio/") && (l.ends_with(".bnk") || l.ends_with(".wem")) }).collect();
            (!sounds.is_empty()).then_some((p, sounds))
        })
        .collect();
    let name = |p: &Path| p.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    mods.sort_by(|a, b| pak_order(&name(&a.0)).cmp(&pak_order(&name(&b.0))).then(name(&a.0).cmp(&name(&b.0))));
    let mut shared: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    for (i, (_, files)) in mods.iter().enumerate() {
        for f in files {
            shared.entry(f.clone()).or_default().push(i);
        }
    }
    shared.retain(|_, v| v.len() > 1);
    let mut report = Report { on: true, ..Default::default() };
    if shared.is_empty() {
        let _ = std::fs::remove_dir_all(dir);
        return Ok(report);
    }
    let stamp = serde_json::json!({
        "mods": mods.iter().map(|(p, _)| { let m = std::fs::metadata(p).ok(); (p.to_string_lossy().to_lowercase(), m.as_ref().map(|m| m.len()),
            m.and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs())) }).collect::<Vec<_>>(),
        "game": crate::xtra_broken::build_key(&crate::xtra_broken::game_containers(&paks)),
    });
    let read = |f: &str| std::fs::read_to_string(dir.join(f)).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok());
    if dir.join(PAK).exists() && read("stamp.json").as_ref() == Some(&stamp) {
        if let Some(r) = read("report.json").and_then(|v| serde_json::from_value(v).ok()) {
            return Ok(r);
        }
    }
    let tmp = tempfile::tempdir().map_err(|e| e.to_string())?;
    let tree = tmp.path().join("tree");
    let mut entries = Vec::new();
    for (file, who) in &shared {
        let copies: Vec<(String, Vec<u8>)> = who.iter().filter_map(|&i| Some((mods[i].0.to_string_lossy().to_string(), extract(&mods[i].0, file, tmp.path())?))).collect();
        if copies.len() < 2 {
            continue;
        }
        let bytes = if file.to_lowercase().ends_with(".bnk") {
            let Some(game) = game_file(&paks, file, tmp.path()) else {
                report.skipped.extend(copies.iter().map(|(p, _)| (p.clone(), format!("the game has no {file} to merge onto"))));
                continue;
            };
            let (merged, losses, skipped) = merge_bank(file, &game, &copies)?;
            report.losses.extend(losses.into_iter().map(|l| serde_json::to_value(l).unwrap_or_default()));
            report.skipped.extend(skipped);
            merged
        } else {
            // a loose streamed sound: one file, the highest-priority mod's (copies are lowest first)
            let (winner, data) = copies.last().cloned().unwrap();
            report.losses.extend(copies[..copies.len() - 1].iter().map(|(p, _)| serde_json::to_value(Loss { loser: p.clone(), winner: winner.clone(), file: file.clone(), sounds: 1 }).unwrap_or_default()));
            data
        };
        let out = tree.join(file.replace('/', "\\"));
        std::fs::create_dir_all(out.parent().unwrap()).map_err(|e| e.to_string())?;
        std::fs::write(&out, bytes).map_err(|e| e.to_string())?;
        entries.push((file.clone(), out.to_string_lossy().to_string()));
        report.merged.push((file.clone(), copies.into_iter().map(|(p, _)| p).collect()));
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("Could not make {}: {e}", dir.display()))?;
    if entries.is_empty() {
        let _ = std::fs::remove_file(dir.join(PAK));
    } else {
        // written beside it, then swapped in: a failed build never leaves half a pak where the game loads it
        let part = dir.join(format!("{PAK}.part"));
        // the tool wants a path hash seed (null fails)
        uasset_toolkit::create_pak(&part.to_string_lossy(), entries, Some("../../../"), Some(0), Some(AES_KEY_HEX)).map_err(|e| format!("Could not pack the merged sounds: {e}"))?;
        std::fs::rename(&part, dir.join(PAK)).map_err(|e| format!("Could not put the merged sounds in place: {e}"))?;
    }
    let _ = std::fs::write(dir.join("stamp.json"), stamp.to_string());
    let _ = std::fs::write(dir.join("report.json"), serde_json::to_string(&report).unwrap_or_default());
    Ok(report)
}

/// The last build's report (merged files, which mod plays instead where two change one sound), for mod details.
#[tauri::command]
pub fn sound_merge_report(state: State<'_, Arc<Mutex<crate::AppState>>>) -> Report {
    out_dir(&state).and_then(|d| std::fs::read_to_string(d.join("report.json")).ok()).and_then(|t| serde_json::from_str(&t).ok())
        .filter(|_| on()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A bank of BKHD, DIDX, DATA and HIRC with these media (16-byte aligned, like the game's).
    fn bank(media: &[(u32, &[u8])], hirc: &[u8]) -> Vec<u8> {
        let (mut didx, mut data) = (Vec::new(), Vec::new());
        for (id, d) in media {
            data.resize(data.len().div_ceil(16) * 16, 0);
            didx.extend_from_slice(&id.to_le_bytes());
            didx.extend_from_slice(&(data.len() as u32).to_le_bytes());
            didx.extend_from_slice(&(d.len() as u32).to_le_bytes());
            data.extend_from_slice(d);
        }
        let mut out = Vec::new();
        for (tag, body) in [(b"BKHD", &b"hdr!"[..]), (b"DIDX", &didx), (b"DATA", &data), (b"HIRC", hirc)] {
            out.extend_from_slice(tag);
            out.extend_from_slice(&(body.len() as u32).to_le_bytes());
            out.extend_from_slice(body);
        }
        out
    }

    #[test]
    fn two_mods_on_one_bank_both_play() {
        let game = bank(&[(1, b"one"), (2, b"two"), (3, b"three")], b"h");
        let a = bank(&[(1, b"AAA"), (2, b"two"), (3, b"three")], b"h");     // changes sound 1
        let b = bank(&[(1, b"one"), (2, b"two"), (3, b"BBBBB")], b"h");     // changes sound 3
        let (out, losses, skipped) = merge_bank("x.bnk", &game, &[("a".into(), a), ("b".into(), b)]).unwrap();
        assert_eq!(media(&out).unwrap(), vec![(1, &b"AAA"[..]), (2, &b"two"[..]), (3, &b"BBBBB"[..])]);
        assert!(losses.is_empty() && skipped.is_empty());
        assert_eq!(section(&out, b"BKHD"), Some(&b"hdr!"[..]));
    }

    #[test]
    fn the_higher_priority_mod_wins_a_sound_both_change() {
        let game = bank(&[(1, b"one"), (2, b"two")], b"h");
        let low = bank(&[(1, b"low"), (2, b"two")], b"h");
        let high = bank(&[(1, b"high"), (2, b"two")], b"h2");
        let (out, losses, _) = merge_bank("x.bnk", &game, &[("low".into(), low), ("high".into(), high)]).unwrap();
        assert_eq!(media(&out).unwrap()[0], (1, &b"high"[..]));
        assert_eq!(section(&out, b"HIRC"), Some(&b"h2"[..]));
        assert_eq!(losses, vec![Loss { loser: "low".into(), winner: "high".into(), file: "x.bnk".into(), sounds: 1 }]);
    }

    #[test]
    fn a_mod_for_another_game_version_is_left_out() {
        let game = bank(&[(1, b"one"), (2, b"two")], b"h");
        let old = bank(&[(1, b"OLD")], b"h");
        let ok = bank(&[(1, b"one"), (2, b"NEW")], b"h");
        let (out, _, skipped) = merge_bank("x.bnk", &game, &[("old".into(), old), ("ok".into(), ok)]).unwrap();
        assert_eq!(media(&out).unwrap(), vec![(1, &b"one"[..]), (2, &b"NEW"[..])]);
        assert_eq!(skipped.len(), 1);
    }

    #[test]
    fn pak_order_follows_unreal() {
        assert_eq!(pak_order("Patch_-Windows_1.1.4008108_P.pak"), 103);
        assert_eq!(pak_order("X_9999999_P.pak"), 3 + 100 * 10_000_000);
        assert!(pak_order(PAK) > pak_order("X_9999999_P.pak") && 100 * 21_000_001u64 < i32::MAX as u64);
        assert_eq!(pak_order("mod.pak"), 3);
        assert_eq!(pak_order("Mod_9999999_P.bak_repak"), pak_order("Mod_9999999_P.pak"));
    }
}
