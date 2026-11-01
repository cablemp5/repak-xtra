RIM_SUN = 2.5                       # energy of the scene's rim light (the kit's is 7 in pale blue): a teal wash on the right
RIM_SUN_COLOR = (0.35, 0.85, 0.9)
STUDIO = []                         # the panel lights, so the glow pass can switch them off
PANELS = (   # name, color, sun-equivalent strength, size (width, height) in figure heights, position in figure heights (right, toward camera, up) from its middle
    ("studio_top", (1.0, 0.97, 0.92), 0.12, (0.9, 0.9), (0.15, 0.55, 1.45)),    # a big soft box above and in front: highlights on glossy shoulders, helmets, trims
    ("studio_edge", (0.8, 0.95, 1.0), 0.2, (0.18, 1.3), (0.95, -0.6, 0.0)),    # a tall strip behind on the right: the white edge on glossy parts
)


def studio_lights():
    """The panels, made once. They are lit area lights, so a glossy surface shows each one's shape as a reflection, the way a
    photo studio's softboxes show in a helmet. Each view places them (place_studio)."""
    for name, color, _, _, _ in PANELS:
        ld = bpy.data.lights.new(name, "AREA"); ld.shape = "RECTANGLE"; ld.color = color
        ob = bpy.data.objects.new(name, ld); sc.collection.objects.link(ob); STUDIO.append(ob)
    return STUDIO


def place_studio(lights, d, rt):
    """Put the panels around the figure for a camera looking along -d with right rt, aimed at its middle. Power is in watts,
    so it grows with the square of the distance: a panel is sized as a strength a sun of that number would have there."""
    mid, h = Vector(P.mean(axis=0).tolist()), z_hi - z_lo
    for ob, (_, _, strength, (sw, sh), (r, t, u)) in zip(lights, PANELS):
        at = mid + rt * (r * h) + d * (t * h) + Vector((0, 0, u * h))
        ob.location = at
        ob.rotation_euler = (mid - at).to_track_quat("-Z", "Y").to_euler()
        ob.data.size, ob.data.size_y = sw * h, sh * h
        ob.data.energy = strength * 40.0 * (at - mid).length ** 2
