# Jelly galaxy skins (cosmic Black Panther on Moon Knight's jelly master), after the lobby shot: a deep navy, nearly black
# body with crisp white stars and small blue glints (stars added twice over the glow, runtime.py) and a soft blue-lilac
# sheen. The kit's read as a pale glossy teal with faint stars and two big blue lens flares.
JELLY_SKY, JELLY_GLOW = 0.4, 1.0    # share of galaxy over the painted skin, and its self-light (the kit's: 0.4, 0.55)
JELLY_DARK = 0.8                    # how far the painted skin is darkened, lit and glowing (the kit's 0.25, glow 0)
JELLY_ROUGH, JELLY_COAT = 0.25, 0.0  # a lilac sheen across the muscles, no coat (the kit's 0.25 coat drew sharp white streaks)
JELLY_NAVY, JELLY_NAVY_MIX = (0.02, 0.03, 0.07), 0.75   # the skin pulled this far toward the lobby's purple-navy (linear): its
                                                       # texture is teal with no red, the lobby's body is a navy with some
JELLY_SPEC = 0.7                    # highlight strength: with the tint below, the lobby's lilac sheen (about a tenth of the body is that bright)
JELLY_SPEC_TINT = (0.5, 0.5, 0.95, 1)   # reflections tinted deep blue-lilac: white ones off the gray studio washed the body gray-teal
JELLY_BODY_GLOW, JELLY_STAR_GLOW = 0.08, 2.0   # self-light of the body and of its stars, apart: the stars shine at full
                                              # strength over a dark body (one shared strength dimmed one with the other)
JELLY_BASE_DIM = 0.6   # the lit skin darkened this much more than its glow: deep shadows, the lobby body is nearly black in them
JELLY_DUST, JELLY_SPARKLE = 0.5, 0.3    # how much of the star dust and of the sparkle sprites a jelly skin's glow takes (the kit's x 1):
                                       # the lobby shows sparse white stars and faint glints, not a dense field and bright crosses
JELLY_DUST_GRAY = 0.7   # how much color the star dust loses: the lobby's stars are mostly white (StarTex4 is pink-red)
JELLY_STAR_SIZE = 0.55    # star fields' repeats on screen (the kit's x 1): fewer, larger white stars instead of a fine dust
JELLY_SPARKLE_SIZE = 2.5 # the blue sparkle sprites' (StarTex1) repeats (the kit's x 1): small blue glints instead of two big lens flares


FLAT = {}   # base texture path -> whether it is one flat color


def jelly(chain):
    """A jelly galaxy skin whose galaxy covers a flat or dark painted skin (cosmic Black Panther; Panther X's black suit with
    white hands outside its GalaxyMask): it gets the lobby's look in this file (navy, stars, sheen, constellation lines).
    A brightly painted one (King of the Cosmos's green, blue and purple) keeps the kit's."""
    return "jelly" in (chain.get("master") or "").lower() and (flat(chain) or dark_galaxy(chain))


DARK = {}   # (base, mask) texture paths -> whether the skin under the galaxy is dark
DARK_SKIN = 0.08   # linear luminance the brightest tenth of the galaxy's skin stays under to count as dark


def pixels(path):
    img = image(path, color=True)
    px = np.empty(len(img.pixels), np.float32); img.pixels.foreach_get(px)
    return px.reshape(img.size[1], img.size[0], img.channels)


def dark_galaxy(chain):
    """Whether the painted skin is dark where the GalaxyMask shows the galaxy: a black suit whose painted bright parts
    (white hands) sit outside the mask is a dark cosmic skin, not a painted one."""
    base, mask = game_png(chain["textures"].get("BaseColor") or chain["textures"].get("DiffuseTex")), galaxy_mask_png(chain)
    if base is None or mask is None:
        return False
    if (base, mask) not in DARK:
        b, m = pixels(base), pixels(mask)
        ys = np.arange(m.shape[0]) * b.shape[0] // m.shape[0]
        xs = np.arange(m.shape[1]) * b.shape[1] // m.shape[1]
        lum = b[ys][:, xs, :3] @ np.array([0.2126, 0.7152, 0.0722], np.float32)
        under = lum[m[..., 0] > 0.5]
        DARK[(base, mask)] = under.size > 0 and float(np.percentile(under, 90)) < DARK_SKIN
    return DARK[(base, mask)]


