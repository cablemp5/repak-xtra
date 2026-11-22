//! repakxtra: the Sounds tab (custom/SoundsScreen.tsx). Each slot (data/sound_slots.json: hit and kill sounds,
//! killstreaks, healing, the kill feed, alerts, the match, the announcer, each hero's ult line) names the Wwise Sound
//! objects it replaces in the game's banks (bnk_ui_battle, and bnk_vo_system or the hero's default bnk_vo_<hero>001 in
//! every voice language). The page decodes a dropped file to
//! 48 kHz 16-bit WAV and saves it here per slot (app dir sounds\<slot>.wav). Make mod writes each as a Wwise PCM .wem
//! (xtra_wem.rs), puts it in a copy of the game's bank and packs a new mod in the app's own folder, which the page
//! hands to the install card (named, put in a loadout, and copied to ~mods there, like the KO Editor's).
//! Every file is replaced in place (put_sounds says why), so a file the game shares between two slots (First KO and
//! Double kill play one file) plays the first slot's sound in both, and one shared with an event no slot covers plays
//! the new sound there too. A streamed sound (the announcer: a short copy in the bank,
//! the whole file in Media\<language>) gets the new file in both places, as the KB's voice replacements do. Sound
//! object ids are Wwise's own and survive game patches. The file ids are read from the game's bank at every build.
//! Where an event plays several sounds at once (layers, or two Play actions: Bodyshot kill, Shield broken), the slot's
//! sound goes in one and the others (`silence` in the table) get 10 ms of silence, so it plays once instead of stacked.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::State;

use crate::install_mod::AES_KEY_HEX;
use crate::xtra_soundmerge::{alignment, decode_wem, extract, game_files, media, paks_of, sections, write_entry};

static SLOTS: &str = include_str!("data/sound_slots.json");
const MOD_STEM: &str = "Sound_mod_9999999_P"; // the install card renames it

