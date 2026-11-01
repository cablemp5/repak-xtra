//! repakxtra: May crash from what a game update changed, not from dates. A Blueprint mod carries whole copies of game
//! classes. When an update gives the game's copy a function, a variable, a widget or a table row the mod's copy lacks,
//! or saves an object in a layout the mod's copy no longer reads as, the game's other code reaches for what is not
//! there and the game can crash. So the mod's copy and the game's current copy of each Blueprint, Widget, DataTable and
//! StringTable package it replaces are read as JSON through UAssetTool with the game's USMAP and compared (the way
//! Rivals Toolkit's override check compares them). What only the mod's copy has is the mod's own intent and never counts.
//! A mod checked and found clean loses the date-only warning, and one made after an update from old extracted files is
//! caught too (xtra_broken.rs judge). Results are kept per mod file and game update in repakxtra-layout-checked.json.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use crate::AppState;

/// What part of the package a finding is about.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Kind {
    /// An object the game reaches by name: a widget, a component, a subobject
    Export,
    Variable,
    Function,
    /// A function's parameters
    Signature,
    /// The class a Blueprint class derives from
    Parent,
    Row,
    /// A DataTable's row struct
    RowStruct,
    /// A StringTable key
    Key,
    /// An object the package imports. Not a verdict on its own (a mod may drop a reference on purpose)
    Import,
    /// An object the game's current layout reads in the game's copy but not in the mod's: saved for an older layout
    Layout,
}

/// One thing the game's copy has that the mod's lacks (`changed`: or holds differently).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Finding {
    pub kind: Kind,
    pub what: String,
    pub changed: bool,
}

fn found(kind: Kind, what: &str, changed: bool) -> Finding {
    Finding { kind, what: what.to_string(), changed }
}

/// "UAssetAPI.ExportTypes.ClassExport, UAssetAPI" -> "ClassExport"
fn type_of(v: &Value) -> &str {
    v["$type"].as_str().and_then(|t| t.split(',').next()).and_then(|t| t.rsplit('.').next()).unwrap_or("")
}

fn has_flag(p: &Value, flag: &str) -> bool {
    p["PropertyFlags"].as_str().is_some_and(|f| f.split(", ").any(|x| x == flag))
}

fn arr(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}

/// The names `of` each item holds.
fn names<'a>(items: &'a [Value], of: fn(&Value) -> &Value) -> Vec<&'a str> {
    items.iter().filter_map(|i| of(i).as_str()).collect()
}

/// Those of `game` that `ours` lacks, without case.
fn lacking<'a>(game: &[&'a str], ours: &[&str]) -> impl Iterator<Item = &'a str> {
    let ours: HashSet<String> = ours.iter().map(|s| s.to_ascii_lowercase()).collect();
    game.to_vec().into_iter().filter(move |s| !ours.contains(&s.to_ascii_lowercase()))
}

/// A package's JSON (UAssetTool to_json): its exports and imports, addressed the way the package does (1-based exports,
/// negative imports).
struct Pkg<'a> {
    exports: &'a [Value],
    imports: &'a [Value],
}

impl<'a> Pkg<'a> {
    fn new(j: &'a Value) -> Self {
        let list = |k: &str| j[k].as_array().map(Vec::as_slice).unwrap_or(&[]);
        Pkg { exports: list("Exports"), imports: list("Imports") }
    }

    fn at(&self, i: i64) -> Option<&'a Value> {
        match i {
            i if i > 0 => self.exports.get(i as usize - 1),
            i if i < 0 => self.imports.get((-i - 1) as usize),
            _ => None,
        }
    }

    fn name(&self, i: i64) -> &'a str {
        self.at(i).and_then(|v| v["ObjectName"].as_str()).unwrap_or("")
    }

    /// Its names from the package (or the top export) down, lowercase: the same object in both copies has the same path.
    fn path(&self, mut i: i64) -> String {
        let mut parts = Vec::new();
        // a cycle never ends: 64 levels is far deeper than any real package
        while let Some(v) = self.at(i).filter(|_| parts.len() < 64) {
            parts.push(v["ObjectName"].as_str().unwrap_or("").to_ascii_lowercase());
            i = v["OuterIndex"].as_i64().unwrap_or(0);
        }
        parts.reverse();
        parts.join("/")
    }

    /// A property's type with everything it is held to, by full path: "StructProperty /script/coreuobject/vector",
    /// "ClassProperty /script/coreuobject/class /script/engine/actor", "ArrayProperty<ObjectProperty ...>".
    fn prop_type(&self, p: &Value) -> String {
        let mut t = p["SerializedType"].as_str().unwrap_or("").to_string();
        for of in ["Struct", "PropertyClass", "MetaClass", "InterfaceClass", "Enum"].iter().filter_map(|k| p[*k].as_i64().filter(|i| *i != 0)) {
            t = format!("{t} {}", self.path(of));
        }
        let inner: Vec<String> = ["Inner", "ElementProp", "KeyProp", "ValueProp"].iter().filter(|k| p[**k].is_object()).map(|k| self.prop_type(&p[*k])).collect();
        if !inner.is_empty() {
            t = format!("{t}<{}>", inner.join(", "));
        }
        t
    }

    /// A function's parameters as "name: Type", with ref, out or return before those that are.
    fn params(&self, f: &Value) -> String {
        f["LoadedProperties"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|p| has_flag(p, "CPF_Parm"))
            .map(|p| {
                let role = if has_flag(p, "CPF_ReturnParm") {
                    "return "
                } else if has_flag(p, "CPF_ReferenceParm") {
                    "ref "
                } else if has_flag(p, "CPF_OutParm") {
                    "out "
                } else {
                    ""
                };
                format!("{role}{}: {}", p["Name"].as_str().unwrap_or(""), self.prop_type(p))
            })
            .collect::<Vec<_>>()
            .join(", ")
    }

    /// The functions a class export (at `class`) declares, by lowercase name.
    fn functions(&self, class: i64) -> HashMap<String, (i64, &'a Value)> {
        (1..=self.exports.len() as i64)
            .filter_map(|i| Some((i, self.at(i)?)))
            .filter(|(_, e)| type_of(e) == "FunctionExport" && e["OuterIndex"].as_i64() == Some(class))
            .map(|(i, e)| (e["ObjectName"].as_str().unwrap_or("").to_ascii_lowercase(), (i, e)))
            .collect()
    }

    /// A class's variables by lowercase name: (name, type).
    fn variables(&self, class: &Value) -> HashMap<String, (String, String)> {
        arr(&class["LoadedProperties"])
            .iter()
            .map(|v| {
                let n = v["Name"].as_str().unwrap_or("");
                (n.to_ascii_lowercase(), (n.to_string(), self.prop_type(v)))
            })
            .collect()
    }

    /// A DataTable's row struct, by full path.
    fn row_struct(&self, table: &Value) -> Option<String> {
        arr(&table["Data"]).iter().find(|d| d["Name"] == "RowStruct").and_then(|d| d["Value"].as_i64()).map(|i| self.path(i))
    }

    /// A struct or class: what holds the objects the game reaches through it.
    fn is_struct(e: &Value) -> bool {
        matches!(type_of(e), "ClassExport" | "StructExport" | "UserDefinedStructExport")
    }
}

