"""Run a preview kit with app-owned renderer fixes, leaving the installed kit unchanged."""
import os
import re
from pathlib import Path

kit = Path(os.environ["REPAKXTRA_KIT"])
rim_on = os.environ.get("REPAKXTRA_RIM", "0") == "1"   # Settings > Previews, off unless switched on
runtime = Path(__file__).resolve().parent
original = kit / "previews" / "mod_previews.py"
renderer = kit / "previews" / "render_preview.py"
source = renderer.read_text(encoding="utf-8-sig")
marker = "# Lobby and gameplay materials share names"
mesh_path = 'str(Path(__file__).resolve().parents[1] / "meshes")'
if marker not in source or mesh_path not in source:
    raise RuntimeError("This preview kit needs an update before the renderer fixes can be applied.")
hooks = [   # (the kit's line, with the fix added): the slot's material, which translucent slots stay hidden, the glow pass, the rim light and its panels, the final result, each saved render
    ('{"galaxy": galaxy_material, "torch": torch_body_material}.get(kind, game_material)(name, info, chain)', "fix_material(kind, name, info, chain)"),
    ("if translucent or empty or effect or", "if (translucent and not layer_kind(name, info, chain)) or empty or effect or"),
    ("# Emission only: every surface black and matte", "drop_added_glow()\n# Emission only: every surface black and matte"),
    # Jelly galaxy skins: the lobby's navy, stars and lines only on a flat-colored one (jelly(), cosmic_tuning.py), the
    # kit's own values on a painted one (King of the Cosmos keeps its green, blue and purple)
    # A galaxy with black colors (Celestial Soldier's hair) is stars over the painted color, not black space
    ('surface = mix(base_col if base_col is not None else (0.05, 0.06, 0.1), (0.004, 0.005, 0.01), mask if mask is not None else 1.0)', 'surface = mix(base_col if base_col is not None else (0.05, 0.06, 0.1), (0.004, 0.005, 0.01), mask if mask is not None else 1.0)\n        surface = base_col if base_col is not None and dark_space(chain) else surface'),
    ('L.new(mix(base_col, (0.0, 0.0, 0.0), 0.25), bsdf.inputs["Base Color"])', 'L.new(mix(jelly_skin(mix, base_col, chain), (0.0, 0.0, 0.0), JELLY_BASE_DIM) if jelly(chain) else mix(base_col, (0.0, 0.0, 0.0), 0.25), bsdf.inputs["Base Color"])'),
    ('L.new(mix(mix(base_col, space, JELLY_SKY), stars, 1.0, "ADD"), bsdf.inputs["Emission Color"])', 'note_lines(chain)\n        L.new(jelly_emission(mix, base_col, space, stars, chain) if jelly(chain) else mix(mix(base_col, space, JELLY_SKY), stars, 1.0, "ADD"), bsdf.inputs["Emission Color"])'),
    ('        bsdf.inputs["Emission Strength"].default_value = JELLY_GLOW\n', '        bsdf.inputs["Emission Strength"].default_value = JELLY_GLOW if jelly(chain) else 0.55\n'),
    ('        bsdf.inputs["Roughness"].default_value = 0.22\n', '        bsdf.inputs["Roughness"].default_value = jelly_rough(chain)\n'),
    ('        bsdf.inputs["Coat Weight"].default_value = 0.25\n', '        bsdf.inputs["Coat Weight"].default_value = JELLY_COAT if jelly(chain) else 0.25\n        bsdf.inputs["Specular Tint"].default_value = JELLY_SPEC_TINT if jelly(chain) else (1.0, 1.0, 1.0, 1.0)\n'),
    ('        bsdf.inputs["Specular IOR Level"].default_value = 0.3   # stronger', '        bsdf.inputs["Specular IOR Level"].default_value = jelly_spec(chain)   # stronger'),
    ('(("StarTex3", "StarTex3_Color", 2.0), ("StarTex4", "StarTex4_Color", 3.0))', '(("StarTex3", "StarTex3_Color", 2.0 * star_scale(chain)), ("StarTex4", "StarTex4_Color", 3.0 * star_scale(chain)))'),
    ('(("StarTex1", max(1.0, 0.35 * float(S.get("StarTex1_Density", 6.0)))), ("StarTex2", 1.3))', '(("StarTex1", sparkle_tiles(chain, "StarTex1", max(1.0, 0.35 * float(S.get("StarTex1_Density", 6.0))) * sparkle_scale(chain))), ("StarTex2", sparkle_tiles(chain, "StarTex2", 1.3)))'),
    ('        tinted = mix(sparkle, vec(chain, key + "_Color", (0.6, 0.8, 1.0)), 1.0, "MULTIPLY")', '        tinted = mix(sparse_cells(N, L, win, mix, sparkle, key, tile, chain), vec(chain, key + "_Color", (0.6, 0.8, 1.0)), 1.0, "MULTIPLY")'),
    ('            stars = mix(stars, layer, 0.45, "ADD")', '            stars = mix(stars, dust_color(mix, layer, chain), 0.45 * dust_gain(chain), "ADD")'),
    ('        stars = mix(stars, tinted, 0.9, "ADD")', '        stars = mix(stars, tinted, 0.9 * sparkle_gain(chain), "ADD")'),
    ('rim = sun("rim", 7.0, (0.75, 0.92, 1.0), 2)', 'rim = sun("rim", RIM_SUN if RIM_ON else 7.0, RIM_SUN_COLOR if RIM_ON else (0.75, 0.92, 1.0), 2)\nif RIM_ON:\n    studio_lights()'),
    ('    rim.rotation_euler = aim(-d * 0.9 + rt * 0.75 + Vector((0, 0, 0.25)))\n', '    rim.rotation_euler = aim(-d * 0.9 + rt * 0.75 + Vector((0, 0, 0.25)))\n    place_studio(STUDIO, d, rt)\n'),
    # A painted jelly skin (King of the Cosmos, Cosmic Kumiho's body): unlit, as Rotate in 3D draws it (cosmic_tuning.py viewer_jelly)
    ('        bsdf.inputs["Coat Tint"].default_value = (0.75 + 0.25 * rim[0] * k, 0.75 + 0.25 * rim[1] * k, 0.75 + 0.25 * rim[2] * k, 1)\n',
     '        bsdf.inputs["Coat Tint"].default_value = (0.75 + 0.25 * rim[0] * k, 0.75 + 0.25 * rim[1] * k, 0.75 + 0.25 * rim[2] * k, 1)\n        viewer_jelly(m, bsdf, N, L, mix, screen, tiles, base_col, stars, mask, chain)\n'),
    ('print("RESULT " + json.dumps({"ok": True, "renders"', 'interior_rim(renders)\nflow_frames(job, glowing)\nprint("RESULT " + json.dumps({"ok": True, "renders"'),
    # the idle the action really came from (borrowed_pose.py): a later clip that fails to load leaves the loop's `path` on it
    ('        A.animation_data.action = act\n', '        A.animation_data.action = act\n        posed_from = path\n'),
    ('    renders[view["name"]] = sc.render.filepath\n', '    renders[view["name"]] = sc.render.filepath\n    constellations(sc.render.filepath)\n    screen_rim(sc.render.filepath)\n    flow_still(sc.render.filepath)\n'),
]
if any(old not in source for old, _ in hooks):
    raise RuntimeError("This preview kit needs an update before the material fixes can be applied.")
