//! repakxtra: crash facts for the setup report (the newest crash, without its folder path), and which mods hold the
//! asset a crash names (crash suspects, custom/CrashSuspects.tsx).

use crate::crash_monitor;
use regex_lite::Regex;
use serde::Serialize;
use std::sync::OnceLock;

#[derive(Serialize)]
pub struct NewestCrash {
    /// Unix seconds when the crash folder was made
    time: u64,
    crash_type: Option<String>,
    asset_path: Option<String>,
    /// The hero the error names (crash_monitor's rule), for crashes that name no asset
    character_id: Option<String>,
    /// How long the game had run when it crashed
    seconds_since_start: Option<u64>,
    /// The error's first line, cut short
    message: Option<String>,
    /// A serial size mismatch's numbers, when that is what it was
    detail: Option<String>,
    /// "3962284" and "5.3.2-3962284+++depot_marvel+S10.5_release"
    build_version: Option<String>,
    engine_version: Option<String>,
    cpu: Option<String>,
    gpu: Option<String>,
    gpu_driver: Option<String>,
    /// "D3D12"
    rhi: Option<String>,
    os: Option<String>,
    ram_gb: Option<u64>,
    /// The engine says it ran out of memory
    oom: bool,
    /// The crashed thread's name, "FAsyncLoadingThread"
    thread: Option<String>,
    /// The top frame's module and its class ("game", "Windows", "GPU driver", "third-party", "unknown")
    faulting_module: Option<String>,
    faulting_class: Option<&'static str>,
    /// The top 5 frames, "Marvel-Win64-Shipping + 10c296b (game)"
    stack: Vec<String>,
    /// File names of the loaded modules that are not the game's, Windows' or the GPU driver's (.asi, proxy DLLs)
    third_party: Vec<String>,
}

/// The newest crash the game left, if any. Reads only; the startup crash check keeps its own bookkeeping.
/// Everything it returns has been through redact().
#[tauri::command]
pub fn xtra_newest_crash() -> Option<NewestCrash> {
    let (_, folder) = crash_monitor::get_newest_crash_folder()?;
    let info = crash_monitor::parse_crash_info(&folder, Vec::new())?;
    let (asset_path, error_type, detail) = crash_monitor::parse_error_details(info.error_message.as_deref().unwrap_or(""));
    let time = info.timestamp.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let message = info.error_message.as_deref().and_then(|e| short_message(e, asset_path.as_deref()));
    // parse_crash_info already refused a file over 10 MB, so this read is the same file it parsed
    let xml = std::fs::read_to_string(folder.join("CrashContext.runtime-xml")).ok().filter(|x| x.len() <= 10_000_000).unwrap_or_default();
    let tag = |name: &str| crash_monitor::extract_xml_tag(&xml, name);
    let modules: Vec<String> = tag("Modules").map(|m| m.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect()).unwrap_or_default();
    let root = norm(&tag("RootDir").unwrap_or_default());
    let thread_xml = crashed_thread(&xml).unwrap_or("");
    // PCallStack already skips the engine's own crash-handling frames, the crashed thread's stack does not
    let mut top = tag("PCallStack").map(|s| frames(&s)).unwrap_or_default();
    if top.is_empty() {
        top = crash_monitor::extract_xml_tag(thread_xml, "CallStack").map(|s| frames(&s)).unwrap_or_default();
    }
    let class_of = |m: &str| classify(m, &modules, &root);
    let users = user_names();
    let r = |s: Option<String>| s.map(|s| redact(&s, &users));
    Some(NewestCrash {
        time,
        crash_type: r(error_type.or(info.crash_type)),
        character_id: info.error_message.as_deref().and_then(crash_monitor::extract_character_id),
        asset_path: r(asset_path),
        seconds_since_start: info.seconds_since_start,
        message: r(message),
        detail: r(detail.and_then(|d| first_line(&d))),
        build_version: r(tag("BuildVersion")),
        engine_version: r(tag("EngineVersion")),
        cpu: r(tag("Misc.CPUBrand")),
        gpu: r(tag("RHI.AdapterName")),
        gpu_driver: r(tag("RHI.UserDriverVersion")),
        rhi: r(tag("RHI.RHIName")),
        os: r(tag("Misc.OSVersionMajor")),
        ram_gb: tag("MemoryStats.TotalPhysicalGB").and_then(|s| s.parse().ok()),
        oom: tag("MemoryStats.bIsOOM").is_some_and(|s| s == "1" || s.eq_ignore_ascii_case("true")),
        thread: r(crash_monitor::extract_xml_tag(thread_xml, "ThreadName")),
        faulting_module: r(top.first().map(|(m, _)| m.clone())),
        faulting_class: top.first().map(|(m, _)| class_of(m).label()),
        stack: top.iter().take(5).map(|(m, off)| redact(&format!("{m} + {off} ({})", class_of(m).label()), &users)).collect(),
        third_party: modules.iter()
            .filter(|p| class_of_path(p, &root) == ModuleClass::ThirdParty && !crate::xtra_setup::is_bundled_bypass(std::path::Path::new(p)))
            .map(|p| redact(p.rsplit(['\\', '/']).next().unwrap_or(p), &users)).collect(),
    })
}