/// What `game` (the game's current copy of a package) has that `ours` (the mod's copy) lacks or declares differently.
/// Exports pair up by path, members by name, rows and keys by name, all without case as the engine's names compare.
pub(crate) fn compare<'a>(game: &'a Value, ours: &'a Value) -> Vec<Finding> {
    let (g, o) = (Pkg::new(game), Pkg::new(ours));
    let our_exports: HashMap<String, i64> = (1..=o.exports.len() as i64).map(|i| (o.path(i), i)).collect();
    let mut out = Vec::new();
    // game exports a member finding already names, so a missing function is not an export finding as well
    let mut named = HashSet::new();
    let mut missing = BTreeSet::new();
    for (gi, e) in (1..).zip(g.exports) {
        let Some(&oi) = our_exports.get(&g.path(gi)) else {
            missing.insert(gi);
            continue;
        };
        let oe = &o.exports[oi as usize - 1];
        let name = e["ObjectName"].as_str().unwrap_or("");
        // the same class in both, so the same schema: only its saved layout can fail. A mod's own subclass in its place,
        // or a parse failure of another kind, says nothing
        let class = |p: &Pkg, x: &Value| p.path(x["ClassIndex"].as_i64().unwrap_or(0));
        if type_of(e) != "RawExport" && type_of(oe) == "RawExport" {
            if class(&g, e) == class(&o, oe) {
                out.push(found(Kind::Layout, name, true));
            }
            continue;
        }
        if type_of(e) != type_of(oe) {
            continue;
        }
        match type_of(e) {
            "ClassExport" => {
                let (was, now) = (g.path(e["SuperStruct"].as_i64().unwrap_or(0)), o.path(oe["SuperStruct"].as_i64().unwrap_or(0)));
                if was != now {
                    out.push(found(Kind::Parent, name, true));
                }
                let theirs = o.variables(oe);
                let mut mine: Vec<_> = g.variables(e).into_values().collect();
                mine.sort();
                for (n, t) in mine {
                    match theirs.get(&n.to_ascii_lowercase()) {
                        None => out.push(found(Kind::Variable, &n, false)),
                        Some((_, ot)) if !ot.eq_ignore_ascii_case(&t) => out.push(found(Kind::Variable, &n, true)),
                        _ => {}
                    }
                }
                let theirs = o.functions(oi);
                let mut mine: Vec<_> = g.functions(gi).into_values().collect();
                mine.sort_by_key(|(i, _)| *i);
                for (fi, f) in mine {
                    let n = f["ObjectName"].as_str().unwrap_or("");
                    match theirs.get(&n.to_ascii_lowercase()) {
                        None => {
                            named.insert(fi);
                            out.push(found(Kind::Function, n, false));
                        }
                        Some((_, of)) if !g.params(f).eq_ignore_ascii_case(&o.params(of)) => out.push(found(Kind::Signature, n, true)),
                        _ => {}
                    }
                }
            }
            "DataTableExport" => {
                if let (Some(was), Some(now)) = (g.row_struct(e), o.row_struct(oe)) {
                    if was != now {
                        out.push(found(Kind::RowStruct, "row struct", true));
                    }
                }
                // Columns are not compared: a row leaves out the values at their default, so no row lists them all. A
                // changed row struct leaves the mod's table unreadable (Layout) instead
                let (grows, orows) = (arr(&e["Table"]["Data"]), arr(&oe["Table"]["Data"]));
                out.extend(lacking(&names(grows, |r| &r["Name"]), &names(orows, |r| &r["Name"])).map(|r| found(Kind::Row, r, false)));
            }
            "StringTableExport" => {
                let keys = |x: &'a Value| names(arr(&x["Table"]["Value"]), |kv| &kv[0]);
                out.extend(lacking(&keys(e), &keys(oe)).map(|k| found(Kind::Key, k, false)));
            }
            _ => {}
        }
    }
    // Only what the game reaches by name: an object at the top, in a class, struct or default object, or a widget (a
    // widget tree holds it whatever panel it sits in). A panel's slots and an animation's tracks are reached through what
    // holds them, and an editor's save names them afresh. A missing object's own objects go unsaid.
    let addressed = |e: &Value| match e["OuterIndex"].as_i64().unwrap_or(0) {
        0 => true,
        outer => g.at(outer).filter(|_| outer > 0).is_some_and(|h| {
            Pkg::is_struct(h) || h["ObjectName"].as_str().is_some_and(|n| n.starts_with("Default__")) || g.name(h["ClassIndex"].as_i64().unwrap_or(0)) == "WidgetTree"
        }),
    };
    for &gi in &missing {
        let e = &g.exports[gi as usize - 1];
        let outer = e["OuterIndex"].as_i64().unwrap_or(0);
        if named.contains(&gi) || missing.contains(&outer) || !addressed(e) {
            continue;
        }
        out.push(found(Kind::Export, e["ObjectName"].as_str().unwrap_or(""), false));
    }
    // A package says little, and an import under a missing object is that object again
    let our_imports: HashSet<String> = (1..=o.imports.len() as i64).map(|i| o.path(-i)).collect();
    let gone: HashMap<i64, i64> = (1..=g.imports.len() as i64)
        .filter(|i| !our_imports.contains(&g.path(-i)))
        .map(|i| (-i, g.imports[i as usize - 1]["OuterIndex"].as_i64().unwrap_or(0)))
        .collect();
    let mut imports: Vec<_> = gone
        .iter()
        .filter(|(_, outer)| **outer != 0 && !gone.get(*outer).is_some_and(|o| *o != 0))
        .map(|(i, _)| (*i, g.path(*i)))
        .collect();
    imports.sort_by(|a, b| a.1.cmp(&b.1));
    out.extend(imports.into_iter().map(|(i, _)| found(Kind::Import, g.name(i), false)));
    out
}