for old, new in hooks:
    source = source.replace(old, new, 1)
# The pose is the lobby idle's first frame: only each bone's first key is read from the file and made into curves (a
# bone's other 350 keys took about half a second of every character preview to parse and build, never used). The
# reader is put back right after, so a dance rendered next in the same Blender reads its clips whole. A kit without
# these exact lines, or an older animation file format (its own reader), imports the whole idle, as before.
pose_import = "            act, _ = UEFormatImport(UEAnimOptions(scale_factor=1, override_skeleton=A, import_curves=False)).import_file_with_dto(path)\n"
pose_loop = "    A.animation_data_create()\n    for path in anims:\n"
if source.count(pose_import) == 1 and source.count(pose_loop) == 1:
    source = source.replace(pose_import, "            act, _ = pose_import(path)\n", 1)
    source = source.replace(pose_loop, '''    import io_scene_ueformat.importer.deserialize.anim as _da

    def pose_import(path):
        whole = _da.read_track

        def first_keys(ar):
            def one(read, size):   # the first key, the rest stepped over (a key is its frame and 3 or 4 floats)
                n = ar.read_int()
                if n <= 0:
                    return []
                key = read(ar)
                ar.skip((n - 1) * size)
                return [key]
            return _da.TrackDto(name=ar.read_fstring(), position_keys=one(_da.read_vector_key, 16),
                                rotation_keys=one(_da.read_quat_key, 20), scale_keys=one(_da.read_vector_key, 16))
        _da.read_track = first_keys
        try:
            return UEFormatImport(UEAnimOptions(scale_factor=1, override_skeleton=A, import_curves=False)).import_file_with_dto(path)
        finally:
            _da.read_track = whole
''' + pose_loop, 1)
fix = f"RIM_ON = {rim_on}\n" + "\n".join(
    (runtime / f).read_text(encoding="utf-8")
    for f in ("galactic_mane.py", "material_rim.py", "translucent_layers.py", "screen_rim.py", "studio_lights.py", "cosmic_tuning.py", "flow_anim.py", "borrowed_pose.py"))