def galaxy_mask_png(chain):
    """The GalaxyMask texture when it limits the galaxy (not the engine's all-white default)."""
    ref = chain["textures"].get("GalaxyMask") or ""
    return None if ref.endswith("LinearWhite") else game_png(ref)


def galaxy_mask(socket, chain):
    """The GalaxyMask as a node output in `socket`'s material (white = galaxy), or None when the galaxy covers all of it."""
    path = galaxy_mask_png(chain)
    if path is None:
        return None
    t = socket.node.id_data.nodes.new("ShaderNodeTexImage"); t.image = image(path, color=False)
    return t.outputs[0]


def matte(chain):
    """An instance that turns every highlight off (no fake specular, matcap or cube map color): matte in game, so no sheen."""
    off = lambda name: max(vec(chain, name, (1.0, 1.0, 1.0))) < 0.01
    return off("FakeSpecularColorTint") and off("Matcap - Color") and float(chain["scalars"].get("CubeMapStrength", 1.0)) <= 0


def jelly_spec(chain):
    return (0.0 if matte(chain) else JELLY_SPEC) if jelly(chain) else 0.3


def jelly_rough(chain):
    return 1.0 if jelly(chain) and matte(chain) else JELLY_ROUGH if jelly(chain) else 0.22


# Painted jelly skins (White Fox's Cosmic Kumiho and King of the Cosmos): a jelly master with a brightly painted skin
# under its galaxy. They are drawn as Rotate in 3D draws them (viewer_jelly, at the end of this file)


def dark_space(chain):
    """A galaxy whose two colors are black: only its stars show, over the painted color."""
    return max(vec(chain, "GalaxyColorTex_Color1", (0.0, 0.09, 0.18)) + vec(chain, "GalaxyColorTex_Color2", (0.0, 0.16, 0.28))) < 0.01


def painted(chain):
    """A jelly galaxy skin with a brightly painted skin under its galaxy."""
    return "jelly" in (chain.get("master") or "").lower() and not jelly(chain)


def flat(chain):
    """Whether a jelly skin's painted skin is one flat color (cosmic Black Panther's CosmicFlat_D)."""
    path = game_png(chain["textures"].get("BaseColor") or chain["textures"].get("DiffuseTex"))
    if path is None:
        return True
    if path not in FLAT:
        img = image(path, color=True)
        px = np.empty(len(img.pixels), np.float32); img.pixels.foreach_get(px)
        FLAT[path] = float(px.reshape(-1, img.channels)[::53, :3].std(axis=0).max()) < 0.02
    return FLAT[path]


SPARSE_TILES = 4.0   # a sparse sparkle layer's cells per card height, over its _Size (Moon Knight's glow sprite, Size 0.5: 8)


GLOW_SPRITE = 0.05   # mean value of a sparkle texture from which it is a wide glow (T_Glow_1_001 0.10), not a small star (T_Star_19_061 0.015)
SPRITE = {}


def sparse(chain, key):
    """A jelly skin's glow sprite layer with a density under 1 (Moon Knight's T_Glow_1_001, 0.05): a few sprites, each in its
    own cell, not one sprite stretched over the card (the kit's tiling read the low density as one repeat). Small star
    sprites (cosmic Black Panther's) keep the kit's tiling. Every galaxy material: Celestial Soldier's two glow sprites,
    one repeat each, washed its chest and hair flat white."""
    if material_kind(chain) != "galaxy" or float(chain["scalars"].get(key + "_Density", 6.0)) >= 1.0:
        return False
    path = game_png(chain["textures"].get(key))
    if path is None:
        return False
    if path not in SPRITE:
        img = image(path, color=False)
        px = np.empty(len(img.pixels), np.float32); img.pixels.foreach_get(px)
        SPRITE[path] = float(px.reshape(-1, img.channels)[:, 0].mean()) >= GLOW_SPRITE
    return SPRITE[path]


