"""Focused checks for the preview correction, without requiring Blender."""
import ast
from pathlib import Path
from types import SimpleNamespace
import importlib.util
import sys

sys.dont_write_bytecode = True

root = Path(__file__).resolve().parents[1]
source = root / "repak-x/src/preview_fixes/galactic_mane.py"
spec = importlib.util.spec_from_file_location("galactic_mane", source)
fix = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fix)

spec = importlib.util.spec_from_file_location("material_rim", root / "repak-x/src/preview_fixes/material_rim.py")
rim = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rim)
c = lambda r, g, b: {"R": r, "G": g, "B": b}
chain = {"vectors": {"A": 1, "B": 2}, "scalars": {"AOIntensity": 0.7}, "defaults": {"vectors": {"B": 9, "C": 3}, "scalars": {"AOIntensity": 0.0, "Metailic": 1.0}}}
merged = rim.with_defaults(chain)
assert merged["vectors"] == {"A": 1, "B": 2, "C": 3} and merged["scalars"] == {"AOIntensity": 0.7, "Metailic": 1.0}
assert rim.with_defaults(None) is None
assert rim.rim_params({"RimLightColor": c(0, 0, 0)}, {"RimFresnelPower": 5.0}) == rim.RIM_COLOR   # black master rim: the lobby's
assert rim.rim_params({}, {}) == rim.RIM_COLOR                                                   # no master rim at all: still the lobby's
assert abs(max(rim.rim_params({"RimLightColor": c(0.02, 0.1, 0.2)}, {"RimFresnelPower": 5.0})) - rim.RIM_FLOOR) < 1e-9   # dim rim lifted, hue kept
assert rim.rim_params({"RimLightColor": c(1, 1, 1)}, {"RimFresnelPower": 0.0}) is None         # crystal masters: power 0 is another effect


class Basis:
    reset = False
    def identity(self): self.reset = True


class Bones(dict):
    def __iter__(self): return iter(self.values())


def skeleton():
    names = ["hair_c_01", "hair_03_01_l", "spine_05", "head"]
    bones = Bones((n, SimpleNamespace(name=n, matrix_basis=Basis())) for n in names)
    curves = [SimpleNamespace(data_path=f'pose.bones["{n}"].location') for n in names]
    action = SimpleNamespace(layers=[SimpleNamespace(strips=[SimpleNamespace(channelbags=[SimpleNamespace(fcurves=curves)])])])
    return SimpleNamespace(pose=SimpleNamespace(bones=bones), animation_data=SimpleNamespace(action=action)), curves


job = {"model": "SK_1026_1026300_Lobby.uemodel", "anim": "/1026001/Animations/HeroDetails/Lobby_Stand_Idle.ueanim"}
a, curves = skeleton()
assert fix.fix_lobby_mane(a, job) == 2
assert all(a.pose.bones[n].matrix_basis.reset for n in ["hair_c_01", "hair_03_01_l"])
assert not a.pose.bones["spine_05"].matrix_basis.reset
assert len(curves) == 2 and all('hair_' not in c.data_path for c in curves)
a, curves = skeleton()
assert fix.fix_lobby_mane(a, {**job, "anim": job["anim"].replace("1026001", "1026300")}) == 0
assert fix.fix_lobby_mane(a, {**job, "model": "SK_1029_1029001.uemodel"}) == 0
assert len(curves) == 4
def load(name):
    spec = importlib.util.spec_from_file_location(name, root / f"repak-x/src/preview_fixes/{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


layers, screen = load("translucent_layers"), load("screen_rim")
layers.RIM_SKIP = rim.RIM_SKIP   # the renderer runs all the fixes in one namespace
chain = lambda master, tex: {"chain": ["/Game/x/" + master], "textures": dict.fromkeys(tex, "/Game/t")}
assert layers.layer_kind("MI_1014001_Hair_03", {}, chain("M_Common_Translucent_Lobby", ["BaseColor", "OpacityMask"])) == "layer"
assert layers.layer_kind("MI_1014001_Hair_03", {}, chain("M_Common_Translucent", ["OpacityMask"])) is None          # no color: stays hidden
assert layers.layer_kind("MI_1014001_Eyes_02", {}, chain("M_SimpleGlass_EyesHighLight", ["HighlightMask"])) == "highlight"   # the catch-light glass, even by an eye name
assert layers.layer_kind("MI_1015001_Eyes_03", {}, chain("M_Common_Translucent", ["BaseColor", "OpacityMask"])) is None   # an eye overlay stays hidden
assert all(rim.RIM_SKIP.search(n) for n in ("MI_1015001_Head", "MI_1014001_Eyes_02", "MI_1017001_Eyeshighlight", "MI_1020001_Tooth"))
assert not any(rim.RIM_SKIP.search(n) for n in ("MI_1015001_Body", "MI_1014001_Hair_01", "MI_1012001_Headband", "MI_1015001_Equip_01"))
assert layers.layer_kind("MI_1014001_Hair_03", {}, chain("M_RimOnly", [])) is None and layers.layer_kind("x", {}, None) is None
try:
    import numpy as np
except ImportError:
    np = None
if np is not None:   # the renderer has numpy in Blender, this machine's python may not
    screen.np = np; screen.RIM_OWN = rim.RIM_OWN
    yy, xx = np.mgrid[:80, :80]
    disc = (np.hypot(xx - 40, yy - 40) < 25).astype(np.float64)
    band = screen.rim_band(disc, 8)
    assert abs(screen.box_blur(np.full((9, 9), 0.3), 2) - 0.3).max() < 1e-9
    depth = np.full((10, 12), 100.0); depth[:, 7:] = 120.0   # a nearer surface (columns 0 to 6) ending against a farther one
    inner = screen.interior_band(depth, np.ones((10, 12)), 3)
    assert inner[5].tolist() == [False] * 4 + [True] * 3 + [False] * 5   # columns 4 to 6: the edge pixel and 2 into the nearer surface
    assert not screen.interior_band(depth[:, ::-1], np.ones((10, 12)), 3)[:, :5].any()   # farther on the left: nothing lit
    assert band[40, 40] == 0 and band[40, 56:66].max() > 0.5                       # right edge lit, centre not
    assert band[40, 14:24].max() < 0.05 and band[..., :].max() <= 1.0              # left edge dark
    rgb = np.zeros((80, 80, 3), np.float32); rgb[40, 56:60] = 0.9; rgb[40, 60:62] = 0.3; rgb[40, 62:66] = 0.9   # two bright bands with a 2 px seam
    fill = screen.close_gaps(rgb, screen.rim_band(disc, 16, edge=0.78) > 0.5, 2)
    assert fill[40, 60:62].all() and fill.sum() == 2                                  # only the seam, not the dark interior
    assert screen.rim_tint([]) == screen.SCREEN_RIM_COLOR
    rim.RIM_OWN[:] = [(1.0, 0.4, 0.1)]; assert screen.rim_tint([(0.45, 0.8, 1.0)]) == (1.0, 0.4, 0.1); rim.RIM_OWN.clear()   # a fire body's own color wins
for path in (root / "repak-x/src/preview_fixes").glob("*.py"):
    ast.parse(path.read_text(encoding="utf-8"))
print("PASS: borrowed idle mane tracks removed; body pose, own skin animations and other heroes preserved")
