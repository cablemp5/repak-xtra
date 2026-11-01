SCREEN_RIM = 0.9                 # strength of the edge band
SCREEN_RIM_LIGHT = (0.88, 0.47)  # where it comes from on the card: screen right, a little above (the scene's rim sun)
SCREEN_RIM_COLOR = (0.55, 0.85, 1.0)   # a cool white-cyan, before the skin's own rim colors tint it


def box_blur(a, r):
    """A (2r+1) square mean of a 2D array, edges repeated."""
    k = 2 * r + 1
    for axis in (0, 1):
        pad = [(0, 0), (0, 0)]; pad[axis] = (r + 1, r)
        c = np.cumsum(np.pad(a, pad, mode="edge"), axis=axis, dtype=np.float64)
        a = (np.take(c, range(k, c.shape[axis]), axis=axis) - np.take(c, range(0, c.shape[axis] - k), axis=axis)) / k
    return a


def rim_band(alpha, width, light=SCREEN_RIM_LIGHT, edge=0.72):
    """How much rim each pixel gets, 0 to 1: the silhouette's inner band (0.44 of `width` pixels), crisp, where the outline faces
    `light`. The direction comes from the alpha gradient, blurred as wide as the band so it holds across all of it. It is the
    figure's edge against the card, not its folds (the materials' own rims cover those)."""
    soft = box_blur(alpha, width)
    gy, gx = np.gradient(soft)
    mag = np.hypot(gx, gy)
    # Hard thresholds, not gradients: a flat cel band with a crisp inner edge. soft is 0.5 on the outline and rises to 1
    # over `width` pixels, so the default `edge` 0.72 puts the inner edge about 0.44 of the width in
    facing = np.clip(((-gx * light[0] - gy * light[1]) / np.maximum(mag, 1e-6) - 0.55) / 0.15, 0.0, 1.0)
    inside = np.clip((edge - soft) / 0.03, 0.0, 1.0)
    return alpha * inside * facing * np.clip(mag * 40.0, 0.0, 1.0)


def close_gaps(rgb, zone, r):
    """The dark pixels inside `zone` that have bright ones on both sides within 2r: the seam between the screen band, drawn over
    the black outline, and the material rim on the surface under it. Filled, so the rim reads as one band joined to the
    figure, not a line floating off it."""
    bright = (rgb @ np.array([0.3, 0.59, 0.11], np.float32) > 0.6).astype(np.float64)
    dilated = box_blur(bright, r) > 1e-6
    closed = box_blur(dilated.astype(np.float64), r) > 1 - 1e-6
    return closed & (bright == 0) & zone


def rim_tint(seen):
    """The scene's cool rim color, pulled halfway toward the average of the skin's own rim colors when it has them."""
    if RIM_OWN:
        return RIM_OWN[0]
    if not seen:
        return SCREEN_RIM_COLOR
    mean = np.mean(np.array(seen, np.float64), axis=0)
    mean = mean / max(mean.max(), 1e-6)
    return tuple(0.5 * np.array(SCREEN_RIM_COLOR) + 0.5 * mean)


def screen_rim(path):
    """Lay a directional rim along the figure's silhouette in the saved render: the graphic edge the lobby shows, which the
    scene's rim light and the materials' own rims only suggest. Pixels are read as stored (Non-Color, straight alpha), so
    nothing else in the picture changes."""
    if job.get("whole") or not RIM_ON:
        return
    img = bpy.data.images.load(path)
    img.colorspace_settings.name = "Non-Color"; img.alpha_mode = "CHANNEL_PACKED"
    w, h = img.size
    px = np.empty(w * h * 4, np.float32); img.pixels.foreach_get(px); px = px.reshape(h, w, 4)
    alpha, scale = px[..., 3].astype(np.float64), w / 640
    band = rim_band(alpha, max(2, round(11 * scale))) * SCREEN_RIM
    color = np.array(rim_tint(RIM_SEEN), np.float32)
    rgb = px[..., :3]
    # Screen blend: brightens without clipping white hair and armor
    rgb[:] = 1.0 - (1.0 - rgb) * (1.0 - color * band[..., None].astype(np.float32))
    fill = close_gaps(rgb, rim_band(alpha, max(2, round(16 * scale)), edge=0.78) > 0.5, max(2, round(2 * scale)))
    rgb[fill] = 1.0 - (1.0 - rgb[fill]) * (1.0 - color)
    img.pixels.foreach_set(px.ravel())
    img.file_format = "PNG"; img.filepath_raw = path
    img.save()
    bpy.data.images.remove(img)


DEPTH_SCALE = 2048.0   # scene units (cm) a 16-bit depth pixel spans in total
DEPTH_JUMP = 5.0       # cm of depth between neighbouring pixels that makes an edge (a flat or turning surface stays under it)


