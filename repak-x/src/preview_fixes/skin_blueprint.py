"""Skins without a mesh of their own (Winter Soldier's Celestial Soldier, 1041308): the game puts them on another skin's
mesh (1041306's) through their blueprints, with their own material in each slot. A mod that recolors one rendered on the
hero's default mesh with default materials, the vanilla skin, not the mod. Here the skin's ChildBP (in game) and ShowBP
(lobby) name the mesh and the material per slot; the render uses both (slot_materials, read by render_preview.py)."""
BP_SKINS = {}     # (hero, skin) -> the gameplay mesh its blueprint puts it on, None when it names none
BP_SLOTS = {}     # (skin, mesh) -> its material per slot, game paths
SLOTS = {}        # this render's mesh name -> material name per slot (render_form's job)
PNG_SKIN = {}     # a rendered png -> (hero, skin): its "before" picture is that skin too
VANILLA_SKIN = []


def mod_skin(pkgs):
    """The (hero, skin) most of a mod's character files are under, or None."""
    looks = [m.groups() for p in pkgs if "/VFX/" not in p for m in [re.search(r"/Characters/(\d{4})/(\d{7})/", p)] if m]
    return max(sorted(set(looks)), key=looks.count) if looks else None


def blueprint_mesh(hero, skin):
    """The mesh the skin's blueprints put it on (its slots go to BP_SLOTS), read once per run."""
    if (hero, skin) not in BP_SKINS:
        BP_SKINS[(hero, skin)] = None
        work = WORK / "_blueprints" / skin
        try:
            drop_work(work)
            work.mkdir(parents=True)
            (work / "config.json").write_text(json.dumps(cue_config()), encoding="utf-8")
            base = f"/Game/Marvel/Characters/{hero}/{skin}/{skin}_"
            out = export(work, [{"op": "export", "mode": "json", "paths": [base + "ChildBP", base + "ShowBP"]}], name="blueprint", out=work / "bp")
            for f in sorted(out.rglob("*.json")):
                for o in json.loads(f.read_text(encoding="utf-8")):
                    p = o.get("Properties") or {}
                    mesh = game_ref((p.get("SkeletalMeshAsset_SoftPtr") or {}).get("AssetPathName", ""))
                    mats = [game_ref(m.get("AssetPathName", "")) for m in p.get("Materials_SoftPtr") or []]
                    if SKIN_MESH.match(mesh) and any(f"/{skin}/" in m for m in mats):
                        BP_SLOTS[(skin, mesh)] = mats
                        if not mesh.endswith("_Lobby"):
                            BP_SKINS[(hero, skin)] = mesh
        except Exception as e:   # the old fallback (the hero's default mesh) rather than no preview
            print(f"# the blueprint of skin {skin} could not be read: {e}", file=sys.stderr, flush=True)
    return BP_SKINS[(hero, skin)]


_kit_character_targets = character_targets


def character_targets(pkgs, meshes=()):
    # shortcut: one form only (a blueprint skin of a hero with forms renders its first), until such a skin turns up
    t = _kit_character_targets(pkgs, meshes)
    hs = mod_skin(pkgs)
    m = SKIN_MESH.match(t[0]) if len(t) == 1 else None
    if not (m and meshes and hs) or m[2] == hs[1] or any((n := SKIN_MESH.match(p)) and (n[1], n[2]) == hs for p in meshes):
        return t   # its own mesh, or a skin the game has a mesh for
    return [blueprint_mesh(*hs) or t[0]]


_kit_render_character = render_character


def render_character(work, targets, pkgs, out_png, bl, meshes=()):
    SLOTS.clear()
    hs = VANILLA_SKIN[0] if VANILLA_SKIN else mod_skin(pkgs)
    ts = [targets] if isinstance(targets, str) else list(targets)
    if hs and (hs in BP_SKINS or VANILLA_SKIN) and blueprint_mesh(*hs) in ts:
        mats = [v for (s, _), v in BP_SLOTS.items() if s == hs[1]]
        SLOTS.update({mesh.rsplit("/", 1)[1]: [x.rsplit("/", 1)[-1] or None for x in v] for (s, mesh), v in BP_SLOTS.items() if s == hs[1]})
        pkgs = list(pkgs) + [x for v in mats for x in dict.fromkeys(v) if "/MI_" in x and x not in pkgs]   # exported as its own
        PNG_SKIN[out_png] = hs
        if not VANILLA_SKIN:
            EXTRA["blueprint_skin"] = list(hs)   # in the index: a later "before" picture (a cache hit) is this skin too
    return _kit_render_character(work, targets, pkgs, out_png, bl, meshes)


