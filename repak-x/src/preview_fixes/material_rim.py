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


FLOW_GLOW_MAX = 4.0   # the flow glow's strength cap (HDR game values bloom to white): the pulses' peaks run hot (2.5 read dull)
FLOW_GLOW_DIM = 0.0    # a line between the noise's bright stretches: black, as the suit is in game (any floor read as a
                       # dark tint of the line color at the 4.0 cap). No hard cuts: FLOW_NOISE_LOW fades it out smoothly
FLOW = []   # each flow-lined material's switches for the animated preview (flow_frames): its noise mapping, a gate on the
            # lines, a keep on its other glow, and how far the noise travels in one loop
FLOW_CORE = (0.28, 0.75)  # mask values from dark to full glow: below the first nothing glows (the falloff around a line)
FLOW_NOISE_TOP = 0.85     # noise at or above this lights a line fully: only the noise's peaks, so bright stretches travel
                          # along dimmer lines (0.5 left most of every line at full glow in every frame: the loop looked still)
FLOW_NOISE_LOW = 0.15     # noise at or below this leaves a line black; between the two a smoothstep fade, so a pulse
                          # tapers into the dark instead of breaking off (the master's sharper power cut lines on rainbow mods)


def add_flow_glow(m, tex, vectors, scalars):
    """The body master's flowing light lines (FX_UseFlowNoise: Black Panther MCU's suit lines, recolored by mods through
    FX_FlowNoiseColor), which the kit never drew: FX_FlowMask in that color, added to any glow already there. In game the
    lines crawl with FX_FlowTex: the still is one frame, flow_frames renders the loop."""
    path = game_png(tex.get("FX_FlowMask"))
    c = vectors.get("FX_FlowNoiseColor")
    if not path or not c or float(scalars.get("FlowNoiseSwitch", 0)) < 0.5 or max(c["R"], c["G"], c["B"]) <= 0.01:
        return
    nt = m.node_tree; N, L = nt.nodes, nt.links
    bsdf = next(n for n in N if n.type == "BSDF_PRINCIPLED")
    peak = max(c["R"], c["G"], c["B"])
    t = N.new("ShaderNodeTexImage"); t.image = image(path, color=False)
    # Only the lines' cores: the mask's soft falloff around them, glowing faintly, tinted the black suit teal between them
    core = N.new("ShaderNodeMapRange"); core.inputs["From Min"].default_value, core.inputs["From Max"].default_value = FLOW_CORE
    # Measured on the mask's brightest channel and keeping its own color: a colored mask (rainbow line mods paint every
    # line its hue, FX_FlowNoiseColor white) read on red alone lost its green and blue lines and came out white
    msep = N.new("ShaderNodeSeparateColor"); L.new(t.outputs[0], msep.inputs[0])
    top = N.new("ShaderNodeMath"); top.operation = "MAXIMUM"; L.new(msep.outputs[0], top.inputs[0]); L.new(msep.outputs[1], top.inputs[1])
    top2 = N.new("ShaderNodeMath"); top2.operation = "MAXIMUM"; L.new(top.outputs[0], top2.inputs[0]); L.new(msep.outputs[2], top2.inputs[1])
    L.new(top2.outputs[0], core.inputs["Value"])
    hue = N.new("ShaderNodeMath"); hue.operation = "DIVIDE"; L.new(core.outputs[0], hue.inputs[0]); L.new(top2.outputs[0], hue.inputs[1])
    safe = N.new("ShaderNodeMath"); safe.operation = "MINIMUM"; L.new(hue.outputs[0], safe.inputs[0]); safe.inputs[1].default_value = 1e4   # a black texel divides by 0
    tinted = N.new("ShaderNodeMix"); tinted.data_type = "RGBA"; tinted.blend_type = "MULTIPLY"; tinted.inputs[0].default_value = 1
    L.new(t.outputs[0], tinted.inputs[6]); L.new(safe.outputs[0], tinted.inputs[7])   # the mask's color at the core's strength
    lines = N.new("ShaderNodeMix"); lines.data_type = "RGBA"; lines.blend_type = "MULTIPLY"; lines.inputs[0].default_value = 1
    L.new(tinted.outputs[2], lines.inputs[6]); lines.inputs[7].default_value = (c["R"] / peak, c["G"] / peak, c["B"] / peak, 1)
    # The lines are not even in game: FX_FlowTex's noise (tiled by FlowTex_UVTile, sharpened by FlowNoisePower) runs along
    # them, bright stretches and dim ones. One frame of it, kept above FLOW_GLOW_DIM so no line goes out
    noise = game_png(tex.get("FX_FlowTex"))
    if noise:
        tile = vectors.get("FlowTex_UVTile") or {"R": 1.0, "G": 1.0}
        uv = N.new("ShaderNodeTexCoord")
        img = image(noise, color=False)

        def sample():
            mp_ = N.new("ShaderNodeMapping")
            mp_.inputs["Scale"].default_value = (float(tile["R"]) or 1.0, float(tile["G"]) or 1.0, 1.0)
            L.new(uv.outputs["UV"], mp_.inputs["Vector"])
            tx = N.new("ShaderNodeTexImage"); tx.image = img; L.new(mp_.outputs[0], tx.inputs[0])
            return mp_, tx
        # Two samples of the noise cross-faded (flow_anim.py moves both and the fade): the loop can crawl a short way and
        # still end where it began, where one sample had to travel a whole tile (too fast)
        mp, tx1 = sample()
        mp2, tx2 = sample()
        blend = N.new("ShaderNodeValue"); blend.outputs[0].default_value = 0.0
        both = N.new("ShaderNodeMix"); both.data_type = "RGBA"; L.new(blend.outputs[0], both.inputs[0])
        L.new(tx1.outputs[0], both.inputs[6]); L.new(tx2.outputs[0], both.inputs[7])
        sep = N.new("ShaderNodeSeparateColor"); L.new(both.outputs[2], sep.inputs[0])
        pw = N.new("ShaderNodeMath"); pw.operation = "POWER"; L.new(sep.outputs[0], pw.inputs[0])
        pw.inputs[1].default_value = max(1.0, float(scalars.get("FlowNoisePower", 1.0)) * 0.6)   # softer than the master's: the fade does the shaping
        rng = N.new("ShaderNodeMapRange"); rng.interpolation_type = "SMOOTHSTEP"; L.new(pw.outputs[0], rng.inputs["Value"])
        rng.inputs["From Min"].default_value = FLOW_NOISE_LOW; rng.inputs["From Max"].default_value = FLOW_NOISE_TOP
        rng.inputs["To Min"].default_value = FLOW_GLOW_DIM
        vary = N.new("ShaderNodeMix"); vary.data_type = "RGBA"; vary.blend_type = "MULTIPLY"; vary.inputs[0].default_value = 1
        L.new(lines.outputs[2], vary.inputs[6]); L.new(rng.outputs[0], vary.inputs[7])
        lines = vary
        pulse = rng.outputs[0]
    else:
        mp = pulse = None
    gate = N.new("ShaderNodeValue"); gate.outputs[0].default_value = 1.0   # 0: no lines (the animated preview's base)
    gated = N.new("ShaderNodeMix"); gated.data_type = "RGBA"; gated.blend_type = "MULTIPLY"; gated.inputs[0].default_value = 1
    L.new(lines.outputs[2], gated.inputs[6]); L.new(gate.outputs[0], gated.inputs[7])
    lines = gated
    keep = N.new("ShaderNodeValue"); keep.outputs[0].default_value = 1.0   # 0: the lines alone (the animated preview's frames)
    strength = min(FLOW_GLOW_MAX, max(1.0, float(scalars.get("FlowMaskIntensity", 1.0)) * float(scalars.get("FlowNoiseIntensity", 1.0)) * 0.6))
    em = bsdf.inputs["Emission Color"]
    if em.is_linked:   # an Emissive glow is there: add the lines at their own strength relative to it
        kept = N.new("ShaderNodeMix"); kept.data_type = "RGBA"; kept.blend_type = "MULTIPLY"; kept.inputs[0].default_value = 1
        L.new(em.links[0].from_socket, kept.inputs[6])
        if pulse is None:
            L.new(keep.outputs[0], kept.inputs[7])
        else:
            # The mod's own glow on the lines pulses with the noise too, as in game: a steady glow there kept every dim
            # stretch teal. Off the lines (eyes, gems) it stays steady. keep*(1-core) + core*pulse*gate: the base (gate 0)
            # has only the steady part, the frames (keep 0) only the pulsing part, the still both
            off = N.new("ShaderNodeMath"); off.operation = "SUBTRACT"; off.inputs[0].default_value = 1.0; L.new(core.outputs[0], off.inputs[1])
            steady = N.new("ShaderNodeMath"); steady.operation = "MULTIPLY"; L.new(keep.outputs[0], steady.inputs[0]); L.new(off.outputs[0], steady.inputs[1])
            lit = N.new("ShaderNodeMath"); lit.operation = "MULTIPLY"; L.new(core.outputs[0], lit.inputs[0]); L.new(pulse, lit.inputs[1])
            on = N.new("ShaderNodeMath"); on.operation = "MULTIPLY"; L.new(lit.outputs[0], on.inputs[0]); L.new(gate.outputs[0], on.inputs[1])
            both_ = N.new("ShaderNodeMath"); both_.operation = "ADD"; L.new(steady.outputs[0], both_.inputs[0]); L.new(on.outputs[0], both_.inputs[1])
            L.new(both_.outputs[0], kept.inputs[7])
        old = kept.outputs[2]
        k = strength / max(bsdf.inputs["Emission Strength"].default_value, 1e-6)
        scaled = N.new("ShaderNodeMix"); scaled.data_type = "RGBA"; scaled.blend_type = "MULTIPLY"; scaled.inputs[0].default_value = 1
        L.new(lines.outputs[2], scaled.inputs[6]); scaled.inputs[7].default_value = (k, k, k, 1)
        add = N.new("ShaderNodeMix"); add.data_type = "RGBA"; add.blend_type = "ADD"; add.inputs[0].default_value = 1
        L.new(old, add.inputs[6]); L.new(scaled.outputs[2], add.inputs[7]); L.new(add.outputs[2], em)
    else:
        L.new(lines.outputs[2], em)
        bsdf.inputs["Emission Strength"].default_value = strength
    if mp is not None:
        tile = vectors.get("FlowTex_UVTile") or {}
        FLOW.append({"material": m.name, "mapping": mp.name, "mapping2": mp2.name, "blend": blend.name, "gate": gate.name, "keep": keep.name,
                     "travel": flow_travel(float(tile.get("B", 0.0)), float(tile.get("A", 0.0)))})


FLOW_TRAVEL = 0.2   # how far the noise crawls in one loop, in tiles (the cross-fade keeps it seamless; 0.12 barely moved)


def flow_travel(u, v):
    """How far the noise moves in one loop, in the direction of the master's pan speeds (FlowTex_UVTile B and A). No
    pan: down the body."""
    big = (u * u + v * v) ** 0.5
    if big < 1e-6:
        return (0.0, FLOW_TRAVEL)
    return (u / big * FLOW_TRAVEL, v / big * FLOW_TRAVEL)


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
    add_flow_glow(m, tex, vectors, scalars)
    # Not on eyes (their own recipe), fur shells or flat gems: the rim there is another effect
    if not RIM_SKIP.search(name) and "IrisBaseColor" not in tex and "IrisUVRadius" not in scalars and "Pattern_Map" not in tex:
        add_rim(m, tex, vectors, scalars, hair=bool(re.search(r"(?i)hair", name)))
    return m
