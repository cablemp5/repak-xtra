//! The tool on damaged and crafted files (tests/fixtures/malformed, synthetic cases from the 2026-11-10 audit). Each case
//! runs in a child process (this test binary again), so a crash or a hang fails that one case instead of ending the run.
//! Needs a built UAssetTool.dll (dev.ps1 or build.ps1 makes target\uassettool, UASSETTOOL_DLL picks another):
//!   cargo test -p uasset_app --test malformed_files
//! Not in CI or check.ps1: neither builds the .NET tool.
#![cfg(windows)]

use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const CASE: &str = "REPAKXTRA_MALFORMED_CASE";

fn fixture(name: &str) -> String {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/malformed").join(name).to_string_lossy().into_owned()
}

/// The child side: one call into the tool, its outcome on stdout.
#[test]
fn child() {
    let Ok(case) = std::env::var(CASE) else { return };
    let mut a = case.splitn(3, '|');
    let (mode, file, out) = (a.next().unwrap(), a.next().unwrap(), a.next().unwrap_or(""));
    let r = match mode {
        "listpak" => uasset_toolkit::list_pak_files(file, None).map(|f| f.len()),
        "listutoc" => uasset_toolkit::list_iostore_files(file, None).map(|r| r.files.len()),
        "extractpak" => uasset_toolkit::extract_pak_all(file, out, None),
        _ => unreachable!(),
    };
    match r {
        Ok(n) => println!("RESULT ok {n}"),
        Err(e) => println!("RESULT err {}", e.to_string().replace('\n', " ")),
    }
}

#[repr(C)]
#[derive(Default)]
struct Counters {
    cb: u32,
    page_faults: u32,
    peak_working_set: usize,
    working_set: usize,
    quota: [usize; 4],
    pagefile: usize,
    peak_pagefile: usize,
}

#[link(name = "kernel32")]
extern "system" {
    fn K32GetProcessMemoryInfo(process: *mut std::ffi::c_void, counters: *mut Counters, cb: u32) -> i32;
}

struct Outcome {
    result: String,
    secs: f64,
    peak_mb: f64,
}

