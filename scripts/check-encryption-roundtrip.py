"""Verify the native encryption action on a disposable copy of an existing IoStore bundle."""
import argparse
import ctypes
import hashlib
import json
from pathlib import Path
import tempfile
import shutil

p = argparse.ArgumentParser()
p.add_argument("--dll", required=True)
p.add_argument("--source", required=True, help="The source .pak/.bak_repak/.utoc; read only")
a = p.parse_args()
lib = ctypes.CDLL(str(Path(a.dll).resolve()))
lib.uat_invoke.argtypes = [ctypes.c_char_p]
lib.uat_invoke.restype = ctypes.c_void_p
lib.uat_free.argtypes = [ctypes.c_void_p]


def invoke(action, expect_success=True, **kw):
    ptr = lib.uat_invoke(json.dumps({"action": action, **kw}).encode())
    assert ptr, "Native call returned no response"
    try:
        value = json.loads(ctypes.string_at(ptr).decode())
    finally:
        lib.uat_free(ptr)
    assert value["success"] == expect_success, value
    return value.get("data")


source = Path(a.source).resolve()
base = source.with_suffix("")
# Appending preserves dots inside the mod stem.
companions = [Path(str(base) + ".utoc"), Path(str(base) + ".ucas")]
assert companions[0].exists() == companions[1].exists(), "Incomplete source IoStore bundle"
originals = [source, *companions] if companions[0].is_file() else [source]


def digest(path):
    with path.open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


before = [digest(x) for x in originals]
with tempfile.TemporaryDirectory(prefix="repakxtra-encryption-test-") as temp:
    temp = Path(temp)
    for src, ext in zip(originals, ["pak", "utoc", "ucas"]):
        shutil.copy2(src, temp / ("input." + ext))
    if len(originals) > 1:
        output = temp / "encrypted.utoc"
        invoke("encrypt_iostore", file_path=str(temp / "input.utoc"), output_path=str(output))
        assert invoke("is_iostore_encrypted", file_path=str(output))["encrypted"]
        # A second encryption pass verifies encrypted input and decrypted directory-index pass-through.
        invoke("encrypt_iostore", file_path=str(output), output_path=str(temp / "again.utoc"))
        invoke("encrypt_iostore", expect_success=False, file_path=str(output), output_path=str(output))
    key = "0C263D8C22DCB085894899C3A3796383E9BF9DE0CBFB08C9BF2DEF2E84F29D74"
    pak = invoke("list_pak", file_path=str(temp / "input.pak"), aes_key=key)
    entries = pak["files"]
    invoke("encrypt_pak", file_path=str(temp / "input.pak"), output_path=str(temp / "encrypted.bak_repak"))
    assert not (temp / "encrypted.pak").exists(), "Staged encrypted PAK must stay disabled"
    result = invoke("list_pak", file_path=str(temp / "encrypted.bak_repak"), aes_key=key)
    assert result["encrypted_index"]
    assert {(e["path"], e["size"]) for e in result["files"]} == {(e["path"], e["size"]) for e in entries}
    # Exercise a standalone legacy PAK as well as an empty or chunknames-only IoStore companion.
    payload = temp / "payload.txt"
    payload.write_text("Plain PAK encryption preserves raw entries.\n", encoding="utf-8")
    invoke("create_pak", output_path=str(temp / "plain.pak"), file_paths=[f"Marvel/Content/test.txt={payload}"], mount_point="../../../", aes_key=key)
    invoke("encrypt_pak", file_path=str(temp / "plain.pak"), output_path=str(temp / "plain-encrypted.pak"))
    invoke("encrypt_pak", expect_success=False, file_path=str(temp / "plain.pak"), output_path=str(temp / "plain.pak"))
    assert invoke("list_pak", file_path=str(temp / "plain-encrypted.pak"), aes_key=key)["encrypted_index"]
    print(f'PASS: encrypted and verified bundle, preserving {len(entries)} PAK entries')
assert before == [digest(x) for x in originals], "Source files changed"
print("PASS: original source bundle unchanged")
