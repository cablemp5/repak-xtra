//! repakxtra: what each game patch moved, learned from the USMAPs on disk (scripts/usmap-diff.py does the same by hand).
//! Cooked unversioned files store properties by their index in the class, so a patch that inserts or removes one moves
//! every later index, and a file cooked before it is read wrong after it (3984769 inserted two material overrides at
//! index 40 and crashed the game on older materials). Each pair of neighbouring builds in the managed USMAP folder is
//! compared: a struct moved when an index its older layout had now holds another property, or none. Properties added
//! after the last one move nothing. Read from the files alone (zstd and parsing, no UAssetTool), kept in memory per
//! folder listing.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;

/// Each struct: its parent, its property count, and its serialized properties (index, array size, name, type).
pub(crate) type Structs = HashMap<String, (Option<String>, u16, Vec<(u16, u8, String, String)>)>;

const TYPES: [&str; 31] = [
    "Byte", "Bool", "Int", "Float", "Object", "Name", "Delegate", "Double", "Array", "Struct", "Str", "Text", "Interface", "MulticastDelegate", "WeakObject", "LazyObject",
    "AssetObject", "SoftObject", "UInt64", "UInt32", "UInt16", "Int64", "Int16", "Int8", "Map", "Set", "Enum", "FieldPath", "OptionalProperty", "Utf8Str", "AnsiStr",
];

struct Reader<'a> {
    b: &'a [u8],
    o: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        let s = self.b.get(self.o..self.o + n).ok_or("the USMAP ends early")?;
        self.o += n;
        Ok(s)
    }
    fn u8(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }
    fn u16(&mut self) -> Result<u16, String> {
        Ok(u16::from_le_bytes(self.take(2)?.try_into().unwrap()))
    }
    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
}

/// The body of a USMAP file, uncompressed, with its version.
fn body(raw: &[u8]) -> Result<(u8, Vec<u8>), String> {
    let mut r = Reader { b: raw, o: 0 };
    if r.u16()? != 0x30C4 {
        return Err("not a USMAP".into());
    }
    let ver = r.u8()?;
    if ver >= 1 && r.u32()? != 0 {
        // versioning: the UE4 and UE5 file versions, the custom versions (a GUID and a version each), the changelist
        r.take(8)?;
        let n = r.u32()? as usize;
        r.take(n * 20)?;
        r.take(4)?;
    }
    let (method, size, full) = (r.u8()?, r.u32()? as usize, r.u32()? as usize);
    let data = r.take(size)?;
    let out = match method {
        0 => data.to_vec(),
        3 => zstd::bulk::decompress(data, full).map_err(|e| format!("zstd: {e}"))?,
        m => return Err(format!("compression {m} is not read here")),
    };
    if out.len() != full {
        return Err("the USMAP's size does not match".into());
    }
    Ok((ver, out))
}

fn parse(raw: &[u8]) -> Result<Structs, String> {
    let (ver, b) = body(raw)?;
    let mut r = Reader { b: &b, o: 0 };
    let n = r.u32()? as usize;
    let mut names = Vec::with_capacity(n);
    for _ in 0..n {
        let len = if ver >= 3 { r.u16()? as usize } else { r.u8()? as usize };
        names.push(String::from_utf8_lossy(r.take(len)?).to_string());
    }
    let name = |r: &mut Reader| -> Result<Option<String>, String> {
        let i = r.u32()?;
        Ok((i != u32::MAX).then(|| names.get(i as usize).cloned().unwrap_or_default()))
    };
    for _ in 0..r.u32()? {
        name(&mut r)?;
        let count = if ver >= 2 { r.u16()? as usize } else { r.u8()? as usize };
        for _ in 0..count {
            if ver >= 4 {
                r.take(8)?;
            }
            name(&mut r)?;
        }
    }
    fn ptype(r: &mut Reader, name: &dyn Fn(&mut Reader) -> Result<Option<String>, String>) -> Result<String, String> {
        let t = *TYPES.get(r.u8()? as usize).ok_or("an unknown property type")?;
        Ok(match t {
            "Enum" => {
                ptype(r, name)?;
                format!("Enum<{}>", name(r)?.unwrap_or_default())
            }
            "Struct" => format!("Struct<{}>", name(r)?.unwrap_or_default()),
            "Array" | "Set" | "OptionalProperty" => format!("{t}<{}>", ptype(r, name)?),
            "Map" => format!("Map<{},{}>", ptype(r, name)?, ptype(r, name)?),
            t => t.to_string(),
        })
    }
    let mut out = Structs::new();
    for _ in 0..r.u32()? {
        let s = name(&mut r)?.unwrap_or_default();
        let parent = name(&mut r)?;
        let (count, serial) = (r.u16()?, r.u16()?);
        let mut props = Vec::with_capacity(serial as usize);
        for _ in 0..serial {
            let (idx, arr) = (r.u16()?, r.u8()?);
            let p = name(&mut r)?.unwrap_or_default();
            props.push((idx, arr, p, ptype(&mut r, &name)?));
        }
        out.insert(s, (parent, count, props));
    }
    Ok(out)
}

