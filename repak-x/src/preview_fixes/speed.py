"""Faster previews, the same pictures. One exporter serves the whole run: it mounts the game once, and an exporter that
can swap (it prints "SWAP 1", Cue4Export's MOUNT line) takes each mod's paks on and off in about 0.01 s instead of
mounting the game again (about 2.3 s). An older one serves every "game alone" export of the run (a VFX mod's game
colors, sound banks, skin tables, the "before" renders) and each mod gets its own, as before. A VFX card's game colors
are cached per game version, so only instances no earlier card read are exported. The dance outline grows its alpha
with numpy, the same pixels as MaxFilter in a fifteenth of the time."""
_kit_run_spec, _kit_close_exporters = run_spec, close_exporters
_SHARED = {}   # (exe, the game's config text) -> {"server": (proc, lines), "swap": bool, "extra": [mounted mod folders]}
_ASKING = []   # non-empty while a line waits for its answer: a timeout then kills the shared exporters instead of asking them


def split_config(config):
    """(the config's text without its mods, the mod folders it mounts) or None when it cannot be read. An empty folder
    mounts nothing (a "before" render mounts one)."""
    try:
        cfg = json.loads(Path(config).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    extra = [p for p in cfg.pop("extra_paks", None) or [] if Path(p).is_dir() and any(Path(p).iterdir())]
    return json.dumps(cfg, sort_keys=True), extra


def shared_exporter(exe, text):
    """The run's exporter for this game config, started with the game alone; None when this build cannot serve."""
    key = (str(exe), text)
    s = _SHARED.get(key)
    if s and s["server"][0].poll() is None:
        return s
    config = WORK / "_game" / (hashlib.sha1(text.encode()).hexdigest()[:16] + ".json")
    config.parent.mkdir(parents=True, exist_ok=True)
    config.write_text(text, encoding="utf-8")
    proc = subprocess.Popen([str(exe), "--serve", str(config)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace", creationflags=NO_WINDOW)
    q = queue.Queue()

    def pump():
        for line in proc.stdout:
            q.put(line)
        q.put(None)
    threading.Thread(target=pump, daemon=True).start()
    try:
        code, lines = _answer((proc, q), "READY", 300)
    except EOFError:   # no --serve in this build
        _no_serve.add(str(exe))
        return None
    except Exception:   # a hang past the timeout: never left running
        stop(proc)
        raise
    if code:
        stop(proc)
        raise RuntimeError(f"{Path(str(exe)).name} could not mount: {''.join(lines)[-800:]}")
    s = _SHARED[key] = {"server": (proc, q), "swap": any(l.startswith("SWAP ") for l in lines), "extra": []}
    return s


def stop(proc):
    try:
        proc.kill()
        proc.wait(10)
    except Exception:
        pass


def drop(key):
    """A shared exporter ended and forgotten: the next request starts a fresh one."""
    s = _SHARED.pop(key, None)
    if s:
        stop(s["server"][0])


def ask(server, line, timeout):
    """One line to the exporter and its DONE code, with the lines before it."""
    _ASKING.append(1)
    try:
        server[0].stdin.write(f"{line}\n")
        server[0].stdin.flush()
        return _answer(server, "DONE", timeout)
    except EOFError as e:
        raise RuntimeError(f"Cue4Export ended: {e}") from None
    finally:
        _ASKING.pop()


def run_spec(exe, spec, config, timeout):
    split = split_config(config)
    if split is None or str(exe) in _no_serve:
        return _kit_run_spec(exe, spec, config, timeout)
    text, extra = split
    s = shared_exporter(exe, text)
    if s is None or (extra and not s["swap"]):   # an older exporter: this mod's own, as before
        return _kit_run_spec(exe, spec, config, timeout)
    key = (str(exe), text)
    if s["extra"] != extra:
        try:
            code, lines = ask(s["server"], "MOUNT " + json.dumps(extra), 120)
        except Exception:
            drop(key)
            raise
        if code:   # the exporter ends after a failed swap: part of the mod may be mounted
            drop(key)
            raise RuntimeError(f"Cue4Export could not mount the mod: {''.join(lines)[-800:]}")
        s["extra"] = extra
    try:
        code, lines = ask(s["server"], spec, timeout)
    except Exception:   # a timeout or an ended exporter: a late DONE must not answer the next request
        drop(key)
        raise
    if code:
        tail = "".join(lines)
        print(f"# {Path(str(exe)).name} exit {code}\n# output: {tail[-1500:]}", file=sys.stderr, flush=True)
        raise RuntimeError(f"{Path(str(exe)).name} exit {code}: {tail[-800:]}")


def close_exporters():
    """The kit's (each mod's own exporters end), and the shared one lets go of the mod's files, which are deleted next:
    MOUNT with no folders. One that does not answer, or a timeout while waiting on one, ends it."""
    _kit_close_exporters()
    for key, s in list(_SHARED.items()):
        if _ASKING or s["server"][0].poll() is not None:   # a timeout while waiting on one: every shared exporter ends
            drop(key)
            continue
        if not s["extra"]:
            continue
        try:
            if ask(s["server"], "MOUNT []", 60)[0]:
                raise RuntimeError("no unmount")
            s["extra"] = []
        except Exception:
            drop(key)


def close_shared_exporters():
    for s in _SHARED.values():
        try:
            s["server"][0].stdin.close()
            s["server"][0].wait(10)
        except Exception:
            s["server"][0].kill()
    _SHARED.clear()


atexit.register(close_shared_exporters)


def vanilla_vectors(work, mis):
    """mi_vectors of the game's own copy of these instances, from the per game version cache; the rest exported with only
    the game mounted and cached (an instance the game lacks as missing: a mod's own adds no game colors)."""
    cfg = json.loads((work / "config.json").read_text(encoding="utf-8"))
    usmap = Path(cfg.get("usmap") or "")
    mappings = f"{usmap.name}|{usmap.stat().st_size}|{usmap.stat().st_mtime_ns}" if usmap.is_file() else ""
    # per game version and mappings: other mappings may read the same instance differently
    cache = vanilla_dir(work) / "vfx_vectors" / hashlib.sha1(mappings.encode()).hexdigest()[:12]
    entry = lambda g: cache / (hashlib.sha1(g.encode()).hexdigest()[:20] + ".json")
    todo = [g for g in mis if not entry(g).exists()]
    if todo:
        cfg.pop("extra_paks", None)
        (work / "vanilla.json").write_text(json.dumps(cfg), encoding="utf-8")
        out = export(work, [{"op": "export", "mode": "json", "paths": todo}], name="vfx_vanilla", out=work / "vfx_vanilla", config="vanilla.json")
        cache.mkdir(parents=True, exist_ok=True)
        for g in todo:
            f = content_file(out, g, ".json")
            found = f.exists()
            vecs = [[p, n, i, rgb] for (p, n, i), rgb in mi_vectors_file(f).items()] if found else []
            tmp = entry(g).with_suffix(".tmp")
            tmp.write_text(json.dumps({"path": g, "found": found, "vectors": vecs}), encoding="utf-8")
            os.replace(tmp, entry(g))
    out = {}
    for g in mis:
        try:
            data = json.loads(entry(g).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        out.update({(p, n, i): tuple(rgb) for p, n, i, rgb in data["vectors"]})
    return out


def mi_vectors_file(f):
    """mi_vectors of one exported JSON file."""
    out = {}
    data = json.loads(f.read_text(encoding="utf-8"))
    for obj in data if isinstance(data, list) else []:
        for v in obj.get("Properties", {}).get("VectorParameterValues", []):
            c, info = v.get("ParameterValue") or {}, v["ParameterInfo"]
            if not NOT_COLOR.search(info["Name"]):
                out[obj.get("Package"), info["Name"], info.get("Index", -1)] = (c.get("R", 0.0), c.get("G", 0.0), c.get("B", 0.0))
    return out


def outlined(frame, px=2):
    """The kit's outline (a dark rim px wide around the figure), its alpha grown by a square max filter in numpy."""
    import numpy as np
    a = np.asarray(frame.getchannel("A"))
    p = np.pad(a, px)
    rows = np.max([p[i:i + a.shape[0]] for i in range(2 * px + 1)], axis=0)
    grown = np.max([rows[:, i:i + a.shape[1]] for i in range(2 * px + 1)], axis=0)
    rim = Image.new("RGBA", frame.size, OUTLINE + (0,))
    rim.putalpha(Image.fromarray(np.ascontiguousarray(grown)))
    rim.alpha_composite(frame)
    return rim


_t = Image.new("RGBA", (40, 30), (0, 0, 0, 0))
ImageDraw.Draw(_t).rectangle((0, 5, 20, 25), fill=(158, 158, 163, 255))
_k = Image.new("RGBA", _t.size, OUTLINE + (0,))
_k.putalpha(_t.getchannel("A").filter(ImageFilter.MaxFilter(5)))
_k.alpha_composite(_t)
assert outlined(_t).tobytes() == _k.tobytes(), "the numpy outline matches MaxFilter, edges included"

def on_threads(fn, items, most=16):
    """fn over items on a few threads, in order (Pillow's filters, resizes and encoders release the lock)."""
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max(1, min(most, (os.cpu_count() or 2) - 1))) as pool:
        return list(pool.map(fn, items))


def write_webp(frames, path, duration):
    """A looping animated WebP (quality 80, method 2, every frame a key frame as save_webp explains), encoded in chunks on
    threads and joined: 279 frames of 512x724 took one encoder 8.8 s and eleven of them 1.7 s. Every frame decodes to the
    pixels the one encoder gives. The encoder stores an animation's first frame cropped to what is not clear, which
    compresses a little differently, so each later chunk starts one frame early (the frame before it) and that extra
    frame is left out of the join: every frame kept is then a whole-canvas key frame, as in the one encoder's file.
    Anything unexpected in a chunk falls back to the one encoder."""
    import io
    def encode(part, to=None):
        out = to or io.BytesIO()
        part[0].save(out, format="WEBP", save_all=True, append_images=part[1:], duration=duration, loop=0, quality=80, method=2, kmax=1)
        return None if to else out.getvalue()
    def chunks(data):
        at, found = 12, []
        while at + 8 <= len(data):
            end = at + 8 + int.from_bytes(data[at + 4:at + 8], "little")
            end += end - at & 1   # chunks are padded to an even size
            found.append((data[at:at + 4], data[at:end]))
            at = end
        return found
    n = min(16, (os.cpu_count() or 2) - 1, len(frames) // 8)   # one chunk per spare thread: the encoder is all CPU
    try:
        if n < 2:
            raise ValueError("too few frames to split")
        cuts = [i * len(frames) // n for i in range(n + 1)]
        parts = [chunks(d) for d in on_threads(encode, [frames[max(0, a - 1):b] for a, b in zip(cuts, cuts[1:])], n)]
        heads = [bytearray(next(c for f, c in p if f == b"VP8X")) for p in parts]
        for h in heads[1:]:
            heads[0][8] |= h[8]   # the file has alpha when any chunk has
        shown = [[bytearray(c) for f, c in p if f == b"ANMF"] for p in parts]
        for part in shown[1:]:   # the frame each later chunk started early on
            if not part:
                raise ValueError("a chunk is not an animation")
            ms = int.from_bytes(part[0][20:23], "little")   # ANMF: 8 header, X 3, Y 3, W 3, H 3, duration 3, flags 1
            if ms == duration:
                del part[0]
            elif ms > duration:   # equal frames after it were stored as this one picture, shown longer
                part[0][20:23] = (ms - duration).to_bytes(3, "little")
            else:
                raise ValueError("a chunk's first frame has no full duration")
            # what is kept must not lean on that frame: the whole canvas, not blended over what was there
            if not part or part[0][8:14] != bytes(6) or part[0][14:20] != heads[0][12:18] or not part[0][23] & 2:
                raise ValueError("a chunk does not start on a whole frame")
        if not shown[0]:
            raise ValueError("a chunk is not an animation")
        body = bytes(heads[0]) + next(c for f, c in parts[0] if f == b"ANIM") + b"".join(bytes(c) for part in shown for c in part)
        Path(path).write_bytes(b"RIFF" + (len(body) + 4).to_bytes(4, "little") + b"WEBP" + body)
    except (StopIteration, ValueError):
        with open(path, "wb") as f:
            encode(frames, f)
