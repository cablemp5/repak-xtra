//! repakxtra: Merge sounds. Since the September 2026 game update the game loads one copy of each Wwise sound bank, so
//! two sound mods that change the same bank (two emote songs in bnk_display_1026001) cannot both play: only the
//! higher-priority pak's bank loads [modding-kb sound.md]. Select two or more sound mods in the Library and Merge sounds
//! (custom/MergeSounds.tsx) lists every sound two or more of them change, with each mod's version to play (decoded by
//! the preview kit's vgmstream) and pick. The merged pack holds each bank rebuilt from the game's own with every
//! changed sound in it, the picked version where mods share one, as a normal mod in ~mods: <name>_19999999_P.pak, whose
//! _19999999_P puts it above every _9999999_P mod in the game's pak order (and under the int32 limit). The originals that
//! hold only sounds are switched off by the app (kept, so one switch brings them back). What was picked is kept in
//! sound-merges.json, so the merged pack's details can open the window again. The bank format follows the KB's
//! tools\sound\bnk.py rebuild (BKHD, DIDX entries of id, offset, size into DATA, HIRC, any other section byte for byte).

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::State;

use crate::install_mod::AES_KEY_HEX;

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

/// The merged pack's priority suffix: above every _9999999_P mod, under the int32 pak order limit. The Library's priority
/// number reads only all-nines suffixes, so it shows this pack as 0, while the game loads it above them.
const SUFFIX: &str = "_19999999_P";

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

/// The media a mod's bank changes against the game's (id -> its bytes). Err (a reason) when it lacks media the game's
/// bank has: it was made for another game version, so it is left out of that bank.
fn changes<'a>(game: &[(u32, &[u8])], bytes: &'a [u8]) -> Result<BTreeMap<u32, &'a [u8]>, String> {
    let theirs = media(bytes).map_err(|e| format!("it could not be read ({e})"))?;
    let ids: std::collections::HashSet<u32> = theirs.iter().map(|(id, _)| *id).collect();
    if game.iter().any(|(id, _)| !ids.contains(id)) {
        return Err("it was made for another game version (sounds the game's bank has are missing)".into());
    }
    let base: BTreeMap<u32, &[u8]> = game.iter().copied().collect();
    Ok(theirs.into_iter().filter(|(id, d)| base.get(id) != Some(d)).collect())
}

/// The game's bank with every mod's changed media in it. `mods` lowest priority first; `picks` says whose version
/// plays for a sound two or more change (a sound without a pick: the highest-priority mod's). HIRC (which media each
/// sound plays) comes from `hirc`, the mod that wins the most picks among those that changed it.
fn build_bank(game: &[u8], mods: &[BTreeMap<u32, &[u8]>], hircs: &[Option<&[u8]>], picks: &BTreeMap<u32, usize>) -> Result<Vec<u8>, String> {
    let base = media(game)?;
    let mut pick: BTreeMap<u32, &[u8]> = base.iter().copied().collect();
    for m in mods {
        pick.extend(m.iter().map(|(id, d)| (*id, *d)));
    }
    for (id, &i) in picks {
        if let Some(d) = mods.get(i).and_then(|m| m.get(id)) {
            pick.insert(*id, *d);
        }
    }
    let wins = |i: usize| picks.values().filter(|&&p| p == i).count();
    let hirc = (0..mods.len()).filter(|&i| hircs.get(i).copied().flatten().is_some()).max_by_key(|&i| (wins(i), i)).and_then(|i| hircs[i]);
    let align = alignment(&base, game);
    let (mut didx, mut data) = (Vec::new(), Vec::new());
    for (id, bytes) in &pick {   // DIDX sorted by id: Wwise binary-searches it
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
            b"HIRC" => hirc.unwrap_or(&game[r]),
            _ => &game[r],
        };
        out.extend_from_slice(&tag);
        out.extend_from_slice(&(body.len() as u32).to_le_bytes());
        out.extend_from_slice(body);
    }
    Ok(out)
}