# A skin on another skin's mesh (skin_blueprint.py): its blueprint's material in each slot, by name (an empty entry keeps
# the mesh's). M_Hide, the game's invisible material, hides its slot: drawn, it was a plain gray shape
slots = ('_names = job.get("slot_materials") or []\n'
         'for _i, _s in enumerate(M.material_slots):\n'
         '    _n = _names[_i] if _i < len(_names) and _names[_i] else (_s.material.name if _s.material else None)\n'
         '    if _n == "M_Hide":\n'
         '        _s.material = None\n'
         '    elif _i < len(_names) and _names[_i]:\n'
         '        _s.material = bpy.data.materials.get(_n) or bpy.data.materials.new(_n)\n')
source = source.replace(marker, fix + '\nfix_lobby_mane(A, job)\nborrowed_pose(A, job, globals().get("posed_from"), posed)\n' + slots + 'bpy.context.view_layer.update()\n\n' + marker, 1)
source = source.replace(mesh_path, repr(str(kit / "meshes")), 1)
patched = runtime / "render_preview.py"
if not patched.exists() or patched.read_text(encoding="utf-8") != source:
    patched.write_text(source, encoding="utf-8")

source = original.read_text(encoding="utf-8-sig")
render_path = 'KIT / "previews" / "render_preview.py"'
if render_path not in source:
    raise RuntimeError("This preview kit does not support the app's renderer fixes. Update it in Setup.")
source = source.replace(render_path, "Path(" + repr(str(patched)) + ")", 1)
# Glowing flow lines also become an animated <key>.webp (flow_compose.py), from the frames flow_anim.py renders
compose = '        alpha = ImageChops.lighter(alpha, glow.convert("L"))\n    rgb.putalpha(alpha)\n    sheet([rgb], out_png)\n    return True\n'
if compose not in source:
    raise RuntimeError("This preview kit does not support the app's animated glow. Update it in Setup.")
source = source.replace(compose, compose.replace("    return True\n", "    flow_anim(str(prefix), out_png)\n    return True\n"), 1)
# Before the main guard: appended after it, the run started before flow_anim was defined ("name 'flow_anim' is not defined")
main_guard = '\nif __name__ == "__main__":'
if source.count(main_guard) != 1:
    raise RuntimeError("This preview kit does not support the app's animated glow. Update it in Setup.")
source = source.replace(main_guard, (runtime / "flow_compose.py").read_text(encoding="utf-8") + "\n" + main_guard, 1)
sound_list = '    files = [f.strip() for f in run([REPAK, "list", pak], 120).stdout.splitlines()]'
if source.count(sound_list) != 1:
    raise RuntimeError("This preview kit does not support the app's sound reader. Update it in Setup.")