/// A struct's properties by their index in the whole chain, as unversioned files number them: its own first, then its
/// parent's, and so on (4042190 checked: an AnimSequence's own three come before AnimSequenceBase's SequenceLength).
fn flat(structs: &Structs, name: &str) -> HashMap<u32, (String, String)> {
    let mut chain = Vec::new();
    let mut at = Some(name.to_string());
    while let Some(n) = at.filter(|n| structs.contains_key(n) && !chain.contains(n)) {
        at = structs[&n].0.clone();
        chain.push(n);
    }
    let mut out = HashMap::new();
    let mut base = 0u32;
    for s in chain.iter() {
        let (_, count, props) = &structs[s];
        for (idx, arr, p, t) in props {
            for k in 0..*arr as u32 {
                out.insert(base + *idx as u32 + k, (if *arr == 1 { p.clone() } else { format!("{p}[{k}]") }, t.clone()));
            }
        }
        base += *count as u32;
    }
    out
}

/// The structs whose own layout moved: an index that held a property now holds another, or none. A struct that only
/// holds one of these keeps its header (its own indices did not move), and the tool's new one would be wrong for some.
fn moved_itself(old: &Structs, new: &Structs) -> std::collections::HashSet<String> {
    old.keys()
        .filter(|n| new.contains_key(*n))
        .filter(|n| {
            let (a, b) = (flat(old, n), flat(new, n));
            a.iter().any(|(i, p)| b.get(i) != Some(p))
        })
        .cloned()
        .collect()
}

/// The structs whose older layout `old` reads wrong in `new`: an index that held a property now holds another, or none,
/// and every struct that holds one of those (a property of its type, in an array, set, map, or optional), since a
/// file stores the inner struct's properties inside the outer one's.
fn moved(old: &Structs, new: &Structs) -> Vec<String> {
    let mut set = moved_itself(old, new);
    // who holds whom, in today's layout: the struct names inside each property type ("Array<Struct<X>>" holds X)
    let mut holders: HashMap<&str, Vec<&str>> = HashMap::new();
    for (name, (_, _, props)) in new.iter().filter(|(n, _)| old.contains_key(*n)) {
        for (_, _, _, t) in props {
            for inner in t.split("Struct<").skip(1).filter_map(|s| s.split(['>', ',']).next()) {
                holders.entry(inner).or_default().push(name);
            }
        }
    }
    // a child class reads its parent's properties first: flat() already moved it with the parent
    let mut todo: Vec<String> = set.iter().cloned().collect();
    while let Some(n) = todo.pop() {
        for h in holders.get(n.as_str()).into_iter().flatten() {
            if set.insert(h.to_string()) {
                todo.push(h.to_string());
            }
        }
    }
    let mut out: Vec<String> = set.into_iter().collect();
    out.sort();
    out
}

static LAYOUTS: Mutex<Vec<(PathBuf, u64, std::sync::Arc<Structs>)>> = Mutex::new(Vec::new());

/// The layouts in the USMAP at `path`, read once while the file keeps its size (a few kept: a run asks two or three).
pub(crate) fn layout(path: &Path) -> Result<std::sync::Arc<Structs>, String> {
    let len = std::fs::metadata(path).map_err(|e| e.to_string())?.len();
    if let Some((_, _, s)) = LAYOUTS.lock().unwrap().iter().find(|(p, l, _)| p == path && *l == len) {
        return Ok(s.clone());
    }
    let s = std::sync::Arc::new(parse(&std::fs::read(path).map_err(|e| e.to_string())?)?);
    let mut kept = LAYOUTS.lock().unwrap();
    kept.retain(|(p, _, _)| p != path);
    if kept.len() >= 3 {
        kept.remove(0);
    }
    kept.push((path.to_path_buf(), len, s.clone()));
    Ok(s)
}