/// One file out of a pak (the bundled UAssetTool's extract_pak_file), as bytes; None when the pak has no such file.
/// Kept for the window's life (a bank is read once for the list, every play, and the build).
fn extract(pak: &Path, inner: &str) -> Option<Arc<Vec<u8>>> {
    let id = (pak.to_string_lossy().to_lowercase(), inner.to_string());
    if let Some(b) = cache().lock().unwrap().get(&id) {
        return Some(b.clone());
    }
    let out = std::env::temp_dir().join(format!("repakxtra-sound-{}-{}.bin", std::process::id(), rand_id()));
    let req = serde_json::json!({ "action": "extract_pak_file", "file_path": pak.to_string_lossy(), "internal_path": inner,
                                  "output_path": out.to_string_lossy(), "aes_key": AES_KEY_HEX });
    let ok = uasset_toolkit::invoke_json(&req.to_string()).ok()
        .and_then(|r| serde_json::from_str::<serde_json::Value>(&r).ok())
        .is_some_and(|v| v["success"].as_bool().or(v["Success"].as_bool()).unwrap_or(false));
    let bytes = if ok { std::fs::read(&out).ok().map(Arc::new) } else { None };
    let _ = std::fs::remove_file(&out);
    if let Some(b) = &bytes {
        cache().lock().unwrap().insert(id, b.clone());
    }
    bytes
}

fn cache() -> &'static Mutex<HashMap<(String, String), Arc<Vec<u8>>>> {
    static C: std::sync::OnceLock<Mutex<HashMap<(String, String), Arc<Vec<u8>>>>> = std::sync::OnceLock::new();
    C.get_or_init(Default::default)
}

fn rand_id() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    N.fetch_add(1, Ordering::Relaxed)
}

/// Where a sound file sits inside the paks, the same for every spelling: lowercase, from "wwiseaudio/" on (a mod packed
/// at ../../../ lists Marvel/Content/WwiseAudio/x.bnk, the game's pak, mounted deeper, lists /x.bnk). None for anything
/// else, and for a path that climbs (..), which would write outside the work folder.
fn sound_key(path: &str) -> Option<String> {
    let l = path.replace('\\', "/").to_lowercase();
    let i = l.find("wwiseaudio/")?;
    let k = l[i..].to_string();
    ((k.ends_with(".bnk") || k.ends_with(".wem")) && !k.split('/').any(|s| s == "..")).then_some(k)
}

/// The game's own sound files by key: (pak, its exact entry name), patch paks first (newest build first: the game's
/// bnk_ui_battle sits in a Patch_-Windows pak, not pakchunkWwise), then pakchunkWwise-Windows.pak. Each pak's index is
/// read once (the conflict check's cache keeps it while the file is unchanged).
fn game_files(paks: &Path) -> BTreeMap<String, (PathBuf, String)> {
    let mut list: Vec<PathBuf> = std::fs::read_dir(paks).into_iter().flatten().flatten().map(|e| e.path())
        .filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.to_lowercase().starts_with("patch_") && n.to_lowercase().ends_with(".pak")))
        .collect();
    list.sort_by_key(|p| std::cmp::Reverse(p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()));
    list.push(paks.join("pakchunkWwise-Windows.pak"));
    let mut out = BTreeMap::new();
    for pak in list {
        let Ok(files) = crate::xtra_conflicts::files_cached(&pak, None, || uasset_toolkit::list_pak_files(&pak.to_string_lossy(), Some(AES_KEY_HEX)).map_err(|e| e.to_string())) else { continue };
        for f in files.iter() {
            // the game pak's mount point is .../WwiseAudio/: its entries are /x.bnk or Media/xx/y.wem
            let k = sound_key(f).or_else(|| sound_key(&format!("wwiseaudio/{}", f.trim_start_matches('/'))));
            if let Some(k) = k {
                out.entry(k).or_insert_with(|| (pak.clone(), f.clone()));
            }
        }
    }
    out
}

/// A selected mod: its pak (on or off) and its files by sound key (its own spelling kept for reading them), plus
/// whether it holds anything besides sounds (then it stays on after the merge).
struct Source {
    path: PathBuf,
    sounds: BTreeMap<String, String>,
    only_sounds: bool,
}

