"""Rotate in 3D's lobby look, added to the preview kit's mod_previews.py (runtime.py; a kit that already has these
functions gets them replaced by these): each slot's master defaults (a hook in viewer_files), rig.json (the skin's lobby
light rig), showrim.json (its show rim light), sounds.json + sounds/<n>.wav (the sound cues of its lobby idle), model.json
v2, and --viewer --target <mesh> --set <key> (the game's own skin, no mod mounted: the viewer's Default skin)."""

UE_M = ((1, 0, 0), (0, 0, 1), (0, 1, 0))   # Unreal (x, y, z) to three (x, z, y), and back


def ue_matrix(pitch, yaw, roll):
    """Unreal's FRotator (degrees) as a 3x3 matrix whose columns are the rotated local X, Y and Z."""
    p, y, r = (math.radians(a) for a in (pitch, yaw, roll))
    cp, sp, cy, sy, cr, sr = math.cos(p), math.sin(p), math.cos(y), math.sin(y), math.cos(r), math.sin(r)
    cols = ((cp * cy, cp * sy, sp), (sr * sp * cy - cr * sy, sr * sp * sy + cr * cy, -sr * cp), (-(cr * sp * cy + sr * sy), cy * sr - cr * sp * sy, cr * cp))
    return [[cols[j][i] for j in range(3)] for i in range(3)]


def mat_mul(a, b):
    return [[sum(a[i][k] * b[k][j] for k in range(3)) for j in range(3)] for i in range(3)]


def quat_of(m):
    """A rotation matrix as a quaternion [x, y, z, w]."""
    t = m[0][0] + m[1][1] + m[2][2]
    if t > 0:
        s4 = math.sqrt(t + 1) * 2
        q = ((m[2][1] - m[1][2]) / s4, (m[0][2] - m[2][0]) / s4, (m[1][0] - m[0][1]) / s4, s4 / 4)
    elif m[0][0] > m[1][1] and m[0][0] > m[2][2]:
        s4 = math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]) * 2
        q = (s4 / 4, (m[0][1] + m[1][0]) / s4, (m[0][2] + m[2][0]) / s4, (m[2][1] - m[1][2]) / s4)
    elif m[1][1] > m[2][2]:
        s4 = math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]) * 2
        q = ((m[0][1] + m[1][0]) / s4, s4 / 4, (m[1][2] + m[2][1]) / s4, (m[0][2] - m[2][0]) / s4)
    else:
        s4 = math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]) * 2
        q = ((m[0][2] + m[2][0]) / s4, (m[1][2] + m[2][1]) / s4, s4 / 4, (m[1][0] - m[0][1]) / s4)
    return [round(v, 7) for v in q]


def srgb_linear(c):
    c /= 255
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def blackbody(kelvin):
    """Unreal's MakeFromColorTemperature (Planckian locus, BT.709), its largest channel 1."""
    t = min(max(kelvin, 1000), 15000)
    u = (0.860117757 + 1.54118254e-4 * t + 1.28641212e-7 * t * t) / (1 + 8.42420235e-4 * t + 7.08145163e-7 * t * t)
    v = (0.317398726 + 4.22806245e-5 * t + 4.20481691e-8 * t * t) / (1 - 2.89741816e-5 * t + 1.61456053e-7 * t * t)
    x, y = 3 * u / (2 * u - 8 * v + 4), 2 * v / (2 * u - 8 * v + 4)
    X, Z = x / y, (1 - x - y) / y
    rgb = (3.2404542 * X - 1.5371385 - 0.4985314 * Z, -0.9692660 * X + 1.8760108 + 0.0415560 * Z, 0.0556434 * X - 0.2040259 + 1.0572252 * Z)
    top = max(rgb)
    return [max(c, 0) / top for c in rgb]