#[derive(serde::Deserialize)]
struct Slot { id: String, banks: Vec<String>, sounds: Vec<u32>, #[serde(default)] silence: Vec<u32> }

fn slots() -> Vec<Slot> {
    #[derive(serde::Deserialize)]
    struct File { slots: Vec<Slot> }
    serde_json::from_str::<File>(SLOTS).map(|f| f.slots).unwrap_or_default()
}

fn dir() -> PathBuf { crate::app_dir().join("sounds") }

/// The slot's saved WAV, only for an id from the table (never a path someone typed).
fn wav_of(slot: &str) -> Result<PathBuf, String> {
    slots().iter().any(|s| s.id == slot).then(|| dir().join(format!("{slot}.wav"))).ok_or_else(|| "Not a sound slot".to_string())
}

fn names_path() -> PathBuf { dir().join("names.json") }
fn names() -> BTreeMap<String, String> {
    std::fs::read_to_string(names_path()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

/// A Sound object in a bank's HIRC: where its body starts (plugin u32, stream type u8, source id u32, size u32).
struct SoundObj { body: usize, stream: u8, source: u32 }

/// Every Sound object (HIRC type 2) of a bank, by id, with offsets into the whole bank.
fn sound_objects(b: &[u8]) -> Result<HashMap<u32, SoundObj>, String> {
    let hirc = sections(b)?.into_iter().find(|(t, _)| t == b"HIRC").map(|(_, r)| r).ok_or("the bank has no HIRC")?;
    let u32_at = |o: usize| b.get(o..o + 4).map(|x| u32::from_le_bytes(x.try_into().unwrap())).ok_or("HIRC runs short");
    let count = u32_at(hirc.start)?;
    let (mut out, mut p) = (HashMap::new(), hirc.start + 4);
    for _ in 0..count {
        let (t, size, id) = (*b.get(p).ok_or("HIRC runs short")?, u32_at(p + 1)? as usize, u32_at(p + 5)?);
        if t == 2 && size >= 17 {
            out.insert(id, SoundObj { body: p + 9, stream: *b.get(p + 13).ok_or("HIRC runs short")?, source: u32_at(p + 14)? });
        }
        p += 5 + size;
    }
    if p != hirc.end { return Err("the HIRC walk did not end on the section end".into()) }
    Ok(out)
}

/// The game's bank with `slots` (each: its Sound objects and the new file) put in. Returns the bank and the streamed
/// files to write beside it (media id, bytes). Every file is replaced in place, also one the game shares with Sound
/// objects no slot names (they play the new sound too): pointing a Sound object at a new file id crashed the game on
/// that sound's first play (headshots, 2026-11-17), and in-place is what Rivals-Toolkit's sound mods do and the game
/// plays. A file two entries replace keeps the first, so callers list real sounds before silences.
fn put_sounds(game: &[u8], slots: &[(&[u32], &[u8])]) -> Result<(Vec<u8>, Vec<(u32, Vec<u8>)>), String> {
    let objs = sound_objects(game)?;
    let mut pick: BTreeMap<u32, Vec<u8>> = media(game)?.into_iter().map(|(id, d)| (id, d.to_vec())).collect();
    let align = alignment(&media(game)?, game);
    let (mut replaced, mut streamed) = (BTreeSet::new(), vec![]);
    for (sounds, wem) in slots {
        for sid in *sounds {
            let o = objs.get(sid).ok_or("The game changed these sounds. repakxtra needs an update for them.")?;
            if !pick.contains_key(&o.source) { return Err("The game changed these sounds. repakxtra needs an update for them.".into()) }
            if replaced.insert(o.source) { pick.insert(o.source, wem.to_vec()); }
            if o.stream != 0 && !streamed.iter().any(|(m, _): &(u32, Vec<u8>)| *m == o.source) { streamed.push((o.source, pick[&o.source].clone())) }
        }
    }
    let (mut didx, mut data) = (vec![], vec![]);
    for (id, bytes) in &pick { // DIDX sorted by id: Wwise binary-searches it
        data.resize(data.len().div_ceil(align) * align, 0);
        didx.extend_from_slice(&id.to_le_bytes());
        didx.extend_from_slice(&(data.len() as u32).to_le_bytes());
        didx.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
        data.extend_from_slice(bytes);
    }
    let mut out = Vec::with_capacity(game.len() + data.len());
    for (tag, r) in sections(game)? {
        let body: &[u8] = match &tag { b"DIDX" => &didx, b"DATA" => &data, _ => &game[r] };
        out.extend_from_slice(&tag);
        out.extend_from_slice(&(body.len() as u32).to_le_bytes());
        out.extend_from_slice(body);
    }
    Ok((out, streamed))
}

#[derive(serde::Serialize)]
pub struct SoundsState {
    /// slot id -> the name of the file it was made from
    names: BTreeMap<String, String>,
    /// Play original needs the preview kit's decoder
    can_play_original: bool,
}

/// The folder a streamed file sits in under Media: its id's first two digits.
fn first2(id: u32) -> String { id.to_string().chars().take(2).collect() }

/// Where a bank's streamed files sit, as sound keys: wwiseaudio/media/ or wwiseaudio/media/english(us)/.
fn media_dir(bank_key: &str) -> String {
    let lang = bank_key.rsplit_once('/').map(|(d, _)| d.trim_start_matches("wwiseaudio").trim_start_matches('/')).unwrap_or("");
    if lang.is_empty() { "wwiseaudio/media/".into() } else { format!("wwiseaudio/media/{lang}/") }
}

fn vgmstream() -> PathBuf { crate::xtra_kit::kit_dir().join("vgmstream").join("vgmstream-cli.exe") }

#[tauri::command]
pub fn sounds_state() -> SoundsState {
    let mut n = names();
    n.retain(|slot, _| dir().join(format!("{slot}.wav")).is_file());
    SoundsState { names: n, can_play_original: vgmstream().is_file() }
}

/// Saves a slot's sound: the raw body is a 48 kHz 16-bit WAV the page rendered, `slot` and `name` (the dropped file's
/// name, URI-encoded) come as headers.
#[tauri::command]
pub fn sounds_set(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("Not a sound".into()) };
    let header = |k: &str| request.headers().get(k).and_then(|v| v.to_str().ok()).and_then(|v| urlencoding::decode(v).ok()).map(|v| v.into_owned()).unwrap_or_default();
    let (slot, name) = (header("slot"), header("name"));
    let path = wav_of(&slot)?;
    read_wav(bytes)?; // only a WAV the encoder can take is kept
    std::fs::create_dir_all(dir()).map_err(|e| e.to_string())?;
    // written beside it, then swapped in: a failed write keeps the slot's last sound
    let part = path.with_extension("part");
    std::fs::write(&part, bytes).and_then(|_| std::fs::rename(&part, &path)).map_err(|e| { let _ = std::fs::remove_file(&part); e.to_string() })?;
    let mut n = names();
    n.insert(slot, name.chars().take(200).collect());
    std::fs::write(names_path(), serde_json::to_string(&n).unwrap()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sounds_clear(slot: String) -> Result<(), String> {
    let path = wav_of(&slot)?;
    if let Err(e) = std::fs::remove_file(&path) {
        if path.exists() { return Err(format!("Its sound could not be removed: {e}")) }
    }
    let mut n = names();
    n.remove(&slot);
    std::fs::write(names_path(), serde_json::to_string(&n).unwrap()).map_err(|e| e.to_string())
}

/// A slot's saved WAV, to play it.
#[tauri::command]
pub fn sounds_get(slot: String) -> Result<tauri::ipc::Response, String> {
    std::fs::read(wav_of(&slot)?).map(tauri::ipc::Response::new).map_err(|_| "This slot has no sound.".to_string())
}

/// A dropped or browsed audio file's bytes, for the page to decode. Only audio files, at most 64 MB.
#[tauri::command]
pub fn sounds_read(path: String) -> Result<tauri::ipc::Response, String> {
    let p = PathBuf::from(&path);
    let ok = p.extension().and_then(|x| x.to_str()).is_some_and(|x| ["wav", "mp3", "ogg", "flac", "m4a"].contains(&x.to_lowercase().as_str()));
    if !ok { return Err("Not a sound file. Use a .wav, .mp3, or .ogg.".into()) }
    if std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0) > 64 << 20 { return Err("That file is over 64 MB.".into()) }
    std::fs::read(&p).map(tauri::ipc::Response::new).map_err(|e| e.to_string())
}

/// The audio files directly inside a dropped folder, for matching to slots by name.
#[tauri::command]
pub fn sounds_folder(path: String) -> Vec<String> {
    let audio = ["wav", "mp3", "ogg", "flac", "m4a"];
    std::fs::read_dir(&path).into_iter().flatten().flatten().map(|e| e.path())
        .filter(|p| p.is_file() && p.extension().and_then(|x| x.to_str()).is_some_and(|x| audio.contains(&x.to_lowercase().as_str())))
        .map(|p| p.to_string_lossy().to_string()).collect()
}

/// The game's own version of a slot (its first Sound object), as WAV, through the preview kit.
#[tauri::command]
pub async fn sounds_original(slot: String, state: State<'_, Arc<Mutex<crate::AppState>>>) -> Result<tauri::ipc::Response, String> {
    let paks = paks_of(&state).ok_or("The game folder is not set.")?;
    tauri::async_runtime::spawn_blocking(move || {
        let exe = vgmstream();
        if !exe.is_file() { return Err("Playing the game's sounds needs the preview kit. Install it in Setup.".to_string()) }
        let s = slots().into_iter().find(|s| s.id == slot).ok_or("Not a sound slot")?;
        let files = game_files(&paks);
        let (pak, entry) = files.get(&s.banks[0]).ok_or("The game's sound bank was not found.")?;
        let bank = extract(pak, entry).ok_or("The game's sound bank could not be read.")?;
        let objs = sound_objects(&bank)?;
        let src = objs.get(&s.sounds[0]).ok_or("The game changed this sound.")?.source;
        // a streamed sound's bank copy is only its start: the whole file sits in Media
        let loose = format!("{}{}/{src}.wem", media_dir(&s.banks[0]), first2(src));
        let wem = files.get(&loose).and_then(|(p, e)| extract(p, e)).map(|b| b.to_vec())
            .or_else(|| media(&bank).ok()?.into_iter().find(|(m, _)| *m == src).map(|(_, d)| d.to_vec()))
            .ok_or("The game's sound could not be found.")?;
        decode_wem(&exe, wem).map(tauri::ipc::Response::new)
    }).await.map_err(|e| e.to_string())?
}

/// 16-bit PCM WAV -> (samples, rate, channels).
fn read_wav(b: &[u8]) -> Result<(Vec<i16>, u32, u16), String> {
    if b.len() < 12 || &b[0..4] != b"RIFF" || &b[8..12] != b"WAVE" { return Err("Not a WAV".into()) }
    let (mut p, mut fmt, mut data) = (12usize, None, None);
    while p + 8 <= b.len() {
        let size = u32::from_le_bytes(b[p + 4..p + 8].try_into().unwrap()) as usize;
        let body = &b[p + 8..(p + 8 + size).min(b.len())];
        match &b[p..p + 4] { b"fmt " if body.len() >= 16 => fmt = Some(body), b"data" => data = Some(body), _ => {} }
        p += 8 + size + (size & 1);
    }
    let (fmt, data) = (fmt.ok_or("WAV without fmt")?, data.ok_or("WAV without data")?);
    let (tag, ch, rate, bits) = (u16::from_le_bytes([fmt[0], fmt[1]]), u16::from_le_bytes([fmt[2], fmt[3]]), u32::from_le_bytes(fmt[4..8].try_into().unwrap()), u16::from_le_bytes([fmt[14], fmt[15]]));
    if tag != 1 || bits != 16 || !(ch == 1 || ch == 2) || !(8000..=192000).contains(&rate) { return Err("Not a 16-bit mono or stereo PCM WAV".into()) }
    let pcm: Vec<i16> = data.chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]])).collect();
    if pcm.len() < ch as usize { return Err("The sound is empty".into()) }
    if pcm.len() / ch as usize > rate as usize * 31 { return Err("The sound is over 30 seconds".into()) } // the page cuts at 30
    Ok((pcm, rate, ch))
}