fn noun(kind: Kind) -> &'static str {
    match kind {
        Kind::Export => "object",
        Kind::Variable => "variable",
        Kind::Function => "function",
        Kind::Signature => "function signature",
        Kind::Parent => "parent class",
        Kind::Row => "row",
        Kind::RowStruct => "row struct",
        Kind::Key => "text key",
        Kind::Import => "import",
        Kind::Layout => "object",
    }
}

/// "a", "a and b", "a, b, and c"
fn list(items: &[String]) -> String {
    match items {
        [] => String::new(),
        [a] => a.clone(),
        [a, b] => format!("{a} and {b}"),
        [rest @ .., last] => format!("{}, and {last}", rest.join(", ")),
    }
}

fn counted(n: usize, kind: Kind) -> String {
    format!("{n} {}{}", noun(kind), if n == 1 { "" } else { "s" })
}

/// Up to three names, then how many more.
fn some(names: &[&str]) -> String {
    let shown = names.iter().take(3).copied().collect::<Vec<_>>().join(", ");
    match names.len() {
        n if n > 3 => format!("{shown}, and {} more", n - 3),
        _ => shown,
    }
}

/// The May crash reason for a mod's findings (per package: its name, what the game's copy has that the mod's lacks),
/// told from the package with the most. None when nothing was found. `before_update`: the mod's file is older than the
/// game's last update (else it was made after it, from older game files).
pub(crate) fn reason(found: &[(String, Vec<Finding>)], before_update: bool) -> Option<String> {
    let (package, findings) = found.iter().filter(|(_, f)| !f.is_empty()).max_by_key(|(_, f)| f.len())?;
    let (layout, members): (Vec<&Finding>, Vec<&Finding>) = findings.iter().partition(|f| f.kind == Kind::Layout);
    let mut kinds: Vec<Kind> = members.iter().map(|f| f.kind).collect();
    kinds.sort();
    kinds.dedup();
    let mut text = String::new();
    if !members.is_empty() {
        let counts: Vec<String> = kinds.iter().map(|k| counted(members.iter().filter(|f| f.kind == *k).count(), *k)).collect();
        let how = if members.iter().any(|f| f.changed) { "lacks or holds differently" } else { "lacks" };
        let names: Vec<&str> = members.iter().map(|f| f.what.as_str()).collect();
        text = format!("The game's {package} has {} this copy {how} ({}).", list(&counts), some(&names));
    }
    if !layout.is_empty() {
        let names: Vec<&str> = layout.iter().map(|f| f.what.as_str()).collect();
        let n = layout.len();
        let what = if n == 1 { "1 object".to_string() } else { format!("{n} objects") };
        let are = if n == 1 { "is" } else { "are" };
        let s = if members.is_empty() {
            format!("{what} in its {package} {are} saved in an older layout than the game reads ({}).", some(&names))
        } else {
            format!(" {what} in it {are} saved in an older layout than the game reads ({}).", some(&names))
        };
        text.push_str(&s);
    }
    let more = found.iter().filter(|(_, f)| !f.is_empty()).count() - 1;
    if more > 0 {
        text.push_str(&format!(" {more} more of its files {} from the game's too.", if more == 1 { "differs" } else { "differ" }));
    }
    text.push_str(if before_update { " It was built before a game update" } else { " It was made from older game files" });
    text.push_str(", and the game can crash on it. Turn it off if the game crashes, and look for an updated version.");
    Some(text)
}

