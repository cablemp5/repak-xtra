FLOW_FRAMES = 24   # renders of one loop of crawling lines (flow_compose.py blends the frames between, to FLOW_FPS). 72 before:
                   # a frame rebuilt from two renders three apart is within the renders' own frame to frame noise of the real
                   # one (mean 0.14 of 255, measured on all 72 of AllBlackMCUskin), and the 72 took 15.8 s of a 33 s preview
FLOW_SCALE = 63    # the frames' render size, percent of the still's: about the saved card size, so 72 passes stay quick
FLOW_SAMPLES = 8   # EEVEE samples per frame: 4 shimmered on the thin lines from frame to frame (the still takes 16)


def flow_nodes(f):
    m = bpy.data.materials.get(f["material"])
    return (m.node_tree.nodes, m) if m and m.node_tree else (None, None)


def flow_set(gate=None, keep=None):
    for f in FLOW:
        nodes, _ = flow_nodes(f)
        if nodes is None:
            continue
        if gate is not None:
            nodes[f["gate"]].outputs[0].default_value = gate
        if keep is not None:
            nodes[f["keep"]].outputs[0].default_value = keep


def flow_still(path):
    """After the main render, the same view without the flow lines: the animated preview's base (mod_previews flow_anim
    lays each frame's lines over it). The saved still keeps its lines."""
    if not FLOW:
        return
    flow_set(gate=0.0)
    keep_path = sc.render.filepath
    sc.render.filepath = path[:-4] + "_noflow.png"
    bpy.ops.render.render(write_still=True)
    screen_rim(sc.render.filepath)
    sc.render.filepath = keep_path
    flow_set(gate=1.0)


def flow_frames(job, glowing):
    """The animated preview's glow, after the kit's glow pass (every surface black and matte, lights off): the glow without
    the lines, then the lines alone in FLOW_FRAMES steps of the noise's travel, one tile per loop so it repeats seamlessly."""
    if not FLOW or not glowing:   # the kit's glow pass did not run: the lights are still on
        return
    if not job.get("flow", True):   # a "before" render: only its still is kept, its frames would be thrown away
        return
    view = job["views"][-1]["name"]   # the camera was left at the last view, the only one in practice
    prefix = f'{job["out_prefix"]}_{view}'
    flow_set(gate=0.0)
    sc.render.resolution_percentage = FLOW_SCALE   # the frames' size, so the compose adds same-size images
    sc.render.filepath = prefix + "_emit_noflow.png"
    bpy.ops.render.render(write_still=True)
    flow_set(gate=1.0, keep=0.0)
    flowing = {f["material"] for f in FLOW}
    for mat in bpy.data.materials:   # the other glows (eyes, gems) are in the base already
        b = next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None) if mat.node_tree and mat.name not in flowing else None
        if b is not None:
            b.inputs["Emission Strength"].default_value = 0.0
    starts = {}
    for f in FLOW:
        nodes, _ = flow_nodes(f)
        if nodes is not None:
            starts[f["material"]] = tuple(nodes[f["mapping"]].inputs["Location"].default_value)
            nodes[f["mapping2"]].inputs["Location"].default_value = starts[f["material"]]
    stage("glow")
    sc.render.resolution_percentage = FLOW_SCALE
    sc.render.image_settings.compression = 0   # read once by the compose, then deleted
    sc.eevee.taa_render_samples = FLOW_SAMPLES
    for i in range(FLOW_FRAMES):
        t = i / FLOW_FRAMES
        for f in FLOW:
            nodes, _ = flow_nodes(f)
            if nodes is None:
                continue
            # Sample one runs from the start, sample two runs into it from one loop's travel behind, and the fade passes
            # from one to two: the last frame meets the first
            x0, y0, z0 = starts[f["material"]]
            (dx, dy) = f["travel"]
            nodes[f["mapping"]].inputs["Location"].default_value = (x0 + dx * t, y0 + dy * t, z0)
            nodes[f["mapping2"]].inputs["Location"].default_value = (x0 + dx * (t - 1), y0 + dy * (t - 1), z0)
            nodes[f["blend"]].outputs[0].default_value = t
        sc.render.filepath = f"{prefix}_flow_{i:02d}.png"
        bpy.ops.render.render(write_still=True)
