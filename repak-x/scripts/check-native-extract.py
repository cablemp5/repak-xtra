"""repakxtra: checks the built native tool's PAK extraction against tiny made-up PAKs (nothing from the game).
Every file, including the outside-the-folder sentinel, lives in one temporary folder that is removed afterwards.
Usage: python scripts/check-native-extract.py [path to UAssetTool.dll]   (default: target/uassettool/UAssetTool.dll)
Exits 1 on the first failed check.
"""
import ctypes, hashlib, json, struct, sys, tempfile
from pathlib import Path

root = Path(__file__).resolve().parents[2]
dll = Path(sys.argv[1]) if len(sys.argv) > 1 else root / 'target/uassettool/UAssetTool.dll'
if not dll.is_file():
    sys.exit(f'native tool not found: {dll} (build it with dotnet publish UAssetToolNative.csproj first)')
lib = ctypes.CDLL(str(dll))
lib.uat_invoke.argtypes = [ctypes.c_char_p]
lib.uat_invoke.restype = ctypes.c_void_p
lib.uat_free.argtypes = [ctypes.c_void_p]


def call(request):
    ptr = lib.uat_invoke(json.dumps(request).encode())
    if not ptr:
        raise RuntimeError('native returned null')
    try:
        return json.loads(ctypes.string_at(ptr))
    finally:
        lib.uat_free(ptr)


u32 = lambda n: struct.pack('<I', n)
u64 = lambda n: struct.pack('<Q', n)


def string(s):
    b = s.encode() + b'\0'
    return u32(len(b)) + b


def pak(path, names):
    """A V11 PAK, uncompressed and unencrypted, holding b'fixture' under each name (mount point ../../../)."""
    payload = b'fixture'
    header = u64(0) + u64(len(payload)) * 2 + u32(0) + hashlib.sha1(payload).digest() + b'\0' + u32(0)
    entry = header + payload
    data = entry * len(names)
    dirs = {}
    for i, n in enumerate(names):
        d, _, leaf = n.rpartition('/')
        dirs.setdefault(d + '/' if d else '', []).append((leaf, i))
    encoded = b''
    offsets = []
    for i in range(len(names)):
        offsets.append(len(encoded))
        encoded += u32(0xc0000000) + u32(i * len(entry)) + u32(len(payload))
    fdi = u32(len(dirs))
    for d, leaves in dirs.items():
        fdi += string(d) + u32(len(leaves))
        for leaf, i in leaves:
            fdi += string(leaf) + u32(offsets[i])
    index = string('../../../') + u32(len(names)) + u64(0) + u32(0) + u32(1)
    index += u64(len(data)) + u64(len(fdi)) + hashlib.sha1(fdi).digest()
    index += u32(len(encoded)) + encoded + u32(0)
    footer = bytes(17) + u32(0x5a6f12e1) + u32(11) + u64(len(data) + len(fdi)) + u64(len(index)) + hashlib.sha1(index).digest() + bytes(160)
    path.write_bytes(data + fdi + index + footer)


def check(ok, what, detail=''):
    print(('ok   ' if ok else 'FAIL ') + what + (f' ({detail})' if detail and not ok else ''))
    if not ok:
        sys.exit(1)


with tempfile.TemporaryDirectory(prefix='repakxtra-native-check-') as tmp:
    tmp = Path(tmp)
    out = tmp / 'out'
    out.mkdir()
    sentinel = tmp / 'outside.txt'
    sentinel.write_bytes(b'sentinel')
    src = tmp / 'input.pak'

    pak(src, ['Marvel/Content/A.uasset'])
    r = call({'action': 'extract_pak_all', 'file_path': str(src), 'output_path': str(out)})
    check(r.get('success') and r['data']['extracted_count'] == 1 and r['data']['status'] == 'complete', 'a normal PAK extracts completely', r)
    check((out / 'Marvel/Content/A.uasset').read_bytes() == b'fixture', 'the file lands under the mount path')

    for bad in ['Marvel/../../outside.txt', 'Marvel/C:/outside.txt', 'Marvel/a.txt:stream', 'Marvel/CON.txt']:
        pak(src, [bad])
        r = call({'action': 'extract_pak_all', 'file_path': str(src), 'output_path': str(out)})
        check(not r.get('success') and r['data']['status'] == 'failed' and r['data']['failed_count'] == 1, f'refuses {bad!r}', r)
    # a junction already inside the output folder that points back out must not carry a write through it
    if sys.platform == 'win32':
        import subprocess
        subprocess.run(['cmd', '/c', 'mklink', '/J', str(out / 'link'), str(tmp)], check=True, capture_output=True)
        pak(src, ['link/outside.txt'])
        r = call({'action': 'extract_pak_all', 'file_path': str(src), 'output_path': str(out)})
        check(not r.get('success') and r['data']['failed_count'] == 1, 'refuses a write through a junction', r)
        (out / 'link').rmdir()
    check(sentinel.read_bytes() == b'sentinel', 'the file outside the output folder is untouched')

    pak(src, ['ok.txt', 'occupied.txt'])
    (out / 'occupied.txt').mkdir()
    r = call({'action': 'extract_pak_all', 'file_path': str(src), 'output_path': str(out)})
    d = r.get('data') or {}
    check(not r.get('success') and d.get('status') == 'partial' and d.get('extracted_count') == 1 and d.get('failed_count') == 1,
          'one failed write out of two is reported as partial, not success', r)

    pak(src, ['occupied.txt'])
    r = call({'action': 'extract_pak_all', 'file_path': str(src), 'output_path': str(out)})
    check(not r.get('success') and (r.get('data') or {}).get('status') == 'failed', 'every write failing is reported as failed', r)

print('native extraction checks passed')
