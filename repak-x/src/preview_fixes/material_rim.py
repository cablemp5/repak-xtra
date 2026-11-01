import json
import re

RIM_SEEN = []        # the rim colors this render's materials carry, for the screen-space rim
RIM_OWN = []         # a fire body's own rim color: the screen rim takes it whole instead of tinting the cool default
RIM_COLOR = (0.45, 0.80, 1.0)    # the lobby's cool rim on every skin (linear), when its master gives none
RIM_FLOOR = 0.6      # a master's own rim keeps its hue but never reads dimmer than this (their values are 0.02 to 0.3)
RIM_LIGHT = (0.85, 0.35, 0.40)   # camera space x, y, z: screen right, a little up, toward the camera
RIM_EDGE = 0.62      # (1 - N.V) above which a surface is on the rim: about the outer tenth of a body's width
RIM_SIDE = 0.62      # how far round to the lit side the rim reaches (0 to 1 over the half-lambert of N.RIM_LIGHT)
RIM_HARD = 0.03      # width of both thresholds: a crisp cel edge, not a glow
RIM_GAIN = 2.5       # brightness of the flat rim color
RIM_SKIP = re.compile(r"(?i)(^|_)(head|face|eye\w*|teeth|tooth|lash\w*|brow\w*|tongue|mouth)(_|\d|$)")   # faces: a hard rim on lids, nostrils and lips reads as white specks


def with_defaults(chain):
    """The chain with its master's default colors and scalars under the instances' own. The kit's renderer reads only the
    instance values, so a master default of 0 (AOIntensity, EmissiveStrength) or 1.94 (CubeMap_Width) was replaced by a
    guess."""
    if not chain:
        return chain
    d = chain.get("defaults", {})
    return {**chain, "vectors": {**d.get("vectors", {}), **chain.get("vectors", {})},
            "scalars": {**d.get("scalars", {}), **chain.get("scalars", {})}}


def rim_params(vectors, scalars):
    """The rim color a material shows, or None for a master that uses the rim names for another effect (crystal glow: a
    RimLightColor with fresnel power 0). It is the master's RimLightColor lifted to RIM_FLOOR, or the lobby's cool RIM_COLOR
    when the master's is black, which is most of them (Black Panther's suit)."""
    if "RimLightColor" in vectors and float(scalars.get("RimFresnelPower", 0.0)) <= 0:
        return None
    c = vectors.get("RimLightColor")
    peak = max(c["R"], c["G"], c["B"]) if c else 0.0
    return tuple(x * max(peak, RIM_FLOOR) / peak for x in (c["R"], c["G"], c["B"])) if peak > 0.01 else RIM_COLOR


def keep_glow(m, bsdf):
    """Remember the material's own glow before a rim or highlight is added to it. The kit's glow pass (every surface black,
    only emission left) must not see what was added: it would render a pass for every hero and bloom the rims."""
    em = bsdf.inputs["Emission Color"]
    src = [em.links[0].from_node.name, em.links[0].from_socket.identifier] if em.is_linked else None
    m["added_glow"] = json.dumps({"src": src, "color": list(em.default_value), "strength": bsdf.inputs["Emission Strength"].default_value})