source = source.replace(sound_list, "    pak = sound_pak(work, cfg, pak)\n" + sound_list, 1)
source = source.replace(main_guard, (runtime / "sound_pak.py").read_text(encoding="utf-8") + "\n" + main_guard, 1)
# Generator fixes also made in the kit's source (tools\previews\mod_previews.py, kit 18 on): each one is skipped when
# the kit already has it. 1: a mod's own skin mesh names the skin it renders (Magik PJ and Jacked Void Panther ship other
# skins' textures, and the game's mesh of that skin rendered instead). 2: a skin table read under stale mappings is a
# retried failure, not a cached "nothing to show". 3: a dance with its music bank in its PAK gets that emote's sound
anim_sound = '''                try:   # a dance with its music bank in its .pak: its sound (a failure keeps the dance, without it)
                    if len(EXTRA.get("emotes") or []) == 1 and not EXTRA.get("form_emotes") and pak.exists():
                        render_sound(work, cfg, pak, work / "sound.png", emote=EXTRA["emotes"][0],
                                     own=[p.rsplit("/", 1)[1] for p in pkgs if p.startswith("/Game/Marvel/Audio/")])
                except Exception as e:
                    print(f"# {key}: its emote sound failed: {e}", file=sys.stderr, flush=True)
'''
sound_copy = '''                if kind == "sound":   # its emote sounds replace the last ones (a failed render keeps those)
                    shutil.rmtree(out_dir / f"{key}.audio", ignore_errors=True)
                    if EXTRA.get("emote_sounds"):
                        shutil.copytree(work / "emote_sounds", out_dir / f"{key}.audio")
'''
no_blender = '''                kind = "error: Blender not found" if not bl else "error: the character render failed"
'''
kit_fixes = [
    ('    looks = [m.groups() for p in chars if SKIN_MESH.match(p)', '    looks = [m.groups() for p in (own or chars) if SKIN_MESH.match(p)'),
    ('    edits = table_edits(s[0], u[0], s[1], u[1])\n',
     '    edits = table_edits(s[0], u[0], s[1], u[1])\n    if len(edits) != 1 and not all(m for m, _ in rows.values()):\n'
     '        raise RuntimeError("its skin table could not be read: the preview mappings are older than the game")\n'),
    ("def render_sound(work, cfg, pak, out_png, most=5):", "def render_sound(work, cfg, pak, out_png, most=5, emote=None, own=()):"),
    ("    names = {bnk.fnv1(n): n for n in wwise_names(work, cfg, banks)}", "    names = {bnk.fnv1(n): n for n in [*wwise_names(work, cfg, banks), *own]}"),
    ("                if (emote := emote_of_event(names[oid])) and (var or lay):\n", "                if (e := emote_of_event(names[oid]) or (emote if names[oid] in own else None)) and (var or lay):\n"),
    ("                    picks.setdefault(emote, []).append((rank, lay + var[:1], blob))", "                    picks.setdefault(e, []).append((rank, lay + var[:1], blob))"),
    ('                kind = "anim"\n', '                kind = "anim"\n' + anim_sound),
    (sound_copy, ""),
    # The game's own banks in a config of their own: the exporter kept running for config.json has the mod mounted
    ('''        (work / "config.json").write_text(json.dumps(cfg), encoding="utf-8")   # no extra_paks: the vanilla files
        export(work, steps, name="wwise", out=WWISE)''', '''        (work / "game.json").write_text(json.dumps(cfg), encoding="utf-8")
        export(work, steps, name="wwise", out=WWISE, config="game.json")'''),
    (no_blender, no_blender + '''            if kind in ("sound", "anim"):   # its emote sounds replace the last ones (a failed render keeps those)
                shutil.rmtree(out_dir / f"{key}.audio", ignore_errors=True)
                if EXTRA.get("emote_sounds"):
                    shutil.copytree(work / "emote_sounds", out_dir / f"{key}.audio")
'''),
]
# A kit whose dance sound step is not best-effort yet (an early kit 18 build): wrapped on its own
bare_sound = """                if len(EXTRA.get("emotes") or []) == 1 and pak.exists():   # a dance with its music bank in its .pak: its sound
                    render_sound(work, cfg, pak, work / "sound.png", emote=EXTRA["emotes"][0],
                                 own=[p.rsplit("/", 1)[1] for p in pkgs if p.startswith("/Game/Marvel/Audio/")])
"""
if bare_sound in source:
    source = source.replace(bare_sound, anim_sound, 1)
if "out_png, most=5, emote=None, own=()):" not in source:   # kit 18 and newer ship all three
    if any(source.count(old) != 1 for old, _ in kit_fixes):
        raise RuntimeError("This preview kit does not support the app's preview fixes. Update it in Setup.")
    for old, new in kit_fixes:
        source = source.replace(old, new, 1)
# One animated preview per emote (emote_split.py): the run keeps and reports each emote's <key>@n.webp
emote_hooks = [
    ("            seqs = [] if target else anim_sequences(pkgs)", "            target, seqs = emote_first(target, pkgs)"),
    ("drop_extras(out_dir, key, 0)   # a character mod's other forms", "drop_extras(out_dir, key, anim_forms(kind))   # a character mod's other forms"),
    ('    for f in sorted(out_dir.glob(f"{key}@*.png")):\n', '    for f in sorted({f.stem: f for f in [*out_dir.glob(f"{key}@*.png"), *out_dir.glob(f"{key}@*.webp")]}.values()):\n'),
    ('                kind = "anim"\n', '                kind = "anim"\n                ui_slide(work, pkgs, out_dir, key)\n'),
]
if any(source.count(old) != 1 for old, _ in emote_hooks):
    raise RuntimeError("This preview kit does not support one preview per emote. Update it in Setup.")
for old, new in emote_hooks:
    source = source.replace(old, new, 1)
source = source.replace(main_guard, (runtime / "emote_split.py").read_text(encoding="utf-8") + "\n" + main_guard, 1)
job_slots = '"whole": not SKIN_MESH.match(target)}'
if source.count(job_slots) != 1:
    raise RuntimeError("This preview kit does not support skins on another skin's mesh. Update it in Setup.")
source = source.replace(job_slots, '"whole": not SKIN_MESH.match(target), "slot_materials": SLOTS.get(model.stem), "flow": not QUIET}', 1)
source = source.replace(main_guard, (runtime / "skin_blueprint.py").read_text(encoding="utf-8") + "\n" + main_guard, 1)
source = source.replace(main_guard, (runtime / "app_usmap.py").read_text(encoding="utf-8") + "\n" + main_guard, 1)
# Speed (speed.py): one game-only exporter per run, a VFX card's game colors cached per game version, a numpy outline
vfx_vanilla = '''    cfg = json.loads((work / "config.json").read_text(encoding="utf-8"))
    cfg.pop("extra_paks", None)
    (work / "vanilla.json").write_text(json.dumps(cfg), encoding="utf-8")
    export(work, [{"op": "export", "mode": "json", "paths": mis}], name="vfx_vanilla", out=work / "vfx_vanilla", config="vanilla.json")
    bands = palette(changed_colors(mi_vectors(work / "vfx_raw"), mi_vectors(work / "vfx_vanilla")))'''
