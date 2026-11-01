def layer_kind(name, info, chain):
    """'layer' for a see-through hair layer (a Translucent master with a color and an opacity mask), 'highlight' for the eye
    glass that carries the catch light (M_SimpleGlass_EyesHighLight: clear, with one small white ellipse in HighlightMask),
    else None. The kit hides every translucent slot. Other eye and face slots stay hidden (RIM_SKIP names)."""
    master = (chain or {}).get("chain", [""])[-1].split("/")[-1]
    tex = {**(chain or {}).get("textures", {}), **info.get("Textures", {})}
    if master == "M_SimpleGlass_EyesHighLight" and "HighlightMask" in tex:
        return "highlight"
    return "layer" if not RIM_SKIP.search(name) and "Translucent" in master and "BaseColor" in tex and "OpacityMask" in tex else None


def layer_material(name, info, chain, kind):
    """A layer is its BaseColor drawn with OpacityMask times OpacityMultiplier as the alpha, blended over the hair under it.
    A highlight is white light (HighlightTint, HighlightIntensity) where HighlightMask is white, at Opacity_HighLight, on a
    glass that is otherwise clear. Either is invisible when a texture is missing, never a flat shape."""
    chain = with_defaults(chain)
    tex = {**(chain or {}).get("textures", {}), **info.get("Textures", {})}
    scal = {**(chain or {}).get("scalars", {}), **info.get("Parameters", {}).get("Scalars", {})}
    m = bpy.data.materials.new(name + "_layer")
    m.use_nodes = True
    N, L = m.node_tree.nodes, m.node_tree.links
    bsdf = next(n for n in N if n.type == "BSDF_PRINCIPLED")
    m["masked"] = True   # no outline hull: it cannot follow the mask
    try:
        m.surface_render_method = "BLENDED"
    except AttributeError:
        m.blend_method = "BLEND"
    bsdf.inputs["Alpha"].default_value = 0.0
    bsdf.inputs["Roughness"].default_value = 0.6
    bsdf.inputs["Specular IOR Level"].default_value = 0.3
    glass = kind == "highlight"
    mask, base = game_png(tex.get("HighlightMask" if glass else "OpacityMask")), game_png(tex.get("BaseColor"))
    if mask and (glass or base):   # a layer needs its colour too: with only the mask it would draw as a gray overlay
        sep = N.new("ShaderNodeSeparateColor"); t = N.new("ShaderNodeTexImage"); t.image = image(mask, color=False)
        L.new(t.outputs[0], sep.inputs[0])
        if glass:
            # The game reflects: HighlightMask is read like a matcap, by the glass's normal in camera space, so the ellipse
            # sits just up and right of the pupil whichever way the eye turns, not where the glass's own UVs put it
            t.extension = "CLIP"
            cam = N.new("ShaderNodeVectorTransform"); cam.vector_type = "NORMAL"; cam.convert_from = "WORLD"; cam.convert_to = "CAMERA"
            L.new(N.new("ShaderNodeNewGeometry").outputs["Normal"], cam.inputs[0])
            uv = N.new("ShaderNodeVectorMath"); uv.operation = "MULTIPLY_ADD"
            uv.inputs[1].default_value = (0.5, 0.5, 0.5); uv.inputs[2].default_value = (0.5, 0.5, 0.5)
            L.new(cam.outputs[0], uv.inputs[0]); L.new(uv.outputs[0], t.inputs["Vector"])
        a = N.new("ShaderNodeMath"); a.operation = "MULTIPLY"; a.use_clamp = True
        L.new(sep.outputs[0], a.inputs[0]); a.inputs[1].default_value = float(scal.get("Opacity_HighLight", 0.8) if glass else scal.get("OpacityMultiplier", 1.0))
        L.new(a.outputs[0], bsdf.inputs["Alpha"])
    if glass:
        keep_glow(m, bsdf)
        c = (chain or {}).get("vectors", {}).get("HighlightTint", {"R": 1.0, "G": 1.0, "B": 1.0})
        bsdf.inputs["Base Color"].default_value = (0, 0, 0, 1)
        bsdf.inputs["Emission Color"].default_value = (c["R"], c["G"], c["B"], 1)
        bsdf.inputs["Emission Strength"].default_value = min(3.0, max(1.0, float(scal.get("HighlightIntensity", 1.0))))
    elif base:
        t = N.new("ShaderNodeTexImage"); t.image = image(base, color=True); L.new(t.outputs[0], bsdf.inputs["Base Color"])
    return m
