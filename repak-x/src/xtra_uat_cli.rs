//! repakxtra: IoStore extracts through UAssetTool's own command line, built from the same UAssetToolRivals source as the
//! in-process library (build.ps1: uassettool-cli.exe, NativeAOT, no .NET install needed). The library's JSON request
//! extracts packages one at a time; the command line extracts them in parallel. Measured 2026-10-24 on the 374 game
//! materials of a VFX mod with dependencies: 59.5 s through the library, 21.1 s through the command line, all 3,373
//! files byte for byte the same. Everything else stays on the library. When the command line is missing (an old
//! install, a dev build without it) or REPAKXTRA_UAT_CLI=off, the library extracts as before.

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
            let ran = cmd.output();
            if let Some(l) = &list {
                let _ = std::fs::remove_file(l);
            }
            let ran = ran.map_err(|e| format!("[VFX] Could not start {}: {e}", exe.display()))?;
            // its own log, without the key, for a failure's message (never logged whole: it names every package)
            let log = String::from_utf8_lossy(&ran.stderr).replace(crate::install_mod::AES_KEY_HEX, "<key>");
            let wrote: Vec<String> = files(&out_dir)
                .into_iter()
                .filter(|(p, at)| before.get(p).is_none_or(|old| old != at))
                .filter_map(|(p, _)| p.strip_prefix(&out_dir).ok().map(|r| r.to_string_lossy().to_string()))
                .collect();
            if !ran.status.success() {
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

fn uniq() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    N.fetch_add(1, Ordering::Relaxed)
}