def interior_band(depth, alpha, width, light=SCREEN_RIM_LIGHT):
    """The pixels along an inside edge, 0 or 1: where a nearer surface ends in front of a farther one of the same figure, on
    the right or upper side (`light`'s side), `width` pixels deep into the nearer surface. depth is in cm, alpha is the
    figure's coverage (the silhouette against the card is rim_band's)."""
    def shifted(a, dy, dx, fill):
        """a moved by (dy, dx) like np.roll, but what wraps round the image edge is `fill`, not the opposite side."""
        r = np.roll(a, (dy, dx), (0, 1))
        for axis, n in ((0, dy), (1, dx)):
            if n:
                r[(slice(None),) * axis + ((slice(None, n),) if n > 0 else (slice(n, None),))] = fill
        return r

    solid = alpha > 0.5
    band = np.zeros(depth.shape, bool)
    for dy, dx in ((0, 1), (1, 0)):   # farther on the right, and farther above (row index grows upward)
        far = shifted(depth, -dy, -dx, -np.inf) - depth > DEPTH_JUMP   # the neighbour on that side is farther
        edge = far & solid & shifted(solid, -dy, -dx, False)
        for j in range(width):
            # the pixel j steps away from the edge, back into the nearer surface (the opposite way to the farther one)
            near = shifted(edge, -j * dy, -j * dx, False)
            same = np.abs(shifted(depth, -j * dy, -j * dx, np.inf) - depth) < DEPTH_JUMP
            band |= near & same & solid
    return band


def interior_rim(renders):
    """Light the inside edges of the last view's render: a second, depth-only render of the same camera (every surface
    black, its emission the distance from the camera, no outline or flames), then rim_band's colour on interior_band."""
    if job.get("whole") or not RIM_ON or not renders:
        return
    path = list(renders.values())[-1]
    for ob in bpy.data.objects:
        if ob.type == "MESH" and ob is not M:
            ob.hide_render = True
    if "outline" in M.modifiers:
        M.modifiers["outline"].show_render = False
    for mat in bpy.data.materials:
        b = next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None) if mat.node_tree else None
        if b is None:
            continue
        N, L = mat.node_tree.nodes, mat.node_tree.links
        for name, value in (("Base Color", (0, 0, 0, 1)), ("Metallic", 0.0), ("Specular IOR Level", 0.0), ("Coat Weight", 0.0), ("Sheen Weight", 0.0)):
            if name in b.inputs:
                for link in list(b.inputs[name].links):
                    L.remove(link)
                b.inputs[name].default_value = value
        if mat.name.endswith("_layer"):   # a blended hair layer would smear the depth: it is not a surface of its own
            b.inputs["Alpha"].default_value = 0.0
            for link in list(b.inputs["Alpha"].links):
                L.remove(link)
        z = N.new("ShaderNodeCameraData"); scale = N.new("ShaderNodeMath"); scale.operation = "DIVIDE"; scale.inputs[1].default_value = DEPTH_SCALE
        L.new(z.outputs["View Z Depth"], scale.inputs[0]); L.new(scale.outputs[0], b.inputs["Emission Color"])
        b.inputs["Emission Strength"].default_value = 1.0
    # Raw colours, 16 bit, few samples: the pixels are measurements, not a picture
    sc.view_settings.view_transform = "Raw"; sc.view_settings.look = "None"
    sc.render.image_settings.color_depth = "16"; sc.eevee.taa_render_samples = 4
    for light_ob in (key, fill, rim):
        light_ob.data.energy = 0
    bg.inputs[1].default_value = 0
    sc.render.filepath = path.replace(".png", "_depth.png")
    bpy.ops.render.render(write_still=True)
    d = bpy.data.images.load(sc.render.filepath)
    d.colorspace_settings.name = "Non-Color"; d.alpha_mode = "CHANNEL_PACKED"
    w, h = d.size
    px = np.empty(w * h * 4, np.float32); d.pixels.foreach_get(px); px = px.reshape(h, w, 4)
    depth, alpha = px[..., 0].astype(np.float64) * DEPTH_SCALE, px[..., 3].astype(np.float64)
    bpy.data.images.remove(d)
    os.remove(sc.render.filepath)
    band = interior_band(depth, alpha, max(2, round(3 * w / 640)))
    zone = face_zone()
    if zone:   # no inside edges on the face: the lids and lashes sit in front of the eyeballs and lit up white
        c = Vector(zone[0])
        a, b = world_to_camera_view(sc, cam, c), world_to_camera_view(sc, cam, c + (cam.matrix_world.to_3x3() @ Vector((1, 0, 0))) * zone[1] * 1.15)
        yy, xx = np.mgrid[:h, :w]
        band &= (xx - a.x * w) ** 2 + (yy - a.y * h) ** 2 > ((b.x - a.x) * w) ** 2
    img = bpy.data.images.load(path)
    img.colorspace_settings.name = "Non-Color"; img.alpha_mode = "CHANNEL_PACKED"
    px = np.empty(w * h * 4, np.float32); img.pixels.foreach_get(px); px = px.reshape(h, w, 4)
    rgb = px[..., :3]
    color = np.array(rim_tint(RIM_SEEN), np.float32)
    rgb[band] = 1.0 - (1.0 - rgb[band]) * (1.0 - color * SCREEN_RIM)
    img.pixels.foreach_set(px.ravel())
    img.file_format = "PNG"; img.filepath_raw = path
    img.save()
    bpy.data.images.remove(img)