def rig_lights(data):
    """A <skin>_HeroDetail_LightBP's character-channel lights (Cue4Export json) as the viewer's rig.json rows, converted
    the way the game viewer's scene export does: intensity / PI, linear color (times the blackbody when the light uses
    its temperature, largest channel 1), quaternion M R M (local +X shines), position (X, Z, Y) cm to meters. A field the
    Blueprint leaves out keeps Unreal's component default (the Blueprint's parent is Actor): directional intensity 10,
    shadows on, white, source angle 0.5357; spot cone 44, attenuation 1000 cm."""
    rows = []
    for o in data:
        kind = {"DirectionalLightComponent": "directional", "SpotLightComponent": "spot"}.get(o.get("Type"))
        if not kind:
            continue
        p = o.get("Properties") or {}
        ch = p.get("LightingChannels") or {}
        if not ch.get("bChannel1") or p.get("bVisible") is False:   # the character channel only (channel 0 lights the stage)
            continue
        c = p.get("LightColor") or {}
        color = [srgb_linear(c.get(k, 255)) for k in ("R", "G", "B")]
        if p.get("bUseTemperature"):
            color = [a * b for a, b in zip(color, blackbody(p.get("Temperature", 6500)))]
            top = max(color) or 1
            color = [a / top for a in color]
        r = p.get("RelativeRotation") or {}
        rot = mat_mul(mat_mul(UE_M, ue_matrix(r.get("Pitch", 0), r.get("Yaw", 0), r.get("Roll", 0))), UE_M)
        loc = p.get("RelativeLocation") or {}
        row = {"name": o.get("Name", "").replace("_GEN_VARIABLE", ""), "kind": kind, "color": [round(a, 7) for a in color],
               "intensity": round(p.get("Intensity", 10) / math.pi, 7), "castShadow": p.get("CastShadows", True),
               "quaternion": quat_of(rot), "position": [round(loc.get(k, 0) * 0.01, 6) for k in ("X", "Z", "Y")],
               "specularScale": p.get("SpecularScale", 1), "sourceAngle": p.get("LightSourceAngle", 0.5357)}
        if kind == "spot":
            row.update(range=p.get("AttenuationRadius", 1000) / 100, outerConeAngle=p.get("OuterConeAngle", 44), innerConeAngle=p.get("InnerConeAngle", 0))
        rows.append(row)
    return rows


# M_RimLight_PP's own defaults, then the parameter names the show rim light reads
SHOW_RIM_DEFAULTS = {"direction": [7.889825, 4.957005, -1], "fresnelPower": 3, "range": 1, "separation": 0,
                     "color": [1, 1, 1], "outline": [0, 0, 0], "offset": [0, 0]}
SHOW_RIM_PARAMS = {"RimFresnelPower": "fresnelPower", "RimRange": "range", "ColorSeperationWidth_2": "separation",
                   "RimLightDirection": "direction", "RimLightColor": "color", "RimLightOutlineColor": "outline", "OutlineOffset": "offset"}


def viewer_lobby(work, target, dest):
    """The lobby files beside the viewer files: the light rig and show rim (lobby_rig), the idle's sounds and the
    physics. Each on its own, so a skin without a rig still gets its sounds and physics."""
    lobby_rig(work, target, dest)
    viewer_sounds(work, dest)
    viewer_physics(work, dest)


def lobby_rig(work, target, dest):
    """rig.json (the skin's lobby light rig, rig_lights) and showrim.json (its show rim light: the skin's
    MI_<skin>_ShowRimLight_HeroDetails over its parents, M_RimLight_PP's defaults under them) beside the viewer files.
    A skin without its own (a recolor variant) takes the hero's default skin's. Never fatal: the viewer has fallbacks."""
    m = re.match(r"/Game/Marvel/Characters/(\d+)/(\d+)/", target)
    if not m:
        return
    hero, skin = m[1], m[2]
    try:
        rigs, rims = [], []
        for s in dict.fromkeys((skin, hero + "001")):   # each from the skin, else from the hero's default skin
            if rigs and rims:
                break
            lst = work / f"lobby_{s}.txt"
            export(work, [{"op": "list", "prefix": f"/Game/Marvel/Characters/{hero}/{s}/", "match": r"(_HeroDetail_LightBP|_ShowRimLight_HeroDetails\w*)$",
                           "out": str(lst)}], name=f"lobbylist_{s}")
            found = [x.strip() for x in lst.read_text(encoding="utf-8").splitlines() if x.strip()] if lst.exists() else []
            rigs = rigs or [x for x in found if x.endswith("_HeroDetail_LightBP")]
            rims = rims or sorted((x for x in found if "ShowRimLight_HeroDetails" in x), key=len)
        paths = [game_ref(x) for x in rigs[:1] + rims[:1]]
        if not paths:
            return
        out = export(work, [{"op": "export", "mode": "json", "paths": paths}], name="lobby", out=work / "lobbyout")
        read = lambda g: json.loads((out / "Marvel" / "Content" / (g[len("/Game/"):] + ".json")).read_text(encoding="utf-8-sig"))
        if rigs:
            lights = rig_lights(read(game_ref(rigs[0])))
            if lights:
                (dest / "rig.json").write_text(json.dumps(lights, indent=1), encoding="utf-8")
        if rims:
            rim, cur, seen = dict(SHOW_RIM_DEFAULTS), game_ref(rims[0]), []
            chain = []
            # the instance, then its parents, up to the master (its defaults are SHOW_RIM_DEFAULTS)
            while cur.startswith("/Game/") and cur not in seen and len(seen) < 4 and not cur.endswith("/M_RimLight_PP"):
                seen.append(cur)
                f = out / "Marvel" / "Content" / (cur[len("/Game/"):] + ".json")
                if not f.exists():
                    export(work, [{"op": "export", "mode": "json", "paths": [cur]}], name="lobbyparent", out=work / "lobbyout")
                obj = next((o for o in read(cur) if str(o.get("Type", "")).startswith("Material")), {})
                chain.append(obj.get("Properties") or {})
                cur = game_ref(((obj.get("Properties") or {}).get("Parent") or {}).get("ObjectPath", ""))
            for props in reversed(chain):   # the nearest instance wins
                for v in props.get("ScalarParameterValues", []):
                    k = SHOW_RIM_PARAMS.get(v["ParameterInfo"]["Name"])
                    if k:
                        rim[k] = v["ParameterValue"]
                for v in props.get("VectorParameterValues", []):
                    k = SHOW_RIM_PARAMS.get(v["ParameterInfo"]["Name"])
                    if k:
                        c = v["ParameterValue"]
                        rim[k] = [c["R"], c["G"]] if k == "offset" else [c["R"], c["G"], c["B"]]
            (dest / "showrim.json").write_text(json.dumps(rim, indent=1), encoding="utf-8")
    except Exception as e:
        print(f"# viewer: lobby rig and rim left out: {e}", file=sys.stderr, flush=True)


