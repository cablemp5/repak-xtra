"""Which property layouts a game patch moved: compares two USMAPs (an older and a newer game build's) and lists the
structs and classes whose properties changed index or type, their own or through a parent. Cooked unversioned files
store properties by index, so a file cooked before such a patch is read wrong after it and can crash the game. Run it
after each game update with the USMAPs of the last two builds, and add a struct the VFX Updater can rewrite to
xtra_mi_layout.rs MOVED (3984769: MaterialInstanceBasePropertyOverrides, and AnimBlueprintGeneratedConstantData, which
xtra_broken.rs flags as May crash). Needs the zstd command line (USMAPs from rivals-depot are zstd-compressed).

  python scripts/usmap-diff.py <older.usmap> <newer.usmap>
"""
import struct, subprocess, sys, tempfile, os

def load(path):
    raw = open(path, 'rb').read()
    magic, ver = struct.unpack_from('<HB', raw, 0)
    assert magic == 0x30C4, hex(magic)
    off = 3
    if ver >= 1:
        hasv = struct.unpack_from('<i', raw, off)[0]; off += 4
        assert hasv == 0, 'versioning not handled'
    comp, csize, dsize = struct.unpack_from('<BII', raw, off); off += 9
    body = raw[off:off + csize]
    if comp == 3:
        with tempfile.TemporaryDirectory() as d:
            i, o = os.path.join(d, 'i.zst'), os.path.join(d, 'o')
            open(i, 'wb').write(body)
            subprocess.run(['zstd', '-q', '-d', i, '-o', o], check=True)
            body = open(o, 'rb').read()
    assert len(body) == dsize, (len(body), dsize)
    return ver, body

class R:
    def __init__(s, b): s.b, s.o = b, 0
    def u8(s): v = s.b[s.o]; s.o += 1; return v
    def u16(s): v = struct.unpack_from('<H', s.b, s.o)[0]; s.o += 2; return v
    def u32(s): v = struct.unpack_from('<I', s.b, s.o)[0]; s.o += 4; return v
    def i32(s): v = struct.unpack_from('<i', s.b, s.o)[0]; s.o += 4; return v
    def u64(s): v = struct.unpack_from('<Q', s.b, s.o)[0]; s.o += 8; return v

TYPES = ['Byte','Bool','Int','Float','Object','Name','Delegate','Double','Array','Struct','Str','Text','Interface','MulticastDelegate','WeakObject','LazyObject','AssetObject','SoftObject','UInt64','UInt32','UInt16','Int64','Int16','Int8','Map','Set','Enum','FieldPath','OptionalProperty','Utf8Str','AnsiStr']

def parse(path):
    ver, body = load(path)
    r = R(body)
    n = r.u32()
    names = []
    for _ in range(n):
        ln = r.u8() if ver < 3 else r.u16()  # LongFName at v3? keep simple
        names.append(r.b[r.o:r.o + ln].decode('utf-8', 'replace')); r.o += ln
    nm = lambda: (lambda i: None if i == 0xFFFFFFFF else names[i])(r.u32())
    ne = r.u32()
    for _ in range(ne):
        nm()
        cnt = r.u16() if ver >= 2 else r.u8()
        for _ in range(cnt):
            if ver >= 4: r.u64()
            nm()
    def ptype():
        t = TYPES[r.u8()] if True else None
        if t == 'Enum':
            inner = ptype(); en = nm(); return f'Enum<{en}>'
        if t == 'Struct': return f'Struct<{nm()}>'
        if t in ('Array', 'Set', 'OptionalProperty'): return f'{t}<{ptype()}>'
        if t == 'Map': k = ptype(); v = ptype(); return f'Map<{k},{v}>'
        return t
    ns = r.u32()
    structs = {}
    for _ in range(ns):
        name = nm(); sup = nm()
        pcount = r.u16(); serial = r.u16()
        props = []
        for _ in range(serial):
            idx = r.u16(); arr = r.u8(); pn = nm(); t = ptype()
            props.append((idx, arr, pn, t))
        structs[name] = (sup, props)
    return structs

def flat(structs, name):
    """property name -> (absolute index in the full chain, type) as unversioned serialization numbers them."""
    chain = []
    n = name
    while n and n in structs:
        chain.append(n); n = structs[n][0]
    out, base = [], 0
    for s in reversed(chain):
        sup, props = structs[s]
        top = 0
        for idx, arr, pn, t in props:
            for k in range(arr):
                out.append((base + idx + k, pn if arr == 1 else f'{pn}[{k}]', t))
            top = max(top, idx + arr)
        base += top
    return out

a, b = parse(sys.argv[1]), parse(sys.argv[2])
changed = []
for name in sorted(set(a) & set(b)):
    fa, fb = flat(a, name), flat(b, name)
    if fa != fb:
        own_a, own_b = a[name][1], b[name][1]
        own = own_a != own_b
        changed.append((name, own, fa, fb))
print('structs in both', len(set(a) & set(b)), 'changed layout', len(changed))
direct = [c for c in changed if c[1]]
print('changed in their own properties:', len(direct))
for name, own, fa, fb in direct:
    sa, sb = {p for _, p, _ in fa}, {p for _, p, _ in fb}
    print(f'  {name}: +{sorted(sb - sa)[:6]} -{sorted(sa - sb)[:6]}')
inherited = [c[0] for c in changed if not c[1]]
print('changed through a parent:', len(inherited))
print('   ', ', '.join(inherited[:80]))
