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
    ('L.new(mix(base_col, (0.0, 0.0, 0.0), 0.25), bsdf.inputs["Base Color"])', 'L.new(mix(jelly_skin(mix, base_col, chain), (0.0, 0.0, 0.0), JELLY_BASE_DIM) if jelly(chain) else mix(base_col, (0.0, 0.0, 0.0), 0.25), bsdf.inputs["Base Color"])'),
    ('L.new(mix(mix(base_col, space, JELLY_SKY), stars, 1.0, "ADD"), bsdf.inputs["Emission Color"])', 'note_lines(chain)\n        L.new(jelly_emission(mix, base_col, space, stars, chain) if jelly(chain) else mix(mix(base_col, space, JELLY_SKY), stars, 1.0, "ADD"), bsdf.inputs["Emission Color"])'),
    ('        bsdf.inputs["Emission Strength"].default_value = JELLY_GLOW\n', '        bsdf.inputs["Emission Strength"].default_value = JELLY_GLOW if jelly(chain) else 0.55\n'),
    ('        bsdf.inputs["Roughness"].default_value = 0.22\n', '        bsdf.inputs["Roughness"].default_value = JELLY_ROUGH if jelly(chain) else 0.22\n'),
    ('        bsdf.inputs["Coat Weight"].default_value = 0.25\n', '        bsdf.inputs["Coat Weight"].default_value = JELLY_COAT if jelly(chain) else 0.25\n        bsdf.inputs["Specular Tint"].default_value = JELLY_SPEC_TINT if jelly(chain) else (1.0, 1.0, 1.0, 1.0)\n'),
    ('        bsdf.inputs["Specular IOR Level"].default_value = 0.3   # stronger', '        bsdf.inputs["Specular IOR Level"].default_value = (JELLY_SPEC if jelly(chain) else 0.3)   # stronger'),
    ('(("StarTex3", "StarTex3_Color", 2.0), ("StarTex4", "StarTex4_Color", 3.0))', '(("StarTex3", "StarTex3_Color", 2.0 * star_scale(chain)), ("StarTex4", "StarTex4_Color", 3.0 * star_scale(chain)))'),
    ('(("StarTex1", max(1.0, 0.35 * float(S.get("StarTex1_Density", 6.0)))), ("StarTex2", 1.3))', '(("StarTex1", max(1.0, 0.35 * float(S.get("StarTex1_Density", 6.0))) * sparkle_scale(chain)), ("StarTex2", 1.3))'),
    ('            stars = mix(stars, layer, 0.45, "ADD")', '            stars = mix(stars, dust_color(mix, layer, chain), 0.45 * dust_gain(chain), "ADD")'),
    ('        stars = mix(stars, tinted, 0.9, "ADD")', '        stars = mix(stars, tinted, 0.9 * sparkle_gain(chain), "ADD")'),
    ('rim = sun("rim", 7.0, (0.75, 0.92, 1.0), 2)', 'rim = sun("rim", RIM_SUN if RIM_ON else 7.0, RIM_SUN_COLOR if RIM_ON else (0.75, 0.92, 1.0), 2)\nif RIM_ON:\n    studio_lights()'),
    ('    rim.rotation_euler = aim(-d * 0.9 + rt * 0.75 + Vector((0, 0, 0.25)))\n', '    rim.rotation_euler = aim(-d * 0.9 + rt * 0.75 + Vector((0, 0, 0.25)))\n    place_studio(STUDIO, d, rt)\n'),
    ('print("RESULT " + json.dumps({"ok": True, "renders"', 'interior_rim(renders)\nprint("RESULT " + json.dumps({"ok": True, "renders"'),
    ('    renders[view["name"]] = sc.render.filepath\n', '    renders[view["name"]] = sc.render.filepath\n    constellations(sc.render.filepath)\n    screen_rim(sc.render.filepath)\n'),
]
if any(old not in source for old, _ in hooks):
    raise RuntimeError("This preview kit needs an update before the material fixes can be applied.")
for old, new in hooks:
    source = source.replace(old, new, 1)
fix = f"RIM_ON = {rim_on}\n" + "\n".join(
    (runtime / f).read_text(encoding="utf-8")
    for f in ("galactic_mane.py", "material_rim.py", "translucent_layers.py", "screen_rim.py", "studio_lights.py", "cosmic_tuning.py"))
source = source.replace(marker, fix + '\nfix_lobby_mane(A, job)\nbpy.context.view_layer.update()\n\n' + marker, 1)
source = source.replace(mesh_path, repr(str(kit / "meshes")), 1)
patched = runtime / "render_preview.py"
if not patched.exists() or patched.read_text(encoding="utf-8") != source:
    patched.write_text(source, encoding="utf-8")

source = original.read_text(encoding="utf-8-sig")
render_path = 'KIT / "previews" / "render_preview.py"'
if render_path not in source:
    raise RuntimeError("This preview kit does not support the app's renderer fixes. Update it in Setup.")
source = source.replace(render_path, "Path(" + repr(str(patched)) + ")", 1)
# The "before" pictures (<key>.vanilla.png) are cached per look: the rim setting is part of that look, so a vanilla made under
# the other setting is rendered again the next time a preview of that hero is generated. Mod previews keep their fingerprint,
# so nothing else is rendered again by the setting.
vanilla_dir = 'f"v{VERSION}-{game_stamp(cfg)}"'
if source.count(vanilla_dir) != 2:
    raise RuntimeError("This preview kit does not support the app's before pictures. Update it in Setup.")
source = source.replace(vanilla_dir, 'f"v{VERSION}' + ("r" if rim_on else "") + '-{game_stamp(cfg)}"')
# VFX palette cards: labels at two thirds of the kit's size (84 px read too large on the card), with their line spacing to
# match. ANIM goes up one and REDO names "vfx", so cards made before render again when asked for (a cached "nothing to
# show" is also looked at once more, which only reads the mod).
vfx_hooks = [
    ("label, gap, top = 140, 40, 100", "label, gap, top = 92, 40, 100"),
    ("(MARGIN + 4, y + bh + 24)", "(MARGIN + 4, y + bh + 16)"),
    ("(w - MARGIN - 4, y + bh + 24)", "(w - MARGIN - 4, y + bh + 16)"),
    ("font(84", "font(55"),
    ("\nANIM = 7 ", "\nANIM = 8 "),
    ('REDO = {"sound": 4, "anim": 6}', 'REDO = {"sound": 4, "anim": 6, "vfx": 8}'),
]
if any(old not in source for old, _ in vfx_hooks):
    raise RuntimeError("This preview kit does not support the app's VFX card size. Update it in Setup.")
for old, new in vfx_hooks:
    source = source.replace(old, new)
# A different fingerprint regenerates cached renders as they are requested. The rim setting is not part of it: changing
# the setting must not render every preview again
source = re.sub(r"(?m)^VERSION = (\d+)", lambda m: "VERSION = " + str(int(m[1]) + 10000), source, count=1)
globals()["__file__"] = str(original)
exec(compile(source, str(original), "exec"), globals())