def _limit(c, deg, motion):
    """A constraint angle: None when free (the cooked JSON leaves out Unreal's defaults: 45 degrees, free), 0 locked."""
    m = c.get(motion, "ACM_Free")
    return None if m.endswith("ACM_Free") else 0.0 if m.endswith("ACM_Locked") else float(c.get(deg, 45.0))


def physics_rows(data):
    """The viewer's physics.json from a PhysicsAsset (Cue4Export json): `sim`, each simulated body's bone with its
    swing and twist limits from its constraint (degrees, null = free), damping and gravity scale (Unreal's defaults when
    left out: 0.01, 0, 1) and its capsule radius; `colliders`, the kinematic bodies' shapes (the legs, pelvis, spine,
    arms and head the hair and cloth stay out of). Shapes in the glTF bone's own space and meters: Unreal's bone axes
    (x, y, z) are the glTF's (x, z, y) (UE_M), as for the light rig."""
    bodies = [(o.get("Properties") or {}) for o in data if o.get("Type") == "SkeletalBodySetup"]
    limits = {}
    for o in data:
        if o.get("Type") == "PhysicsConstraintTemplate":
            d = (o.get("Properties") or {}).get("DefaultInstance") or {}
            p = d.get("ProfileInstance") or {}
            cone, tw = p.get("ConeLimit") or {}, p.get("TwistLimit") or {}
            limits[d.get("ConstraintBone1")] = {"parent": d.get("ConstraintBone2"),
                                                "swing": [_limit(cone, "Swing1LimitDegrees", "Swing1Motion"), _limit(cone, "Swing2LimitDegrees", "Swing2Motion")],
                                                "twist": _limit(tw, "TwistLimitDegrees", "TwistMotion")}
    sim, colliders = [], []
    for b in bodies:
        bone, inst, geo = b.get("BoneName"), b.get("DefaultInstance") or {}, b.get("AggGeom") or {}
        caps = geo.get("SphylElems") or []
        if b.get("PhysicsType", "").endswith("PhysType_Simulated"):
            sim.append({"bone": bone, **limits.get(bone, {"parent": None, "swing": [None, None], "twist": None}),
                        "linear": inst.get("LinearDamping", 0.01), "angular": inst.get("AngularDamping", 0.0),
                        "gravity": inst.get("GravityScale", 1.0), "radius": round(max([c.get("Radius", 0) for c in caps] or [1.0]) * 0.01, 5)})
            continue
        for c in caps + [dict(s, Length=0) for s in geo.get("SphereElems") or []]:
            colliders.append(_collider(bone, c.get("Center"), c.get("Rotation"), c))
    return {"sim": sim, "colliders": colliders}


def _collider(bone, center, rot, c):
    """A capsule (a sphere when its Length is 0) in its bone's space as a collider row, glTF axes and meters."""
    ce, r = center or {}, rot or {}
    axis = [row[2] for row in mat_mul(UE_M, ue_matrix(r.get("Pitch", 0), r.get("Yaw", 0), r.get("Roll", 0)))]   # the capsule's local Z
    return {"bone": bone, "center": [round(ce.get(k, 0) * 0.01, 5) for k in ("X", "Z", "Y")],
            "axis": [round(a, 5) for a in axis], "half": round(c.get("Length", 0) * 0.005, 5), "radius": round(c.get("Radius", 0) * 0.01, 5)}


KAWAII_AXIS = {"X_Positive": [1, 0, 0], "X_Negative": [-1, 0, 0], "Y_Positive": [0, 0, 1], "Y_Negative": [0, 0, -1], "Z_Positive": [0, 1, 0], "Z_Negative": [0, -1, 0]}