/// The `<Thread>` block whose IsCrashed is true.
fn crashed_thread(xml: &str) -> Option<&str> {
    let at = xml.find("<IsCrashed>true</IsCrashed>")?;
    let start = xml[..at].rfind("<Thread>")?;
    let end = at + xml[at..].find("</Thread>")?;
    Some(&xml[start..end])
}

/// A UE portable call stack ("ntdll 0x00007fff89350000 + 9dc24 KERNELBASE 0x... + 462ce") as (module, offset) pairs.
fn frames(stack: &str) -> Vec<(String, String)> {
    static FRAME: OnceLock<Regex> = OnceLock::new();
    let re = FRAME.get_or_init(|| Regex::new(r"(\S+)\s+0x[0-9A-Fa-f]+\s*\+\s*([0-9A-Fa-f]+)").unwrap());
    re.captures_iter(stack).map(|c| (c[1].to_string(), c[2].to_string())).collect()
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum ModuleClass {
    Game,
    Windows,
    GpuDriver,
    ThirdParty,
    Unknown,
}

impl ModuleClass {
    fn label(self) -> &'static str {
        match self {
            ModuleClass::Game => "game",
            ModuleClass::Windows => "Windows",
            ModuleClass::GpuDriver => "GPU driver",
            ModuleClass::ThirdParty => "third-party",
            ModuleClass::Unknown => "unknown",
        }
    }
}

/// Lower case with forward slashes, so paths compare.
fn norm(path: &str) -> String {
    path.replace('\\', "/").to_lowercase()
}

/// A path's file name without its last extension, lower case: "sl.common.dll" is "sl.common".
fn file_stem(path: &str) -> String {
    let p = norm(path);
    let file = p.rsplit('/').next().unwrap_or(&p);
    file.rsplit_once('.').map(|(s, _)| s).unwrap_or(file).to_string()
}

/// DLL names a mod loader or overlay takes over by sitting beside the game exe (the signature bypass is dsound.dll).
const PROXY_DLLS: &[&str] = &[
    "dsound", "dinput8", "winmm", "version", "d3d9", "d3d11", "d3d12", "dxgi", "xinput1_3", "xinput1_4", "xinput9_1_0",
    "winhttp", "wininet", "dwmapi", "msimg32", "opengl32", "bcrypt", "iphlpapi",
];
/// Windows' own modules, for stack frames whose path the crash file does not list.
const WINDOWS_DLLS: &[&str] = &[
    "ntdll", "kernel32", "kernelbase", "user32", "gdi32", "gdi32full", "win32u", "ucrtbase", "msvcp140", "msvcp140_1",
    "vcruntime140", "vcruntime140_1", "combase", "rpcrt4", "ole32", "oleaut32", "advapi32", "sechost", "ws2_32", "dxgi",
    "d3d11", "d3d12", "d3d12core", "dxcore", "d3dcompiler_47", "dbghelp", "xaudio2_9", "mmdevapi", "audioses", "shell32",
    "bcrypt", "crypt32", "msvcrt",
];
/// Name starts of NVIDIA, AMD and Intel user-mode driver modules.
const GPU_PREFIXES: &[&str] = &[
    "nvwgf2um", "nvd3dum", "nvoglv", "nvgpucomp", "nvldumd", "nvapi", "nvcuda", "nvumdshim", "nvppe", "atidxx", "atiumd",
    "atiadl", "aticfx", "amdxc", "amdxx", "amdenc", "amdihk", "amdvlk", "amdadlx", "igd", "igc64", "igxe",
];

fn is_gpu_name(stem: &str) -> bool {
    GPU_PREFIXES.iter().any(|p| stem.starts_with(p))
}