if source.count(vfx_vanilla) != 1:
    raise RuntimeError("This preview kit does not support the app's faster previews. Update it in Setup.")
source = source.replace(vfx_vanilla, '    bands = palette(changed_colors(mi_vectors(work / "vfx_raw"), vanilla_vectors(work, mis)))', 1)
source = source.replace(main_guard, (runtime / "speed.py").read_text(encoding="utf-8") + "\n" + main_guard, 1)
# A loadout's encrypted mods are unpacked at once before mount() copies them (speed.py unpack_ahead). A kit whose mount()
# reads differently keeps its own one-by-one unpack
mount_start = '    stage("mount")\n    (work / "paks").mkdir(parents=True)\n'
if source.count(mount_start) == 1:
    source = source.replace(mount_start, mount_start + "    unpack_ahead(work, cfg, entries)\n", 1)
    # a set with an encrypted mod mounts every mod repacked together (speed.py unpack_ahead): mount() takes each from there
    for old, new in (("        if obfuscated(utoc):\n", "        if obfuscated(utoc) or (TOGETHER[0] and utoc):\n"),
                     ('            repacked = WORK.parent / "cache" / "repacked" / hashlib.sha1(signature(utoc, ucas, pak).encode()).hexdigest()[:16]\n',
                      "            repacked = repack_dir(entries, utoc, ucas, pak)\n")):
        if source.count(old) == 1:
            source = source.replace(old, new, 1)
# The animation lives beside its still: a character's cleanup (keep_only .png) keeps a .webp written after the .png (a flow
# animation; an older animation mod's .webp is older and still goes), and a dropped form or an empty loadout takes its .webp too
cleanup = [
    ("        if x != ext:\n", "        if x != ext and not (ext == \".png\" and x == \".webp\" and flow_newer(out_dir, key)):\n"),
    ('    for f in out_dir.glob(f"{key}@*.png"):\n', '    for f in [*out_dir.glob(f"{key}@*.png"), *out_dir.glob(f"{key}@*.webp")]:\n'),
    ("            png.unlink(missing_ok=True)\n", "            png.unlink(missing_ok=True)\n            png.with_suffix(\".webp\").unlink(missing_ok=True)\n"),
]
if any(source.count(old) != 1 for old, _ in cleanup):
    raise RuntimeError("This preview kit does not support the app's animated glow. Update it in Setup.")
for old, new in cleanup:
    source = source.replace(old, new, 1)
# The "before" pictures (<key>.vanilla.png) are cached per look: the rim setting is part of that look, so a vanilla made under
# the other setting is rendered again the next time a preview of that hero is generated. Mod previews keep their fingerprint,
# so nothing else is rendered again by the setting.
vanilla_dir = 'f"v{VERSION}-{game_stamp(cfg)}"'
if source.count(vanilla_dir) != 2:
    raise RuntimeError("This preview kit does not support the app's before pictures. Update it in Setup.")
source = source.replace(vanilla_dir, 'f"v{VERSION}' + ("r" if rim_on else "") + '-{game_stamp(cfg)}"')
# VFX palette cards use smaller labels and matching spacing. ANIM 9 retries cached empty results now that stripped
# sound PAKs can be read. ANIM 10 renders animation previews again, one per emote and the
# mod's UI after them (emote_split.py). ANIM 11 retries "nothing to show" once (skin_blueprint.py). ANIM 12 retries it once
# more with the app's newer mappings (app_usmap.py: skin table mods read under stale mappings). Existing successful previews keep their own REDO thresholds.
# ANIM 13 with REDO sound 13: cached sound cards render once more at the VFX text size (each "nothing to show" retries once too).
vfx_hooks = [
    ("label, gap, top = 140, 40, 100", "label, gap, top = 92, 40, 100"),
    ("(MARGIN + 4, y + bh + 24)", "(MARGIN + 4, y + bh + 16)"),
    ("(w - MARGIN - 4, y + bh + 24)", "(w - MARGIN - 4, y + bh + 16)"),
    ("font(84", "font(55"),
    ("\nANIM = 7 ", "\nANIM = 14 "),   # 14 with REDO anim 14: cached animation previews render once more, at 60 frames a second
    ('REDO = {"sound": 4, "anim": 6}', 'REDO = {"sound": 13, "anim": 14, "vfx": 8}'),
    # sound cards: the VFX labels' size (55 px, weight 560), the speaker icon and spacing scaled to match
    ("font(52, 520)", "font(55, 560)"),
    ("icon_image(VOLUME_ICON, 48,", "icon_image(VOLUME_ICON, 51,"),
    ("(MARGIN, y + 11)", "(MARGIN, y + 12)"),
    ("(MARGIN + 68, y)", "(MARGIN + 72, y)"),
    ("w - 2 * MARGIN - 68", "w - 2 * MARGIN - 72"),
    ("step = 104   # one line per sound", "step = 110   # one line per sound"),
]
# A mod packed with another project's mount point (WhiteFox_Bows/Content/Marvel/...) lists its packages under that
# folder: the kit read only Marvel/Content/ and saw none (nothing to show). Its files still sit at /Game/Marvel/...
vfx_hooks.append(('PACKAGE = re.compile(r"Marvel/Content/((?:(?!Marvel/Content/)\\S)+?)\\.uasset")', 'PACKAGE = re.compile(r"(?:Marvel|[^/\\s]+(?=/Content/Marvel/))/Content/((?:(?![^/\\s]+/Content/)\\S)+?)\\.uasset")'))
if any(old not in source for old, _ in vfx_hooks):
    raise RuntimeError("This preview kit does not support the app's VFX card size. Update it in Setup.")
