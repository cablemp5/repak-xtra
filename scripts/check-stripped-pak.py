"""Check stripped PAK listing and extraction with a built UAssetTool command line."""
import argparse
import hashlib
from pathlib import Path
import struct
import subprocess
import tempfile

args = argparse.ArgumentParser()
args.add_argument("--tool", required=True)
a = args.parse_args()
tool = str(Path(a.tool).resolve())
pack = struct.pack


def string(s):
    data = s.encode() + b"\0"
    return pack("<i", len(data)) + data


def path_hash(path, seed):
    h = (0xcbf29ce484222325 + seed) & 0xffffffffffffffff
    for b in path.lower().encode("utf-16-le"):
        h = ((h ^ b) * 0x100000001b3) & 0xffffffffffffffff
    return h


def write_pak(path, mount, name, payload, stripped=False, seed=0):
    # One uncompressed entry with a real inline header, plus a V11 primary index.
    data = pack("<QQQI", 0, len(payload), len(payload), 0) + hashlib.sha1(payload).digest() + pack("<BI", 0, 0) + payload
    encoded = pack("<III", 0xe0000000, 0, len(payload)) if name else b""
    phi = pack("<IQII", 1, path_hash(name, seed), 0, 0) if name else pack("<II", 0, 0)
    directory, _, filename = name.rpartition("/")
    fdi = pack("<I", 1) + string(directory + "/") + pack("<I", 1) + string(filename) + pack("<I", 0)
    index = string(mount) + pack("<IQI", bool(name), seed, 1)
    index += pack("<QQ", len(data), len(phi)) + hashlib.sha1(phi).digest()
    index += pack("<I", not stripped)
    if not stripped:
        index += pack("<QQ", len(data) + len(phi), len(fdi)) + hashlib.sha1(fdi).digest()
    index += pack("<I", len(encoded)) + encoded + pack("<I", 0)
    before = data + phi + (fdi if not stripped else b"")
    footer = bytes(17) + pack("<IIQQ", 0x5a6f12e1, 11, len(before), len(index)) + hashlib.sha1(index).digest() + bytes(160)
    path.write_bytes(before + index + footer)


def invoke(*command, ok=True):
    result = subprocess.run([tool, *map(str, command)], capture_output=True, text=True, timeout=30)
    assert (result.returncode == 0) == ok, result.stderr
    return result.stdout


with tempfile.TemporaryDirectory(prefix="stripped-pak-") as temp:
    root = Path(temp) / "Paks"
    mods = root / "~mods" / "nested"
    mods.mkdir(parents=True)
    name = "Marvel/Content/WwiseAudio/bnk_display_1036802.bnk"
    payload = b"A replacement sound bank"
    # Game indexes can mount below the mod's mount and prefix root entries with '/'.
    write_pak(root / "game.pak", "../../../Marvel/Content/WwiseAudio/", "/bnk_display_1036802.bnk", b"vanilla")
    mod = mods / "sound.bak_repak"
    write_pak(mod, "../../../", name, payload, stripped=True, seed=37)
    before = mod.read_bytes()
    assert invoke("list_pak", mod, "--paths-only").splitlines() == [name]
    out = Path(temp) / "out"
    invoke("extract_pak", mod, out)
    assert (out / name).read_bytes() == payload
    assert mod.read_bytes() == before
    write_pak(mod, "../../../", "Marvel/Content/WwiseAudio/missing.bnk", payload, stripped=True)
    invoke("list_pak", mod, "--paths-only", ok=False)
    write_pak(mod, "../../../", "", b"", stripped=True)
    assert invoke("list_pak", mod, "--paths-only").strip() == ""
print("PASS: stripped paths, nested mods, mounted game names, nonzero seed, exact extraction, unresolved errors, and empty PAKs")