def kawaii_rows(abp, limits_of):
    """The viewer's KawaiiPhysics chains from a post-process AnimBlueprint (Cue4Export json): what swings the hair,
    skirt, tail and straps of a skin (and of most mods with their own physics) that its PhysicsAsset does not simulate.
    Per chain: its node (chains collide with their own node's limits only), root bone, the bones left out, damping,
    stiffness, the bones' radius (meters), the angle limit (degrees, 0: none), gravity (m/s2, glTF axes, already times
    its scale), the leaf's dummy bone (length in meters and axis) and the curves over the chain's length (0 root to 1
    tip, each scaling its value). Returns (chains, colliders): the nodes' capsule and outer sphere limits, with those
    of a limits data asset (`limits_of(path)` gives its json). shortcut: box, planar and inner sphere limits, bone
    constraints, wind and the wave are left out (13 limits and 4 chains of 397 in the game's own skins), and a curve
    is read as straight lines between its keys"""
    chains, colliders = [], []
    nodes = [n for o in abp for k, n in (o.get("Properties") or {}).items() if k.startswith("AnimGraphNode_KawaiiPhysics") and isinstance(n, dict)]
    for i, n in enumerate(nodes):
        asset = game_ref((n.get("LimitsDataAsset") or {}).get("ObjectPath") or "")
        shared = next(((o.get("Properties") or {}) for o in (limits_of(asset) if asset.startswith("/Game/") else []) if "LimitsDataAsset" in str(o.get("Type"))), {})
        for src in (n, shared):
            spheres = [dict(s, Length=0) for s in src.get("SphericalLimits") or [] if not str(s.get("LimitType", "")).endswith("Inner")]
            for l in [c for c in src.get("CapsuleLimits") or [] if c.get("Length", 0) > 0] + spheres:
                bone = (l.get("DrivingBone") or {}).get("BoneName")
                if l.get("bEnable", True) and l.get("Radius", 0) > 0 and bone and bone != "None":
                    colliders.append({**_collider(bone, l.get("OffsetLocation"), l.get("OffsetRotation"), l), "node": i})
        for c in n.get("Chains") or []:
            bs, ps, g = c.get("BoneSettings") or {}, c.get("PhysicsSettings") or {}, (c.get("ExternalForceSettings") or {}).get("Gravity") or {}
            p, root = ps.get("PhysicsSettings") or {}, (bs.get("RootBone") or {}).get("BoneName")
            if not root or root == "None":
                continue
            scale = p.get("GravityScale", 1.0) * 0.01
            row = {"node": i, "root": root, "exclude": [b.get("BoneName") for b in bs.get("ExcludeBones") or []],
                   "damping": p.get("Damping", 0.1), "stiffness": p.get("Stiffness", 0.05), "radius": round(p.get("Radius", 3.0) * 0.01, 5),
                   "limit": p.get("LimitAngle", 0.0), "gravity": [round(g.get(k, 0) * scale, 5) for k in ("X", "Z", "Y")],
                   "dummy": round(bs.get("DummyBoneLength", 0.0) * 0.01, 5), "axis": KAWAII_AXIS.get(str(bs.get("BoneForwardAxis", "")).rsplit("::", 1)[-1], [1, 0, 0])}
            if ps.get("bUseCurve"):
                curves = {k: [[round(x.get("Time", 0), 5), round(x.get("Value", 0), 5)] for x in ((ps.get(f) or {}).get("EditorCurveData") or {}).get("Keys") or []]
                          for k, f in (("damping", "DampingCurveData"), ("stiffness", "StiffnessCurveData"), ("radius", "RadiusCurveData"), ("limit", "LimitAngleCurveData"))}
                row["curves"] = {k: v for k, v in curves.items() if v}
            chains.append(row)
    return chains, colliders


def _quat_matrix(q):
    x, y, z, w = (q.get(k, 0.0) for k in ("X", "Y", "Z", "W"))
    return [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]]


