"""Check real texture packaging: python check-quake-packaging.py TOOL_DLL LEGACY_DIR.

Uses two local textures; writes only to a temporary directory, never the game.
Append --native when TOOL_DLL is the NativeAOT library.
"""
import ctypes
import functools
import itertools
import json
import shutil
import struct
import subprocess
import sys
import tempfile
from pathlib import Path


@functools.cache
def native_library(tool):
    library = ctypes.CDLL(str(tool))
    library.uat_invoke.argtypes = [ctypes.c_char_p]
    library.uat_invoke.restype = ctypes.c_void_p
    library.uat_free.argtypes = [ctypes.c_void_p]
    return library


def request(tool, **payload):
    if "--native" in sys.argv:
        library = native_library(tool)
        pointer = library.uat_invoke(json.dumps(payload).encode())
        assert pointer, "native tool returned no response"
        try:
            response = json.loads(ctypes.string_at(pointer).decode())
        finally:
            library.uat_free(pointer)
        assert response["success"], response
        return response.get("data")
    command = ["dotnet", str(tool)] if tool.suffix == ".dll" else [str(tool)]
    result = subprocess.run(command, input=json.dumps(payload) + "\n", text=True,
                            encoding="utf-8", capture_output=True, check=True)
    responses = [json.loads(line.lstrip("\ufeff")) for line in result.stdout.splitlines()
                 if line.lstrip("\ufeff").startswith("{")]
    response = responses[-1]
    assert response["success"], response
    return response.get("data")


def package_ids(path):
    toc = path.read_bytes()
    header_size, count = struct.unpack_from("<II", toc, 20)
    # Container-header chunk IDs include the container's own name and may differ.
    return sorted(toc[i:i + 12] for i in range(header_size, header_size + count * 12, 12)
                  if toc[i + 11] == 1)


def main():
    tool, source = map(lambda x: Path(x).resolve(), sys.argv[1:3])
    with tempfile.TemporaryDirectory(prefix="quake-packaging-") as temp:
        work = Path(temp)
        fixtures = list(itertools.islice(source.rglob("*.uasset"), 2))
        assert len(fixtures) == 2, "need two cooked textures"
        for asset in fixtures:
            for ext in (".uasset", ".uexp"):
                dest = work / "input" / asset.relative_to(source).with_suffix(ext)
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(asset.with_suffix(ext), dest)
        paths = {}
        for quake in (False, True):
            base = work / ("quake" if quake else "normal")
            request(tool, action="create_mod_iostore", input_dir=str(work / "input"),
                    output_path=str(base), compress=True, quake_packaging=quake)
            encrypted = request(tool, action="is_iostore_encrypted", file_path=str(base.with_suffix(".utoc")))
            assert encrypted["encrypted"] == quake, encrypted
            paths[quake] = request(tool, action="list_iostore_files", file_path=str(base.with_suffix(".utoc")),
                                   aes_key="0C263D8C22DCB085894899C3A3796383E9BF9DE0CBFB08C9BF2DEF2E84F29D74")["files"]
            pak = request(tool, action="list_pak", file_path=str(base.with_suffix(".pak")))
            assert pak["total_files"] == (0 if quake else 1), pak
            if quake:
                assert base.with_suffix(".pak").stat().st_size == 416
        expected = sorted(p.replace("Marvel/Content/", "quakeV6/Content/", 1) for p in paths[False])
        assert sorted(paths[True]) == expected, (paths[True], expected)
        normal_ids = package_ids(work / "normal.utoc")
        assert len(normal_ids) == 2
        assert normal_ids == package_ids(work / "quake.utoc"), "real game package IDs must stay unchanged"
        print("PASS: encrypted V6 paths, empty 416-byte PAK, unchanged package IDs; ordinary packing unchanged")


if __name__ == "__main__":
    main()