/// The selected legacy paks (.pak or switched off .bak_repak, no .utoc) that hold sound files, lowest priority first
/// (ties: by name, the later name winning, as the game's tie order is not known [inference]).
fn sources(paths: &[String]) -> Vec<Source> {
    let mut out: Vec<Source> = paths.iter().map(PathBuf::from)
        .filter(|p| p.extension().and_then(|x| x.to_str()).is_some_and(|x| x.eq_ignore_ascii_case("pak") || x.eq_ignore_ascii_case("bak_repak")) && !p.with_extension("utoc").exists())
        .filter_map(|p| {
            let files = crate::xtra_conflicts::files_cached(&p, None, || uasset_toolkit::list_pak_files(&p.to_string_lossy(), Some(AES_KEY_HEX)).map_err(|e| e.to_string())).ok()?;
            let sounds: BTreeMap<String, String> = files.iter().filter_map(|f| Some((sound_key(f)?, f.clone()))).collect();
            let only_sounds = files.iter().all(|f| sound_key(f).is_some());
            (!sounds.is_empty()).then_some(Source { path: p, sounds, only_sounds })
        }).collect();
    let name = |p: &Path| p.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    out.sort_by(|a, b| pak_order(&name(&a.path)).cmp(&pak_order(&name(&b.path))).then(name(&a.path).cmp(&name(&b.path))));
    out
}

/// What the Merge sounds window shows for the selected mods.
#[derive(serde::Serialize, Default)]
pub struct Plan {
    /// the sound mods among the selection, lowest priority first (the indices below point here)
    pub mods: Vec<String>,
    /// files two or more of them change, with the sounds two or more change in each
    pub banks: Vec<PlanBank>,
    /// sounds only one of them changes: they come along as they are
    pub only_one: usize,
    /// mods left out of a file, and why
    pub skipped: Vec<(String, String)>,
    /// what else the merge does that is worth knowing
    pub notes: Vec<String>,
    /// files (banks, streamed sounds) two or more of them ship: none means they already play together
    pub shared_files: usize,
}

#[derive(serde::Serialize)]
pub struct PlanBank {
    /// the sound key (wwiseaudio/bnk_sfx_1026001.bnk, or a loose wwiseaudio/media/../x.wem)
    pub key: String,
    pub sounds: Vec<PlanSound>,
}

#[derive(serde::Serialize)]
pub struct PlanSound {
    /// the media id (a loose .wem: its file number)
    pub id: u32,
    /// the mods with their own version of it, and the one that wins today (the highest priority)
    pub has: Vec<usize>,
    pub pick: usize,
    /// a streamed sound: its full file (a loose .wem of the same number) beside the bank's short prefetch copy. It is
    /// picked with the row and plays from this file
    pub stream: Option<String>,
}

fn paks_of(state: &State<'_, Arc<Mutex<crate::AppState>>>) -> Option<PathBuf> {
    let mods = state.lock().unwrap().game_path.clone();
    crate::xtra_broken::paks_dir(&mods)
}

/// A bank's file name for the window's notes: bnk_sfx_1026001.
fn bank_name(key: &str) -> String {
    key.rsplit('/').next().unwrap_or(key).trim_end_matches(".bnk").to_string()
}

/// A mod's name for the window's notes: its file name without the priority suffix.
fn file_label(path: &str) -> String {
    let n = Path::new(path).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    match n.strip_suffix("_P").and_then(|r| r.rsplit_once('_')) {
        Some((head, num)) if !num.is_empty() && num.bytes().all(|b| b.is_ascii_digit()) => head.to_string(),
        _ => n,
    }
}

