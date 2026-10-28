"""Run a preview kit with app-owned renderer fixes, leaving the installed kit unchanged."""
import os
import re
from pathlib import Path

kit = Path(os.environ["REPAKXTRA_KIT"])
runtime = Path(__file__).resolve().parent
original = kit / "previews" / "mod_previews.py"
renderer = kit / "previews" / "render_preview.py"
source = renderer.read_text(encoding="utf-8-sig")
marker = "# Lobby and gameplay materials share names"
mesh_path = 'str(Path(__file__).resolve().parents[1] / "meshes")'
if marker not in source or mesh_path not in source:
    raise RuntimeError("This preview kit needs an update before the renderer fixes can be applied.")
fix = (runtime / "galactic_mane.py").read_text(encoding="utf-8")
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
# A different fingerprint regenerates cached broken renders as they are requested.
source = re.sub(r"(?m)^VERSION = (\d+)", lambda m: "VERSION = " + str(int(m[1]) + 1000), source, count=1)
globals()["__file__"] = str(original)
exec(compile(source, str(original), "exec"), globals())
