// repakxtra: build steps of this fork, called from build.rs.

/// A fingerprint of the code that works out a mod's details (xtra_details_cache.rs stamps its saved cache with it): the
/// cache starts over when that code changes, not on every new build, so an app update no longer re-reads every mod.
/// From main_tauri.rs only ModDetails and compute_mod_details count (the whole file when either cannot be found).
pub fn details_logic_stamp() {
    let files = ["src/utils.rs", "src/xtra_classify.rs", "src/xtra_library_files.rs", "src/utoc_utils.rs", "src/character_data.rs"];
    let mut text = String::new();
    let main = std::fs::read_to_string("src/main_tauri.rs").expect("main_tauri.rs");
    let part = |start: &str, end: &str| main.find(start).and_then(|a| main[a..].find(end).map(|b| &main[a..a + b]));
    match (part("struct ModDetails {", "\n}\n"), part("fn compute_mod_details(", "// --- End cache store ---")) {
        (Some(a), Some(b)) => text.extend([a, b]),
        _ => text.push_str(&main),
    }
    for f in files {
        text.push_str(&std::fs::read_to_string(f).unwrap_or_else(|e| panic!("{f}: {e}")));
        println!("cargo:rerun-if-changed={f}");
    }
    println!("cargo:rerun-if-changed=src/main_tauri.rs");
    // FNV-1a, line endings left out so a checkout with CRLF stamps the same as one with LF
    let hash = text.bytes().filter(|b| *b != b'\r').fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ b as u64).wrapping_mul(0x0100_0000_01b3));
    println!("cargo:rustc-env=REPAKXTRA_DETAILS_LOGIC={hash:016x}");
}
