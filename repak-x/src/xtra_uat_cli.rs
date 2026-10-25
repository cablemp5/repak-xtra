//! repakxtra: IoStore extracts through UAssetTool's own command line, built from the same UAssetToolRivals source as the
//! in-process library (build.ps1: uassettool-cli.exe, NativeAOT, no .NET install needed). The library's JSON request
//! extracts packages one at a time; the command line extracts them in parallel. Measured 2026-10-24 on the 374 game
//! materials of a VFX mod with dependencies: 59.5 s through the library, 21.1 s through the command line, all 3,373
//! files byte for byte the same. Everything else stays on the library. When the command line is missing (an old
//! install, a dev build without it) or REPAKXTRA_UAT_CLI=off, the library extracts as before.
//! The command line stays running between extracts (`serve`, see `Server`): opening the game's 23 containers costs
//! about 4 s each time, and a mod's update extracts two to four times. REPAKXTRA_UAT_SERVE=off runs each one-shot.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use crate::vfx_updater::uasset_tool::{VfxUatRequest, VfxUatResponse};

const EXE: &str = "uassettool-cli.exe";
static ONE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// The command line: beside the app, else the workspace's build (dev copy, tests). None when switched off or missing.
fn cli() -> Option<PathBuf> {
    if std::env::var("REPAKXTRA_UAT_CLI").is_ok_and(|v| v.eq_ignore_ascii_case("off")) {
        return None;
    }
    let beside = std::env::current_exe().ok().and_then(|e| e.parent().map(|d| d.join(EXE)));
    let workspace = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("target").join("uassettool-cli").join("UAssetTool.exe");
    [beside, Some(workspace)].into_iter().flatten().find(|p| p.is_file())
}

/// Every file under `dir`, with when it was written.
fn files(dir: &Path) -> Vec<(PathBuf, Option<SystemTime>)> {
    walkdir::WalkDir::new(dir)
        .into_iter()
        .flatten()
        .filter(|e| e.file_type().is_file())
        .map(|e| (e.path().to_path_buf(), e.metadata().ok().and_then(|m| m.modified().ok())))
        .collect()
}

/// An `extract_iostore_legacy` request run through the command line, answered like the library would (`files`: what
/// the call wrote, relative to the output folder). None for any other request, or without the command line.
pub(crate) async fn extract(request: &VfxUatRequest<'_>) -> Option<Result<VfxUatResponse, String>> {
    if request.action != "extract_iostore_legacy" {
        return None;
    }
    let exe = cli()?;
    // one at a time, as the library's calls are: two starting together can trip over the tool's Oodle file
    let _one = ONE.lock().await;
    let (Some(paks), Some(out)) = (request.game_paks.clone(), request.output_path.clone()) else { return None };
    let filters = request.filter_patterns.clone().unwrap_or_default();
    let (mod_path, with_deps) = (request.mod_path.clone(), request.with_deps.unwrap_or(false));
    Some(
        tokio::task::spawn_blocking(move || -> Result<VfxUatResponse, String> {
            let out_dir = PathBuf::from(&out);
            std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
            let before: std::collections::HashMap<PathBuf, Option<SystemTime>> = files(&out_dir).into_iter().collect();
            let mut cmd = std::process::Command::new(&exe);
            cmd.arg("extract_iostore_legacy").arg(&paks).arg(&out_dir).arg("--aes").arg(crate::install_mod::AES_KEY_HEX);
            if with_deps {
                cmd.arg("--with-deps");
            }
            if let Some(m) = &mod_path {
                cmd.arg("--mod").arg(m);
            }
            // a pattern list too long for a command line goes in a file (the tool reads a .txt as one pattern per line)
            let list = (!filters.is_empty()).then(|| std::env::temp_dir().join(format!("repakxtra-uat-filter-{}-{}.txt", std::process::id(), uniq())));
            if let Some(l) = &list {
                std::fs::write(l, filters.join("\n")).map_err(|e| e.to_string())?;
                cmd.arg("--filter").arg(l);
            }
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flashing up
            }
            // the long-lived command line first (the game's containers stay loaded between calls), else a one-shot run
            let args: Vec<String> = cmd.get_args().map(|a| a.to_string_lossy().to_string()).collect();
            let mut one_shot = || cmd.output().map(|o| (o.status.success(), String::from_utf8_lossy(&o.stderr).to_string()));
            let served = serve(&exe, &args);
            let changed = || files(&out_dir).into_iter().filter(|(p, at)| before.get(p).is_none_or(|old| old != at)).map(|(p, _)| p).collect::<Vec<_>>();
            let ran = match served {
                // a running server that lost the game's class names (seen once, cause not found) writes them as
                // __ScriptImport_<hash>__, which a good extract never does: it stops, and this request runs one-shot
                Some((true, _)) if unnamed(&changed()) => {
                    log::warn!("[uat serve] an extract came back without the game's class names: the command line restarts, and this one runs one-shot");
                    reset();
                    one_shot()
                }
                Some(r) => Ok(r),
                None => one_shot(),
            };
            if let Some(l) = &list {
                let _ = std::fs::remove_file(l);
            }
            let (ok, log) = ran.map_err(|e| format!("[VFX] Could not start {}: {e}", exe.display()))?;
            // its own log, without the key, for a failure's message (never logged whole: it names every package)
            let log = log.replace(crate::install_mod::AES_KEY_HEX, "<key>");
            // a load that went wrong (uassettool-patches 0007): said in the app's log, so its cause shows the next time
            for l in log.lines().filter(|l| l.contains("[serve]") || l.contains("[FZenPackageContext]")) {
                log::warn!("[uat serve] {l}");
            }
            let wrote: Vec<String> = files(&out_dir)
                .into_iter()
                .filter(|(p, at)| before.get(p).is_none_or(|old| old != at))
                .filter_map(|(p, _)| p.strip_prefix(&out_dir).ok().map(|r| r.to_string_lossy().to_string()))
                .collect();
            if !ok {
                let tail: String = log.lines().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join(" ");
                return Ok(VfxUatResponse { success: false, message: format!("Failed to extract IoStore (legacy): {tail}"), data: None });
            }
            let packages = wrote.iter().filter(|f| f.ends_with(".uasset")).count();
            Ok(VfxUatResponse {
                success: true,
                message: format!("Extracted {packages} packages from IoStore"),
                data: Some(serde_json::json!({ "extracted_count": packages, "output_dir": out, "files": wrote })),
            })
        })
        .await
        .map_err(|e| e.to_string())
        .and_then(|r| r),
    )
}