for old, new in vfx_hooks:
    source = source.replace(old, new)
# Rotate in 3D's lobby look (viewer_lobby.py): each slot's master defaults, the skin's light rig, its show rim light, its
# lobby idle's sounds, model.json v2 (older exports are made again), and the Default skin (--viewer --target). A kit that
# already has a hook's change skips it; the appended functions replace a kit's own copies.
viewer_hooks = [
    ('            info["Scalars"], info["Vectors"] = chain.get("scalars", {}), chain.get("vectors", {})',
     '            _d = chain.get("defaults") or {}\n            info["Scalars"], info["Vectors"] = {**_d.get("scalars", {}), **chain.get("scalars", {})}, {**_d.get("vectors", {}), **chain.get("vectors", {})}'),
    ('    model = {"v": 1, "glb": "model.glb", "mesh": lobby,', '    model = {"v": 2, "glb": "model.glb", "mesh": lobby,'),
    ('json.dumps({**base["model"], "base": bkey,', 'json.dumps({**base["model"], "v": 2, "base": bkey,'),
    ('    ap.add_argument("--mods", required=True,', '    ap.add_argument("--target", help="with --viewer and --set: the game skin of this mesh, no mod")\n    ap.add_argument("--mods", required="--target" not in sys.argv,'),
    ('        viewer(a, out_dir) if a.viewer else', '        (viewer_default(a, out_dir) if getattr(a, "target", None) else viewer(a, out_dir)) if a.viewer else'),
    # the 3D export takes a mod's effect materials too (a VFX mod's recolored lobby fires, Devil Dinosaur's teal to orange):
    # only those named in a mesh slot are read, so no other effect gets in
    ('    own_mi = [p for p in pkgs if p.startswith("/Game/Marvel/Characters/") and re.search(r"/MI_[^/]+$", p)]\n    own_tex = [p for p in pkgs if p.startswith("/Game/Marvel/Characters/") and re.search(r"/T_[^/]+$", p)]\n    # A texture or material mod keeps',
     '    own_mi = [p for p in pkgs if p.startswith(("/Game/Marvel/Characters/", "/Game/Marvel/VFX/")) and re.search(r"/MI_[^/]+$", p)]\n    own_tex = [p for p in pkgs if p.startswith(("/Game/Marvel/Characters/", "/Game/Marvel/VFX/")) and re.search(r"/T_[^/]+$", p)]\n    # A texture or material mod keeps'),
    # a mod's own materials can have any name (Skirtt, MeshLace): read every material file named like a mesh slot, not
    # only MI_ ones (they were missing and drew white)
    ('    for f in sorted(content.rglob("MI_*.json")):\n        if f.name.endswith(".chain.json"):',
     '    _slots = set(glb_materials(glb))\n    for f in sorted(p for p in content.rglob("*.json") if p.name.startswith("MI_") or p.stem in _slots):\n        if f.name.endswith(".chain.json"):'),
    # a slot whose material the glTF export could not load (a mod's own, cooked against placeholders of another class) is
    # named after its material, which is exported and walked like a mod's instances (viewer_lobby.py named_slots)
    ('    shutil.copyfile(glb, tmp / "model.glb")\n    slots, textures, missing = viewer_files(out, glb, tmp, lobby.endswith("_Lobby"))',
     '    named_slots(work, out, glb, lobby, pkgs, tmp)\n    shutil.copyfile(glb, tmp / "model.glb")\n    slots, textures, missing = viewer_files(out, glb, tmp, lobby.endswith("_Lobby"))'),
    ('for f in content.rglob("MI_*.json")\n              if not f.name.endswith(".chain.json")}',
     'for f in content.rglob("*.json")\n              if (f.name.startswith("MI_") or f.stem in SLOT_MATERIALS) and not f.name.endswith(".chain.json")}'),
]
if "viewer_lobby(work, target, tmp)" not in source:
    viewer_hooks += [
        ('        return place_viewer(tmp, dest)', '        viewer_lobby(work, target, tmp)\n        return place_viewer(tmp, dest)'),
        ('    (tmp / "model.json").write_text(json.dumps({**model, **extra}, indent=1), encoding="utf-8")\n',
         '    (tmp / "model.json").write_text(json.dumps({**model, **extra}, indent=1), encoding="utf-8")\n    viewer_lobby(work, target, tmp)\n'),
    ]
