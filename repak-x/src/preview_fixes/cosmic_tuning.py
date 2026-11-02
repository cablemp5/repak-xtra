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
    """A jelly galaxy skin with a flat-colored painted skin (cosmic Black Panther): it gets the lobby's look in this file
    (navy, stars, sheen, constellation lines). A painted one (King of the Cosmos's green, blue and purple) keeps the kit's."""
    return "jelly" in (chain.get("master") or "").lower() and flat(chain)


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


def star_scale(chain):
    return JELLY_STAR_SIZE if jelly(chain) else 1.0


def sparkle_scale(chain):
    return JELLY_SPARKLE_SIZE if jelly(chain) else 1.0


def jelly_skin(mix, base_col, chain):
    """The painted skin as the lobby shows it: darkened, then pulled toward its purple-navy."""
    return mix(mix(base_col, (0.0, 0.0, 0.0), JELLY_DARK), JELLY_NAVY, JELLY_NAVY_MIX)


def jelly_emission(mix, base_col, space, stars, chain):
    """The glow: the skin with its faint galaxy, dim, plus the stars at their own strength (JELLY_GLOW is 1, so these are
    the real strengths)."""
    body = mix(mix(jelly_skin(mix, base_col, chain), space, JELLY_SKY), (0.0, 0.0, 0.0), 1.0 - JELLY_BODY_GLOW)
    lit = mix(stars, (0.0, 0.0, 0.0), 1.0 - min(1.0, JELLY_STAR_GLOW / 2))   # mixing caps at 1: added twice for up to 2
    return mix(body, mix(lit, lit, 1.0, "ADD"), 1.0, "ADD")


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