/// A Blueprint, Widget, DataTable or StringTable package, by its path in the mod (the JSON says for sure, this picks
/// what to read).
fn is_layout_package(file: &str) -> bool {
    let f = file.replace('\\', "/").to_ascii_lowercase();
    let Some(stem) = f.rsplit('/').next().and_then(|n| n.strip_suffix(".uasset")) else { return false };
    // textures, materials, meshes and effects sit in Blueprints folders too (Environment/Common/Blueprints/.../T_Noise)
    if ["t_", "mi_", "m_", "mf_", "sk_", "sm_", "ns_", "ne_", "img_"].iter().any(|p| stem.starts_with(p)) {
        return false;
    }
    ["bp_", "wbp_", "abp_"].iter().any(|p| stem.starts_with(p)) || stem.ends_with("bp") || ["/blueprints/", "/datatable/", "/stringtable/"].iter().any(|d| f.contains(d))
}

/// Whether a package's JSON holds a class, function or table: what the game's other code reaches into.
fn holds_class(j: &Value) -> bool {
    arr(&j["Exports"]).iter().any(|e| matches!(type_of(e), "ClassExport" | "FunctionExport" | "DataTableExport" | "StringTableExport"))
}

/// Packages read per mod: a few seconds each pair, in the background scan. A mod with more is flagged on what these
/// show, never cleared on them (was 40, which left the rest of a large Blueprint mod unread).
const MAX_PACKAGES: usize = 400;

/// What one check found: the May crash reason (None: its copies match), and whether it read all of the mod's packages.
pub(crate) struct Outcome {
    pub reason: Option<String>,
    pub complete: bool,
}

/// The mod at `utoc` (its `files`) against the game in `paks`: the May crash reason when the game's copies of its classes
/// and tables have what the mod's lack, None when they match (or it replaces none of the game's: its own classes are its
/// business). Not complete when some could not be read (or sit in a hybrid mod's .pak) and nothing was found, so the date
/// rule stays until the mod, the game or the USMAP changes. An error when the check itself failed, tried again next scan.
/// The game's copies are kept under `vanilla` for the next mod.
pub(crate) async fn check_mod(paks: &Path, usmap: &str, utoc: &Path, files: &[String], work: &Path, vanilla: &Path) -> Result<Outcome, String> {
    let have = crate::xtra_broken::rewritten_since(paks, files, 0).ok_or("the game's file list could not be read")?;
    let all: BTreeSet<String> = have.iter().filter(|f| is_layout_package(f)).map(|f| crate::xtra_niagara::package_rel(f)).collect();
    if all.is_empty() {
        return Ok(Outcome { reason: None, complete: true });
    }
    // with no container to read, the extract hands back the game's own copies, which always match
    if !utoc.is_file() {
        return Err(format!("{} is not there", utoc.display()));
    }
    let complete = all.len() <= MAX_PACKAGES;
    let rels: Vec<String> = all.into_iter().take(MAX_PACKAGES).collect();
    if rels.is_empty() {
        return Ok(Outcome { reason: None, complete });
    }
    let progress = &crate::vfx_updater::progress::NoOpProgressSink;
    let game_paks = paks.to_string_lossy().to_string();
    let x = work.join("mod_extract");
    let _ = std::fs::remove_dir_all(&x);
    let req = crate::vfx_updater::uasset_tool::VfxUatRequest {
        action: "extract_iostore_legacy",
        game_paks: Some(game_paks.clone()),
        mod_path: Some(utoc.to_string_lossy().to_string()),
        output_path: Some(x.to_string_lossy().to_string()),
        filter_patterns: Some(rels.iter().map(|r| crate::xtra_niagara::tail_filter(r)).collect()),
        with_deps: Some(false),
        ..Default::default()
    };
    let r = crate::vfx_updater::uasset_tool::run_vfx_uat_request(&PathBuf::new(), &req).await?;
    if !r.success {
        return Err(format!("the mod's copies could not be read: {}", r.message));
    }
    // a hybrid mod's .pak half too: the .utoc extract hands back the game's own copies for those, which always match
    let half_read = crate::xtra_vfx::pak_half(utoc, &x).is_ok();
    // each one where the extract wrote it: plugin content lands under Marvel/Plugins/<name>/Content, whatever the mod's
    // list calls it
    let written: HashMap<String, String> = walkdir::WalkDir::new(&x)
        .into_iter()
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|e| e == "uasset"))
        .filter_map(|e| {
            let rel = e.path().strip_prefix(&x).ok()?.with_extension("").to_string_lossy().replace('\\', "/");
            Some((crate::xtra_broken::match_key(&format!("{rel}.uasset")), rel))
        })
        .collect();
    let present: Vec<String> = rels.iter().filter_map(|r| written.get(&crate::xtra_broken::match_key(&format!("{r}.uasset"))).cloned()).collect();
    let mut unreadable = rels.len() - present.len();
    let (only, json) = (work.join("mod_only"), work.join("mod_json"));
    crate::xtra_niagara::stage(&x, &only, &present, true)?;
    crate::xtra_niagara::to_json(usmap, &only, &json, progress).await?;
    let (_, gj) = crate::xtra_niagara::game_copies(&game_paks, usmap, &present, work, vanilla, progress).await?;
    let mut found = Vec::new();
    for r in &present {
        let (Ok(g), Ok(m)) = (crate::xtra_niagara::read_json(&gj.join(format!("{r}.json"))), crate::xtra_niagara::read_json(&json.join(format!("{r}.json")))) else {
            unreadable += 1;
            continue;
        };
        match (holds_class(&g), holds_class(&m)) {
            (true, _) => found.push((r.rsplit('/').next().unwrap_or(r).to_string(), compare(&g, &m).into_iter().filter(|f| f.kind != Kind::Import).collect())),
            // the mod's copy has a class the game's does not show: the game's could not be read, not a match
            (false, true) => unreadable += 1,
            (false, false) => {}
        }
    }
    let game_updated = crate::xtra_broken::game_containers(paks).iter().map(|c| c.2).max().unwrap_or(0);
    let before_update = crate::xtra_broken::file_stamp(utoc).is_some_and(|(_, modified)| modified < game_updated);
    let reason = reason(&found, before_update);
    // unreadable and nothing found: kept as not complete, so the date rule stays and it is not read again for nothing
    Ok(Outcome { complete: complete && half_read && (reason.is_some() || unreadable == 0), reason })
}

