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
for path in (root / "repak-x/src/preview_fixes").glob("*.py"):
    ast.parse(path.read_text(encoding="utf-8"))
print("PASS: borrowed idle mane tracks removed; body pose, own skin animations and other heroes preserved")
