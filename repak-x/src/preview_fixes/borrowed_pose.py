POSE_KEEP_MOVES = ("root", "pelvis")   # bones that keep a borrowed idle's translation (and every ik_ helper)


def skin_of(path, folder):
    """The 7-digit skin folder above `folder` (Meshes, Animations) in a game file path, or None."""
    parts = Path(path).parts
    return parts[parts.index(folder) - 1] if folder in parts else None


def borrowed_pose(A, job, anim, posed):
    """A lobby idle borrowed from another skin (1041306 wears the default 1041001 idle) moves bones by that skin's offsets:
    Celestial Soldier's hair_root 9.5 cm off his head. As the game retargets it: rotations from the idle, every bone's
    translation from this mesh, but root, pelvis and the ik_ helpers."""
    if not posed or skin_of(job["model"], "Meshes") == skin_of(anim, "Animations"):
        return
    act = A.animation_data.action
    bags = [act] if hasattr(act, "fcurves") else [cb for l in act.layers for st in l.strips for cb in st.channelbags]
    for bag in bags:
        for fc in [fc for fc in bag.fcurves if fc.data_path.endswith(".location")]:
            bone = fc.data_path.split('"')[1]
            if bone not in POSE_KEEP_MOVES and not bone.startswith("ik_"):
                bag.fcurves.remove(fc)
                A.pose.bones[bone].location = (0.0, 0.0, 0.0)
    bpy.context.scene.frame_set(bpy.context.scene.frame_current)
    bpy.context.view_layer.update()


assert skin_of("C:/x/Characters/1041/1041306/Meshes/SK_1041_1041306_Lobby.uemodel", "Meshes") == "1041306"
assert skin_of("C:/x/Characters/1041/1041001/Animations/HeroDetails/Lobby_Stand_Idle.ueanim", "Animations") == "1041001"