def driver_rows(abp, poses_of):
    """The viewer's pose drivers from a post-process AnimBlueprint (Cue4Export json): each AnimNode_PoseDriver that
    drives a PoseAsset's poses from one bone's rotation (Phoenix's skirt roots follow her thighs). Per driver: the source
    bone, its targets (the bone's local rotation, glTF quaternion), the RBF radius (null: automatic), the driven bones,
    and per target that pose's local transform of each driven bone ([qx, qy, qz, qw, tx, ty, tz], glTF meters; null:
    the bone's rest). `poses_of(path)` gives a PoseAsset's json."""
    rows = []
    for o in abp:
        for k, n in (o.get("Properties") or {}).items():
            if not k.startswith("AnimGraphNode_PoseDriver") or not isinstance(n, dict) or not n.get("DriveOutput", "").endswith("DrivePoses"):
                continue
            src, pa = [b.get("BoneName") for b in n.get("SourceBones") or []], game_ref((n.get("PoseAsset") or {}).get("ObjectPath") or "")
            if not src or not pa.startswith("/Game/"):
                continue
            pc = next((x for x in poses_of(pa) if x.get("Type") == "PoseAsset"), {}).get("Properties", {}).get("PoseContainer") or {}
            names, tracks = pc.get("PoseFNames") or [], pc.get("Tracks") or []
            bones = [b.get("BoneName") for b in n.get("OnlyDriveBones") or [] if b.get("BoneName") in tracks]
            if not bones:
                continue
            targets, poses = [], []
            for t in n.get("PoseTargets") or []:
                r = ((t.get("BoneTransforms") or [{}])[0]).get("TargetRotation") or {}
                targets.append(quat_of(mat_mul(mat_mul(UE_M, ue_matrix(r.get("Pitch", 0), r.get("Yaw", 0), r.get("Roll", 0))), UE_M)))
                pi, row = names.index(t["DrivenName"]) if t.get("DrivenName") in names else -1, []
                for b in bones:
                    inf = next((i for i in (pc["TrackPoseInfluenceIndices"][tracks.index(b)].get("Influences") or []) if i.get("PoseIndex") == pi), None) if pi >= 0 else None
                    if inf is None:
                        row.append(None)
                        continue
                    lp = pc["Poses"][pi]["LocalSpacePose"][inf["BoneTransformIndex"]]
                    q = quat_of(mat_mul(mat_mul(UE_M, _quat_matrix(lp.get("Rotation") or {})), UE_M))
                    tr = lp.get("Translation") or {}
                    row.append(q + [round(tr.get(a, 0) * 0.01, 6) for a in ("X", "Z", "Y")])
                poses.append(row)
            rp = n.get("RBFParams") or {}
            # how far the source is from a target: the angle between the two rotations, or between their twist axes alone
            # (the viewer read every driver as the second, so a skirt keyed on the thigh's twist folded wrong). fromRef:
            # the targets are the source's turn away from its reference pose. normalize: "above1" leaves weights that
            # sum under 1 as they are, and the rest of the weight stays on the bone's own pose
            rows.append({"source": src[0], "targets": targets, "radius": None if rp.get("bAutomaticRadius") else rp.get("Radius", 45.0),
                         "bones": bones, "poses": poses, "method": "quat" if str(rp.get("DistanceMethod", "")).endswith("Quaternion") else "swing",
                         "fromRef": bool(n.get("bEvalFromRefPose")), "normalize": "above1" if str(rp.get("NormalizeMethod", "")).endswith("OnlyNormalizeAboveOne") else "always"})
    return rows


def viewer_physics(work, dest):
    """physics.json beside the viewer files: the lobby mesh's PhysicsAsset (physics_rows), what makes its hair, skirt,
    cape and ornaments swing in the lobby (the idle never keys those bones). Always written ({} when the mesh has none
    or it could not be read), so the app knows the export had this pass. Never fatal."""
    rows = {}
    try:
        model = json.loads((dest / "model.json").read_text(encoding="utf-8")) if (dest / "model.json").exists() else {}
        mesh = model.get("mesh") or ""
        if mesh.startswith("/Game/"):
            out = work / "physout"
            read = lambda g: json.loads((out / "Marvel" / "Content" / (g[len("/Game/"):] + ".json")).read_text(encoding="utf-8-sig"))
            export(work, [{"op": "export", "mode": "json", "paths": [mesh]}], name="physmesh", out=out)
            sk = next((o for o in read(mesh) if o.get("Type") == "SkeletalMesh"), {})
            asset = game_ref(((sk.get("Properties") or {}).get("PhysicsAsset") or {}).get("ObjectPath") or "")
            if asset.startswith("/Game/"):
                export(work, [{"op": "export", "mode": "json", "paths": [asset]}], name="physasset", out=out)
                rows = physics_rows(read(asset))
            # the lobby mesh's post-process AnimBlueprint: its pose drivers (corrective poses the skirt or sleeves take
            # as a limb turns), run before the physics as the game does
            post = game_ref(((sk.get("Properties") or {}).get("PostProcessAnimBlueprint") or {}).get("ObjectPath") or "")
            if post.startswith("/Game/"):
                def poses_of(path):
                    export(work, [{"op": "export", "mode": "json", "paths": [path]}], name="physpose", out=out)
                    return read(path)
                abp = poses_of(post)
                drivers = driver_rows(abp, poses_of)
                if drivers:
                    rows["drivers"] = drivers
                chains, limits = kawaii_rows(abp, poses_of)
                if chains:
                    rows["kawaii"] = chains
                    rows["colliders"] = rows.get("colliders", []) + limits
    except Exception as e:
        print(f"# viewer: lobby physics left out: {e}", file=sys.stderr, flush=True)
    # v 2: the KawaiiPhysics chains and the pose drivers' distance, reference and normalize settings (the app makes an older export again)
    (dest / "physics.json").write_text(json.dumps({**rows, "v": 2}), encoding="utf-8")