/// The structs whose own layout moved between the USMAPs at `old` and `new`: the ones a rewrite gives new headers.
pub(crate) fn moved_between(old: &Path, new: &Path) -> Result<std::collections::HashSet<String>, String> {
    Ok(moved_itself(&*layout(old)?, &*layout(new)?))
}

/// Each export's own unversioned header (`OriginalUnversionedHeader`, the class's property indices the file was cooked
/// with), rewritten from `old`'s layout to `new`'s: each index is the property it named in `old` (its name, array slot,
/// and type), found again in `new`. Its zero bits go with it, and the fragments are built again (runs and skips of at
/// most 127). An export whose class is not a native one both layouts know, or whose layout did not move, keeps its
/// header. Letting the tool write a new header from the USMAP is wrong for some classes (2026-11-13: a material's
/// ScalarParameterValue stops reading), so the cooked one is carried. Err names the first property `new` lacks or
/// changed the type of, or an order the new indices do not keep: such a file is not rewritten. Ok: how many changed.
pub(crate) fn remap_headers(j: &mut serde_json::Value, old: &Structs, new: &Structs) -> Result<usize, String> {
    use serde_json::{json, Value};
    let imports: Vec<String> = j.get("Imports").and_then(Value::as_array).map_or_else(Vec::new, |a| a.iter().map(|i| i.get("ObjectName").and_then(Value::as_str).unwrap_or_default().to_string()).collect());
    let mut changed = 0;
    for e in j.get_mut("Exports").and_then(Value::as_array_mut).into_iter().flatten() {
        let class = match e.get("ClassIndex").and_then(Value::as_i64) {
            Some(i) if i < 0 => imports.get((-i - 1) as usize).cloned().unwrap_or_default(),
            _ => continue,
        };
        if !old.contains_key(&class) || !new.contains_key(&class) {
            continue;
        }
        let (a, b) = (flat(old, &class), flat(new, &class));
        if a == b {
            continue;
        }
        let Some(h) = e.get_mut("OriginalUnversionedHeader").filter(|h| h.is_object()) else { continue };
        let Some(frags) = h.get("Fragments").and_then(Value::as_array).filter(|f| !f.is_empty()) else { continue };
        let mask: Vec<bool> = h.get("ZeroMask").and_then(Value::as_array).map_or_else(Vec::new, |m| m.iter().map(|b| b.as_bool().unwrap_or(false)).collect());
        let (mut items, mut at, mut zi) = (Vec::new(), 0u32, 0usize);
        for f in frags {
            let n = |k: &str| f.get(k).and_then(Value::as_u64).unwrap_or(0) as u32;
            at += n("SkipNum");
            let zeroes = f.get("bHasAnyZeroes").and_then(Value::as_bool).unwrap_or(false);
            for k in 0..n("ValueNum") {
                let z = zeroes && mask.get(zi).copied().unwrap_or(false);
                zi += zeroes as usize;
                items.push((at + k, z));
            }
            at += n("ValueNum");
        }
        let inv: HashMap<&(String, String), u32> = b.iter().map(|(i, p)| (p, *i)).collect();
        let mut out = Vec::with_capacity(items.len());
        for (i, z) in &items {
            let p = a.get(i).ok_or_else(|| format!("{class} index {i} is not in the older layout"))?;
            let to = inv.get(p).ok_or_else(|| format!("{class}.{} is gone or changed type", p.0))?;
            out.push((*to, *z));
        }
        if out.windows(2).any(|w| w[0].0 >= w[1].0) {
            return Err(format!("{class}: its properties change order"));
        }
        if out.iter().map(|o| o.0).eq(items.iter().map(|i| i.0)) {
            continue;
        }
        let (mut frags, mut zero_mask, mut pos, mut k) = (Vec::new(), Vec::new(), 0u32, 0usize);
        let frag = |skip: u32, start: u32, n: u32, zeroes: bool| json!({ "$type": "UAssetAPI.Unversioned.FFragment, UAssetAPI", "SkipNum": skip, "ValueNum": n, "bIsLast": false, "FirstNum": start, "bHasAnyZeroes": zeroes, "LastNum": (start + n).saturating_sub(1) });
        while k < out.len() {
            let start = out[k].0;
            let mut n = 1;
            while k + n < out.len() && out[k + n].0 == start + n as u32 && n < 127 {
                n += 1;
            }
            let mut skip = start - pos;
            while skip > 127 {
                frags.push(frag(127, pos + 127, 0, false));
                pos += 127;
                skip -= 127;
            }
            let zs: Vec<bool> = out[k..k + n].iter().map(|o| o.1).collect();
            let zeroes = zs.iter().any(|z| *z);
            frags.push(frag(skip, start, n as u32, zeroes));
            if zeroes {
                zero_mask.extend(zs);
            }
            pos = start + n as u32;
            k += n;
        }
        if let Some(last) = frags.last_mut() {
            last["bIsLast"] = json!(true);
        }
        h["Fragments"] = json!(frags);
        h["ZeroMask"] = json!(zero_mask);
        changed += 1;
    }
    Ok(changed)
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Moved {
    /// the newer game build
    build: u64,
    /// the build it is compared with (the next older USMAP on disk)
    from: u64,
    structs: Vec<String>,
}

static SEEN: Mutex<Option<(String, Vec<Moved>)>> = Mutex::new(None);

/// What each game build moved since the one before it, for the USMAPs in `dir`, oldest first.
fn moves_in(dir: &Path) -> Vec<Moved> {
    let mut have: Vec<(u64, PathBuf, u64)> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            Some((crate::xtra_niagara::usmap_build(&p.to_string_lossy())?, p, e.metadata().ok()?.len()))
        })
        .collect();
    have.sort();
    have.dedup_by(|a, b| a.0 == b.0);
    // the newest few: what moved long ago is in every update since (each file takes a moment to unpack and read)
    let skip = have.len().saturating_sub(4);
    have.drain(..skip);
    let key = have.iter().map(|(b, _, len)| format!("{b}:{len}")).collect::<Vec<_>>().join("|");
    if let Some((k, m)) = SEEN.lock().unwrap().as_ref() {
        if *k == key {
            return m.clone();
        }
    }
    let read = |p: &Path| std::fs::read(p).map_err(|e| e.to_string()).and_then(|b| parse(&b));
    let mut out = Vec::new();
    let mut prev: Option<(u64, Structs)> = None;
    for (b, p, _) in &have {
        match read(p) {
            Ok(s) => {
                if let Some((pb, ps)) = &prev {
                    out.push(Moved { build: *b, from: *pb, structs: moved(ps, &s) });
                }
                prev = Some((*b, s));
            }
            Err(e) => {
                log::warn!("[usmap diff] {}: {e}", p.display());
                prev = None; // a gap: the next one is not compared across it
            }
        }
    }
    *SEEN.lock().unwrap() = Some((key, out.clone()));
    out
}