def sparkle_tiles(chain, key, kit):
    return SPARSE_TILES / max(0.05, float(chain["scalars"].get(key + "_Size", 0.5))) if sparse(chain, key) else kit


def sparse_cells(N, L, win, mix, sparkle, key, tile, chain):
    """The sparkle kept in about Density of its cells (a fixed random pick per cell), dark in the rest."""
    if not sparse(chain, key):
        return sparkle
    mp = N.new("ShaderNodeMapping"); mp.inputs["Scale"].default_value = (tile * W / H, tile, 1)
    L.new(win, mp.inputs["Vector"])
    cell = N.new("ShaderNodeVectorMath"); cell.operation = "FLOOR"; L.new(mp.outputs[0], cell.inputs[0])
    noise = N.new("ShaderNodeTexWhiteNoise"); L.new(cell.outputs[0], noise.inputs["Vector"])
    keep = N.new("ShaderNodeMath"); keep.operation = "LESS_THAN"; L.new(noise.outputs["Value"], keep.inputs[0])
    keep.inputs[1].default_value = float(chain["scalars"][key + "_Density"])
    core = mix(mix(sparkle, sparkle, 1.0, "MULTIPLY"), sparkle, 1.0, "MULTIPLY")   # cubed: the cross, not its wide halo cut square by the cell
    return mix((0.0, 0.0, 0.0), core, keep.outputs[0])


def star_scale(chain):
    return JELLY_STAR_SIZE if jelly(chain) else 1.0


def sparkle_scale(chain):
    return JELLY_SPARKLE_SIZE if jelly(chain) else 1.0


def jelly_skin(mix, base_col, chain):
    """The painted skin as the lobby shows it: darkened, then pulled toward its purple-navy. Outside a GalaxyMask the
    painted skin stays as painted (Panther X's white hands)."""
    navy = mix(mix(base_col, (0.0, 0.0, 0.0), JELLY_DARK), JELLY_NAVY, JELLY_NAVY_MIX * navy_share(chain))
    mask = galaxy_mask(base_col, chain)
    return navy if mask is None else mix(base_col, navy, mask)


NAVY_FULL = 0.25   # galaxy color brightness (its brighter of GalaxyColorTex_Color1/2) from which the body takes the full navy


def navy_share(chain):
    """How much of the lobby navy a body takes: all of it with the game's galaxy colors (0.28 to 0.6), little when the skin
    sets them near black (Panther X's 0.06: a black body in game)."""
    peak = max(vec(chain, "GalaxyColorTex_Color1", (1.0, 1.0, 1.0)) + vec(chain, "GalaxyColorTex_Color2", (1.0, 1.0, 1.0)))
    return min(1.0, peak / NAVY_FULL)


JELLY_PAINT_GLOW = 0.6  # self-light of the painted skin outside a GalaxyMask: Panther X's white hands read luminous in game


def jelly_emission(mix, base_col, space, stars, chain):
    """The glow: the skin with its faint galaxy, dim, plus the stars at their own strength (JELLY_GLOW is 1, so these are
    the real strengths). Outside a GalaxyMask: no galaxy or stars, the painted skin glowing softly."""
    body = mix(mix(jelly_skin(mix, base_col, chain), space, JELLY_SKY), (0.0, 0.0, 0.0), 1.0 - JELLY_BODY_GLOW)
    lit = mix(stars, (0.0, 0.0, 0.0), 1.0 - min(1.0, JELLY_STAR_GLOW / 2))   # mixing caps at 1: added twice for up to 2
    glow = mix(body, mix(lit, lit, 1.0, "ADD"), 1.0, "ADD")
    mask = galaxy_mask(base_col, chain)
    return glow if mask is None else mix(mix(base_col, (0.0, 0.0, 0.0), 1.0 - JELLY_PAINT_GLOW), glow, mask)


