// repakxtra: build steps of this fork, called from build.rs.
use std::path::Path;

/// Stamps for the saved caches, fingerprints of the code that fills them, so a cache starts over when that code changes
/// and not on every new build (an app update then no longer re-reads every mod or the game's asset list):
/// - REPAKXTRA_DETAILS_LOGIC (xtra_details_cache.rs): what works out a mod's details.
/// - REPAKXTRA_ASSETS_LOGIC (xtra_broken.rs, the saved game asset list): what reads and keys the game's packages.
/// - REPAKXTRA_DECODE_LOGIC (xtra_vfx.rs parser_id): what decodes and compares a mod's files for the VFX checks.
/// All include the native reader UAssetTool (the Rust wrapper, this repo's patches and the submodule's commit), since
/// a fix there can change the file lists any one saved.
pub fn cache_stamps() {
    let native = native_reader_text();
    // without the background scans' loops: which mods they visit and in what order changes no decoded file or answer
    // (a change there that changes what a saved record means bumps that store's file name instead)
    let decode = [
        no_tests("src/vfx_updater/uasset_tool.rs"),
        without(&no_tests("src/xtra_niagara.rs"), "pub async fn xtra_vfx_layout_scan("),
        without(&no_tests("src/xtra_layout.rs"), "pub async fn xtra_layout_scan("),
    ];
    println!("cargo:rustc-env=REPAKXTRA_DECODE_LOGIC={:016x}", fnv(&(decode.concat() + &native)));
    let details = [
        part("src/main_tauri.rs", "struct ModDetails {"),
        part("src/main_tauri.rs", "fn compute_mod_details("),
        whole("src/utils.rs"),
        whole("src/xtra_classify.rs"),
        whole("src/xtra_library_files.rs"),
        whole("src/utoc_utils.rs"),
        whole("src/character_data.rs"),
    ];
    let assets = [
        part("src/xtra_broken.rs", "fn is_package("),
        part("src/xtra_broken.rs", "pub(crate) fn match_key("),
        part("src/xtra_broken.rs", "fn read_containers("),
        part("src/xtra_crash.rs", "pub(crate) fn asset_key("),
        whole("src/utoc_utils.rs"),
    ];
    println!("cargo:rustc-env=REPAKXTRA_DETAILS_LOGIC={:016x}", fnv(&(details.concat() + &native)));
    println!("cargo:rustc-env=REPAKXTRA_ASSETS_LOGIC={:016x}", fnv(&(assets.concat() + &native)));
}

/// A file without its lines marked `// stamp:skip`: code that cannot change what a cache holds (a request field only
/// packing uses), so a build that adds such lines (another edition) keeps every stamp and shares the saved caches.
fn whole(file: &str) -> String {
    println!("cargo:rerun-if-changed={file}");
    let text = std::fs::read_to_string(file).unwrap_or_else(|e| panic!("{file}: {e}"));
    text.split_inclusive('\n').filter(|l| !l.contains("// stamp:skip")).collect()
}

/// A file up to its tests module (the last item in each), so a test edit leaves the stamp alone.
fn no_tests(file: &str) -> String {
    let mut text = whole(file);
    if let Some(at) = text.find("#[cfg(test)]\nmod tests").or_else(|| text.find("#[cfg(test)]\r\nmod tests")) {
        text.truncate(at);
    }
    text
}

/// One item of a file: from `start` to the first line that is only a closing brace. The whole file when `start` is not
/// found, so a rename can only make the stamp change more often, never miss a change.
fn part(file: &str, start: &str) -> String {
    let text = whole(file);
    match text.find(start).and_then(|a| text[a..].find("\n}\n").or_else(|| text[a..].find("\n}\r\n")).map(|b| text[a..a + b].to_string())) {
        Some(p) => p,
        None => text,
    }
}

/// `text` without one item: from `start` to the first line that is only a closing brace. The whole text when `start` is
/// not found, so a rename can only make the stamp change more often, never miss a change.
fn without(text: &str, start: &str) -> String {
    match text.find(start).and_then(|a| text[a..].find("\n}\n").or_else(|| text[a..].find("\n}\r\n")).map(|b| (a, a + b))) {
        Some((a, b)) => format!("{}{}", &text[..a], &text[b..]),
        None => text.to_string(),
    }
}

/// The native reader's inputs. The submodule's commit is read from git's own record of it, so a checkout without the
/// submodule (CI's Rust tests) still builds, with "none" in its place. Only the patches that change how files are read:
/// not the folder's notes, nor a `-packaging.patch` (it changes how a mod is written, which no cache holds).
fn native_reader_text() -> String {
    let mut text = whole("../uasset_toolkit/uasset_app/src/lib.rs");
    let patches = Path::new("../uassettool-patches");
    println!("cargo:rerun-if-changed={}", patches.display());
    let mut names: Vec<_> = std::fs::read_dir(patches).into_iter().flatten().flatten().map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "patch") && !p.to_string_lossy().ends_with("-packaging.patch")).collect();
    names.sort();
    for p in names {
        text.push_str(&std::fs::read_to_string(&p).unwrap_or_default());
    }
    let head = Path::new("../.git/modules/UAssetToolRivals/HEAD");
    println!("cargo:rerun-if-changed={}", head.display());
    text.push_str(&std::fs::read_to_string(head).unwrap_or_else(|_| "none".into()));
    text
}

/// FNV-1a, line endings left out so a checkout with CRLF stamps the same as one with LF.
fn fnv(text: &str) -> u64 {
    text.bytes().filter(|b| *b != b'\r').fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ b as u64).wrapping_mul(0x0100_0000_01b3))
}
