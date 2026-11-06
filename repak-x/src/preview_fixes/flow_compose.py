

# repakxtra (preview_fixes/flow_compose.py, added to mod_previews): a render with crawling flow lines (flow_anim.py in the
# renderer) also becomes an animated <key>.webp, which the app shows over the still <key>.png


FLOW_FPS = 18   # the animated glow's frame rate (flow_anim.py FLOW_FRAMES make one 4 s loop)
FLOW_BLUR = 0.63   # the bloom's blurs scaled to the frames' render size (flow_anim.py FLOW_SCALE)
FLOW_BLACK = 14    # the base's black point: the suit's darkest values (about 14 to 20) go to black


def bloom(e, k=1.0):
    """A bloom of an emission pass, a tight and a wide blur: stronger than the kit's still, so the crawling lines glow."""
    e = e.point(lambda v: max(0, v - 80) * 2.5)   # the animation's glow: from mid-bright lines up (110 and x2 barely showed)
    return ImageChops.add(ImageEnhance.Brightness(e.filter(ImageFilter.GaussianBlur(6 * k))).enhance(1.2),
                          ImageEnhance.Brightness(e.filter(ImageFilter.GaussianBlur(16 * k))).enhance(0.9))   # 26 hazed the black suit


def sheet_canvas(im):
    """One image on the portrait sheet at the saved size, as sheet() and save() lay a single image out."""
    w, h = SHEET
    canvas = Image.new("RGBA", SHEET, (0, 0, 0, 0))
    k = min(w / im.width, h / im.height)
    im = im.resize((max(1, int(im.width * k)), max(1, int(im.height * k))), Image.LANCZOS)
    canvas.alpha_composite(im, ((w - im.width) // 2, (h - im.height) // 2))
    return canvas.resize(OUT, Image.LANCZOS)


def flow_newer(out_dir, key):
    """Whether <key>.webp is a flow animation of the current still: written after <key>.png."""
    png, webp = out_dir / f"{key}.png", out_dir / f"{key}.webp"
    return png.exists() and webp.exists() and webp.stat().st_mtime_ns >= png.stat().st_mtime_ns


def flow_anim(prefix, out_png):
    """The animated preview from the renderer's flow frames: the render without its lines, each frame's lines added over
    it with the bloom of the other glows and those lines. Written as <key>.webp beside the still; a render without flow
    lines removes an older one. Returns whether it made one."""
    frames = sorted(Path(prefix).parent.glob(Path(prefix).name + "_front_flow_*.png"))
    base_path, emit_path = Path(f"{prefix}_front_noflow.png"), Path(f"{prefix}_front_emit_noflow.png")
    out_webp = out_png.with_suffix(".webp")
    if not frames or not base_path.exists():
        out_webp.unlink(missing_ok=True)
        return False
    size = Image.open(frames[0]).size   # the frames render smaller than the still: the base is brought to their size
    base = Image.open(base_path).convert("RGBA").resize(size, Image.LANCZOS)
    # the still's brightness, a black point and no extra saturation: the suit between the lines stays black, not tinted
    rgb0 = ImageEnhance.Brightness(base.convert("RGB")).enhance(1.08).point(lambda v: max(0, v - FLOW_BLACK) * 255 // (255 - FLOW_BLACK))
    alpha0 = base.getchannel("A")
    emit = Image.open(emit_path).convert("RGB").resize(size) if emit_path.exists() else Image.new("RGB", size)
    def one(f):
        lines = Image.open(f).convert("RGB")
        glow = bloom(ImageChops.add(emit, lines), FLOW_BLUR)
        rgb = ImageChops.add(ImageChops.add(rgb0, lines), glow)
        rgb.putalpha(ImageChops.lighter(alpha0, glow.convert("L")))
        return sheet_canvas(rgb)
    # Frames on threads (Pillow's filters and resizes release the lock): the same frames, 7.8 s to 2.9 s for 72
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max(1, min(6, (os.cpu_count() or 2) - 1))) as pool:
        out = list(pool.map(one, frames))
    tmp = out_webp.with_suffix(".tmp.webp")   # as save_webp, at this loop's own frame rate
    out[0].save(tmp, save_all=True, append_images=out[1:], duration=round(1000 / FLOW_FPS), loop=0, quality=80, method=2, kmax=1)
    os.replace(tmp, out_webp)
    return True