/// Runs one case in a child, killed at `limit`.
fn run(mode: &str, file: &str, out: &str, limit: Duration) -> Outcome {
    let start = Instant::now();
    let mut c = Command::new(std::env::current_exe().unwrap())
        .args(["child", "--exact", "--nocapture", "--test-threads=1"])
        .env(CASE, format!("{mode}|{file}|{out}"))
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let status = loop {
        if let Some(s) = c.try_wait().unwrap() {
            break Some(s);
        }
        if start.elapsed() > limit {
            let _ = c.kill();
            let _ = c.wait();
            break None;
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let secs = start.elapsed().as_secs_f64();
    let mut m = Counters { cb: std::mem::size_of::<Counters>() as u32, ..Default::default() };
    unsafe { K32GetProcessMemoryInfo(c.as_raw_handle() as _, &mut m, m.cb) };
    let stdout = std::io::read_to_string(c.stdout.take().unwrap()).unwrap_or_default();
    // libtest prints "test child ... " on the same line
    let line = stdout.lines().find_map(|l| l.split_once("RESULT ").map(|(_, r)| r.to_string()));
    let result = match (status, line) {
        (None, _) => "timed out".into(),
        (Some(_), Some(l)) => l,
        (Some(s), None) => format!("crashed {:#010x}", s.code().unwrap_or(0) as u32),
    };
    Outcome { result, secs, peak_mb: m.peak_pagefile as f64 / 1e6 }
}

/// A V11 pak with one uncompressed 7-byte file (the layout of the audit's fuzz script).
fn one_file_pak(name: &str) -> Vec<u8> {
    let u32b = |n: u32| n.to_le_bytes().to_vec();
    let pstr = |s: &str| [u32b(s.len() as u32 + 1), s.as_bytes().to_vec(), vec![0]].concat();
    let (dir, leaf) = name.rsplit_once('/').map(|(d, l)| (format!("{d}/"), l)).unwrap();
    let data = [vec![0; 8], 7u64.to_le_bytes().to_vec(), 7u64.to_le_bytes().to_vec(), u32b(0), vec![0; 20], vec![0], u32b(0), b"fixture".to_vec()].concat();
    let fdi = [u32b(1), pstr(&dir), u32b(1), pstr(leaf), u32b(0)].concat();
    let encoded = [u32b(0xC000_0000), u32b(0), u32b(7)].concat();
    let index = [pstr("../../../"), u32b(1), vec![0; 8], u32b(0), u32b(1), (data.len() as i64).to_le_bytes().to_vec(),
        (fdi.len() as u64).to_le_bytes().to_vec(), vec![0; 20], u32b(encoded.len() as u32), encoded, u32b(0)].concat();
    let footer = [vec![0; 17], u32b(0x5A6F_12E1), u32b(11), ((data.len() + fdi.len()) as i64).to_le_bytes().to_vec(),
        (index.len() as u64).to_le_bytes().to_vec(), vec![0; 20], vec![0; 160]].concat();
    [data, fdi, index, footer].concat()
}

#[test]
fn malformed_files_fail_safely() {
    if std::env::var(CASE).is_ok() {
        return;
    }
    // the loader looks beside the test exe first
    let exe_dir = std::env::current_exe().unwrap().parent().unwrap().to_path_buf();
    let workspace = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let dll = std::env::var("UASSETTOOL_DLL").map(PathBuf::from).unwrap_or(workspace.join("target/uassettool/UAssetTool.dll"));
    std::fs::copy(&dll, exe_dir.join("UAssetTool.dll")).unwrap_or_else(|e| panic!("{}: {e}", dll.display()));

    let mut failed = Vec::new();
    let mut expect = |what: &str, o: &Outcome, ok: bool| {
        println!("{what:44} {:5.1}s {:7.0} MB  {}", o.secs, o.peak_mb, o.result);
        if !ok {
            failed.push(what.to_string());
        }
    };
    let ten = Duration::from_secs(10);

    let control = run("listpak", &fixture("00-control-pak.pak"), "", ten);
    expect("00 control pak lists 1 file", &control, control.result == "ok 1");
    let utoc = run("listutoc", &fixture("10-control-utoc.utoc"), "", ten);
    expect("10 control utoc reads", &utoc, utoc.result.starts_with("ok"));
    for f in ["01-pak-index-size-2gb.pak", "02-pak-mount-string-2gb.pak"] {
        let o = run("listpak", &fixture(f), "", ten);
        expect(&format!("{f} is an error"), &o, o.result.starts_with("err"));
    }

    // F-101: names sharing one encoded entry, under 100 MB more than the control pak
    for f in ["03-pak-shared-entry-1500-names.pak", "03b-pak-shared-entry-1500-names-30000-blocks.pak"] {
        let o = run("listpak", &fixture(f), "", ten);
        let ok = !o.result.starts_with("crashed") && o.result != "timed out" && o.peak_mb - control.peak_mb < 100.0;
        expect(&format!("{f} stays under 100 MB"), &o, ok);
    }

    // F-100: a damaged .utoc is an error within 2 s (it overflowed the stack or never returned)
    for f in ["11-utoc-method-count-ffffffff", "12-utoc-dir-self-child", "13-utoc-dir-sibling-loop", "14-utoc-file-self-next", "15-utoc-dir-self-child-and-sibling", "16-utoc-shared-long-filename"] {
        let o = run("listutoc", &fixture(&format!("{f}.utoc")), "", Duration::from_secs(5));
        expect(&format!("{f} is an error within 2 s"), &o, o.result.starts_with("err") && o.secs < 2.0 && o.peak_mb - control.peak_mb < 100.0);
    }

    // F-50: a rooted name and a ".." name are refused by the tool itself, and nothing lands outside the output folder
    let d = std::env::temp_dir().join(format!("repakxtra-malformed-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(d.join("out")).unwrap();
    let rooted = d.join("rooted").to_string_lossy().replace('\\', "/");
    let rooted = &rooted[rooted.find('/').unwrap()..]; // the same folder, without its drive
    for (what, name, escaped) in [
        ("a rooted name", format!("{rooted}/ESCAPED.txt"), d.join("rooted").join("ESCAPED.txt")),
        ("a .. name", "Marvel/../../ESCAPED.txt".to_string(), d.join("ESCAPED.txt")),
    ] {
        let pak = d.join("crafted.pak");
        std::fs::write(&pak, one_file_pak(&name)).unwrap();
        let o = run("extractpak", &pak.to_string_lossy(), &d.join("out").to_string_lossy(), ten);
        expect(&format!("extract with {what} is refused"), &o, o.result.starts_with("err") && !escaped.exists());
    }
    let inside = d.join("inside.pak");
    std::fs::write(&inside, one_file_pak("Marvel/Content/A.uasset")).unwrap();
    let o = run("extractpak", &inside.to_string_lossy(), &d.join("out").to_string_lossy(), ten);
    expect("extract of a normal name lands inside", &o, o.result == "ok 1" && d.join("out/Marvel/Content/A.uasset").exists());
    // UE's root directory is "/": a companion's "/chunknames" lands in the output folder, not refused
    std::fs::write(&inside, one_file_pak("/chunknames")).unwrap();
    let o = run("extractpak", &inside.to_string_lossy(), &d.join("out").to_string_lossy(), ten);
    expect("extract of a root-level file lands inside", &o, o.result == "ok 1" && d.join("out/chunknames").exists());
    let _ = std::fs::remove_dir_all(&d);

    assert!(failed.is_empty(), "failed: {failed:?}");
}