/// One file of the merged pack, written into the build folder under its key.
fn write_entry(tmp: &Path, key: &str, file: &str, bytes: Vec<u8>, entries: &mut Vec<(String, String)>) -> Result<(), String> {
    let out = tmp.join("tree").join(key.replace('/', "\\"));
    std::fs::create_dir_all(out.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(&out, bytes).map_err(|e| e.to_string())?;
    entries.push((file.to_string(), out.to_string_lossy().to_string()));
    Ok(())
}

/// A loose .wem's number (its file name), the id the window keys it by.
fn wem_id(key: &str) -> u32 {
    key.rsplit('/').next().and_then(|n| n.strip_suffix(".wem")).and_then(|n| n.parse().ok()).unwrap_or(0)
}

/// Lists every sound two or more of the selected mods change (Merge sounds window). Reads each shared bank once (kept
/// for playing and building).
#[tauri::command]
pub async fn sound_merge_plan(paths: Vec<String>, state: State<'_, Arc<Mutex<crate::AppState>>>) -> Result<Plan, String> {
    let paks = paks_of(&state).ok_or("The game folder is not set.")?;
    tauri::async_runtime::spawn_blocking(move || {
        cache().lock().unwrap().clear();
        let src = sources(&paths);
        let mut plan = Plan { mods: src.iter().map(|s| s.path.to_string_lossy().to_string()).collect(), ..Default::default() };
        for p in paths.iter().filter(|p| !src.iter().any(|s| stem_of(&s.path) == stem_of(Path::new(p)))) {
            plan.skipped.push((p.clone(), "only sound mods packed as a single .pak can be merged".into()));
        }
        let mut keys: BTreeMap<&String, Vec<usize>> = BTreeMap::new();
        for (i, s) in src.iter().enumerate() {
            for k in s.sounds.keys() {
                keys.entry(k).or_default().push(i);
            }
        }
        let game = if keys.keys().any(|k| k.ends_with(".bnk")) { game_files(&paks) } else { BTreeMap::new() };
        for (key, who) in keys {
            if who.len() < 2 {
                // one mod's bank: every sound it changes comes along (counted against the game's when it has one)
                let s = &src[who[0]];
                plan.only_one += if key.ends_with(".bnk") {
                    let g = game.get(key).and_then(|(p, e)| extract(p, e));
                    let m = extract(&s.path, &s.sounds[key]);
                    match (g, m) {
                        (Some(g), Some(m)) => media(&g).ok().and_then(|gm| changes(&gm, &m).ok()).map_or(0, |c| c.len()),
                        (None, Some(m)) => media(&m).map_or(0, |x| x.len()),
                        _ => 0,
                    }
                } else { 1 };
                continue;
            }
            if key.ends_with(".wem") {
                let copies: Vec<(usize, Arc<Vec<u8>>)> = who.iter().filter_map(|&i| Some((i, extract(&src[i].path, &src[i].sounds[key])?))).collect();
                let has: Vec<usize> = copies.iter().map(|(i, _)| *i).collect();
                plan.shared_files += 1;
                if has.len() > 1 && copies.iter().any(|(_, d)| *d != copies[0].1) {
                    plan.banks.push(PlanBank { key: key.clone(), sounds: vec![PlanSound { id: wem_id(key), pick: *has.last().unwrap(), has, stream: None }] });
                }
                continue;
            }
            plan.shared_files += 1;
            let Some(g) = game.get(key).and_then(|(p, e)| extract(p, e)) else {
                // a bank the game lacks: the highest-priority mod's plays whole, as it does today
                plan.notes.push(format!("{} is not in the game, so {}'s version of it is used whole.", bank_name(key), file_label(&plan.mods[*who.last().unwrap()])));
                continue;
            };
            let gm = media(&g)?;
            let mut by_id: BTreeMap<u32, Vec<usize>> = BTreeMap::new();
            for &i in &who {
                let Some(m) = extract(&src[i].path, &src[i].sounds[key]) else { continue };
                match changes(&gm, &m) {
                    Ok(c) => c.keys().for_each(|id| by_id.entry(*id).or_default().push(i)),
                    Err(why) => plan.skipped.push((plan.mods[i].clone(), format!("left out of {}: {why}", bank_name(key)))),
                }
            }
            // 7: only one HIRC (which media each sound plays) survives a bank
            let distinct = {
                let mut v: Vec<Vec<u8>> = who.iter().filter_map(|&i| extract(&src[i].path, &src[i].sounds[key]))
                    .filter_map(|m| section(&m, b"HIRC").filter(|h| Some(*h) != section(&g, b"HIRC")).map(|h| h.to_vec())).collect();
                v.sort();
                v.dedup();
                v.len()
            };
            if distinct > 1 {
                plan.notes.push(format!("Two or more of these mods also change how {} plays its sounds: the mod you pick most keeps its version of that.", bank_name(key)));
            }
            let mut sounds = Vec::new();
            for (id, has) in by_id {
                if has.len() > 1 {
                    sounds.push(PlanSound { id, pick: *has.last().unwrap(), has, stream: None });
                } else {
                    plan.only_one += 1;
                }
            }
            if !sounds.is_empty() {
                plan.banks.push(PlanBank { key: key.clone(), sounds });
            }
        }
        // a streamed sound shows once: its loose .wem joins the bank row with the same number
        let loose: Vec<(usize, u32)> = plan.banks.iter().enumerate().filter(|(_, b)| b.key.ends_with(".wem")).map(|(i, b)| (i, b.sounds[0].id)).collect();
        let mut folded = Vec::new();
        for (i, id) in loose {
            let wem = plan.banks[i].key.clone();
            if let Some(row) = plan.banks.iter_mut().filter(|b| b.key.ends_with(".bnk")).flat_map(|b| b.sounds.iter_mut()).find(|s| s.id == id) {
                row.stream = Some(wem);
                folded.push(i);
            }
        }
        for i in folded.into_iter().rev() {
            plan.banks.remove(i);
        }
        Ok(plan)
    }).await.map_err(|e| e.to_string())?
}

/// One mod's version of a sound, decoded to WAV by the preview kit's vgmstream, as bytes for the window to play.
#[tauri::command]
pub async fn sound_merge_play(path: String, key: String, id: u32) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let exe = crate::xtra_kit::kit_dir().join("vgmstream").join("vgmstream-cli.exe");
        if !exe.is_file() {
            return Err("Playing sounds needs the preview kit. Install it in Setup.".to_string());
        }
        let src = sources(&[path]);
        let s = src.first().ok_or("This mod has no sound files.")?;
        let file = extract(&s.path, s.sounds.get(&key).ok_or("This mod does not change that file.")?).ok_or("The sound could not be read.")?;
        let wem = if key.ends_with(".wem") { file.to_vec() } else {
            media(&file)?.into_iter().find(|(m, _)| *m == id).map(|(_, d)| d.to_vec()).ok_or("This mod has no version of that sound.")?
        };
        let dir = tempfile::tempdir().map_err(|e| e.to_string())?;
        let (inp, out) = (dir.path().join("in.wem"), dir.path().join("out.wav"));
        std::fs::write(&inp, wem).map_err(|e| e.to_string())?;
        let mut cmd = std::process::Command::new(&exe);
        cmd.arg("-o").arg(&out).arg(&inp).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // no console window
        }
        let ok = cmd.status().map(|s| s.success()).unwrap_or(false);
        std::fs::read(&out).ok().filter(|_| ok).map(tauri::ipc::Response::new).ok_or_else(|| "The sound could not be decoded.".to_string())
    }).await.map_err(|e| e.to_string())?
}