def _check_physics_rows():
    # a capsule along the bone (Pitch -90 turns its Z onto X) stays along X; a hair link keeps its 16 degree swing
    data = [{"Type": "SkeletalBodySetup", "Properties": {"BoneName": "thigh_l", "PhysicsType": "EPhysicsType::PhysType_Kinematic",
             "AggGeom": {"SphylElems": [{"Center": {"X": -16}, "Rotation": {"Pitch": -90}, "Radius": 7, "Length": 23}]}}},
            {"Type": "SkeletalBodySetup", "Properties": {"BoneName": "h2", "PhysicsType": "EPhysicsType::PhysType_Simulated", "DefaultInstance": {"LinearDamping": 2}}},
            {"Type": "PhysicsConstraintTemplate", "Properties": {"DefaultInstance": {"ConstraintBone1": "h2", "ConstraintBone2": "h1", "ProfileInstance": {
                "ConeLimit": {"Swing1LimitDegrees": 16, "Swing1Motion": "EAngularConstraintMotion::ACM_Limited"}, "TwistLimit": {"TwistMotion": "EAngularConstraintMotion::ACM_Locked"}}}}}]
    r = physics_rows(data)
    c = r["colliders"][0]
    assert c["center"] == [-0.16, 0, 0] and abs(abs(c["axis"][0]) - 1) < 1e-6 and c["half"] == 0.115 and c["radius"] == 0.07, c
    s = r["sim"][0]
    assert s["parent"] == "h1" and s["swing"] == [16.0, None] and s["twist"] == 0.0 and s["linear"] == 2 and s["gravity"] == 1.0, s
    # a KawaiiPhysics node: its chain in meters and glTF axes (Unreal's -Z gravity is -Y), its capsule kept, an inner
    # sphere and a switched off capsule left out, a curve only where it has keys
    node = {"Chains": [{"BoneSettings": {"RootBone": {"BoneName": "hair_01"}, "ExcludeBones": [{"BoneName": "strap"}], "DummyBoneLength": 2.0, "BoneForwardAxis": "EBoneForwardAxis::Y_Negative"},
                        "PhysicsSettings": {"PhysicsSettings": {"Damping": 0.3, "Stiffness": 0.2, "Radius": 2.0, "LimitAngle": 40.0, "GravityScale": 2.0}, "bUseCurve": True,
                                            "RadiusCurveData": {"EditorCurveData": {"Keys": [{"Time": 0, "Value": 1}, {"Time": 1, "Value": 0.5}]}}, "DampingCurveData": {"EditorCurveData": {"Keys": []}}},
                        "ExternalForceSettings": {"Gravity": {"Z": -500.0}}}],
            "CapsuleLimits": [{"Radius": 9, "Length": 40, "DrivingBone": {"BoneName": "thigh_l"}, "OffsetRotation": {"Pitch": -90}},
                              {"Radius": 9, "Length": 40, "DrivingBone": {"BoneName": "thigh_r"}, "bEnable": False}],
            "SphericalLimits": [{"Radius": 11, "LimitType": "ESphericalLimitType::Inner", "DrivingBone": {"BoneName": "head"}}]}
    chains, limits = kawaii_rows([{"Properties": {"AnimGraphNode_KawaiiPhysics_1": node}}], lambda p: [])
    k = chains[0]
    assert k["root"] == "hair_01" and k["exclude"] == ["strap"] and k["gravity"] == [0, -10.0, 0] and k["radius"] == 0.02 and k["dummy"] == 0.02 and k["axis"] == [0, 0, -1], k
    assert k["curves"] == {"radius": [[0, 1], [1, 0.5]]} and k["node"] == 0, k
    assert len(limits) == 1 and limits[0]["bone"] == "thigh_l" and limits[0]["half"] == 0.2 and limits[0]["node"] == 0, limits


_check_physics_rows()


def _check_lobby_math():
    # Winter Soldier's Main_Light (P -12.471, Y -72.292, R 182.697) gives the game viewer's quaternion up to sign
    q = quat_of(mat_mul(mat_mul(UE_M, ue_matrix(-12.471029, -72.2924, 182.69667)), UE_M))
    assert all(abs(abs(a) - b) < 2e-3 for a, b in zip(q, (0.8040, 0.1015, 0.5841, 0.0452))), q
    assert [round(srgb_linear(c), 4) for c in (255, 218, 170)] == [1.0, 0.7011, 0.402]
    b = blackbody(12000)
    assert abs(b[2] - 1) < 1e-9 and 0.6 < b[1] < 0.7, b