def dust_gain(chain):
    return JELLY_DUST if jelly(chain) else 1.0


def sparkle_gain(chain):
    return JELLY_SPARKLE if jelly(chain) else 1.0


JELLY_LINES = []   # the constellation settings of a jelly skin in this render (its Dynamic* parameters), for constellations()
LINE_CELLS = 14    # cells across the card, one star of a constellation in each
LINE_LINK = 0.03   # chance a star links to each of four neighbours: a few short strokes, as in the lobby shot
LINE_STRENGTH = 0.7
LINE_DEEPEN = (0.45, 0.7, 1.0)   # the line color pulled to the deeper blue the lobby shows (its stored 6EC9FF reads pale)


def note_lines(chain):
    """Remember a jelly skin's line color, so the saved render gets its constellations."""
    if jelly(chain) and not JELLY_LINES:
        JELLY_LINES.append(vec(chain, "DynamicLineColor", (0.15, 0.58, 1.0)))


def segment_distance(xx, yy, a, b):
    """Each pixel's distance to the segment a-b (x, y in pixels)."""
    dx, dy = b[0] - a[0], b[1] - a[1]
    t = np.clip(((xx - a[0]) * dx + (yy - a[1]) * dy) / max(dx * dx + dy * dy, 1e-6), 0.0, 1.0)
    return np.hypot(xx - (a[0] + t * dx), yy - (a[1] + t * dy))


def constellation_lines(w, h, inside, seed=7):
    """The constellations as (start, end) pixel pairs: one star per grid cell at a fixed random spot, linked to some of its
    right and lower neighbours, kept where both ends are on the body (`inside(x, y)`). The same for every render of a size,
    as the game's sit fixed on screen."""
    rng = np.random.default_rng(seed)
    cell = w / LINE_CELLS
    cols, rows = LINE_CELLS, int(h / cell) + 1
    pts = (np.stack(np.meshgrid(np.arange(cols), np.arange(rows)), -1) + 0.2 + 0.6 * rng.random((rows, cols, 2))) * cell
    steps = ((0, 1), (1, 0), (1, 1), (1, -1))   # right, down and both diagonals: short strokes at any angle, not an L grid
    links = rng.random((rows, cols, len(steps))) < LINE_LINK
    out = []
    for r in range(rows):
        for c in range(cols):
            for k, (dr, dc) in enumerate(steps):
                nr, nc = r + dr, c + dc
                if nr < rows and 0 <= nc < cols and links[r, c, k]:
                    a, b = tuple(pts[r, c]), tuple(pts[nr, nc])
                    if inside(*a) and inside(*b):
                        out.append((a, b))
    return out