// ---- kept per mod file, game update and USMAP, like xtra_broken's Checked store ----

/// A mod the check looked at: its .utoc's size and time then, the game's last update and the USMAP then (another USMAP
/// reads the classes differently), the reason when the game's copies have what the mod's lack, and whether it read only
/// some of them (`partial`: clean so far, which clears nothing).
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub(crate) struct Done {
    size: u64,
    modified: u64,
    game: u64,
    #[serde(default)]
    usmap: String,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    partial: bool,
}

fn store() -> PathBuf {
    dirs::config_dir().unwrap_or_else(|| PathBuf::from(".")).join("Repak-X").join("repakxtra-layout-checked.json")
}

fn load(store: &Path) -> HashMap<String, Done> {
    std::fs::read_to_string(store).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

/// Every mod the check has looked at (xtra_broken reads it once per check).
pub(crate) fn load_done() -> HashMap<String, Done> {
    load(&store())
}

/// The saved USMAP as the check keys it (as the game's cached copies are, xtra_vfx::usmap_hash). Empty without one.
pub(crate) fn usmap_id() -> String {
    crate::vfx_updater::commands::saved_usmap_path().map(|u| crate::xtra_vfx::usmap_hash(&u)).unwrap_or_default()
}

fn current<'a>(all: &'a HashMap<String, Done>, utoc: &Path, game_updated: u64, usmap: &str) -> Option<&'a Done> {
    all.get(&crate::xtra_broken::checked_key(utoc))
        .filter(|d| crate::xtra_broken::file_stamp(utoc) == Some((d.size, d.modified)) && game_updated <= d.game && d.usmap == usmap)
}

/// What the check found about the mod at `utoc` as the file it is now, in this game, under this USMAP (`usmap_id`):
/// Some(None) its copies match the game's (or it replaces none of the game's classes), Some(Some(reason)) they lack what
/// the game's have, None not checked (or only partly, with nothing found).
pub(crate) fn found_now(all: &HashMap<String, Done>, utoc: &Path, game_updated: u64, usmap: &str) -> Option<Option<String>> {
    current(all, utoc, game_updated, usmap).filter(|d| d.reason.is_some() || !d.partial).map(|d| d.reason.clone())
}

fn remember(store: &Path, all: &mut HashMap<String, Done>, utoc: &Path, done: Done) {
    all.insert(crate::xtra_broken::checked_key(utoc), done);
    let tmp = store.with_extension("json.tmp");
    // each mod: a closed app keeps its progress
    if std::fs::write(&tmp, serde_json::to_string(&*all).unwrap_or_default()).is_ok() {
        let _ = std::fs::rename(&tmp, store);
    }
}