/// Where a loaded module came from decides its class: a .asi plugin or a proxy DLL beside the exe is a mod loader,
/// DriverStore is the GPU driver, the Windows folder is Windows, the rest of the game folder is the game's own, and
/// anything else (overlays, injectors) is third-party. `root` is the crash's RootDir, normalized.
fn class_of_path(path: &str, root: &str) -> ModuleClass {
    let p = norm(path);
    let stem = file_stem(&p);
    let exe_dir = format!("{root}marvel/binaries/win64/");
    if p.ends_with(".asi") {
        ModuleClass::ThirdParty
    } else if p.contains("/driverstore/") || is_gpu_name(&stem) {
        ModuleClass::GpuDriver
    } else if p.contains("/windows/") {
        ModuleClass::Windows
    } else if !root.is_empty() && p.starts_with(root) {
        let beside_exe = p.strip_prefix(&exe_dir).is_some_and(|rest| !rest.contains('/'));
        if beside_exe && PROXY_DLLS.contains(&stem.as_str()) { ModuleClass::ThirdParty } else { ModuleClass::Game }
    } else {
        ModuleClass::ThirdParty
    }
}

/// A stack frame's module ("KERNELBASE", "Marvel-Win64-Shipping"): by its path when the crash lists it, else by name.
fn classify(module: &str, modules: &[String], root: &str) -> ModuleClass {
    let name = module.to_lowercase();
    if let Some(path) = modules.iter().find(|m| file_stem(m) == name) {
        return class_of_path(path, root);
    }
    if name == "unknown" {
        ModuleClass::Unknown
    } else if is_gpu_name(&name) {
        ModuleClass::GpuDriver
    } else if WINDOWS_DLLS.contains(&name.as_str()) || name.starts_with("api-ms-win") {
        ModuleClass::Windows
    } else if name.starts_with("marvel-") {
        ModuleClass::Game
    } else {
        ModuleClass::ThirdParty
    }
}

/// The Windows user name and the home folder's name, 3 characters or more (shorter would cut common words apart).
fn user_names() -> Vec<String> {
    let mut names: Vec<String> = [std::env::var("USERNAME").ok(), dirs::home_dir().and_then(|h| h.file_name().map(|n| n.to_string_lossy().into_owned()))]
        .into_iter().flatten().filter(|n| n.chars().count() >= 3).collect();
    names.dedup_by(|a, b| a.eq_ignore_ascii_case(b));
    names
}