_check_lobby_math()


def viewer_sounds(work, dest):
    """The lobby idle's sound cues (its AN_AkEvent notifies) as sounds.json [{"t": seconds, "file": "sounds/<n>.wav"}]
    with each event's layers and first variation decoded (vgmstream) and mixed, from the skin's display bank (the game's
    own, cached in WWISE). Never fatal: no sounds is the default."""
    try:
        # model.json names the idle (an export that shares its skin's mesh keeps idle.json in the shared base)
        model = json.loads((dest / "model.json").read_text(encoding="utf-8")) if (dest / "model.json").exists() else {}
        anim = (model.get("idle") or {}).get("anim")
        if not anim or not VGMSTREAM.exists():
            return
        out = export(work, [{"op": "export", "mode": "json", "paths": [anim]}], name="idlecues", out=work / "lobbyout")
        data = json.loads((out / "Marvel" / "Content" / (anim[len("/Game/"):] + ".json")).read_text(encoding="utf-8-sig"))
        seq = next((o for o in data if "AnimSequence" in str(o.get("Type", ""))), {})
        objs = {o.get("Name"): o for o in data}
        cues = []
        for n in (seq.get("Properties") or {}).get("Notifies", []):
            ref = ((n.get("Notify") or {}).get("ObjectName") or "").rstrip("'").rsplit(".", 1)[-1].rsplit(":", 1)[-1]
            ev = (((objs.get(ref) or {}).get("Properties") or {}).get("Event") or {}).get("AssetPathName", "")
            if ev:
                cues.append((float(n.get("LinkValue", n.get("Time", 0)) or 0), ev.rsplit(".", 1)[-1].lower()))
        if not cues:
            return
        sys.path.insert(0, str(SOUND))
        import bnk, bp_sound_data as sd
        cfg = json.loads((work / "config.json").read_text(encoding="utf-8"))
        rows = []
        for i, (t, ev) in enumerate(cues):
            m = re.match(r"(display|sfx)_(\d{7})_", ev)
            if not m:
                continue
            bank = f"Marvel/Content/WwiseAudio/bnk_{m[1]}_{m[2]}.bnk"
            wwise_names(work, cfg, [bank])
            if not (WWISE / bank).exists():
                continue
            b = (WWISE / bank).read_bytes()
            p = bnk.parse(b)
            didx = {mid: (o, size) for mid, o, size in p["didx"]}
            # each source's stream type: 0 in the bank, 1 prefetch (the bank holds only its first bytes), 2 streamed
            streamed = {struct.unpack_from("<IBI", body, 0)[2]: struct.unpack_from("<IBI", body, 0)[1] for kind, body in p["hirc"].values() if kind == bnk.HIRC_SOUND}
            sources = set(streamed)
            var, lay = sd.resolve(p["hirc"], set(didx) | sources, bnk.fnv1(ev))
            wavs = []
            for mid in lay + var[:1]:
                wem = work / "lobbysound" / f"{mid}.wem"
                wem.parent.mkdir(parents=True, exist_ok=True)
                if mid in didx and not streamed.get(mid):
                    o, size = didx[mid]
                    wem.write_bytes(b[p["data_offset"] + o:p["data_offset"] + o + size])
                else:   # streamed or prefetched media: its loose Media/<nn>/<id>.wem, the game alone
                    (work / "game.json").write_text(json.dumps(cfg), encoding="utf-8")
                    export(work, [{"op": "files", "match": f"Media/[0-9]+/{mid}[.]wem$", "raw_out": str(work / "lobbymedia")}], name="lobbymedia", config="game.json")
                    found = next((work / "lobbymedia").rglob(f"{mid}.wem"), None)
                    if not found:
                        continue
                    shutil.copyfile(found, wem)
                wav = wem.with_suffix(".wav")
                if subprocess.run([str(VGMSTREAM), "-o", str(wav), str(wem)], capture_output=True, timeout=120, creationflags=NO_WINDOW).returncode == 0:
                    wavs.append(wav)
            (dest / "sounds").mkdir(exist_ok=True)
            if wavs and mix_wavs(wavs, dest / "sounds" / f"{i}.wav"):
                rows.append({"t": round(t, 4), "file": f"sounds/{i}.wav", "event": ev})
        if rows:
            (dest / "sounds.json").write_text(json.dumps(rows, indent=1), encoding="utf-8")
    except Exception as e:
        print(f"# viewer: lobby sounds left out: {e}", file=sys.stderr, flush=True)


