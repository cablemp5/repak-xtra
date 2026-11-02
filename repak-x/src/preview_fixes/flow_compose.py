

# repakxtra (preview_fixes/flow_compose.py, added to mod_previews): a render with crawling flow lines (flow_anim.py in the
# renderer) also becomes an animated <key>.webp, which the app shows over the still <key>.png


def bloom(e):
    """The kit's bloom of an emission pass: only the brightest light, a tight and a wide blur."""
    e = e.point(lambda v: max(0, v - 110) * 2)
    return ImageChops.add(ImageEnhance.Brightness(e.filter(ImageFilter.GaussianBlur(6))).enhance(0.9),
                          ImageEnhance.Brightness(e.filter(ImageFilter.GaussianBlur(26))).enhance(0.8))


def sheet_canvas(im):
    """One image on the portrait sheet at the saved size, as sheet() and save() lay a single image out."""
    w, h = SHEET
    canvas = Image.new("RGBA", SHEET, (0, 0, 0, 0))
    k = min(w / im.width, h / im.height)
    im = im.resize((max(1, int(im.width * k)), max(1, int(im.height * k))), Image.LANCZOS)
    canvas.alpha_composite(im, ((w - im.width) // 2, (h - im.height) // 2))
    return canvas.resize(OUT, Image.LANCZOS)


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
    base = Image.open(base_path).convert("RGBA")
    rgb0 = ImageEnhance.Color(ImageEnhance.Brightness(base.convert("RGB")).enhance(1.08)).enhance(1.2)   # as render_form's still
    alpha0 = base.getchannel("A")
    emit = Image.open(emit_path).convert("RGB") if emit_path.exists() else Image.new("RGB", base.size)
    out = []
    for f in frames:
        lines = Image.open(f).convert("RGB")
        glow = bloom(ImageChops.add(emit, lines))
        rgb = ImageChops.add(ImageChops.add(rgb0, lines), glow)
        rgb.putalpha(ImageChops.lighter(alpha0, glow.convert("L")))
        out.append(sheet_canvas(rgb))
    save_webp(out, out_webp)
    return True


# Self-check: a synthetic two-frame render makes a two-frame WebP the size of the saved previews
def _flow_check():
    import tempfile
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "view0"
        Image.new("RGBA", (64, 90), (10, 10, 10, 255)).save(f"{p}_front_noflow.png")
        for i in range(2):
            Image.new("RGB", (64, 90), (0, 200 * i, 180 * i)).save(f"{p}_front_flow_{i:02d}.png")
        assert flow_anim(str(p), Path(d) / "k.png")
        im = Image.open(Path(d) / "k.webp")
        assert im.n_frames == 2 and im.size == OUT, (im.n_frames, im.size)
        im.close()
