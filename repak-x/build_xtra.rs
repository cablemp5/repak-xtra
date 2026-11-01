// repakxtra: build steps of this fork, called from build.rs.
use std::path::Path;

/// Stamps for the saved caches, fingerprints of the code that fills them, so a cache starts over when that code changes
/// and not on every new build (an app update then no longer re-reads every mod or the game's asset list):
/// - REPAKXTRA_DETAILS_LOGIC (xtra_details_cache.rs): what works out a mod's details.
/// - REPAKXTRA_ASSETS_LOGIC (xtra_broken.rs, the saved game asset list): what reads and keys the game's packages.
/// Both include the native reader UAssetTool (the Rust wrapper, this repo's patches and the submodule's commit), since
/// a fix there can change the file lists either one saved.
pub fn cache_stamps() {
    let native = native_reader_text();
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

fn whole(file: &str) -> String {
    println!("cargo:rerun-if-changed={file}");
    std::fs::read_to_string(file).unwrap_or_else(|e| panic!("{file}: {e}"))
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

/// The native reader's inputs. The submodule's commit is read from git's own record of it, so a checkout without the
/// submodule (CI's Rust tests) still builds, with "none" in its place.
fn native_reader_text() -> String {
    let mut text = whole("../uasset_toolkit/uasset_app/src/lib.rs");
    let patches = Path::new("../uassettool-patches");
    println!("cargo:rerun-if-changed={}", patches.display());
    let mut names: Vec<_> = std::fs::read_dir(patches).into_iter().flatten().flatten().map(|e| e.path()).collect();
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