/// `uassettool-cli.exe serve`: one request per stdin line, the arguments joined by \x1f (no Windows path holds it),
/// answered by "@@DONE <code>\x1f<log lines>". It keeps the game's containers loaded between requests (a one-shot run
/// spends about 4 s opening them) and exits on its own after 90 s without one, or when the app closes its stdin.
struct Server {
    child: std::process::Child,
    stdin: std::process::ChildStdin,
    out: std::io::BufReader<std::process::ChildStdout>,
}

static SERVER: std::sync::Mutex<Option<Server>> = std::sync::Mutex::new(None);

fn start(exe: &Path) -> std::io::Result<Server> {
    use std::process::Stdio;
    let mut cmd = std::process::Command::new(exe);
    cmd.arg("serve").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn()?;
    let (stdin, out) = (child.stdin.take(), child.stdout.take());
    match (stdin, out) {
        (Some(stdin), Some(out)) => Ok(Server { child, stdin, out: std::io::BufReader::new(out) }),
        _ => {
            let _ = child.kill();
            Err(std::io::Error::other("no pipes"))
        }
    }
}

fn ask(s: &mut Server, line: &str) -> std::io::Result<(bool, String)> {
    use std::io::{BufRead, Write};
    s.stdin.write_all(line.as_bytes())?;
    s.stdin.write_all(b"\n")?;
    s.stdin.flush()?;
    let mut line = Vec::new();
    loop {
        line.clear();
        // bytes, not a String: its log tail is in the console's code page (a user name like Jürgen is not UTF-8)
        if s.out.read_until(b'\n', &mut line)? == 0 {
            return Err(std::io::Error::other("the command line closed"));
        }
        if let Some(answer) = done(&String::from_utf8_lossy(&line)) {
            return Ok(answer);
        }
    }
}

/// A serve reply line, "@@DONE <code>\x1f<log lines>": whether it succeeded, and the log lines. None for any other line.
fn done(line: &str) -> Option<(bool, String)> {
    let rest = line.trim_end().strip_prefix("@@DONE ")?;
    let mut parts = rest.split('\x1f');
    let code = parts.next().unwrap_or("1");
    Some((code == "0", parts.collect::<Vec<_>>().join("\n")))
}

/// The request through the long-lived command line, started when there is none (or it exited after idling), tried
/// on a fresh one once more if it fails. None when it cannot serve (an older command line without `serve`): the
/// caller runs it one-shot as before.
fn serve(exe: &Path, args: &[String]) -> Option<(bool, String)> {
    use std::sync::atomic::{AtomicBool, Ordering};
    static CANNOT: AtomicBool = AtomicBool::new(false);
    if CANNOT.load(Ordering::Relaxed) || std::env::var("REPAKXTRA_UAT_SERVE").is_ok_and(|v| v.eq_ignore_ascii_case("off")) || args.iter().any(|a| a.contains('\x1f') || a.contains('\n')) {
        return None;
    }
    let line = args.join("\x1f");
    let mut slot = SERVER.lock().unwrap_or_else(|e| e.into_inner());
    for _ in 0..2 {
        if slot.as_mut().is_none_or(|s| !matches!(s.child.try_wait(), Ok(None))) {
            *slot = start(exe).ok();
        }
        let s = slot.as_mut()?;
        match ask(s, &line) {
            Ok(r) => return Some(r),
            Err(_) => {
                let _ = s.child.kill();
                let _ = s.child.wait();
                *slot = None;
            }
        }
    }
    // the second try failed too: this command line cannot serve, the rest of this session runs one-shot
    CANNOT.store(true, Ordering::Relaxed);
    None
}