/// What each game build moved, from the managed USMAP folder.
pub(crate) fn moves() -> Vec<Moved> {
    moves_in(&crate::vfx_updater::commands::managed_usmap_dir())
}

/// Every layout the game builds on disk moved (moves(), the newest few USMAPs).
pub(crate) fn moved_lately() -> std::collections::HashSet<String> {
    moves().into_iter().flat_map(|m| m.structs).collect()
}

/// Whether the newest game build on disk moved `name`: an older file of that class is in the wrong layout today.
pub(crate) fn newest_moved(name: &str) -> bool {
    moves().iter().max_by_key(|m| m.build).is_some_and(|m| m.structs.iter().any(|s| s == name))
}

/// The newest game build that moved `name` (among the USMAPs on disk).
pub(crate) fn last_moved(name: &str) -> Option<u64> {
    moves().iter().filter(|m| m.structs.iter().any(|s| s == name)).map(|m| m.build).max()
}

/// The layouts the Mod Updater handles: every moved property layout is rewritten (remap_headers, xtra_mi_layout.rs),
/// and Animation Blueprints are left out and flagged (xtra_broken.rs). Kept as a list for a layout it ever cannot.
const NOT_HANDLED: &[&str] = &[];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutNews {
    newest: Option<Moved>,
    /// of its structs, those the Mod Updater neither rewrites nor flags itself
    not_handled: Vec<String>,
}