/// Makes a mod from every slot with a sound, for the install card. Returns its path.
#[tauri::command]
pub async fn sounds_make(state: State<'_, Arc<Mutex<crate::AppState>>>) -> Result<String, String> {
    let paks = paks_of(&state).ok_or("The game folder is not set.")?;
    tauri::async_runtime::spawn_blocking(move || make(paks)).await.map_err(|e| e.to_string())?
}

/// The build behind Make mod, from the game's Paks folder.
fn make(paks: PathBuf) -> Result<String, String> {
    {
        // one build at a time (a page reload mid-build could start a second over the same files)
        static BUSY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
        if BUSY.swap(true, std::sync::atomic::Ordering::SeqCst) { return Err("The sounds mod is already being made.".to_string()) }
        struct Done;
        impl Drop for Done { fn drop(&mut self) { BUSY.store(false, std::sync::atomic::Ordering::SeqCst) } }
        let _done = Done;
        let chosen: Vec<(Slot, Vec<u8>)> = slots().into_iter().filter_map(|s| {
            let wav = std::fs::read(dir().join(format!("{}.wav", s.id))).ok()?;
            Some((s, wav))
        }).collect();
        if chosen.is_empty() { return Err("Add a sound to a slot first.".into()) }
        // encode each once, in parallel (a few seconds of audio each)
        use rayon::prelude::*;
        let wems: Vec<Result<Vec<u8>, String>> = chosen.par_iter().map(|(s, wav)| {
            let (pcm, rate, ch) = read_wav(wav)?;
            crate::xtra_wem::encode(&pcm, rate, ch).map_err(|e| format!("{}: {e}", s.id))
        }).collect();
        let wems = wems.into_iter().collect::<Result<Vec<_>, _>>()?;
        let files = game_files(&paks);
        let quiet = crate::xtra_wem::silence();
        // every real sound before any silence: a file both name keeps the real sound (put_sounds keeps the first)
        let mut by_bank: BTreeMap<&str, Vec<(&[u32], &[u8])>> = BTreeMap::new();
        for ((s, _), wem) in chosen.iter().zip(&wems) {
            for b in &s.banks { by_bank.entry(b.as_str()).or_default().push((&s.sounds, wem)) }
        }
        for (s, _) in chosen.iter().filter(|(s, _)| !s.silence.is_empty()) {
            for b in &s.banks { by_bank.entry(b.as_str()).or_default().push((&s.silence, &quiet)) }
        }
        let tmp = tempfile::tempdir().map_err(|e| e.to_string())?;
        let mut entries = vec![];
        for (key, slots) in by_bank {
            let Some((pak, entry)) = files.get(key) else {
                if media_dir(key) != "wwiseaudio/media/" { continue } // a voice language this install lacks
                return Err("The game's sound bank was not found. Check the game folder in Setup.".into());
            };
            let game = extract(pak, entry).ok_or_else(|| format!("{key} could not be read"))?;
            let media_dir = media_dir(key);
            let lang = media_dir != "wwiseaudio/media/";
            let (bank, streamed) = put_sounds(&game, &slots).map_err(|e| format!("{key}: {e}"))?;
            // the entry's own case for the folders: Marvel/Content/WwiseAudio/English(US)/bnk_vo_system.bnk
            let real_lang = entry.replace('\\', "/").rsplit('/').nth(1).filter(|_| lang).map(str::to_string);
            let bank_file = match &real_lang { Some(l) => format!("Marvel/Content/WwiseAudio/{l}/{}", key.rsplit('/').next().unwrap()), None => format!("Marvel/Content/WwiseAudio/{}", key.rsplit('/').next().unwrap()) };
            write_entry(tmp.path(), key, &bank_file, bank, &mut entries)?;
            for (id, wem) in streamed {
                let first2 = first2(id);
                let file = match &real_lang { Some(l) => format!("Marvel/Content/WwiseAudio/Media/{l}/{first2}/{id}.wem"), None => format!("Marvel/Content/WwiseAudio/Media/{first2}/{id}.wem") };
                write_entry(tmp.path(), &format!("{media_dir}{first2}/{id}.wem"), &file, wem, &mut entries)?;
            }
        }
        if entries.is_empty() { return Err("The game's sound banks were not found.".into()) }
        // a fresh folder each time: the install card copies the pak into ~mods, this one is only handed over
        let out = dir().join("out");
        let _ = std::fs::remove_dir_all(&out);
        std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
        let dest = out.join(format!("{MOD_STEM}.pak"));
        uasset_toolkit::create_pak(&dest.to_string_lossy(), entries, Some("../../../"), Some(0), Some(AES_KEY_HEX))
            .map_err(|e| format!("Could not pack the sounds: {e}"))?;
        Ok(dest.to_string_lossy().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A bank with one HIRC of Sound objects and media, the shape put_sounds reads.
    fn bank(sounds: &[(u32, u8, u32)], media: &[(u32, &[u8])]) -> Vec<u8> {
        let mut hirc = (sounds.len() as u32).to_le_bytes().to_vec();
        for (id, stream, src) in sounds {
            let mut body = id.to_le_bytes().to_vec();
            body.extend_from_slice(&0x40001u32.to_le_bytes());
            body.push(*stream);
            body.extend_from_slice(&src.to_le_bytes());
            body.extend_from_slice(&[0; 8]);
            hirc.push(2);
            hirc.extend_from_slice(&(body.len() as u32).to_le_bytes());
            hirc.extend_from_slice(&body);
        }
        let (mut didx, mut data) = (vec![], vec![]);
        for (id, d) in media {
            didx.extend_from_slice(&id.to_le_bytes());
            didx.extend_from_slice(&(data.len() as u32).to_le_bytes());
            didx.extend_from_slice(&(d.len() as u32).to_le_bytes());
            data.extend_from_slice(d);
            data.resize(data.len().div_ceil(16) * 16, 0);
        }
        let mut b = vec![];
        for (t, body) in [(b"BKHD", vec![0u8; 8]), (b"DIDX", didx), (b"DATA", data), (b"HIRC", hirc)] {
            b.extend_from_slice(t);
            b.extend_from_slice(&(body.len() as u32).to_le_bytes());
            b.extend_from_slice(&body);
        }
        b
    }

    #[test]
    fn every_file_is_replaced_in_place_and_the_first_replacement_wins() {
        // Sounds 10 and 11 share file 100 (First KO and Double kill), Sound 12 alone plays 200 (streamed)
        let game = bank(&[(10, 0, 100), (11, 0, 100), (12, 1, 200)], &[(100, b"aaaa"), (200, b"bbbb")]);
        let silence: &[u8] = b"QUIET";
        let (out, streamed) = put_sounds(&game, &[(&[10], b"NEW1"), (&[12], b"NEW2"), (&[11], silence)]).unwrap();
        let objs = sound_objects(&out).unwrap();
        let m: BTreeMap<u32, Vec<u8>> = media(&out).unwrap().into_iter().map(|(i, d)| (i, d.to_vec())).collect();
        assert_eq!((objs[&10].source, objs[&11].source, objs[&12].source), (100, 100, 200), "no Sound object is pointed at a new file");
        assert_eq!(m[&100], b"NEW1", "the shared file holds the first entry's sound, a later silence does not replace it");
        assert_eq!(m[&200], b"NEW2");
        assert_eq!(m.len(), 2, "no file added");
        assert_eq!(streamed, vec![(200, b"NEW2".to_vec())], "a streamed sound also goes to Media");
        let hirc = |b: &[u8]| { let (_, r) = sections(b).unwrap().into_iter().find(|(t, _)| t == b"HIRC").unwrap(); b[r].to_vec() };
        assert_eq!(hirc(&out), hirc(&game), "the HIRC is the game's, byte for byte");
    }

    /// The whole build on the game's real banks, without the app: SOUNDS_BANKS = a folder holding Marvel/Content/WwiseAudio
    /// as extracted from the game, SOUNDS_OUT = where the rebuilt banks and streamed files go. Each slot gets a tone of
    /// its own pitch (440 Hz + 20 Hz x its place in the table), to check by decoding them.
    /// `SOUNDS_BANKS=... SOUNDS_OUT=... cargo test --bin REPAK-X real_banks -- --ignored`
    #[test]
    #[ignore]
    fn real_banks() {
        let (Ok(src), Ok(out)) = (std::env::var("SOUNDS_BANKS"), std::env::var("SOUNDS_OUT")) else { return };
        let all = slots();
        let wems: Vec<Vec<u8>> = all.iter().enumerate().map(|(i, _)| {
            let f = 440.0 + 20.0 * i as f32;
            let pcm: Vec<i16> = (0..48000).map(|n| ((n as f32 * f * std::f32::consts::TAU / 48000.0).sin() * 12000.0) as i16).collect();
            crate::xtra_wem::encode(&pcm, 48000, 1).unwrap()
        }).collect();
        let keys: BTreeSet<&str> = all.iter().flat_map(|s| s.banks.iter().map(|b| b.as_str())).collect();
        for key in keys {
            let rel = key.strip_prefix("wwiseaudio/").unwrap();
            let path = std::fs::read_dir(format!("{src}/Marvel/Content/WwiseAudio")).unwrap().flatten()
                .flat_map(|e| if e.path().is_dir() { std::fs::read_dir(e.path()).unwrap().flatten().map(|f| f.path()).collect() } else { vec![e.path()] })
                .find(|p| p.to_string_lossy().replace('\\', "/").to_lowercase().ends_with(rel)).unwrap();
            let game = std::fs::read(&path).unwrap();
            let quiet = crate::xtra_wem::silence();
            let picks: Vec<(&[u32], &[u8])> = all.iter().zip(&wems).filter(|(s, _)| s.banks.iter().any(|b| b == key))
                .flat_map(|(s, w)| [(&s.sounds[..], &w[..]), (&s.silence[..], &quiet[..])]).filter(|(ids, _)| !ids.is_empty()).collect();
            let (bank, streamed) = put_sounds(&game, &picks).unwrap();
            let dest = PathBuf::from(&out).join(rel);
            std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
            std::fs::write(&dest, bank).unwrap();
            for (id, wem) in streamed { std::fs::write(dest.parent().unwrap().join(format!("stream_{id}.wem")), wem).unwrap() }
        }
    }

    /// Make mod without the app, from the slots saved on this PC (app dir sounds\):
    /// `REPAKXTRA_PAKS=<...\Content\Paks> cargo test --bin REPAK-X make_from_saved_sounds -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn make_from_saved_sounds() {
        let paks = PathBuf::from(std::env::var("REPAKXTRA_PAKS").expect("REPAKXTRA_PAKS"));
        println!("{}", make(paks).unwrap());
    }

    #[test]
    fn slot_table_is_whole() {
        let s = slots();
        assert_eq!(s.len(), 148);
        assert!(s.iter().all(|s| !s.sounds.is_empty() && !s.banks.is_empty()));
    }
}