def drop_added_glow():
    """Put every material's emission back to what it was before keep_glow, for the kit's glow pass. The studio panels go dark too."""
    for ob in STUDIO:
        ob.data.energy = 0
    for m in bpy.data.materials:
        saved = m.get("added_glow")
        bsdf = next((n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None) if saved and m.node_tree else None
        if bsdf is None:
            continue
        saved = json.loads(saved)
        em = bsdf.inputs["Emission Color"]
        for link in list(em.links):
            m.node_tree.links.remove(link)
        if saved["src"]:
            node = m.node_tree.nodes[saved["src"][0]]
            m.node_tree.links.new(next(o for o in node.outputs if o.identifier == saved["src"][1]), em)
        em.default_value = saved["color"]
        bsdf.inputs["Emission Strength"].default_value = saved["strength"]


def face_zone():
    """The sphere (center, radius) around the head where a material gets no rim: a hard rim on eyelids, lashes, nostrils and
    lips reads as white specks, and which material a lid belongs to differs per skin (Rogue's are in her body's). The head
    bone's middle, out to its length, covers the face and a little of the neck. None without a head bone."""
    bone = A.pose.bones.get("head")
    if bone is None:
        return None
    head, tail = A.matrix_world @ bone.head, A.matrix_world @ bone.tail
    return tuple((head + tail) / 2), max(8.0, (tail - head).length)


def add_rim(m, tex, vectors, scalars, hair=False):
    """The lobby's rim as a flat, hard-edged band: where the surface turns away from the camera (RIM_EDGE) on the side that
    faces RIM_LIGHT in camera space (RIM_SIDE), in one bright color, like a cel-shaded highlight. It is cut from the smooth
    geometry normal, so a normal map does not break its edge, and added to the emission so it holds on dark and metal
    materials."""
    color = rim_params(vectors, scalars) if RIM_ON else None
    bsdf = next((n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if color is None or bsdf is None:
        return
    N, L = m.node_tree.nodes, m.node_tree.links
    normal = N.new("ShaderNodeNewGeometry").outputs["Normal"]

    def step(value, lo):
        n = N.new("ShaderNodeMapRange")
        n.inputs["From Min"].default_value, n.inputs["From Max"].default_value = lo, lo + RIM_HARD
        L.new(value, n.inputs["Value"])
        return n.outputs["Result"]

    def mul(a, b):
        n = N.new("ShaderNodeMath"); n.operation = "MULTIPLY"; L.new(a, n.inputs[0]); L.new(b, n.inputs[1])
        return n.outputs[0]

    lw = N.new("ShaderNodeLayerWeight"); lw.inputs["Blend"].default_value = 0.5; L.new(normal, lw.inputs["Normal"])   # Facing: 1 - N.V
    amount = step(lw.outputs["Facing"], RIM_EDGE)
    cam = N.new("ShaderNodeVectorTransform"); cam.vector_type = "NORMAL"; cam.convert_from = "WORLD"; cam.convert_to = "CAMERA"
    L.new(normal, cam.inputs[0])
    toward = N.new("ShaderNodeVectorMath"); toward.operation = "DOT_PRODUCT"; L.new(cam.outputs[0], toward.inputs[0])
    toward.inputs[1].default_value = RIM_LIGHT
    half = N.new("ShaderNodeMath"); half.operation = "MULTIPLY_ADD"; half.inputs[1].default_value = 0.5; half.inputs[2].default_value = 0.5
    L.new(toward.outputs["Value"], half.inputs[0])
    amount = mul(amount, step(half.outputs[0], RIM_SIDE))
    zone = None if hair else face_zone()
    if zone:   # fades to none inside the face sphere, over the next 20 percent of its radius
        pos = N.new("ShaderNodeNewGeometry").outputs["Position"]
        dist = N.new("ShaderNodeVectorMath"); dist.operation = "DISTANCE"; L.new(pos, dist.inputs[0]); dist.inputs[1].default_value = zone[0]
        away = N.new("ShaderNodeMapRange"); away.inputs["From Min"].default_value = zone[1]; away.inputs["From Max"].default_value = zone[1] * 1.2
        L.new(dist.outputs["Value"], away.inputs["Value"])
        amount = mul(amount, away.outputs["Result"])
    mask = game_png((tex or {}).get("RimLightMask"))
    if mask:
        t = N.new("ShaderNodeTexImage"); t.image = image(mask, color=False)
        sep = N.new("ShaderNodeSeparateColor"); L.new(t.outputs[0], sep.inputs[0])
        amount = mul(amount, sep.outputs[0])
    total = N.new("ShaderNodeVectorMath"); total.operation = "SCALE"; total.inputs[0].default_value = tuple(c * RIM_GAIN for c in color)
    L.new(amount, total.inputs["Scale"])

    # Added to whatever glow the material has; its strength folds into the colors so the rim is not scaled by it
    em, strength = bsdf.inputs["Emission Color"], bsdf.inputs["Emission Strength"]
    keep_glow(m, bsdf)
    RIM_SEEN.append(color)
    if em.is_linked or strength.default_value > 0:
        own = N.new("ShaderNodeVectorMath"); own.operation = "SCALE"; own.inputs[0].default_value = tuple(em.default_value[:3])
        if em.is_linked:
            L.new(em.links[0].from_socket, own.inputs[0])
        own.inputs["Scale"].default_value = strength.default_value
        both = N.new("ShaderNodeVectorMath"); both.operation = "ADD"
        L.new(own.outputs[0], both.inputs[0]); L.new(total.outputs[0], both.inputs[1])
        total = both
    L.new(total.outputs[0], em)
    strength.default_value = 1.0


def fix_material(kind, name, info, chain):
    """One slot's material: the kit's builder for it, from the chain with its master defaults, and the master's rim."""
    special = {"galaxy": galaxy_material, "torch": torch_body_material}.get(kind)
    if special:
        if kind == "torch":   # the silhouette rim of a burning body is its fire's color
            c = vec(chain, "Color_Fresnel", (1.0, 0.37, 0.05))
            RIM_OWN[:] = [tuple(x / max(max(c), 1e-6) for x in c)]
        return special(name, info, chain)
    layer = layer_kind(name, info, chain)
    if layer:
        return layer_material(name, info, chain, layer)
    chain = with_defaults(chain)
    m = game_material(name, info, chain)
    par = info.get("Parameters", {})
    vectors = {**(chain or {}).get("vectors", {}), **par.get("Colors", {})}
    scalars = {**(chain or {}).get("scalars", {}), **par.get("Scalars", {})}
    tex = {**(chain or {}).get("textures", {}), **info.get("Textures", {})}
    # Not on eyes (their own recipe), fur shells or flat gems: the rim there is another effect
    if not RIM_SKIP.search(name) and "IrisBaseColor" not in tex and "IrisUVRadius" not in scalars and "Pattern_Map" not in tex:
        add_rim(m, tex, vectors, scalars, hair=bool(re.search(r"(?i)hair", name)))
    return m
