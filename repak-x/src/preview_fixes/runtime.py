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
    ('L.new(mix(base_col, (0.0, 0.0, 0.0), 0.25), bsdf.inputs["Base Color"])', 'L.new(mix(jelly_skin(mix, base_col, chain), (0.0, 0.0, 0.0), JELLY_BASE_DIM) if jelly(chain) else mix(painted_skin(mix, base_col, chain), (0.0, 0.0, 0.0), 0.25), bsdf.inputs["Base Color"])'),
    ('L.new(mix(mix(base_col, space, JELLY_SKY), stars, 1.0, "ADD"), bsdf.inputs["Emission Color"])', 'note_lines(chain)\n        L.new(jelly_emission(mix, base_col, space, stars, chain) if jelly(chain) else painted_emission(mix, base_col, space, stars, chain) if painted(chain) else mix(mix(base_col, space, JELLY_SKY), stars, 1.0, "ADD"), bsdf.inputs["Emission Color"])'),
    ('        bsdf.inputs["Emission Strength"].default_value = JELLY_GLOW\n', '        bsdf.inputs["Emission Strength"].default_value = JELLY_GLOW if jelly(chain) else painted_look(chain)[1] if painted(chain) else 0.55\n'),
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
    ('print("RESULT " + json.dumps({"ok": True, "renders"', 'interior_rim(renders)\nflow_frames(job, glowing)\nprint("RESULT " + json.dumps({"ok": True, "renders"'),
    # the idle the action really came from (borrowed_pose.py): a later clip that fails to load leaves the loop's `path` on it
    ('        A.animation_data.action = act\n', '        A.animation_data.action = act\n        posed_from = path\n'),
    ('    renders[view["name"]] = sc.render.filepath\n', '    renders[view["name"]] = sc.render.filepath\n    constellations(sc.render.filepath)\n    screen_rim(sc.render.filepath)\n    flow_still(sc.render.filepath)\n'),
]
if any(old not in source for old, _ in hooks):
    raise RuntimeError("This preview kit needs an update before the material fixes can be applied.")
for old, new in hooks:
    source = source.replace(old, new, 1)
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
vfx_hooks = [
    ("label, gap, top = 140, 40, 100", "label, gap, top = 92, 40, 100"),
    ("(MARGIN + 4, y + bh + 24)", "(MARGIN + 4, y + bh + 16)"),
    ("(w - MARGIN - 4, y + bh + 24)", "(w - MARGIN - 4, y + bh + 16)"),
    ("font(84", "font(55"),
    ("\nANIM = 7 ", "\nANIM = 12 "),
    ('REDO = {"sound": 4, "anim": 6}', 'REDO = {"sound": 4, "anim": 10, "vfx": 8}'),
]
# A mod packed with another project's mount point (WhiteFox_Bows/Content/Marvel/...) lists its packages under that
# folder: the kit read only Marvel/Content/ and saw none (nothing to show). Its files still sit at /Game/Marvel/...
vfx_hooks.append(('PACKAGE = re.compile(r"Marvel/Content/((?:(?!Marvel/Content/)\\S)+?)\\.uasset")', 'PACKAGE = re.compile(r"(?:Marvel|[^/\\s]+(?=/Content/Marvel/))/Content/((?:(?![^/\\s]+/Content/)\\S)+?)\\.uasset")'))
if any(old not in source for old, _ in vfx_hooks):
    raise RuntimeError("This preview kit does not support the app's VFX card size. Update it in Setup.")
for old, new in vfx_hooks:
    source = source.replace(old, new)
# A different fingerprint regenerates cached renders as they are requested. The rim setting is not part of it: changing
# the setting must not render every preview again
# (10001: painted galaxy skins, flow lines and their animation. 10002: blueprint skins, galaxy masks and sprites, borrowed
# idles, no shell outline: cached previews and before pictures render again once. 10003: mesh swaps fitted to another
# body keep their own proportions in the lobby pose, borrowed_pose.py)
source = re.sub(r"(?m)^VERSION = (\d+)", lambda m: "VERSION = " + str(int(m[1]) + 10003), source, count=1)
globals()["__file__"] = str(original)
exec(compile(source, str(original), "exec"), globals())
