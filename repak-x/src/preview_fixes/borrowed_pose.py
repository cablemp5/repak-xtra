POSE_KEEP_MOVES = ("root", "pelvis")   # bones that keep a borrowed idle's translation (and every ik_ helper)
# Limb, spine and neck spans compared with the idle's: a mesh fitted onto the hero's skeleton with its own proportions
# (the Gojo and Miku Black Panther swaps: Panther's bone names, joints moved into the new body) differs where its body does
FIT_SPANS = [("thigh_l", "calf_l"), ("calf_l", "foot_l"), ("thigh_r", "calf_r"), ("calf_r", "foot_r"),
             ("upperarm_l", "lowerarm_l"), ("lowerarm_l", "hand_l"), ("upperarm_r", "lowerarm_r"), ("lowerarm_r", "hand_r"),
             ("spine_01", "spine_02"), ("spine_02", "spine_03"), ("neck_01", "head")]


def skin_of(path, folder):
    """The 7-digit skin folder above `folder` (Meshes, Animations) in a game file path, or None."""
    parts = Path(path).parts
    return parts[parts.index(folder) - 1] if folder in parts else None


def fitted_legs(A):
    """How much longer this skeleton's legs are than the idle's, when it was fitted to another body (two or more spans
    off by over 5%: a standard skeleton matches the idle exactly, since rotations alone never change a span). Else None."""
    pb, rest = A.pose.bones, A.data.bones
    spans = [(a, b) for a, b in FIT_SPANS if a in pb and b in pb]
    if len(spans) < 6:
        return None
    posed = [(pb[b].head - pb[a].head).length for a, b in spans]
    resting = [(rest[b].head_local - rest[a].head_local).length for a, b in spans]
    if sum(abs(p - r) / max(r, 1e-6) > 0.05 for p, r in zip(posed, resting)) < 2:
        return None
    legs = [i for i, (a, _) in enumerate(spans) if a.startswith(("thigh", "calf"))]
    return sum(resting[i] for i in legs) / max(sum(posed[i] for i in legs), 1e-6) if legs else 1.0


def borrowed_pose(A, job, anim, posed):
    """A lobby idle borrowed from another skin (1041306 wears the default 1041001 idle) moves bones by that skin's offsets:
    Celestial Soldier's hair_root 9.5 cm off his head. A fitted mesh swap (fitted_legs) gets pulled back to the hero's
    spacing the same way, which crushed its neck and body. As the game retargets it: rotations from the idle, every bone's
    translation from this mesh, but root, pelvis and the ik_ helpers. A fitted body's pelvis moves scaled by its legs."""
    if not posed:
        return
    legs = fitted_legs(A)
    if legs is None and skin_of(job["model"], "Meshes") == skin_of(anim, "Animations"):
        return
    pb = A.pose.bones
    root = pb["root"].head.copy() if "root" in pb else None
    pelvis = pb["pelvis"].head.copy() if "pelvis" in pb else None
    act = A.animation_data.action
    bags = [act] if hasattr(act, "fcurves") else [cb for l in act.layers for st in l.strips for cb in st.channelbags]
    keep = ("root",) if legs is not None else POSE_KEEP_MOVES   # a fitted pelvis is placed below, unkeyed so it stays
    for bag in bags:
        for fc in [fc for fc in bag.fcurves if fc.data_path.endswith(".location")]:
            bone = fc.data_path.split('"')[1]
            if bone not in keep and not bone.startswith("ik_"):
                bag.fcurves.remove(fc)
                pb[bone].location = (0.0, 0.0, 0.0)
    bpy.context.scene.frame_set(bpy.context.scene.frame_current)
    bpy.context.view_layer.update()
    if legs is not None and root is not None and pelvis is not None:
        M = pb["pelvis"].matrix.copy()
        M.translation = root + (pelvis - root) * legs
        pb["pelvis"].matrix = M
        bpy.context.view_layer.update()
        print(f"FITTED_POSE legs x{legs:.2f}")


assert skin_of("C:/x/Characters/1041/1041306/Meshes/SK_1041_1041306_Lobby.uemodel", "Meshes") == "1041306"
assert skin_of("C:/x/Characters/1041/1041001/Animations/HeroDetails/Lobby_Stand_Idle.ueanim", "Animations") == "1041001"