/// Whether any of `written` (an extract's files) names a class as __ScriptImport_<hash>__: the converter could not name the
/// game's classes. A good extract has none (0 of 1,421 files in a deep one, 2026-10-24). Only the .uasset headers hold
/// the import names.
fn unnamed(written: &[PathBuf]) -> bool {
    const MARK: &[u8] = b"__ScriptImport_";
    written
        .iter()
        .filter(|p| p.extension().is_some_and(|x| x.eq_ignore_ascii_case("uasset")))
        .any(|p| std::fs::read(p).is_ok_and(|b| b.windows(MARK.len()).any(|w| w == MARK)))
}

/// Stops the long-lived command line: the next extract starts a fresh one, which loads the game's containers again.
/// shortcut: what leaves a running one unable to name classes is not known (seen once in the dev copy, not reproduced by
/// replaying the layout scan's requests); find it if the "[uat serve]" warning shows in a log.
pub(crate) fn reset() {
    if let Some(mut s) = SERVER.lock().unwrap_or_else(|e| e.into_inner()).take() {
        let _ = s.child.kill();
        let _ = s.child.wait();
    }
}

fn uniq() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    N.fetch_add(1, Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_extract_without_class_names_is_told_apart() {
        let dir = tempfile::tempdir().unwrap();
        let (good, bad, data) = (dir.path().join("MI_A.uasset"), dir.path().join("MI_B.uasset"), dir.path().join("MI_B.uexp"));
        std::fs::write(&good, b"..MaterialInstanceConstant../Script/Engine..").unwrap();
        std::fs::write(&bad, b"..__ScriptImport_7F7253AB5570E48F__..").unwrap();
        std::fs::write(&data, b"..__ScriptImport_..").unwrap();
        assert!(!unnamed(&[good.clone(), data.clone()]), "named classes, and export data is not looked at");
        assert!(unnamed(&[good, bad]));
    }

    #[test]
    fn a_serve_reply_is_its_done_line_and_nothing_else() {
        assert_eq!(done("Loading game containers from: C:/Paks"), None, "its own output before the answer is skipped");
        assert_eq!(done("@@DONE 0\x1f\r\n"), Some((true, String::new())));
        assert_eq!(done("@@DONE 1\x1fa\x1fb\r\n"), Some((false, "a\nb".to_string())));
        // a log line in another code page arrives lossy, and the answer still reads
        let bytes = b"@@DONE 1\x1f[Filter] C:\\Users\\J\xfcrgen\n";
        assert_eq!(done(&String::from_utf8_lossy(bytes)).map(|(ok, _)| ok), Some(false));
    }

    /// The long-lived command line gives the same files as one-shot runs, for a mod, another mod, then the first again
    /// (each request works on its own copy of the game's index: a mod loaded by one never shows in the next).
    ///   UAT_SAME_A=<mod.utoc> UAT_SAME_B=<mod.utoc> [UAT_SAME_PAKS=<Paks>] cargo test -p repak-x --bin REPAK-X serve_matches -- --ignored --nocapture
    #[test]
    #[ignore]
    fn serve_matches_one_shot_extracts() {
        let paks = std::env::var("UAT_SAME_PAKS").unwrap_or_else(|_| r"C:\Program Files (x86)\Steam\steamapps\common\MarvelRivals\MarvelGame\Marvel\Content\Paks".into());
        let mods = [std::env::var("UAT_SAME_A").expect("UAT_SAME_A"), std::env::var("UAT_SAME_B").expect("UAT_SAME_B")];
        let base = std::env::temp_dir().join(format!("xuat-same-{}", std::process::id()));
        let rt = tokio::runtime::Runtime::new().unwrap();
        let digest = |dir: &Path| -> std::collections::BTreeMap<String, Vec<u8>> {
            files(dir).into_iter().map(|(p, _)| (p.strip_prefix(dir).unwrap().to_string_lossy().to_string(), std::fs::read(&p).unwrap())).collect()
        };
        let mut runs = Vec::new();
        for serve in [false, true] {
            // read per request (serve() checks it each time)
            std::env::set_var("REPAKXTRA_UAT_SERVE", if serve { "on" } else { "off" });
            let mut got = Vec::new();
            for (i, m) in [&mods[0], &mods[1], &mods[0]].into_iter().enumerate() {
                let out = base.join(format!("{serve}-{i}"));
                let req = VfxUatRequest { action: "extract_iostore_legacy", game_paks: Some(paks.clone()), mod_path: Some(m.clone()), output_path: Some(out.to_string_lossy().to_string()), with_deps: Some(false), ..Default::default() };
                let r = rt.block_on(extract(&req)).expect("uassettool-cli.exe is not built").unwrap();
                assert!(r.success, "{}", r.message);
                got.push(digest(&out));
            }
            runs.push(got);
        }
        let _ = std::fs::remove_dir_all(&base);
        for i in 0..3 {
            assert!(!runs[0][i].is_empty(), "request {i} wrote nothing");
            assert!(runs[0][i] == runs[1][i], "request {i}: serve wrote other files than a one-shot run");
        }
    }
}