/// What a merged pack was made from, by its file stem (lowercase): its name, its sources (paths without extension, so
/// a source switched off still matches) and the picks, by source.
fn store_path() -> PathBuf {
    crate::app_dir().join("sound-merges.json")
}

fn read_store() -> serde_json::Map<String, serde_json::Value> {
    std::fs::read_to_string(store_path()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn stem_of(p: &Path) -> String {
    // one spelling for a path however the app wrote it (the game folder setting can mix / and \)
    p.with_extension("").to_string_lossy().to_lowercase().replace('/', "\\")
}

/// A merged pack's name as a file name: letters, digits, spaces, and - _ + . kept, the rest dropped.
fn file_name(name: &str) -> String {
    let n: String = name.chars().filter(|c| c.is_alphanumeric() || " -_+.".contains(*c)).collect();
    let n = n.trim().trim_matches('.').to_string();
    if n.is_empty() { "Merged sounds".into() } else { n }
}

#[derive(serde::Serialize)]
pub struct Made {
    /// the merged pack
    pub path: String,
    /// the originals that hold only sounds and are on: the app switches them off
    pub turn_off: Vec<String>,
}

/// Builds the merged pack from `paths` (any order) with `picks` (sound key -> media id -> the picked mod's path) as
/// ~mods\<name>_19999999_P.pak, replacing `replace` (an older merged pack being changed) when given.
#[tauri::command]
pub async fn sound_merge_make(paths: Vec<String>, picks: BTreeMap<String, BTreeMap<String, String>>, name: String, replace: Option<String>,
    state: State<'_, Arc<Mutex<crate::AppState>>>) -> Result<Made, String> {
    let paks = paks_of(&state).ok_or("The game folder is not set.")?;
    tauri::async_runtime::spawn_blocking(move || {
        if crate::xtra_vfx::game_running() {
            return Err("Close the game first: it holds the sound files while it runs.".to_string());
        }
        let src = sources(&paths);
        if src.len() < 2 {
            return Err("Pick two or more sound mods.".into());
        }
        let index = |p: &str| src.iter().position(|s| stem_of(&s.path) == stem_of(Path::new(p)));
        let mut keys: BTreeMap<&String, Vec<usize>> = BTreeMap::new();
        for (i, s) in src.iter().enumerate() {
            for k in s.sounds.keys() {
                keys.entry(k).or_default().push(i);
            }
        }
        let game = game_files(&paks);
        let tmp = tempfile::tempdir().map_err(|e| e.to_string())?;
        let mut entries = Vec::new();
        for (key, who) in &keys {
            // the entry's case from the first mod's own spelling
            let own = &src[who[0]].sounds[*key];
            let file = format!("Marvel/Content/{}", &own[own.to_lowercase().find("wwiseaudio/").unwrap_or(0)..]);
            let chosen = |id: u32| picks.get(*key).and_then(|m| m.get(&id.to_string())).and_then(|p| index(p));
            let bytes: Vec<u8> = if who.len() == 1 {
                extract(&src[who[0]].path, own).ok_or_else(|| format!("{file} could not be read"))?.to_vec()
            } else if key.ends_with(".wem") {
                let i = chosen(wem_id(key)).filter(|i| who.contains(i)).unwrap_or(*who.last().unwrap());
                extract(&src[i].path, &src[i].sounds[*key]).ok_or_else(|| format!("{file} could not be read"))?.to_vec()
            } else {
                let top = *who.last().unwrap();
                let whole = || extract(&src[top].path, &src[top].sounds[*key]).map(|b| b.to_vec()).ok_or_else(|| format!("{file} could not be read"));
                let Some(g) = game.get(*key).and_then(|(p, e)| extract(p, e)) else {
                    let b = whole()?;
                    write_entry(tmp.path(), key, &file, b, &mut entries)?;
                    continue;
                };
                let gm = media(&g)?;
                let copies: Vec<(usize, Arc<Vec<u8>>)> = who.iter().filter_map(|&i| Some((i, extract(&src[i].path, &src[i].sounds[*key])?))).collect();
                let mut mods = Vec::new();
                let mut hircs = Vec::new();
                let mut at = Vec::new(); // position in mods -> source index
                for (i, b) in &copies {
                    if let Ok(c) = changes(&gm, b) {
                        mods.push(c);
                        hircs.push(section(b, b"HIRC").filter(|h| Some(*h) != section(&g, b"HIRC")));
                        at.push(*i);
                    }
                }
                if mods.is_empty() {
                    let b = whole()?;
                    write_entry(tmp.path(), key, &file, b, &mut entries)?;
                    continue;
                }
                let mut p = BTreeMap::new();
                for (id_s, path) in picks.get(*key).into_iter().flatten() {
                    if let (Ok(id), Some(i)) = (id_s.parse::<u32>(), index(path)) {
                        if let Some(pos) = at.iter().position(|&x| x == i) {
                            p.insert(id, pos);
                        }
                    }
                }
                build_bank(&g, &mods, &hircs, &p).map_err(|e| format!("{file} could not be merged ({e})"))?
            };
            write_entry(tmp.path(), key, &file, bytes, &mut entries)?;
        }
        let mods_dir = paks.join("~mods");
        let dest = mods_dir.join(format!("{}{SUFFIX}.pak", file_name(&name)));
        let replace = replace.map(PathBuf::from).filter(|r| {
            r.parent().is_some_and(|d| stem_of(d) == stem_of(&mods_dir)) && read_store().contains_key(&stem_of(r))
        });
        // 6: never over another mod of that name, unless it is the merged pack being changed (on or off)
        let changing = replace.as_deref().is_some_and(|r| stem_of(r) == stem_of(&dest));
        if !changing && (dest.exists() || dest.with_extension("bak_repak").exists()) {
            return Err(format!("A mod named {} is already in the mods folder. Pick another name.", file_name(&name)));
        }
        // written beside it, then swapped in: a failed build never leaves half a pak where the game loads it
        let part = dest.with_extension("pak.part");
        let made = uasset_toolkit::create_pak(&part.to_string_lossy(), entries, Some("../../../"), Some(0), Some(AES_KEY_HEX))
            .map_err(|e| format!("Could not pack the merged sounds: {e}"))
            .and_then(|_| std::fs::rename(&part, &dest).map_err(|e| format!("Could not put the merged sounds in place: {e}")));
        if let Err(e) = made {
            let _ = std::fs::remove_file(&part);
            return Err(e);
        }
        let mut store = read_store();
        if let Some(old) = replace.filter(|o| o.to_string_lossy().to_lowercase() != dest.to_string_lossy().to_lowercase()) {
            let _ = std::fs::remove_file(&old);
            store.remove(&stem_of(&old)); // 5: renamed, so its old record goes with it
        }
        // what was picked, by source path, so its details can open the window again
        let real = |p: &Path| p.with_extension("").to_string_lossy().to_string();
        let by_source: serde_json::Map<String, serde_json::Value> = picks.iter().map(|(k, m)| (k.clone(), serde_json::json!(
            m.iter().filter_map(|(id, p)| Some((id.clone(), real(&src[index(p)?].path)))).collect::<BTreeMap<_, _>>()))).collect();
        store.insert(stem_of(&dest), serde_json::json!({
            "name": name, "sources": src.iter().map(|s| real(&s.path)).collect::<Vec<_>>(), "picks": by_source }));
        cache().lock().unwrap().clear();
        std::fs::write(store_path(), serde_json::Value::Object(store).to_string()).map_err(|e| format!("Made, but its picks could not be saved: {e}"))?;
        Ok(Made {
            path: dest.to_string_lossy().to_string(),
            turn_off: src.iter().filter(|s| s.only_sounds && s.path.extension().is_some_and(|x| x.eq_ignore_ascii_case("pak"))).map(|s| s.path.to_string_lossy().to_string()).collect(),
        })
    }).await.map_err(|e| e.to_string())?
}

#[derive(serde::Serialize)]
pub struct MergeInfo {
    pub name: String,
    /// the sources as they are now (on or off); a deleted one is left out
    pub sources: Vec<String>,
    /// sound key -> media id -> source path as it is now
    pub picks: BTreeMap<String, BTreeMap<String, String>>,
}

/// The window closed: the banks it read are let go.
#[tauri::command]
pub fn sound_merge_done() {
    cache().lock().unwrap().clear();
}

/// For a merged pack (its details): what it was made from, to open the window again. None for any other mod.
#[tauri::command]
pub fn sound_merge_info(path: String) -> Option<MergeInfo> {
    let store = read_store();
    let entry = store.get(&stem_of(Path::new(&path)))?;
    let now = |stem: &str| ["pak", "bak_repak"].iter().map(|x| PathBuf::from(format!("{stem}.{x}"))).find(|p| p.is_file()).map(|p| p.to_string_lossy().to_string());
    let sources: Vec<String> = entry["sources"].as_array()?.iter().filter_map(|s| now(s.as_str()?)).collect();
    let picks = entry["picks"].as_object()?.iter().map(|(k, m)| (k.clone(), m.as_object().into_iter().flatten()
        .filter_map(|(id, s)| Some((id.clone(), now(s.as_str()?)?))).collect())).collect();
    Some(MergeInfo { name: entry["name"].as_str().unwrap_or_default().to_string(), sources, picks })
}

/// The earlier automatic merger's leftovers (Settings > Sounds, before Merge sounds): its pak folder in ~mods and its
/// setting. Removed once, when the game is closed.
#[tauri::command]
pub fn sound_merge_cleanup(state: State<'_, Arc<Mutex<crate::AppState>>>) {
    let Some(paks) = paks_of(&state) else { return };
    let old = paks.join("~mods").join(".repakxtra-sounds");
    if old.exists() && !crate::xtra_vfx::game_running() {
        let _ = std::fs::remove_dir_all(old);
    }
    let _ = std::fs::remove_file(crate::app_dir().join("sound-merge.json"));
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

    fn merged(game: &[u8], mods: &[Vec<u8>], picks: &[(u32, usize)]) -> Vec<u8> {
        let gm = media(game).unwrap();
        let ch: Vec<_> = mods.iter().map(|m| changes(&gm, m).unwrap()).collect();
        let hircs: Vec<_> = mods.iter().map(|m| section(m, b"HIRC").filter(|h| Some(*h) != section(game, b"HIRC"))).collect();
        build_bank(game, &ch, &hircs, &picks.iter().copied().collect()).unwrap()
    }

    #[test]
    fn two_mods_on_one_bank_both_play() {
        let game = bank(&[(1, b"one"), (2, b"two"), (3, b"three")], b"h");
        let a = bank(&[(1, b"AAA"), (2, b"two"), (3, b"three")], b"h");     // changes sound 1
        let b = bank(&[(1, b"one"), (2, b"two"), (3, b"BBBBB")], b"h");     // changes sound 3
        let out = merged(&game, &[a, b], &[]);
        assert_eq!(media(&out).unwrap(), vec![(1, &b"AAA"[..]), (2, &b"two"[..]), (3, &b"BBBBB"[..])]);
        assert_eq!(section(&out, b"BKHD"), Some(&b"hdr!"[..]));
    }

    #[test]
    fn a_pick_decides_a_sound_both_change() {
        let game = bank(&[(1, b"one"), (2, b"two"), (3, b"three")], b"h");
        let low = bank(&[(1, b"low1"), (2, b"low2"), (3, b"three")], b"hL");
        let high = bank(&[(1, b"high1"), (2, b"high2"), (3, b"three")], b"hH");
        // without picks the higher priority mod wins both, with its HIRC
        let out = merged(&game, &[low.clone(), high.clone()], &[]);
        assert_eq!(media(&out).unwrap()[..2], [(1, &b"high1"[..]), (2, &b"high2"[..])]);
        assert_eq!(section(&out, b"HIRC"), Some(&b"hH"[..]));
        // sound 1 and 2 picked from the lower mod: its versions, and its HIRC (it wins the most picks)
        let out = merged(&game, &[low, high], &[(1, 0), (2, 0)]);
        assert_eq!(media(&out).unwrap()[..2], [(1, &b"low1"[..]), (2, &b"low2"[..])]);
        assert_eq!(section(&out, b"HIRC"), Some(&b"hL"[..]));
    }

    #[test]
    fn a_mod_for_another_game_version_is_found() {
        let game = bank(&[(1, b"one"), (2, b"two")], b"h");
        let old = bank(&[(1, b"OLD")], b"h");
        assert!(changes(&media(&game).unwrap(), &old).is_err());
        let ok = bank(&[(1, b"one"), (2, b"NEW")], b"h");
        assert_eq!(changes(&media(&game).unwrap(), &ok).unwrap().into_iter().collect::<Vec<_>>(), vec![(2, &b"NEW"[..])]);
    }

    #[test]
    fn pak_order_follows_unreal() {
        assert_eq!(pak_order("Patch_-Windows_1.1.4008108_P.pak"), 103);
        assert_eq!(pak_order("X_9999999_P.pak"), 3 + 100 * 10_000_000);
        assert!(pak_order(&format!("Merged{SUFFIX}.pak")) > pak_order("X_9999999_P.pak") && 100 * 20_000_000u64 < i32::MAX as u64);
        assert_eq!(pak_order("mod.pak"), 3);
        assert_eq!(pak_order("Mod_9999999_P.bak_repak"), pak_order("Mod_9999999_P.pak"));
    }

    #[test]
    fn names_and_ids() {
        assert_eq!(file_name("Merged: cosmic + minecraft"), "Merged cosmic + minecraft");
        assert_eq!(file_name("../.."), "Merged sounds");
        assert_eq!(wem_id("wwiseaudio/media/12/345.wem"), 345);
        assert_eq!(file_label(r"C:\m\minecraft_sfx_v7_9999999_P.pak"), "minecraft_sfx_v7");
        assert_eq!(file_label(r"C:\m\abc_v7.pak"), "abc_v7");
        assert_eq!(bank_name("wwiseaudio/bnk_sfx_1026001.bnk"), "bnk_sfx_1026001");
        assert_eq!(sound_key("Marvel/Content/WwiseAudio/bnk_X.bnk").as_deref(), Some("wwiseaudio/bnk_x.bnk"));
        assert_eq!(sound_key("WwiseAudio/Media/12/34.wem").as_deref(), Some("wwiseaudio/media/12/34.wem"));
        assert_eq!(sound_key("Marvel/Content/WwiseAudio/../../x.bnk"), None);
        assert_eq!(sound_key("Marvel/Content/Marvel/x.uasset"), None);
    }
}