for old, new in viewer_hooks:
    if source.count(old) == 1:
        source = source.replace(old, new, 1)
source = source.replace(main_guard, (runtime / "viewer_lobby.py").read_text(encoding="utf-8") + "\n" + main_guard, 1)
# "Nothing to show" for a mod that had a preview from the same files (same signature) is a failed try, not an answer:
# its preview, before picture, and index entry stay and the mod is reported as failed, so no "none" is cached over it and
# Regenerate tries again (seen twice on an unchanged skin table mod). A kit without this exact line runs as it is.
kept_none = '        index[key] = {"sig": sig, "kind": kind, "seconds": round(time.time() - t0, 1), "anim": ANIM,\n'
if source.count(kept_none) == 1:
    source = source.replace(kept_none, (
        '        kept_old = kind == "none" and sig is not None and index.get(key, {}).get("sig") == sig and index.get(key, {}).get("kind") in GOOD\n'
        '        if kept_old:\n'
        '            print(f"# {key}: nothing to show this time, its preview from the same files is kept (Regenerate tries again)", file=sys.stderr, flush=True)\n'
        '            kind = "kept"\n'
        + kept_none.replace('index[key] = {', 'index[key] = index[key] if kept_old else {', 1)), 1)
# White Fox's fox form (her ultimate, form 10601) gets no picture of its own beside her (cable, 2026-11-12): it is
# rendered only when it is the one form a mod changes. A kit without this exact line keeps both.
fox_form = '    return [min([p for p in ps if not p.endswith("_Lobby")] or ps, key=len) for _, ps in sorted(forms.items())]'
if source.count(fox_form) == 1:
    source = source.replace(fox_form, fox_form.replace("for _, ps in sorted(forms.items())]", 'for f, ps in sorted(forms.items()) if f != "10601" or len(forms) == 1]'), 1)
