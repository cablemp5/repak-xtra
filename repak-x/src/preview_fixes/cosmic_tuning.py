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


SHELL_RIM = []   # a jelly skin's own silhouette rim color (RimLightColor at full RimRange, Panther X's white), for screen_rim
SHELL_RIM_MIN = 0.8   # every channel this bright: a white rim the skin asks for, not the master's tinted fresnel


def note_shell_rim(chain):
    c = vec(chain, "RimLightColor", (0.0, 0.0, 0.0))
    if not SHELL_RIM and min(c) >= SHELL_RIM_MIN and float(chain["scalars"].get("RimRange", 0.0)) >= 1.0:
        SHELL_RIM.append(tuple(x / max(c) for x in c))


# Painted jelly skins (White Fox's Cosmic Kumiho and King of the Cosmos, after their store shots): the painted colors show
# light and soft, glowing, with the galaxy faint over them. The kit's (0.4 galaxy, glow 0.55) drew them dim and deep
PAINTED_LOOK = (0.35, 0.85)   # share of galaxy over the painted skin, and its glow: swirls on King of the Cosmos's bright skin
PAINTED_LOOK_FOX = (0.2, 1.8)   # White Fox's darker lilac glows harder, the galaxy fainter
PAINTED_SOFT = 0.3   # color they lose: the store shots' colors are soft, the render's light and AgX deepened them
PAINTED_WARM = (1.0, 0.68, 0.75)   # White Fox's lilac warmed: the render's light turned it periwinkle blue (King of the
                                   # Cosmos's green and blue keep their hue)


def painted(chain):
    """A jelly galaxy skin with a brightly painted skin under its galaxy."""
    return "jelly" in (chain.get("master") or "").lower() and not jelly(chain)


def painted_look(chain):
    return PAINTED_LOOK_FOX if "/Characters/1060/" in chain["chain"][0] else PAINTED_LOOK


def painted_skin(mix, base_col, chain):
    """A painted jelly skin's color, softened (White Fox's also warmed); any other skin's as it is."""
    if not painted(chain):
        return base_col
    if "/Characters/1060/" in chain["chain"][0]:
        base_col = mix(base_col, PAINTED_WARM, 1.0, "MULTIPLY")
    return mix(base_col, (0.5, 0.5, 0.5), PAINTED_SOFT, "SATURATION")


def painted_emission(mix, base_col, space, stars, chain):
    """A painted jelly skin's glow: its warmed painted color with a faint galaxy, plus the stars."""
    return mix(mix(painted_skin(mix, base_col, chain), space, painted_look(chain)[0]), stars, 1.0, "ADD")


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
    sprites (cosmic Black Panther's) keep the kit's tiling."""
    if not jelly(chain) or float(chain["scalars"].get(key + "_Density", 6.0)) >= 1.0:
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
    note_shell_rim(chain)
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