_kit_render_vanillas = _render_vanillas


def saved_skin(out_dir, key, index):
    """The blueprint skin a saved preview shows: a mod's in index.json, a loadout's in its <key>.json. () for any other."""
    meta = (load_result(out_dir / f"{key}.json") or {}) if key.startswith("loadout-") else index.get(key, {})
    return tuple(meta.get("blueprint_skin") or ())


def _render_vanillas(todo, cfg, bl, meshes, out_dir, cache):
    """A blueprint skin's "before" picture is the game's own skin on that mesh, cached apart from the mesh's skin."""
    index = load_result(out_dir / "index.json") or {}
    skins = {png: PNG_SKIN.get(png) or saved_skin(out_dir, png.stem, index) for _, png in todo}
    _kit_render_vanillas([t for t in todo if not skins[t[1]]], cfg, bl, meshes, out_dir, cache)
    for t in [t for t in todo if skins[t[1]]]:
        meta = out_dir / f"{t[1].stem}.json"
        if t[1].stem.startswith("loadout-") and (info := load_result(meta)) is not None:   # a loadout keeps it in its own file
            meta.write_text(json.dumps({**info, "blueprint_skin": list(skins[t[1]])}, indent=1), encoding="utf-8")
        VANILLA_SKIN[:] = [skins[t[1]]]
        try:
            _kit_render_vanillas([t], cfg, bl, meshes, out_dir, cache / f"bp{skins[t[1]][1]}")
        finally:
            VANILLA_SKIN.clear()


_kit_share_vanillas = share_vanillas


def share_vanillas(a, out_dir, index, cfg):
    """The kit shares "before" pictures by mesh: a blueprint skin missing its own got the mesh's skin (1041306 for
    Celestial Soldier). Taken back, so its next render makes the right one."""
    pending = {k for k in [*index, *(m.stem for m in out_dir.glob("loadout-*.json"))]
               if saved_skin(out_dir, k, index) and not vanilla_png(out_dir / f"{k}.png").exists()}
    _kit_share_vanillas(a, out_dir, index, cfg)
    for k in pending:
        if vanilla_png(out_dir / f"{k}.png").exists():
            vanilla_png(out_dir / f"{k}.png").unlink()
            print(f"PREVIEW_NONE {k}.vanilla", flush=True)


VIEWER_SWAPS = {}   # Rotate in 3D's export of a blueprint skin: its mesh's skin, its own, and its material names
_kit_export_viewer = export_viewer
_kit_viewer_files = viewer_files


def export_viewer(work, target, pkgs, meshes, dest):
    """A blueprint skin's 3D export draws its own material in each slot, as its preview does (Nebucy: 1041308 on
    1041306's mesh drew 1041306's pink galaxy). Slots match by name (MI_1041306_Body -> MI_1041308_Body): the lobby
    mesh's slot order is not the blueprint's."""
    VIEWER_SWAPS.clear()
    hs = mod_skin(pkgs)
    base = SKIN_MESH.match(target)
    if hs and base and blueprint_mesh(*hs) == target:
        mats = {x.rsplit("/", 1)[-1]: x for (s, _), v in BP_SLOTS.items() if s == hs[1] for x in v if "/MI_" in x}
        VIEWER_SWAPS.update({"from": base[2], "to": hs[1], "names": set(mats)})
        pkgs = list(pkgs) + [x for x in mats.values() if x not in pkgs]
    try:
        return _kit_export_viewer(work, target, pkgs, meshes, dest)
    finally:
        VIEWER_SWAPS.clear()


def viewer_files(out, glb, dest, lobby, swaps=None):
    if swaps is None and VIEWER_SWAPS:
        names, a, b = VIEWER_SWAPS["names"], VIEWER_SWAPS["from"], VIEWER_SWAPS["to"]
        swaps = {s: s.replace(a, b) for s in glb_materials(glb) if s and s.replace(a, b) in names}
    return _kit_viewer_files(out, glb, dest, lobby, swaps)


assert mod_skin(["/Game/Marvel/Characters/1041/1041308/Textures/T_A", "/Game/Marvel/Characters/1041/1041308/Textures/T_B",
                 "/Game/Marvel/VFX/Characters/1041/1041001/T_C"]) == ("1041", "1041308")
assert mod_skin(["/Game/Marvel/UI/Textures/T_A"]) is None