/// The Mod Updater's USMAP section: what the newest game build on disk moved, and what of that it does not handle yet.
#[tauri::command(async)]
pub fn xtra_layout_moves() -> LayoutNews {
    let newest = moves().into_iter().max_by_key(|m| m.build);
    let not_handled = newest.as_ref().map_or_else(Vec::new, |m| m.structs.iter().filter(|s| NOT_HANDLED.contains(&s.as_str())).cloned().collect());
    LayoutNews { newest, not_handled }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(entries: &[(&str, Option<&str>, u16, &[(u16, &str, &str)])]) -> Structs {
        entries
            .iter()
            .map(|(n, parent, count, props)| (n.to_string(), (parent.map(String::from), *count, props.iter().map(|(i, p, t)| (*i, 1, p.to_string(), t.to_string())).collect())))
            .collect()
    }

    #[test]
    fn an_inserted_property_moves_a_struct_and_its_children_one_added_last_does_not() {
        let old = s(&[
            ("Overrides", None, 3, &[(0, "bOverride_A", "Bool"), (1, "TwoSided", "Bool"), (2, "BlendMode", "Byte")]),
            ("Child", Some("Overrides"), 1, &[(0, "Extra", "Int")]),
            ("Tail", None, 1, &[(0, "A", "Int")]),
            ("Gone", None, 1, &[(0, "A", "Int")]),
        ]);
        let new = s(&[
            ("Overrides", None, 4, &[(0, "bOverride_A", "Bool"), (1, "bNew", "Bool"), (2, "TwoSided", "Bool"), (3, "BlendMode", "Byte")]),
            ("Child", Some("Overrides"), 1, &[(0, "Extra", "Int")]),
            ("Tail", None, 2, &[(0, "A", "Int"), (1, "B", "Int")]),
        ]);
        assert_eq!(moved(&old, &new), vec!["Child".to_string(), "Overrides".to_string()], "inserted, and through a parent; appended moves nothing; a removed struct is not compared");
    }

    #[test]
    fn a_struct_holding_a_moved_one_moves_too() {
        let old = s(&[("Inner", None, 1, &[(0, "A", "Int")]), ("Outer", None, 1, &[(0, "Items", "Array<Struct<Inner>>")]), ("Other", None, 1, &[(0, "B", "Struct<InnerX>")])]);
        let new = s(&[("Inner", None, 2, &[(0, "N", "Int"), (1, "A", "Int")]), ("Outer", None, 1, &[(0, "Items", "Array<Struct<Inner>>")]), ("Other", None, 1, &[(0, "B", "Struct<InnerX>")])]);
        assert_eq!(moved(&old, &new), vec!["Inner".to_string(), "Outer".to_string()], "held in an array moves; a longer name does not match");
    }

    fn header(indices: &[(u32, bool)]) -> serde_json::Value {
        // one fragment per run, as the tool reads them
        let (mut frags, mut mask, mut pos, mut k) = (vec![], vec![], 0, 0);
        while k < indices.len() {
            let mut n = 1;
            while k + n < indices.len() && indices[k + n].0 == indices[k].0 + n as u32 {
                n += 1;
            }
            let zeroes = indices[k..k + n].iter().any(|i| i.1);
            if zeroes {
                mask.extend(indices[k..k + n].iter().map(|i| i.1));
            }
            frags.push(serde_json::json!({ "SkipNum": indices[k].0 - pos, "ValueNum": n, "bIsLast": k + n == indices.len(), "bHasAnyZeroes": zeroes }));
            pos = indices[k].0 + n as u32;
            k += n;
        }
        serde_json::json!({ "Fragments": frags, "ZeroMask": mask })
    }

    fn indices(h: &serde_json::Value) -> Vec<(u32, bool)> {
        let mask: Vec<bool> = h["ZeroMask"].as_array().unwrap().iter().map(|b| b.as_bool().unwrap()).collect();
        let (mut out, mut at, mut zi) = (vec![], 0, 0);
        for f in h["Fragments"].as_array().unwrap() {
            assert!(f["SkipNum"].as_u64().unwrap() <= 127 && f["ValueNum"].as_u64().unwrap() <= 127, "{f}");
            at += f["SkipNum"].as_u64().unwrap() as u32;
            for k in 0..f["ValueNum"].as_u64().unwrap() as u32 {
                let z = f["bHasAnyZeroes"].as_bool().unwrap() && mask[zi];
                zi += f["bHasAnyZeroes"].as_bool().unwrap() as usize;
                out.push((at + k, z));
            }
            at += f["ValueNum"].as_u64().unwrap() as u32;
        }
        assert!(h["Fragments"].as_array().unwrap().last().unwrap()["bIsLast"].as_bool().unwrap());
        out
    }

    #[test]
    fn an_export_header_follows_its_properties_to_their_new_indices() {
        // 4042190: MaterialInstance gained a property before StaticParametersRuntime, a child class reads the parent's first
        let old = s(&[("Base", None, 3, &[(0, "A", "Int"), (1, "B", "Int"), (2, "C", "Int")]), ("MIC", Some("Base"), 1, &[(0, "D", "Int")])]);
        let new = s(&[("Base", None, 4, &[(0, "A", "Int"), (1, "New", "Int"), (2, "B", "Int"), (3, "C", "Int")]), ("MIC", Some("Base"), 1, &[(0, "D", "Int")])]);
        let mut j = serde_json::json!({ "Imports": [{ "ObjectName": "MIC" }, { "ObjectName": "Unknown" }],
            "Exports": [{ "ClassIndex": -1, "OriginalUnversionedHeader": header(&[(0, false), (1, true), (3, false)]) },
                        { "ClassIndex": -2, "OriginalUnversionedHeader": header(&[(1, false)]) },
                        { "ClassIndex": 1, "OriginalUnversionedHeader": header(&[(1, false)]) }] });
        assert_eq!(remap_headers(&mut j, &old, &new), Ok(1));
        // the class's own D is 0, its parent's A, B, C follow: D, A and C remapped, the zero bit with A
        assert_eq!(indices(&j["Exports"][0]["OriginalUnversionedHeader"]), vec![(0, false), (1, true), (4, false)], "the zero bit goes with its property");
        assert_eq!(indices(&j["Exports"][1]["OriginalUnversionedHeader"]), vec![(1, false)], "a class neither layout has keeps its header");
        assert_eq!(indices(&j["Exports"][2]["OriginalUnversionedHeader"]), vec![(1, false)], "a class the package defines keeps its header");
        // a property gone or changed type: the file is refused
        let gone = s(&[("Base", None, 2, &[(0, "A", "Int"), (1, "C", "Int")]), ("MIC", Some("Base"), 1, &[(0, "D", "Int")])]);
        let mut k = serde_json::json!({ "Imports": [{ "ObjectName": "MIC" }], "Exports": [{ "ClassIndex": -1, "OriginalUnversionedHeader": header(&[(2, false)]) }] });
        assert!(remap_headers(&mut k, &old, &gone).unwrap_err().contains("B is gone"));
        let retyped = s(&[("Base", None, 4, &[(0, "A", "Int"), (1, "New", "Int"), (2, "B", "Float"), (3, "C", "Int")]), ("MIC", Some("Base"), 1, &[(0, "D", "Int")])]);
        assert!(remap_headers(&mut k, &old, &retyped).is_err());
    }

    #[test]
    fn a_remapped_header_splits_runs_and_skips_at_127() {
        let props = |n: u16, at: u16| (0..n).map(|i| (i + if i >= at { 1 } else { 0 }, format!("P{i}"), "Int".to_string())).collect::<Vec<_>>();
        let build = |n: u16, insert: Option<u16>| -> Structs {
            let mut p: Vec<(u16, u8, String, String)> = props(n, insert.unwrap_or(u16::MAX)).into_iter().map(|(i, name, t)| (i, 1, name, t)).collect();
            if let Some(at) = insert {
                p.push((at, 1, "New".into(), "Int".into()));
            }
            [("C".to_string(), (None, n + insert.is_some() as u16, p))].into_iter().collect()
        };
        let (old, new) = (build(300, None), build(300, Some(0)));
        let want: Vec<(u32, bool)> = (0..130).map(|i| (i, i % 2 == 0)).chain([(299, false)]).collect();
        let mut j = serde_json::json!({ "Imports": [{ "ObjectName": "C" }], "Exports": [{ "ClassIndex": -1, "OriginalUnversionedHeader": header(&want) }] });
        assert_eq!(remap_headers(&mut j, &old, &new), Ok(1));
        assert_eq!(indices(&j["Exports"][0]["OriginalUnversionedHeader"]), want.iter().map(|(i, z)| (i + 1, *z)).collect::<Vec<_>>());
    }

    /// The installed game's USMAPs (--ignored --nocapture): 3984769 must move the material overrides.
    #[test]
    #[ignore]
    fn real_usmaps() {
        let t = std::time::Instant::now();
        let m = moves();
        println!("{:?} in {:?}", m.iter().map(|m| (m.from, m.build, m.structs.len())).collect::<Vec<_>>(), t.elapsed());
        let at = m.iter().find(|m| m.build == 3984769).expect("3984769 on disk");
        println!("{:?}", at.structs);
        assert!(at.structs.iter().any(|s| s == "MaterialInstanceBasePropertyOverrides"));
    }
}