def viewer_default(a, out_dir):
    """--viewer --target <mesh> --set <key>: the game's own skin of that mesh, no mod mounted, as <out>/<key>.3d (the
    viewer's Default skin). Prints VIEWER <key> or VIEWER_FAIL <key> like viewer()."""
    key = a.set
    work = WORK / ("v_" + re.sub(r"[^\w.+-]", "_", key))
    try:
        if not key or not re.fullmatch(r"/Game/Marvel/Characters/\d+/\d+/Meshes/\w+", a.target or ""):
            raise RuntimeError(f"not a character mesh: {a.target}")
        cfg = cue_config()
        drop_work(work)
        stage("read")
        mount(work, cfg, [])
        export_viewer(work, a.target, [], game_meshes(cfg), out_dir / f"{key}.3d")
        print(f"VIEWER {key}", flush=True)
    except Exception as e:
        print(f"# {key}: default skin export failed: {e}", file=sys.stderr, flush=True)
        print(f"VIEWER_FAIL {key}", flush=True)



SLOT_MATERIALS = set()   # materials named_slots added: material_chains walks them like the MI_ ones


def named_slots(work, out, glb, mesh, mounted, dest):
    """Slots the glTF export names "None" because it could not load their material. A mesh swap that re-binds a cosmetic
    mod's mesh onto another skin points its slots at that mod's materials through placeholders of another class, which
    the export cannot load and the game loads by path (Phoenix's Momiji hair Bangs301 and eyes MI_1054502_Eyes_Inst drew
    white). The slot's name is still there, and the mod's own mesh, also mounted, has a slot of that name with the
    material loaded: the slot takes that material's name, and the material is exported like a mod's own instance. Writes
    slots.json (the slots it named) in dest, so the app knows the export had this pass. shortcut: glTF primitive i is
    slot i, as the game's meshes order their sections; a mesh with another count keeps its "None" slots"""
    named = {}
    try:
        data = Path(glb).read_bytes()
        n = struct.unpack("<I", data[12:16])[0]
        j = json.loads(data[20:20 + n])
        mats = j.get("materials") or []
        none = lambda i: i is not None and 0 <= i < len(mats) and (mats[i].get("name") or "None") == "None"
        prims = [p for m in j.get("meshes") or [] for p in m.get("primitives") or []]
        if any(none(p.get("material")) for p in prims):
            lobby = mesh.endswith("_Lobby")
            donors = sorted((p for p in mounted if p != mesh and re.search(r"/Meshes/SK_\w+$", p) and p.endswith("_Lobby") == lobby), key=len)
            raw = work / "raw"
            cached_export(work, [mesh, *donors], mounted, ".json", {"op": "export", "mode": "json"}, name="slots", out=raw)

            def slots_of(m):
                f = content_file(raw, m, ".json")
                obj = next((o for o in json.loads(f.read_text(encoding="utf-8")) if o.get("Type") == "SkeletalMesh"), {}) if f.exists() else {}
                return [(s.get("MaterialSlotName"), game_ref((s.get("Material") or {}).get("ObjectPath") or "")) for s in obj.get("SkeletalMaterials") or []]
            own = slots_of(mesh)
            known = {}
            for d in donors:
                for slot, path in slots_of(d):
                    if path.startswith("/Game/"):
                        known.setdefault(slot, path)
            if len(own) == len(prims):
                for p, (slot, path) in zip(prims, own):
                    path = path if path.startswith("/Game/") else known.get(slot, "")
                    name = path.rsplit("/", 1)[-1]
                    if none(p.get("material")) and path.startswith("/Game/") and re.fullmatch(r"\w+", name):
                        at = next((i for i, m in enumerate(mats) if m.get("name") == name), None)
                        if at is None:
                            mats.append({"name": name, "pbrMetallicRoughness": {}})
                            at = len(mats) - 1
                        p["material"] = at
                        named[name] = path
            if named:
                j["materials"] = mats
                body = json.dumps(j, separators=(",", ":")).encode()
                body += b" " * (-len(body) % 4)
                rest = data[20 + n:]
                Path(glb).write_bytes(data[:8] + struct.pack("<I", 20 + len(body) + len(rest)) + struct.pack("<I", len(body)) + b"JSON" + body + rest)
                export(work, [{"op": "export", "paths": sorted(set(named.values())), "mode": "material"}], name="slotmats", out=out)
                SLOT_MATERIALS.update(named)
                material_chains(work, out, mounted)
    except Exception as e:   # never fatal: the slots stay "None" and draw plain
        print(f"# viewer: unnamed slots left as they are: {e}", file=sys.stderr, flush=True)
    (Path(dest) / "slots.json").write_text(json.dumps(named, indent=1), encoding="utf-8")
