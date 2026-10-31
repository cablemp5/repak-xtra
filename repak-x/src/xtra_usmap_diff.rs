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
type Structs = HashMap<String, (Option<String>, u16, Vec<(u16, u8, String, String)>)>;

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

/// A struct's properties by their index in the whole chain (its parents' first), as unversioned files number them.
fn flat(structs: &Structs, name: &str) -> HashMap<u32, (String, String)> {
    let mut chain = Vec::new();
    let mut at = Some(name.to_string());
    while let Some(n) = at.filter(|n| structs.contains_key(n) && !chain.contains(n)) {
        at = structs[&n].0.clone();
        chain.push(n);
    }
    let mut out = HashMap::new();
    let mut base = 0u32;
    for s in chain.iter().rev() {
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

/// The structs whose older layout `old` reads wrong in `new`: an index that held a property now holds another, or none.
fn moved(old: &Structs, new: &Structs) -> Vec<String> {
    let mut out: Vec<String> = old
        .keys()
        .filter(|n| new.contains_key(*n))
        .filter(|n| {
            let (a, b) = (flat(old, n), flat(new, n));
            a.iter().any(|(i, p)| b.get(i) != Some(p))
        })
        .cloned()
        .collect();
    out.sort();
    out
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

/// The newest game build that moved `name` (among the USMAPs on disk).
pub(crate) fn last_moved(name: &str) -> Option<u64> {
    moves().iter().filter(|m| m.structs.iter().any(|s| s == name)).map(|m| m.build).max()
}

/// The layouts the Mod Updater handles: rewritten (xtra_mi_layout.rs MOVED) or left out and flagged (Animation
/// Blueprints, xtra_broken.rs). The game's own Blueprint classes are judged by the class check (xtra_layout.rs).
const HANDLED: &[&str] = &["MaterialInstanceBasePropertyOverrides", "AnimBlueprintGeneratedConstantData", "AnimBlueprintGeneratedMutableData"];

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
    let not_handled = newest.as_ref().map_or_else(Vec::new, |m| m.structs.iter().filter(|s| !HANDLED.contains(&s.as_str())).cloned().collect());
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