/// Takes out what could name the player or their PC: emails, keyed ids (uid=, token:, MachineId=, player name: ...),
/// command-line flag values (the flag stays), Steam ids, IPv4 addresses and the Windows user name `users`.
/// setupReport.ts scrub() still runs after this, on file paths.
pub(crate) fn redact(text: &str, users: &[String]) -> String {
    static RULES: OnceLock<[(Regex, &'static str); 4]> = OnceLock::new();
    static DOTTED: OnceLock<Regex> = OnceLock::new();
    let rules = RULES.get_or_init(|| [
        (Regex::new(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+").unwrap(), "<email>"),
        (Regex::new(r#"(?i)(\b\w*(?:uid|udid|token|ticket|machine_?id|device_?id|account_?id|session[_ ]?id|player[_ ]?name)["']?\s*[:=]\s*["']?)[^\s"'&,;<>]+"#).unwrap(), "${1}<redacted>"),
        (Regex::new(r#"(^|\s)(--?[A-Za-z][\w.-]*)=(?:"[^"]*"|\S+)"#).unwrap(), "${1}${2}=<redacted>"),
        (Regex::new(r"\b7656119\d{10}\b").unwrap(), "<steam id>"),
    ]);
    let mut out = text.to_string();
    for (re, with) in rules {
        out = re.replace_all(&out, *with).into_owned();
    }
    // a whole dotted number run, so "10.0.19045.6466" (a Windows version) is not read as an address inside it
    let dotted = DOTTED.get_or_init(|| Regex::new(r"\d[\d.]*\d").unwrap());
    out = dotted.replace_all(&out, |c: &regex_lite::Captures| {
        let parts: Vec<&str> = c[0].split('.').collect();
        if parts.len() == 4 && parts.iter().all(|p| p.parse::<u8>().is_ok()) { "<ip>".to_string() } else { c[0].to_string() }
    }).into_owned();
    for user in users {
        if let Ok(re) = Regex::new(&format!("(?i){}", regex_lite::escape(user))) {
            out = re.replace_all(&out, "<user>").into_owned();
        }
    }
    out
}

/// The error's first line without what the report already says: the engine's source folders before the file name, the
/// object hashes, and the crashed asset (on the Newest crash line), so what failed inside it fits in the 300 characters.
fn short_message(error: &str, asset: Option<&str>) -> Option<String> {
    static SOURCE: OnceLock<Regex> = OnceLock::new();
    static HASH: OnceLock<Regex> = OnceLock::new();
    static REPEAT: OnceLock<Regex> = OnceLock::new();
    let line = error.lines().map(str::trim).find(|l| !l.is_empty())?;
    let mut out = SOURCE.get_or_init(|| Regex::new(r"\[File:[^\]]*[\\/]").unwrap()).replace_all(line, "[File:").into_owned();
    out = HASH.get_or_init(|| Regex::new(r" \(0x[0-9A-Fa-f]+\)").unwrap()).replace_all(&out, "").into_owned();
    if let Some(asset) = asset.filter(|a| !a.trim().is_empty()) {
        // the package path, and its object path (".NS_A:SystemUpdateScript" keeps the part after the colon)
        if let Ok(re) = Regex::new(&format!(r"{}(?:\.\w+)?", regex_lite::escape(asset))) {
            out = re.replace_all(&out, "<asset>").into_owned();
        }
        out = REPEAT.get_or_init(|| Regex::new(r"<asset>(?: <asset>)+").unwrap()).replace_all(&out, "<asset>").into_owned();
    }
    first_line(&out)
}

/// The first line with words in it, cut at 300 characters.
fn first_line(text: &str) -> Option<String> {
    let line = text.lines().map(str::trim).find(|l| !l.is_empty())?;
    Some(line.chars().take(300).collect())
}

/// One spelling per game asset: the UE path (`Game/...`) without its extension or object name, lower case.
/// "/Game/Marvel/X/SK_A.SK_A", "Marvel/Content/Marvel/X/SK_A.uasset" and "../../../Marvel/Content/Marvel/X/SK_A.uexp"
/// all become "game/marvel/x/sk_a".
pub(crate) fn asset_key(raw: &str) -> String {
    let path = crate::asset_explorer::normalize_asset_path(raw.trim());
    let (dir, name) = path.rsplit_once('/').map(|(d, n)| (Some(d), n)).unwrap_or((None, path.as_str()));
    let name = name.split('.').next().unwrap_or(name);
    match dir {
        Some(d) => format!("{d}/{name}").to_lowercase(),
        None => name.to_lowercase(),
    }
}

/// Whether a mod's file list holds the crashed asset.
fn holds_asset(files: &[String], asset: &str) -> bool {
    let want = asset_key(asset);
    !want.is_empty() && files.iter().any(|f| asset_key(f) == want)
}

/// A mod's file list, on or off: the .utoc next to it (IoStore) or the .pak itself.
pub(crate) fn mod_files(path: &std::path::Path) -> Vec<String> {
    let utoc = path.with_extension("utoc");
    if utoc.exists() {
        return crate::utoc_utils::read_utoc(&utoc).into_iter().map(|e| e.file_path).collect();
    }
    uasset_toolkit::list_pak_files(path.to_str().unwrap_or_default(), Some(crate::install_mod::AES_KEY_HEX)).unwrap_or_default()
}

/// The mods (of `mod_paths`) that contain the asset a crash names.
#[tauri::command]
pub async fn xtra_crash_suspects(asset_path: String, mod_paths: Vec<String>) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        mod_paths.into_iter().filter(|p| holds_asset(&mod_files(std::path::Path::new(p)), &asset_path)).collect()
    })
    .await
    .map_err(|e| e.to_string())
}

/// How close a mod is to a crash: it holds the crashed asset, changes the same hero's same skin, or the same hero.
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum Tier {
    Asset,
    Skin,
    Hero,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Tiered {
    path: String,
    tier: Tier,
    /// a hero match while the crash names a skin: the mod changes another skin of that hero
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    other_skin: bool,
    /// the hero the crash points at (from the asset's folders, else the crash's id), so the reasons name the same one
    #[serde(skip_serializing_if = "Option::is_none")]
    hero: Option<String>,
}

/// The hero and skin a crash points at: from the crashed asset's folders, else the crash's character id (no skin then).
fn crash_hero(asset_path: &str, hero_id: Option<&str>) -> Option<crate::xtra_heroes::HeroSkin> {
    crate::xtra_heroes::hero_skin(asset_path).or_else(|| {
        let id = hero_id.filter(|h| h.len() == 4 && h.bytes().all(|b| b.is_ascii_digit()))?;
        Some(crate::xtra_heroes::HeroSkin { hero: id.to_string(), skin: None })
    })
}

/// A mod's best tier for the crash, or None. Pure.
fn tier_of(files: &[String], asset_path: &str, hero: Option<&crate::xtra_heroes::HeroSkin>) -> Option<Tier> {
    if holds_asset(files, asset_path) {
        return Some(Tier::Asset);
    }
    let hero = hero?;
    let mut best = None;
    for f in files {
        match crate::xtra_heroes::hero_skin(f) {
            Some(h) if h.hero == hero.hero && hero.skin.is_some() && h.skin == hero.skin => return Some(Tier::Skin),
            Some(h) if h.hero == hero.hero => best = Some(Tier::Hero),
            _ => {}
        }
    }
    best
}

/// A mod's file list (on or off) through the conflict check's cache. None when it cannot be read.
fn listed(path: &std::path::Path) -> Option<std::sync::Arc<Vec<String>>> {
    let utoc = crate::xtra_bundle::companion(path, "utoc");
    let utoc = utoc.exists().then_some(utoc);
    crate::xtra_conflicts::files_cached(path, utoc.as_deref(), || match &utoc {
        Some(u) => crate::utoc_utils::try_read_utoc(u).map(|e| e.into_iter().map(|e| e.file_path).collect()).map_err(|e| e.to_string()),
        None => uasset_toolkit::list_pak_files(path.to_str().unwrap_or_default(), Some(crate::install_mod::AES_KEY_HEX)).map_err(|e| e.to_string()),
    })
    .ok()
}

fn tiers(asset_path: &str, hero_id: Option<&str>, mod_paths: &[String], read: impl Fn(&std::path::Path) -> Option<std::sync::Arc<Vec<String>>>) -> Vec<Tiered> {
    let hero = crash_hero(asset_path, hero_id);
    let mut out: Vec<Tiered> = mod_paths
        .iter()
        .filter_map(|p| {
            let tier = tier_of(&read(std::path::Path::new(p))?, asset_path, hero.as_ref())?;
            let other_skin = tier == Tier::Hero && hero.as_ref().is_some_and(|h| h.skin.is_some());
            Some(Tiered { path: p.clone(), tier, other_skin, hero: hero.as_ref().map(|h| h.hero.clone()) })
        })
        .collect();
    out.sort_by_key(|t| t.tier); // stable: the given order within a tier
    out
}

/// The mods (of `mod_paths`) that match a crash, best tier per mod, asset first, then skin, then hero. Mods that match
/// nothing, or whose files cannot be read, are left out.
#[tauri::command]
pub async fn xtra_crash_tiers(asset_path: String, hero_id: Option<String>, mod_paths: Vec<String>) -> Result<Vec<Tiered>, String> {
    tauri::async_runtime::spawn_blocking(move || tiers(&asset_path, hero_id.as_deref(), &mod_paths, listed)).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crash_tiers_rank_asset_then_skin_then_hero() {
        let lists: std::collections::HashMap<&str, Vec<String>> = [
            ("exact.pak", v(&["Marvel/Content/Marvel/Characters/1026/1026001/Meshes/SK_1026_1026001.uasset"])),
            ("io.pak", v(&["../../../Marvel/Content/Marvel/Characters/1026/1026001/Meshes/SK_1026_1026001.uexp"])),
            ("skin.pak", v(&["/Game/Marvel/Characters/1026/1026001/Textures/T_Body_D.uasset"])),
            ("hero.pak", v(&["/Game/Marvel/Characters/1026/1026500/Textures/T_Body_D.uasset", "/Game/Marvel/Characters/1026/Weapons/X.uasset"])),
            ("other.pak", v(&["/Game/Marvel/Characters/1011/1011001/Textures/T_Body_D.uasset"])),
            ("named.pak", v(&["/Game/Marvel/UI/Textures/T_1026001_Icon.uasset"])),
        ]
        .into();
        let read = |p: &std::path::Path| lists.get(p.to_str().unwrap()).cloned().map(std::sync::Arc::new);
        let mods: Vec<String> = ["other.pak", "hero.pak", "missing.pak", "skin.pak", "io.pak", "exact.pak", "named.pak"].map(String::from).to_vec();
        let got = tiers("/Game/Marvel/Characters/1026/1026001/Meshes/SK_1026_1026001.SK_1026_1026001", None, &mods, read);
        assert!(got.iter().all(|t| t.other_skin == (t.tier == Tier::Hero)), "the crash names a skin: a hero match is another skin");
        let got: Vec<(&str, Tier)> = got.iter().map(|t| (t.path.as_str(), t.tier)).collect();
        assert_eq!(got, [("io.pak", Tier::Asset), ("exact.pak", Tier::Asset), ("skin.pak", Tier::Skin), ("hero.pak", Tier::Hero)],
            "pak and IoStore spellings both hold the asset, an unreadable list and other heroes are left out, a file name never counts");
    }

    /// Real proof: REPAKXTRA_PAKS=<...\Content\Paks> cargo test -p repak-x --bin REPAK-X real_newest_crash -- --ignored
    /// --nocapture. The newest crash against the mods that are on now: before (exact asset) and after (tiers).
    #[test]
    #[ignore]
    fn real_newest_crash() {
        let paks = std::path::PathBuf::from(std::env::var("REPAKXTRA_PAKS").expect("REPAKXTRA_PAKS"));
        let crash = xtra_newest_crash().expect("a crash");
        let asset = crash.asset_path.clone().unwrap_or_default();
        println!("newest crash: {:?} asset {asset:?}", crash.crash_type);
        let on: Vec<String> = walkdir::WalkDir::new(paks.join("~mods"))
            .into_iter()
            .filter_entry(crate::xtra_bundle::not_staging)
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x == "pak"))
            .map(|e| e.path().to_string_lossy().to_string())
            .collect();
        println!("{} mods on", on.len());
        let before: Vec<&String> = on.iter().filter(|p| holds_asset(&mod_files(std::path::Path::new(p)), &asset)).collect();
        println!("before (exact asset): {}", before.len());
        for p in before {
            println!("   {p}");
        }
        let hero_id = crash_monitor::extract_character_id(&asset);
        println!("crash hero: {:?} (id from the path: {hero_id:?})", crash_hero(&asset, hero_id.as_deref()));
        let after = tiers(&asset, hero_id.as_deref(), &on, listed);
        println!("after (tiers): {}", after.len());
        for t in after {
            println!("   {:?} {}", t.tier, t.path);
        }
    }

    #[test]
    fn crash_tiers_need_a_hero_beyond_the_asset() {
        let files = v(&["/Game/Marvel/Characters/1026/1026001/Textures/T_Body_D.uasset"]);
        assert_eq!(tier_of(&files, "/Game/Marvel/UI/X.X", None), None, "no hero known: only the asset tier");
        let from_id = crash_hero("/Game/Marvel/UI/X.X", Some("1026"));
        assert_eq!(tier_of(&files, "/Game/Marvel/UI/X.X", from_id.as_ref()), Some(Tier::Hero), "hero from the crash's character id, no skin");
        assert_eq!(crash_hero("", Some("10x6")), None, "a malformed id is ignored");
        let read = |_: &std::path::Path| Some(std::sync::Arc::new(files.clone()));
        let rows = tiers("/Game/Marvel/UI/X.X", Some("1026"), &["m.pak".to_string()], read);
        assert!(!rows[0].other_skin, "no skin known: just the same hero");
        assert_eq!(rows[0].hero.as_deref(), Some("1026"), "the hero the reasons name");
        let rows = tiers("/Game/Marvel/Characters/1011/1011001/A.A", Some("1026"), &["m.pak".to_string()], |_| Some(std::sync::Arc::new(v(&["/Game/Marvel/Characters/1011/1011500/B.uasset"]))));
        assert_eq!(rows[0].hero.as_deref(), Some("1011"), "the asset's hero, not the crash's id");
        assert_eq!(crash_hero("/Game/Marvel/Characters/1011/1011001/A.A", Some("1026")).map(|h| h.hero), Some("1011".into()), "the asset's folder wins over the id");
    }

    fn v(paths: &[&str]) -> Vec<String> {
        paths.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn crash_asset_matches_pak_and_iostore_spellings() {
        let crash = "/Game/Marvel/Characters/1026/1026001/Meshes/SK_1026_1026001.SK_1026_1026001";
        assert!(holds_asset(&v(&["Marvel/Content/Marvel/Characters/1026/1026001/Meshes/SK_1026_1026001.uasset"]), crash));
        assert!(holds_asset(&v(&["../../../Marvel/Content/Marvel/Characters/1026/1026001/Meshes/SK_1026_1026001.uexp"]), crash));
        assert!(holds_asset(&v(&["marvel/content/marvel/characters/1026/1026001/meshes/sk_1026_1026001.ubulk"]), crash), "case differs");
        assert!(holds_asset(&v(&[r"Marvel\Content\Marvel\Characters\1026\1026001\Meshes\SK_1026_1026001.uasset"]), crash), "backslashes");
    }

    #[test]
    fn the_message_is_its_first_line_cut_short() {
        assert_eq!(first_line("
  Fatal error: x
second").as_deref(), Some("Fatal error: x"));
        assert_eq!(first_line("a".repeat(400).as_str()).map(|s| s.len()), Some(300));
        assert_eq!(first_line(" 
 "), None);
    }

    #[test]
    fn the_message_names_the_crashed_asset_once_and_keeps_what_failed_in_it() {
        let asset = "/Game/Marvel/VFX/Particles/Characters/1026/1026001/102671/NS_102671_Hit_01";
        let error = format!(r"Fatal error: [File:G:\workspace\S10.5_release\UnrealEngine\Engine\Source\Runtime\CoreUObject\Private\Serialization\AsyncLoading2.cpp] [Line: 6459] ObjectSerializationError: {asset} (0x6289A3B9C8F1BA7A) {asset} (0x6289A3B9C8F1BA7A) - NiagaraDataInterfaceCurve {asset}.NS_102671_Hit_01:SystemUpdateScript.NiagaraDataInterfaceCurve_0: Serial size mismatch: Expected read size 408, Actual read size 16");
        assert_eq!(short_message(&error, Some(asset)).as_deref(), Some("Fatal error: [File:AsyncLoading2.cpp] [Line: 6459] ObjectSerializationError: <asset> - NiagaraDataInterfaceCurve <asset>:SystemUpdateScript.NiagaraDataInterfaceCurve_0: Serial size mismatch: Expected read size 408, Actual read size 16"));
        let av = "Unhandled Exception: EXCEPTION_ACCESS_VIOLATION writing address 0x0000019d741b18a0";
        assert_eq!(short_message(av, None).as_deref(), Some(av), "no asset: as it was");
    }

    fn users() -> Vec<String> {
        v(&["Alice"])
    }

    #[test]
    fn redacts_the_windows_user_name_in_any_case() {
        assert_eq!(redact(r"C:\Users\Alice\AppData and ALICE-PC", &users()), r"C:\Users\<user>\AppData and <user>-PC");
        assert_eq!(redact("nothing here", &users()), "nothing here");
    }

    #[test]
    fn redacts_steam_ids_but_not_other_long_numbers() {
        assert_eq!(redact("steam 76561198012345678 build 3962284", &[]), "steam <steam id> build 3962284");
        assert_eq!(redact("765611980123456789", &[]), "765611980123456789", "18 digits is not a Steam id");
    }

    #[test]
    fn redacts_emails() {
        assert_eq!(redact("mail first.last+rivals@example.co.uk now", &[]), "mail <email> now");
    }

    #[test]
    fn redacts_ipv4_but_not_versions() {
        assert_eq!(redact("from 192.168.1.20:7777", &[]), "from <ip>:7777");
        assert_eq!(redact("Windows 10 (22H2) [10.0.19045.6466]", &[]), "Windows 10 (22H2) [10.0.19045.6466]", "an OS build");
        assert_eq!(redact("driver 32.0.21045.16010, engine 5.3.2", &[]), "driver 32.0.21045.16010, engine 5.3.2");
        assert_eq!(redact("999.1.1.1", &[]), "999.1.1.1", "not an address");
    }

    #[test]
    fn redacts_keyed_ids_and_keeps_the_key() {
        assert_eq!(redact("uid=12345 token: abc.def", &[]), "uid=<redacted> token: <redacted>");
        assert_eq!(redact(r#"{"ticket":"T-99","udid":"X1"}"#, &[]), r#"{"ticket":"<redacted>","udid":"<redacted>"}"#);
        assert_eq!(redact("MachineId=AB12 EpicAccountId=cd34 DeviceID: 77", &[]), "MachineId=<redacted> EpicAccountId=<redacted> DeviceID: <redacted>");
        assert_eq!(redact("session id: s1 Player Name=Bob", &[]), "session id: <redacted> Player Name=<redacted>");
        assert_eq!(redact("tokens are fine", &[]), "tokens are fine");
    }

    #[test]
    fn redacts_command_line_values_and_keeps_the_flags() {
        assert_eq!(redact(r#"Marvel.exe -dx12 -AUTH_LOGIN=bob --auth="a b" -nosplash"#, &[]), "Marvel.exe -dx12 -AUTH_LOGIN=<redacted> --auth=<redacted> -nosplash");
        assert_eq!(redact("Marvel-Win64-Shipping x=1", &[]), "Marvel-Win64-Shipping x=1", "a dash inside a word is no flag");
    }

    const ROOT: &str = "c:/program files (x86)/steam/steamapps/common/marvelrivals/marvelgame/";

    fn game_modules() -> Vec<String> {
        let win64 = r"C:\Program Files (x86)\Steam\steamapps\common\MarvelRivals\MarvelGame\Marvel\Binaries\Win64";
        v(&[
            &format!(r"{win64}\Marvel-Win64-Shipping.exe"),
            &format!(r"{win64}\dsound.dll"),
            &format!(r"{win64}\steam_api64.dll"),
            &format!(r"{win64}\D3D12\D3D12Core.dll"),
            &format!(r"{win64}\plugins\MarvelRivalsUTOCSignatureBypass.asi"),
            r"C:\Windows\System32\DriverStore\FileRepository\nv_dispi.inf_amd64_1\nvwgf2umx.dll",
            r"C:\Windows\System32\dsound.dll",
            r"C:\Program Files\RivaTuner Statistics Server\RTSSHooks64.dll",
        ])
    }

    #[test]
    fn classifies_modules_by_where_they_loaded_from() {
        let m = game_modules();
        let class = |name: &str| classify(name, &m, ROOT);
        assert_eq!(class("Marvel-Win64-Shipping"), ModuleClass::Game);
        assert_eq!(class("steam_api64"), ModuleClass::Game, "a DLL the game ships");
        assert_eq!(class("D3D12Core"), ModuleClass::Game, "a subfolder of the exe's is not beside it");
        assert_eq!(class("dsound"), ModuleClass::ThirdParty, "the first dsound listed is the proxy beside the exe");
        assert_eq!(class("MarvelRivalsUTOCSignatureBypass"), ModuleClass::ThirdParty);
        assert_eq!(class("nvwgf2umx"), ModuleClass::GpuDriver);
        assert_eq!(class("RTSSHooks64"), ModuleClass::ThirdParty, "an overlay outside the game");
        assert_eq!(class_of_path(r"C:\Windows\System32\dsound.dll", ROOT), ModuleClass::Windows, "Windows' own dsound");
    }

    #[test]
    fn classifies_unlisted_frames_by_name() {
        let class = |name: &str| classify(name, &[], ROOT);
        assert_eq!(class("KERNELBASE"), ModuleClass::Windows);
        assert_eq!(class("ntdll"), ModuleClass::Windows);
        assert_eq!(class("VCRUNTIME140"), ModuleClass::Windows);
        assert_eq!(class("atidxx64"), ModuleClass::GpuDriver);
        assert_eq!(class("amdenc64"), ModuleClass::GpuDriver);
        assert_eq!(class("igd12umd64"), ModuleClass::GpuDriver);
        assert_eq!(class("Marvel-Win64-Shipping"), ModuleClass::Game);
        assert_eq!(class("Unknown"), ModuleClass::Unknown);
        assert_eq!(class("SomeInjector64"), ModuleClass::ThirdParty);
    }

    #[test]
    fn reads_frames_and_the_crashed_thread() {
        let stack = "Marvel-Win64-Shipping 0x00007ff6c4050000 + 10c296b KERNEL32 0x00007fff88f10000 + 17374 ntdll 0x00007fff89350000 + 4cc91";
        let got: Vec<String> = frames(stack).into_iter().map(|(m, off)| format!("{m}+{off}")).collect();
        assert_eq!(got, v(&["Marvel-Win64-Shipping+10c296b", "KERNEL32+17374", "ntdll+4cc91"]));
        let xml = "<Threads><Thread><CallStack>a 0x1 + 2</CallStack><IsCrashed>false</IsCrashed><ThreadName>Game</ThreadName></Thread>\
            <Thread><CallStack>b 0x1 + 3</CallStack><IsCrashed>true</IsCrashed><ThreadName>FAsyncLoadingThread</ThreadName></Thread></Threads>";
        let t = crashed_thread(xml).unwrap();
        assert_eq!(crash_monitor::extract_xml_tag(t, "ThreadName").as_deref(), Some("FAsyncLoadingThread"));
        assert_eq!(crash_monitor::extract_xml_tag(t, "CallStack").as_deref(), Some("b 0x1 + 3"));
    }

    /// cargo test -p repak-x --bin REPAK-X newest_real_crash -- --ignored --nocapture
    /// Prints what the setup report gets from the newest crash on this PC and checks the user name is not in it.
    #[test]
    #[ignore]
    fn newest_real_crash_has_no_user_name() {
        let crash = xtra_newest_crash().expect("a crash folder in %LOCALAPPDATA%\\Marvel\\Saved\\Crashes");
        let json = serde_json::to_string_pretty(&crash).unwrap();
        println!("{json}");
        for user in user_names() {
            assert!(!json.to_lowercase().contains(&user.to_lowercase()), "the user name is in the output");
        }
    }

    #[test]
    fn other_assets_do_not_match() {
        let crash = "/Game/Marvel/Characters/1026/1026001/Meshes/SK_1026_1026001";
        assert!(!holds_asset(&v(&["Marvel/Content/Marvel/Characters/1026/1026001/Meshes/SK_1026_1026001_Lobby.uasset"]), crash), "longer name");
        assert!(!holds_asset(&v(&["Marvel/Content/Marvel/Characters/1026/1026002/Meshes/SK_1026_1026001.uasset"]), crash), "other skin folder");
        assert!(!holds_asset(&[], crash));
        assert!(!holds_asset(&v(&["Marvel/Content/Marvel/A.uasset"]), "  "), "no asset named");
    }
}