def constellations(path):
    """Thin blue constellation lines with a brighter star at each end, over a jelly skin in the saved render: the game draws
    them from its Dynamic* line parameters, the kit had none."""
    if not JELLY_LINES:
        return
    img = bpy.data.images.load(path)
    img.colorspace_settings.name = "Non-Color"; img.alpha_mode = "CHANNEL_PACKED"
    w, h = img.size
    px = np.empty(w * h * 4, np.float32); img.pixels.foreach_get(px); px = px.reshape(h, w, 4)
    body = box_blur((px[..., 3] > 0.9).astype(np.float64), max(4, w // 60)) > 0.999   # away from the outline
    zone, head = face_zone(), None
    if zone:   # none on the head, as in the lobby shot: the mask stays plain
        c0 = world_to_camera_view(sc, cam, Vector(zone[0]))
        c1 = world_to_camera_view(sc, cam, Vector(zone[0]) + cam.matrix_world.to_3x3() @ Vector((zone[1] * 1.3, 0, 0)))
        head = (c0.x * w, c0.y * h, (c1.x - c0.x) * w)
    off_head = lambda x, y: head is None or (x - head[0]) ** 2 + (y - head[1]) ** 2 > head[2] ** 2
    inside = lambda x, y: 0 <= int(y) < h and 0 <= int(x) < w and body[int(y), int(x)] and off_head(x, y)
    width, dot = max(0.8, 0.8 * w / 640), max(1.2, 1.5 * w / 640)
    c = np.array(JELLY_LINES[0], np.float32); c = c / max(float(c.max()), 1e-6)
    color = (c * np.array(LINE_DEEPEN, np.float32)) ** (1 / 2.2)   # sRGB, like the picture
    amount = np.zeros((h, w), np.float32)
    for a, b in constellation_lines(w, h, inside):
        x0, x1 = int(max(0, min(a[0], b[0]) - dot - 2)), int(min(w, max(a[0], b[0]) + dot + 3))
        y0, y1 = int(max(0, min(a[1], b[1]) - dot - 2)), int(min(h, max(a[1], b[1]) + dot + 3))
        yy, xx = np.mgrid[y0:y1, x0:x1]
        line = np.clip(width + 0.5 - segment_distance(xx, yy, a, b), 0, 1) * LINE_STRENGTH
        star = np.clip(dot + 0.5 - np.minimum(np.hypot(xx - a[0], yy - a[1]), np.hypot(xx - b[0], yy - b[1])), 0, 1)
        amount[y0:y1, x0:x1] = np.maximum(amount[y0:y1, x0:x1], np.maximum(line, star))
    k = (amount * (px[..., 3] > 0.5))[..., None]
    px[..., :3] = 1.0 - (1.0 - px[..., :3]) * (1.0 - color * k)
    img.pixels.foreach_set(px.ravel())
    img.file_format = "PNG"; img.filepath_raw = path
    img.save()
    bpy.data.images.remove(img)


def dust_color(mix, layer, chain):
    """A star dust layer, mostly white on a jelly skin."""
    return mix(layer, (0.5, 0.5, 0.5), JELLY_DUST_GRAY, "SATURATION") if jelly(chain) else layer


# The jelly galaxy master (King of the Cosmos, Cosmic Kumiho's body) drawn as Rotate in 3D draws it (viewer3d/toon.ts
# jellyGalaxyMaterial), which is how the game shows it: unlit. The painted color in the master's own three shade steps
# from its own light direction, its rim, a pin of fake highlight, and the galaxy added over it inside the GalaxyMask
# where the body faces the camera: smoke in the instance's two galaxy colors, plus the stars. Lit by the scene's suns
# and glowing at 0.85 on top, the painted color came out far over full brightness, pale lilac all over (the in-game
# shot of 2026-11-11 shows a green chest, blue thighs and lilac shins).
# shortcut: the master's matcap, cube map and subsurface noise are left out (black or unset on the skins seen so far),
# and the light direction is taken in the camera's frame, right for the card's front view
VIEWER_JELLY = True
JELLY_VIEW_GAIN = 1.6   # the kit's display curve (AgX) darkens midtones the viewer's film curve keeps: at 1 the body came out dim


def shade3(pos, colors, s2, s3):
    """The master's fake shade as color ramp stops [(g, (r, g, b))] over g 0 to 1: it is straight lines between them."""
    hi = min(pos[0], pos[1]); lo = min(hi, pos[2])
    w2, w3 = max((pos[0] - hi) * s2, 1e-4), max((hi - lo) * s3, 1e-4)
    stops = [(0.0, colors[2]), (lo, colors[2]), (min(lo + w3, hi), colors[1]), (hi, colors[1]), (min(hi + w2, 1.0), colors[0]), (1.0, colors[0])]
    out = []
    for g, c in stops:   # a ramp wants rising positions
        g = min(1.0, max(0.0, g))
        if out and g <= out[-1][0]:
            g = min(1.0, out[-1][0] + 1e-3)
        out.append((g, c))
    return out


def viewer_jelly(m, bsdf, N, L, mix, screen, tiles, base_col, stars, mask, chain):
    if not VIEWER_JELLY or base_col is None or not painted(chain):
        return
    c = with_defaults(chain)
    num = lambda k, d: float(c["scalars"].get(k, d))

    def calc(op, a, b=None, clamp=False):
        n = N.new("ShaderNodeMath"); n.operation = op; n.use_clamp = clamp
        for sock, v in ((n.inputs[0], a), (n.inputs[1], b)):
            if v is None:
                continue
            if isinstance(v, (int, float)):
                sock.default_value = v
            else:
                L.new(v, sock)
        return n.outputs[0]

    def smooth(value, lo, hi):
        n = N.new("ShaderNodeMapRange"); n.interpolation_type = "SMOOTHSTEP"
        n.inputs["From Min"].default_value, n.inputs["From Max"].default_value = lo, hi
        L.new(value, n.inputs["Value"])
        return n.outputs["Result"]

    def parts(color):
        s = N.new("ShaderNodeSeparateColor"); L.new(color, s.inputs[0]); return s.outputs

    cam = N.new("ShaderNodeVectorTransform"); cam.vector_type = "NORMAL"; cam.convert_from = "WORLD"; cam.convert_to = "CAMERA"
    L.new(N.new("ShaderNodeNewGeometry").outputs["Normal"], cam.inputs[0])

    def toward(v):   # the normal's dot with a direction in the camera's frame (right, up, toward the camera)
        k = math.sqrt(sum(x * x for x in v)) or 1.0
        d = N.new("ShaderNodeVectorMath"); d.operation = "DOT_PRODUCT"; L.new(cam.outputs[0], d.inputs[0])
        d.inputs[1].default_value = tuple(x / k for x in v)
        return d.outputs["Value"]

    # the fake shade: half-lambert against the master's own light direction, through its three steps
    dl = vec(c, "ShadowLightDirection", (0.5, 0.5, 0.0))
    g = N.new("ShaderNodeMath"); g.operation = "MULTIPLY_ADD"; g.inputs[1].default_value = 0.5; g.inputs[2].default_value = 0.5
    L.new(toward((dl[0], dl[2], dl[1])), g.inputs[0])
    ramp = N.new("ShaderNodeValToRGB"); ramp.color_ramp.interpolation = "LINEAR"
    stops = shade3([num("Shadow - ShadePos1", 0.9), num("Shadow - ShadePos2", 0.5), num("Shadow - ShadePos3", 0.2)],
                   [vec(c, "Shadow - ShadeColor1", (0.75, 0.75, 0.75)), vec(c, "Shadow - ShadeColor2", (0.177, 0.177, 0.177)), vec(c, "Shadow - ShadeColor3", (0.0, 0.0, 0.0))],
                   num("Shadow - ShadeSmoothness2", 0.5), num("Shadow - ShadeSmoothness3", 0.5))
    el = ramp.color_ramp.elements   # Blender keeps them sorted as they move: the two it starts with stay at the ends
    el[0].position, el[0].color = 0.0, (*stops[0][1], 1)
    el[1].position, el[1].color = 1.0, (*stops[-1][1], 1)
    for x, col in stops[1:-1]:
        el.new(x).color = (*col, 1)
    L.new(g.outputs[0], ramp.inputs[0])
    tint = vec(c, "BaseTint", (1.0, 1.0, 1.0))
    albedo = base_col if max(abs(x - 1.0) for x in tint) < 1e-3 else mix(base_col, tint, 1.0, "MULTIPLY")
    total = mix(albedo, ramp.outputs["Color"], 1.0, "MULTIPLY")
    # a pin of highlight between the view and the master's fake light
    fd = vec(c, "FakeSpecularDir", (0.0, 0.0, -1.0))
    spot = calc("POWER", calc("MAXIMUM", toward((fd[0], fd[2], fd[1] + 1.0)), 0.0), max(1000 - 980 * num("FakeSpecularRoughness", 0.0), 1.0))
    total = mix(total, mix((0.0, 0.0, 0.0), vec(c, "FakeSpecularColorTint", (1.0, 1.0, 1.0)), spot), 1.0, "ADD")
    # the rim, toward the silhouette
    lw = N.new("ShaderNodeLayerWeight"); lw.inputs["Blend"].default_value = 0.5   # Facing: 1 - N.V
    edge = lw.outputs["Facing"]
    rim = smooth(calc("POWER", calc("MAXIMUM", edge, 1e-4), num("RimFresnelPower", 3.0)), 0.0, max(1 - num("RimRange", 0.2), 1e-3))
    total = mix(total, mix((0.0, 0.0, 0.0), vec(c, "RimLightColor", (0.02, 0.1, 0.2)), rim), 1.0, "ADD")
    # the galaxy seen through the body: smoke in the two galaxy colors, and the stars
    galaxy = None
    g1 = screen("GalaxyTex1", tiles("GalaxyTex1_Size", 0.1), color=True)
    if g1 is not None:
        p1 = num("GalaxyTex1_Power", 1.0)
        if abs(p1 - 1.0) > 1e-3:   # the smoke's own contrast, each channel raised to it
            gm = N.new("ShaderNodeGamma"); gm.inputs["Gamma"].default_value = p1; L.new(g1, gm.inputs["Color"]); g1 = gm.outputs[0]
        field = screen("GalaxyColorTex", tiles("GalaxyColorTex_Size", 0.2))
        cm = calc("POWER", parts(field)[0], num("GalaxyColorTex_Power", 1.0), clamp=True) if field is not None else 1.0
        colors = mix(vec(c, "GalaxyColorTex_Color2", (0.0, 0.041, 1.0)), vec(c, "GalaxyColorTex_Color1", (0.8, 0.054, 0.133)), cm)
        galaxy = mix(g1, colors, 1.0, "MULTIPLY")
        g2 = screen("GalaxyTex2", tiles("GalaxyTex2_Size", 0.2))
        if g2 is not None:
            galaxy = mix((0.0, 0.0, 0.0), galaxy, calc("POWER", parts(g2)[0], num("GalaxyTex2_Power", 5.0), clamp=True))
    if not isinstance(stars, tuple):
        galaxy = stars if galaxy is None else mix(galaxy, stars, 1.0, "ADD")
    if galaxy is not None:
        # full where the body faces the camera, gone toward its edges, and only on the GalaxyMask
        gate = smooth(calc("MULTIPLY", calc("SUBTRACT", 0.65, calc("SQRT", edge)), 5.0), 0.0, 1.0)
        if mask is not None:
            gate = calc("MULTIPLY", gate, parts(mask)[1])
        galaxy = mix((0.0, 0.0, 0.0), galaxy, gate)
    em, strength = bsdf.inputs["Emission Color"], bsdf.inputs["Emission Strength"]
    for link in list(em.links):
        L.remove(link)
    # the glow pass blooms only the galaxy (keep_glow remembers it), not the whole unlit body
    if galaxy is not None:
        L.new(galaxy, em)
        total = mix(total, galaxy, 1.0, "ADD")
    else:
        em.default_value = (0.0, 0.0, 0.0, 1)
    strength.default_value = 1.0
    keep_glow(m, bsdf)
    k = num("FakeSpecularNormalStrength", 1.0) * JELLY_VIEW_GAIN
    if abs(k - 1.0) > 1e-3:
        total = mix(total, (k, k, k), 1.0, "MULTIPLY")
    for link in list(em.links):
        L.remove(link)
    L.new(total, em)
    # unlit: the Principled adds nothing of its own
    base = bsdf.inputs["Base Color"]
    for link in list(base.links):
        L.remove(link)
    base.default_value = (0.0, 0.0, 0.0, 1)
    bsdf.inputs["Specular IOR Level"].default_value = 0.0
    bsdf.inputs["Coat Weight"].default_value = 0.0
