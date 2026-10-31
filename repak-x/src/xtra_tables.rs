//! repakxtra: DataTable and StringTable mods carried onto the game's current tables. A game update adds rows, keys and
//! row fields, and a mod's old copy lacks them (the class check flags that May crash, xtra_layout.rs). Here the game's
//! current table is the base and the mod's values go onto it: a StringTable's texts by key, a DataTable's row
//! properties by row and property name, the mod's own rows and keys added. What a row points at by import (an object
//! reference) cannot move between packages, so the game's value stays there and the report says so. Read with
//! today's USMAP, written back and read again (pipeline.ts verifies every rebuilt file).

use std::collections::HashSet;
use std::path::Path;

use serde::Serialize;
use serde_json::Value;
use tauri::Window;

use crate::vfx_updater::progress::TauriVfxProgressSink;
use crate::xtra_niagara::{read_json, stage, to_json};

#[derive(Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Merged {
    file: String,
    /// texts or row properties carried
    carried: usize,
    /// rows or keys only the mod has, added
    added: usize,
    /// properties left as the game's (an object reference by import)
    kept: usize,
    error: Option<String>,
}

fn table(j: &mut Value) -> Option<&mut Value> {
    j.get_mut("Exports")?.as_array_mut()?.iter_mut().find_map(|e| e.get_mut("Table"))
}

/// A property holding an object reference by import index (soft references are names, and move fine).
fn is_import_ref(v: &Value) -> bool {
    v.to_string().replace("SoftObjectPropertyData", "").contains("ObjectPropertyData, UAssetAPI")
}

/// The mod's table values onto the game's table (both decoded with today's USMAP). The game's JSON, merged, and counts.
fn merge(game: &Value, ours: &Value) -> Result<(Value, Merged), String> {
    let mut out = game.clone();
    let mut m = Merged::default();
    let mut theirs = ours.clone();
    let mine = table(&mut theirs).cloned().ok_or("the mod's copy has no table")?;
    let base = table(&mut out).ok_or("the game's copy has no table")?;
    if let (Some(rows), Some(mod_rows)) = (base.get_mut("Value").and_then(Value::as_array_mut), mine.get("Value").and_then(Value::as_array)) {
        // StringTable: [key, text] pairs
        for pair in mod_rows {
            let (Some(k), Some(_)) = (pair.get(0), pair.get(1)) else { continue };
            match rows.iter_mut().find(|r| r.get(0) == Some(k)) {
                Some(r) if r != pair => {
                    *r = pair.clone();
                    m.carried += 1;
                }
                Some(_) => {}
                None => {
                    rows.push(pair.clone());
                    m.added += 1;
                }
            }
        }
    } else if let (Some(rows), Some(mod_rows)) = (base.get_mut("Data").and_then(Value::as_array_mut), mine.get("Data").and_then(Value::as_array)) {
        // DataTable: rows by name, each row's properties by name
        for mr in mod_rows {
            let name = mr.get("Name");
            match rows.iter_mut().find(|r| r.get("Name") == name) {
                Some(gr) => {
                    let mut changed = false;
                    if let (Some(gp), Some(mp)) = (gr.get_mut("Value").and_then(Value::as_array_mut), mr.get("Value").and_then(Value::as_array)) {
                        for p in mp {
                            let Some(slot) = gp.iter_mut().find(|g| g.get("Name") == p.get("Name")) else { continue };
                            if slot == p {
                                continue;
                            }
                            if is_import_ref(p) {
                                m.kept += 1;
                                continue;
                            }
                            *slot = p.clone();
                            m.carried += 1;
                            changed = true;
                        }
                    }
                    // its values changed: the header the game's row kept would skip or misplace them, so the tool writes one
                    if changed {
                        if let Some(o) = gr.as_object_mut() {
                            o.remove("OriginalStructHeader");
                        }
                    }
                }
                None if is_import_ref(mr) => m.kept += 1,
                None => {
                    rows.push(mr.clone());
                    m.added += 1;
                }
            }
        }
    } else {
        return Err("not a DataTable or StringTable the game's copy matches".into());
    }
    // the mod's names (row names, name values) the game's NameMap lacks
    if let (Some(names), Some(theirs)) = (out.get_mut("NameMap").and_then(Value::as_array_mut), ours.get("NameMap").and_then(Value::as_array)) {
        let have: HashSet<String> = names.iter().filter_map(Value::as_str).map(String::from).collect();
        names.extend(theirs.iter().filter(|n| n.as_str().is_some_and(|s| !have.contains(s))).cloned());
    }
    Ok((out, m))
}

/// pipeline.ts: `files` (DataTable and StringTable packages inside `mod_extract`, no extension) carried onto the game's
/// current copies and written into `out` (the update's folder). Each file's result; one that failed is left as it was.
#[tauri::command]
pub async fn xtra_vfx_merge_tables(window: Window, game_paks: String, usmap_path: String, mod_extract: String, files: Vec<String>, out: String, stage_dir: String) -> Result<Vec<Merged>, String> {
    merge_tables(&game_paks, &usmap_path, &mod_extract, &files, &out, &stage_dir, &TauriVfxProgressSink::new(&window)).await
}

