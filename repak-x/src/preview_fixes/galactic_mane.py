"""Keep Galactic Claw's simulated mane in its mesh rest pose for a borrowed default idle."""
import re


def fix_lobby_mane(armature, job):
    model = str(job.get("model", "")).replace("\\", "/").lower()
    anim = str(job.get("anim", "")).replace("\\", "/").lower()
    if "sk_1026_" not in model or "/1026001/" not in anim:
        return 0
    if "hair_c_01" not in armature.pose.bones or "hair_03_01_l" not in armature.pose.bones:
        return 0
    # The shared idle carries skin-specific hair tracks with asymmetric offsets (up to 19 cm).
    # These chains are simulated in game; they should follow the posed spine from their own bind pose.
    names = {b.name for b in armature.pose.bones if re.fullmatch(r"hair_(?:\d{2}_\d{2}_[lr]|c_\d{2})", b.name)}
    action = armature.animation_data.action if armature.animation_data else None
    if action:
        bags = [action] if hasattr(action, "fcurves") else [bag for layer in action.layers for strip in layer.strips for bag in strip.channelbags]
        for bag in bags:
            for curve in list(bag.fcurves):
                if any(curve.data_path.startswith(f'pose.bones["{name}"]') for name in names):
                    bag.fcurves.remove(curve)
    for name in names:
        armature.pose.bones[name].matrix_basis.identity()
    return len(names)