static SCAN: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Checks the Blueprint mods among `mod_paths` not checked yet as this file in this game, and returns how many it
/// checked (their verdicts may have changed). Only with the saved USMAP for this game build (another reads the game's
/// classes wrong). Stops while a VFX update runs (the next scan goes on from there), skipped while another scan runs.
#[tauri::command]
pub async fn xtra_layout_scan(mod_paths: Vec<String>, state: State<'_, Arc<Mutex<AppState>>>) -> Result<usize, String> {
    let Ok(_one) = SCAN.try_lock() else { return Ok(0) };
    let state = state.inner().clone();
    let mods_dir = state.lock().unwrap().game_path.clone();
    let Some(paks) = mods_dir.ancestors().find(|p| p.file_name().is_some_and(|n| n.eq_ignore_ascii_case("Paks"))).map(Path::to_path_buf) else { return Ok(0) };
    if !crate::xtra_niagara::saved_usmap_matches(&paks) {
        return Ok(0);
    }
    let Some(usmap) = crate::vfx_updater::commands::saved_usmap_path() else { return Ok(0) };
    let usmap_id = crate::xtra_vfx::usmap_hash(&usmap);
    let game = crate::xtra_broken::game_updated(&mods_dir);
    let vanilla = crate::xtra_vfx::vanilla_dir(&paks.to_string_lossy(), &usmap);
    let work = std::env::temp_dir().join("repak-x").join("xclass").join(std::process::id().to_string());
    let store = store();
    let mut all = load(&store);
    let mut checked = 0;
    for p in mod_paths {
        if !crate::xtra_vfx::background_may_run() {
            break; // an update uses the same tool: the rest waits for the next scan
        }
        let path = PathBuf::from(&p);
        if crate::xtra_builtins::in_folder(&path) {
            continue; // built-ins: xtra_builtins judges them by the game build they were made for, never these checks
        }
        let utoc = path.with_extension("utoc");
        // the file as it is before it is read: a mod replaced meanwhile is not given this one's result
        let Some((size, modified)) = crate::xtra_broken::file_stamp(&utoc) else { continue };
        if current(&all, &utoc, game, &usmap_id).is_some() {
            continue;
        }
        let st = state.clone();
        let Some(details) = tauri::async_runtime::spawn_blocking(move || crate::compute_mod_details(&path, &st).ok()).await.ok().flatten() else { continue };
        // not kept: a file list that failed to read looks like no Blueprint, and would stay cleared once it reads
        if !details.has_blueprint {
            continue;
        }
        let t = std::time::Instant::now();
        // seconds of file reads and JSON work between the tool runs: off the async workers
        let (pk, us, ut, wk, va) = (paks.clone(), usmap.clone(), utoc.clone(), work.clone(), vanilla.clone());
        let outcome = tauri::async_runtime::spawn_blocking(move || tauri::async_runtime::block_on(check_mod(&pk, &us, &ut, &details.files, &wk, &va)))
            .await
            .unwrap_or_else(|e| Err(e.to_string()));
        match outcome {
            Ok(o) => {
                let said = if o.reason.is_some() { "older than the game" } else if o.complete { "matches" } else { "partly read or unreadable, date rule stays" };
                log::info!("[layout] {p}: {:.1}s, {said}", t.elapsed().as_secs_f64());
                if crate::xtra_broken::file_stamp(&utoc) == Some((size, modified)) {
                    checked += 1;
                    remember(&store, &mut all, &utoc, Done { size, modified, game, usmap: usmap_id.clone(), partial: !o.complete, reason: o.reason });
                }
            }
            Err(e) => log::warn!("[layout] {p}: {e}"), // tried again by the next scan
        }
    }
    let _ = std::fs::remove_dir_all(&work);
    Ok(checked)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const CLASS: &str = "UAssetAPI.ExportTypes.ClassExport, UAssetAPI";
    const FUNC: &str = "UAssetAPI.ExportTypes.FunctionExport, UAssetAPI";
    const NORMAL: &str = "UAssetAPI.ExportTypes.NormalExport, UAssetAPI";
    const RAW: &str = "UAssetAPI.ExportTypes.RawExport, UAssetAPI";

    fn prop(name: &str, ty: &str, flags: &str) -> Value {
        json!({ "Name": name, "SerializedType": ty, "PropertyFlags": flags })
    }
    fn export(ty: &str, name: &str, outer: i64, class: i64) -> Value {
        json!({ "$type": ty, "ObjectName": name, "OuterIndex": outer, "ClassIndex": class })
    }
    /// A widget class WBP_X_C deriving from UserWidget, with `vars`, `funcs` (name, parameters) and widgets in its tree.
    fn widget(vars: &[(&str, &str)], funcs: &[(&str, Vec<Value>)], widgets: &[&str], raw_cdo: bool) -> Value {
        let imports = json!([
            { "ObjectName": "/Script/UMG", "OuterIndex": 0, "ClassName": "Package" },
            { "ObjectName": "UserWidget", "OuterIndex": -1, "ClassName": "Class" },
            { "ObjectName": "WidgetTree", "OuterIndex": -1, "ClassName": "Class" },
            { "ObjectName": "Image", "OuterIndex": -1, "ClassName": "Class" },
        ]);
        let mut class = export(CLASS, "WBP_X_C", 0, 0);
        class["SuperStruct"] = json!(-2);
        class["LoadedProperties"] = Value::Array(vars.iter().map(|(n, t)| prop(n, t, "CPF_BlueprintVisible")).collect());
        let mut exports = vec![class, export(if raw_cdo { RAW } else { NORMAL }, "Default__WBP_X_C", 0, 1), export(NORMAL, "WidgetTree", 1, -3)];
        for (n, params) in funcs {
            let mut f = export(FUNC, n, 1, 0);
            f["LoadedProperties"] = Value::Array(params.clone());
            exports.push(f);
        }
        for w in widgets {
            exports.push(export(NORMAL, w, 3, -4));
            exports.push(export(NORMAL, &format!("{w}_Slot"), exports.len() as i64, 0)); // a slot under the widget
        }
        json!({ "Exports": exports, "Imports": imports })
    }
    fn kinds(f: &[Finding]) -> Vec<(Kind, &str, bool)> {
        f.iter().map(|f| (f.kind, f.what.as_str(), f.changed)).collect()
    }

    #[test]
    fn the_same_copy_finds_nothing_and_what_only_the_mod_has_is_its_own() {
        let game = widget(&[("Img_Bg", "ObjectProperty")], &[("OnShow", vec![])], &["Img_Bg"], false);
        assert!(compare(&game, &game).is_empty());
        let more = widget(&[("Img_Bg", "ObjectProperty"), ("Mine", "BoolProperty")], &[("OnShow", vec![]), ("MyEvent", vec![])], &["Img_Bg", "Img_Mine"], false);
        assert!(compare(&game, &more).is_empty(), "{:?}", compare(&game, &more));
    }

    #[test]
    fn what_the_game_added_is_found_once_each() {
        let int = |n: &str| prop(n, "IntProperty", "CPF_Parm");
        let game = widget(&[("Img_Bg", "ObjectProperty"), ("Count", "IntProperty")], &[("OnShow", vec![int("Times")]), ("OnHide", vec![])], &["Img_Bg", "Img_New"], false);
        let old = widget(&[("Img_Bg", "ObjectProperty"), ("Count", "FloatProperty")], &[("OnShow", vec![])], &["Img_Bg"], false);
        let mut f = compare(&game, &old);
        f.sort_by(|a, b| a.kind.cmp(&b.kind).then(a.what.cmp(&b.what)));
        assert_eq!(
            kinds(&f),
            vec![
                (Kind::Export, "Img_New", false),
                (Kind::Variable, "Count", true),
                (Kind::Function, "OnHide", false),
                (Kind::Signature, "OnShow", true),
            ],
            "the new widget's slot goes unsaid, the missing function is not an export finding too"
        );
    }

    #[test]
    fn a_slot_by_another_name_is_not_a_finding() {
        let game = widget(&[], &[], &["Img_Bg"], false);
        let mut ours = game.clone();
        ours["Exports"][4]["ObjectName"] = json!("Img_Bg_Slot_99");
        assert!(compare(&game, &ours).is_empty());
    }

    #[test]
    fn an_object_the_game_reads_but_not_in_the_mods_copy_is_an_older_layout() {
        let game = widget(&[], &[], &[], false);
        assert_eq!(kinds(&compare(&game, &widget(&[], &[], &[], true))), vec![(Kind::Layout, "Default__WBP_X_C", true)]);
        assert!(compare(&widget(&[], &[], &[], true), &game).is_empty(), "raw in the game's own copy says nothing");
        let mut own = widget(&[], &[], &[], true);
        own["Exports"][1]["ClassIndex"] = json!(-4);
        assert!(compare(&game, &own).is_empty(), "the mod's own class in its place: unreadable for another reason, not older");
    }

    #[test]
    fn a_type_held_to_another_class_is_found() {
        let class_prop = |meta: i64| json!({ "Name": "Spawn", "SerializedType": "ClassProperty", "PropertyFlags": "", "PropertyClass": -2, "MetaClass": meta });
        let with = |meta| {
            let mut w = widget(&[], &[], &[], false);
            w["Exports"][0]["LoadedProperties"] = json!([class_prop(meta)]);
            w
        };
        assert_eq!(kinds(&compare(&with(-3), &with(-4))), vec![(Kind::Variable, "Spawn", true)], "the same PropertyClass, another MetaClass");
    }

    #[test]
    fn another_parent_class_is_found() {
        let game = widget(&[], &[], &[], false);
        let mut ours = game.clone();
        ours["Exports"][0]["SuperStruct"] = json!(-4);
        assert_eq!(kinds(&compare(&game, &ours)), vec![(Kind::Parent, "WBP_X_C", true)]);
    }

    #[test]
    fn table_rows_row_structs_and_text_keys_the_mod_lacks() {
        let table = |rows: &[&str], cols: &[&str], strukt: &str| {
            let rows: Vec<Value> = rows.iter().map(|r| json!({ "Name": r, "Value": cols.iter().map(|c| json!({ "Name": c })).collect::<Vec<_>>() })).collect();
            json!({
                "Exports": [{ "$type": "UAssetAPI.ExportTypes.DataTableExport, UAssetAPI", "ObjectName": "SkinTable", "OuterIndex": 0,
                    "Data": [{ "Name": "RowStruct", "Value": -1 }], "Table": { "Data": rows } }],
                "Imports": [{ "ObjectName": strukt, "OuterIndex": 0 }],
            })
        };
        let game = table(&["1011", "1026"], &["HeroName", "SkinSpecs"], "MarvelHeroSkinTable");
        assert_eq!(
            kinds(&compare(&game, &table(&["1011"], &["HeroName"], "MarvelHeroSkinTable"))),
            vec![(Kind::Row, "1026", false)],
            "a row without SkinSpecs left it at its default: not a missing column"
        );
        assert_eq!(kinds(&compare(&game, &table(&["1011", "1026"], &["HeroName", "SkinSpecs"], "OldStruct"))), vec![(Kind::RowStruct, "row struct", true)]);
        let st = |keys: &[&str]| json!({ "Exports": [{ "$type": "UAssetAPI.ExportTypes.StringTableExport, UAssetAPI", "ObjectName": "ST", "OuterIndex": 0,
            "Table": { "Value": keys.iter().map(|k| json!([k, "text"])).collect::<Vec<_>>() } }], "Imports": [] });
        assert_eq!(kinds(&compare(&st(&["A_Name", "B_Name"]), &st(&["a_name"]))), vec![(Kind::Key, "B_Name", false)], "keys compare without case");
    }

    #[test]
    fn imports_name_the_object_not_its_package() {
        let mut game = widget(&[], &[], &[], false);
        let ours = game.clone();
        let imports = game["Imports"].as_array_mut().unwrap();
        imports.push(json!({ "ObjectName": "/Game/UI/WBP_Banner", "OuterIndex": 0 }));
        imports.push(json!({ "ObjectName": "WBP_Banner_C", "OuterIndex": -5 }));
        imports.push(json!({ "ObjectName": "ShowBanner", "OuterIndex": -6 }));
        assert_eq!(kinds(&compare(&game, &ours)), vec![(Kind::Import, "WBP_Banner_C", false)]);
    }

    #[test]
    fn the_reason_names_a_few() {
        let f = |kind, what: &str| Finding { kind, what: what.into(), changed: false };
        let funcs = vec![f(Kind::Function, "OnA"), f(Kind::Function, "OnB"), f(Kind::Function, "OnC")];
        let r = reason(&[("WBP_X".into(), funcs.clone())], true).unwrap();
        assert!(r.starts_with("The game's WBP_X has 3 functions this copy lacks (OnA, OnB, OnC)."), "{r}");
        assert!(!r.contains(';') && !r.contains('\u{2014}'), "no semicolons or em dashes in UI text");
        assert!(r.contains("It was built before a game update, and the game can crash"), "{r}");
        let after = reason(&[("WBP_X".into(), funcs.clone())], false).unwrap();
        assert!(after.contains("It was made from older game files, and the game can crash") && !after.contains("before a game update"), "{after}");
        let mixed = vec![f(Kind::Variable, "V"), f(Kind::Function, "F"), Finding { kind: Kind::Layout, what: "Default__X".into(), changed: true }];
        let r = reason(&[("BP_Small".into(), vec![f(Kind::Row, "1")]), ("BP_X".into(), mixed)], true).unwrap();
        assert!(r.starts_with("The game's BP_X has 1 variable and 1 function this copy lacks (V, F). 1 object in it is saved in an older layout"), "{r}");
        assert!(r.contains("1 more of its files differs from"), "{r}");
        let layout: Vec<Finding> = (0..5).map(|i| Finding { kind: Kind::Layout, what: format!("O{i}"), changed: true }).collect();
        let r = reason(&[("1026001_ChildBP".into(), layout)], true).unwrap();
        assert!(r.starts_with("5 objects in its 1026001_ChildBP are saved in an older layout than the game reads (O0, O1, O2, and 2 more)."), "{r}");
        assert_eq!(reason(&[("BP_X".into(), vec![])], true), None);
    }

    #[test]
    fn layout_packages_are_picked_by_name() {
        for f in ["Marvel/Content/Marvel/Characters/1026/1026001/1026001_ChildBP.uasset", "M/UI/Blueprints/Battle/WBP_Battle_Kill_1026_V3.uasset", "M/Cues/Cue_Ability_Loop_10553102_BP.uasset", "M/Data/DataTable/MarvelHeroSkinTable.uasset", "M/Data/StringTable/Hero_ST/1026/123_Customize_1026_ST.uasset"] {
            assert!(is_layout_package(f), "{f}");
        }
        for f in ["M/Characters/1026/Meshes/SK_1026_1026001.uasset", "M/Characters/1026/1026001/1026001_ChildBP.uexp", "M/VFX/NS_Burst.uasset", "M/Environment/Common/Blueprints/Planet_Creator_2_V2/Textures/T_Noise_RGB_1.uasset"] {
            assert!(!is_layout_package(f), "{f}");
        }
    }

    #[test]
    fn only_classes_and_tables_are_judged() {
        assert!(holds_class(&widget(&[], &[], &[], false)));
        assert!(!holds_class(&json!({ "Exports": [export("UAssetAPI.ExportTypes.TextureExport, UAssetAPI", "T_Noise", 0, 0)] })), "a texture in a Blueprints folder");
    }

    #[test]
    fn a_check_holds_until_the_mod_the_game_or_the_usmap_changes() {
        let dir = tempfile::tempdir().unwrap();
        let (store, utoc) = (dir.path().join("layout.json"), dir.path().join("Bp_9999999_P.utoc"));
        std::fs::write(&utoc, b"toc").unwrap();
        let (size, modified) = crate::xtra_broken::file_stamp(&utoc).unwrap();
        let done = |reason: Option<&str>, partial| Done { size, modified, game: 200, usmap: "u1".into(), reason: reason.map(Into::into), partial };
        let mut all = HashMap::new();
        assert_eq!(found_now(&all, &utoc, 200, "u1"), None, "never checked");
        remember(&store, &mut all, &utoc, done(Some("why"), false));
        assert_eq!(found_now(&load(&store), &utoc, 200, "u1"), Some(Some("why".into())));
        assert_eq!(found_now(&load(&store), &utoc, 300, "u1"), None, "the game updated since");
        assert_eq!(found_now(&load(&store), &utoc, 200, "u2"), None, "another USMAP since");
        remember(&store, &mut all, &utoc, done(None, false));
        assert_eq!(found_now(&load(&store), &utoc, 200, "u1"), Some(None), "checked and clean");
        remember(&store, &mut all, &utoc, done(None, true));
        assert_eq!(found_now(&load(&store), &utoc, 200, "u1"), None, "clean on part of it clears nothing: the date rule stays");
        assert!(current(&load(&store), &utoc, 200, "u1").is_some(), "and it is not read again");
        remember(&store, &mut all, &utoc, done(Some("why"), true));
        assert_eq!(found_now(&load(&store), &utoc, 200, "u1"), Some(Some("why".into())), "what part of it shows is enough to flag it");
        std::fs::write(&utoc, b"toc v2").unwrap();
        assert_eq!(found_now(&load(&store), &utoc, 200, "u1"), None, "the mod changed");
    }
}