/// xtra_vfx_merge_tables without a window (xtra_vfx.rs vfx_rpc).
pub(crate) async fn merge_tables(game_paks: &str, usmap_path: &str, mod_extract: &str, files: &[String], out: &str, stage_dir: &str, progress: &dyn crate::vfx_updater::progress::VfxProgressSink) -> Result<Vec<Merged>, String> {
    let (game_paks, usmap_path, mod_extract, out) = (game_paks.to_string(), usmap_path.to_string(), mod_extract.to_string(), out.to_string());
    let work = Path::new(stage_dir).join("tables");
    let r = async {
        let (input, mine) = (work.join("mod"), work.join("mod_json"));
        stage(Path::new(&mod_extract), &input, files, true)?;
        to_json(&usmap_path, &input, &mine, progress).await?;
        let game = crate::xtra_mi_layout::game_copies(&game_paks, &usmap_path, files, &work).await.ok_or("the game's tables could not be read")?;
        let merged_json = work.join("merged_json");
        let mut results: Vec<Merged> = files
            .iter()
            .map(|f| {
                let res = (|| {
                    let g = read_json(&game.join(format!("{f}.json"))).map_err(|_| "the game's copy could not be read".to_string())?;
                    let o = read_json(&mine.join(format!("{f}.json"))).map_err(|_| "the mod's copy could not be read".to_string())?;
                    let (mut j, m) = merge(&g, &o)?;
                    let to = merged_json.join(format!("{f}.json"));
                    std::fs::create_dir_all(to.parent().unwrap_or(&merged_json)).map_err(|e| e.to_string())?;
                    std::fs::write(&to, crate::xtra_mi_layout::to_tool_json(&mut j)).map_err(|e| e.to_string())?;
                    Ok::<_, String>(m)
                })();
                match res {
                    Ok(m) => Merged { file: f.clone(), ..m },
                    Err(e) => Merged { file: f.clone(), error: Some(e), ..Default::default() },
                }
            })
            .collect();
        if results.iter().any(|m| m.error.is_none()) {
            let built = work.join("built");
            crate::vfx_updater::pipeline::step_convert_json_to_uassets(Path::new(""), &usmap_path, &merged_json.to_string_lossy(), &built.to_string_lossy(), progress).await?;
            for m in results.iter_mut().filter(|m| m.error.is_none()) {
                let copied = ["uasset", "uexp"].iter().all(|x| {
                    let (from, to) = (built.join(format!("{}.{x}", m.file)), Path::new(&out).join(format!("{}.{x}", m.file)));
                    from.is_file() && std::fs::create_dir_all(to.parent().unwrap_or(Path::new(&out))).is_ok() && std::fs::copy(&from, &to).is_ok()
                });
                if !copied {
                    m.error = Some("it could not be written back".into());
                }
            }
        }
        Ok::<_, String>(results)
    }
    .await;
    let _ = std::fs::remove_dir_all(&work);
    r
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn st(pairs: &[(&str, &str)]) -> Value {
        json!({ "NameMap": ["A"], "Exports": [{ "$type": "UAssetAPI.ExportTypes.StringTableExport, UAssetAPI", "Table": { "TableNamespace": "X", "Value": pairs.iter().map(|(k, v)| json!([k, v])).collect::<Vec<_>>() } }] })
    }

    #[test]
    fn a_string_tables_texts_go_onto_the_games_keys_and_new_game_keys_stay() {
        let game = st(&[("Skin_1", "Blood of Wakanda"), ("Skin_2", "New skin")]);
        let ours = st(&[("Skin_1", "Catboy"), ("Mine", "Own key")]);
        let (out, m) = merge(&game, &ours).unwrap();
        assert_eq!((m.carried, m.added), (1, 1));
        assert_eq!(out["Exports"][0]["Table"]["Value"], json!([["Skin_1", "Catboy"], ["Skin_2", "New skin"], ["Mine", "Own key"]]));
    }

    fn row(name: &str, props: Value) -> Value {
        json!({ "$type": "UAssetAPI.PropertyTypes.Structs.StructPropertyData, UAssetAPI", "Name": name, "StructType": "Row", "OriginalStructHeader": {}, "Value": props })
    }
    fn dt(rows: Vec<Value>, names: &[&str]) -> Value {
        json!({ "NameMap": names, "Exports": [{ "$type": "UAssetAPI.ExportTypes.DataTableExport, UAssetAPI", "Table": { "Data": rows } }] })
    }
    fn prop(name: &str, ty: &str, v: Value) -> Value {
        json!({ "$type": format!("UAssetAPI.PropertyTypes.Objects.{ty}PropertyData, UAssetAPI"), "Name": name, "Value": v })
    }

    #[test]
    fn a_data_tables_row_values_go_onto_the_games_rows_and_new_fields_stay() {
        let game = dt(vec![row("Mood_1", json!([prop("Speed", "Float", json!(1.0)), prop("NewField", "Int", json!(7)), prop("Icon", "Object", json!(-3))])), row("Mood_2", json!([]))], &["Mood_1"]);
        let ours = dt(vec![row("Mood_1", json!([prop("Speed", "Float", json!(2.5)), prop("Icon", "Object", json!(-9))])), row("Mine", json!([]))], &["Mood_1", "Mine"]);
        let (out, m) = merge(&game, &ours).unwrap();
        assert_eq!((m.carried, m.added, m.kept), (1, 1, 1), "Speed carried, Mine added, Icon (an import) kept as the game's");
        let rows = &out["Exports"][0]["Table"]["Data"];
        assert_eq!(rows[0]["Value"][0]["Value"], json!(2.5));
        assert_eq!(rows[0]["Value"][1]["Value"], json!(7), "the game's new field stays");
        assert_eq!(rows[0]["Value"][2]["Value"], json!(-3));
        assert!(rows[0].get("OriginalStructHeader").is_none() && rows[1].get("OriginalStructHeader").is_some(), "only a changed row gets a new header");
        assert_eq!(rows.as_array().unwrap().len(), 3);
        assert_eq!(out["NameMap"], json!(["Mood_1", "Mine"]));
    }
}