# Animated previews at 60 frames a second (15 before). The game's clips are keyed at 30, so a sample between two keys
# blends both (the curve read at a subframe), where the kit took the nearest key. Four times the frames in about the old
# render time: each frame's edges get one FXAA pass instead of five samples (the outline covers the edges). A kit
# without these exact lines keeps its 15.
anim_render = kit / "previews" / "render_anim.py"
anim_hooks = [
    (mesh_path, repr(str(kit / "meshes"))),   # the copy runs from this folder: its mesh reader is still the kit's
    ("    samples += [(act, min(n - 1, round(i * fps / FPS))) for i in range(shown)]", "    samples += [(act, min(n - 1.0, i * fps / FPS)) for i in range(shown)]"),
    ("    sc.frame_set(frame)\n", "    sc.frame_set(int(frame), subframe=frame - int(frame))\n"),
    ('sc.display.render_aa = "5"', 'sc.display.render_aa = "FXAA"'),
    # the camera is framed from the poses the 15 a second render sampled, not all four times as many (a skinned mesh read each)
    ("for act, frame in samples:\n    pose(act, frame)\n    ev = M.evaluated_get(", "for act, frame in samples[::max(1, round(FPS / 15))]:\n    pose(act, frame)\n    ev = M.evaluated_get("),
    # frames are read once and deleted: raw TGA, a third of a PNG's write time even uncompressed
    ('sc.render.image_settings.file_format = "PNG"', 'sc.render.image_settings.file_format = "TARGA_RAW"'),
    # Each clip in one animation render call over a remapped timeline, instead of a render call per frame. Measured on
    # 279 frames: posing and rendering 10.9 s as separate calls with PNGs, 4.7 s this way, the frames the same but for
    # 0.002% of pixels. A clip whose sampling no frame map can express keeps the call per frame
    ("for i, (act, frame) in enumerate(samples):\n    pose(act, frame)\n    sc.render.filepath = str(out_dir / f\"f_{i:04d}.png\")\n    bpy.ops.render.render(write_still=True)\n",
     "_runs = []\n"
     "for _i, (_act, _f) in enumerate(samples):   # one run per clip, in order\n"
     "    if _runs and _runs[-1][0] is _act:\n"
     "        _runs[-1][2].append(_f)\n"
     "    else:\n"
     "        _runs.append((_act, _i, [_f]))\n"
     "for _act, _base, _fs in _runs:\n"
     "    _step = _fs[1] - _fs[0] if len(_fs) > 1 else 0\n"
     "    _ratio = __import__(\"fractions\").Fraction(_step).limit_denominator(900) if _step > 0 else None\n"
     "    # every sample on the mapped timeline (the clip's last frame held past its end), not only the first two\n"
     "    if _ratio and _ratio.numerator <= 900 and all(abs(_f - min(_fs[-1], _k * float(_ratio))) < 0.02 for _k, _f in enumerate(_fs)):\n"
     "        pose(_act, 0)\n"
     "        sc.render.frame_map_old, sc.render.frame_map_new = _ratio.numerator, _ratio.denominator\n"
     "        sc.frame_start, sc.frame_end = 0, len(_fs) - 1\n"
     "        sc.render.filepath = str(out_dir / f\"c{_base:04d}_####\")\n"
     "        bpy.ops.render.render(animation=True)\n"
     "        sc.render.frame_map_old = sc.render.frame_map_new = 100\n"
     "        for _k in range(len(_fs)):   # the clip's frames take their place in the whole\n"
     "            (out_dir / f\"c{_base:04d}_{_k:04d}.tga\").rename(out_dir / f\"f_{_base + _k:04d}.tga\")\n"
     "    else:\n"
     "        for _k, _f in enumerate(_fs):\n"
     "            pose(_act, _f)\n"
     "            sc.render.filepath = str(out_dir / f\"f_{_base + _k:04d}.tga\")\n"
     "            bpy.ops.render.render(write_still=True)\n"),
]
# their frames get their rim on threads and are encoded in chunks on threads (speed.py write_webp)
anim_save = [
    ('    frames = sorted(frames_dir.glob("f_*.png"))\n', '    frames = sorted(frames_dir.glob("f_*.*"))\n'),   # .tga now
    ("    save_webp([outlined(Image.open(f).convert(\"RGBA\")) for f in frames], out_webp)\n", "    save_webp(on_threads(lambda f: outlined(Image.open(f).convert(\"RGBA\")), frames), out_webp)\n"),
    ("    frames[0].save(tmp, save_all=True, append_images=frames[1:], duration=round(1000 / ANIM_FPS), loop=0, quality=80, method=2, kmax=1)\n", "    write_webp(frames, tmp, round(1000 / ANIM_FPS))\n"),
]
if all(source.count(old) == 1 for old, _ in anim_save):
    for old, new in anim_save:
        source = source.replace(old, new, 1)
anim_fps = "ANIM_SIZE, ANIM_FPS, ANIM_SECONDS, ANIM_SHORTEST = (512, 724), 15, 6.0, 0.3"
anim_path = 'KIT / "previews" / "render_anim.py"'
anim_source = anim_render.read_text(encoding="utf-8-sig") if anim_render.exists() else ""
if all(anim_source.count(old) == 1 for old, _ in anim_hooks) and source.count(anim_fps) == 1 and source.count(anim_path) == 1:
    for old, new in anim_hooks:
        anim_source = anim_source.replace(old, new, 1)
    patched_anim = runtime / "render_anim.py"
    if not patched_anim.exists() or patched_anim.read_text(encoding="utf-8") != anim_source:
        patched_anim.write_text(anim_source, encoding="utf-8")
    source = source.replace(anim_fps, anim_fps.replace("15, 6.0", "60, 6.0"), 1).replace(anim_path, "Path(" + repr(str(patched_anim)) + ")", 1)
# Blender's render server is the one the last run left open, when a keeper still has it (speed.py kept, keeper.py). A
# kit without this exact line starts its own each run, as before.
open_blender = '''        cls.proc = subprocess.Popen([str(bl), "-b", "--factory-startup", "--python", str(BLENDER_SERVER)],
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                    encoding="utf-8", errors="replace", creationflags=NO_WINDOW,
                                    env={**os.environ, "REPAKXTRA_STAGES": "1"})
'''
if source.count(open_blender) == 1:
    source = source.replace(open_blender, '        cls.proc = kept([str(bl), "-b", "--factory-startup", "--python", str(BLENDER_SERVER)], {"REPAKXTRA_STAGES": "1"})\n', 1)
# A different fingerprint regenerates cached renders as they are requested. The rim setting is not part of it: changing
# the setting must not render every preview again
# (10001: painted galaxy skins, flow lines and their animation. 10002: blueprint skins, galaxy masks and sprites, borrowed
# idles, no shell outline: cached previews and before pictures render again once. 10003: mesh swaps fitted to another
# body keep their own proportions in the lobby pose, borrowed_pose.py)
source = re.sub(r"(?m)^VERSION = (\d+)", lambda m: "VERSION = " + str(int(m[1]) + 10003), source, count=1)
globals()["__file__"] = str(original)
exec(compile(source, str(original), "exec"), globals())
