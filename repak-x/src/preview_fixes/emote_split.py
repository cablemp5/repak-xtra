"""An animation mod with several emotes (a whole emote wheel in one PAK): one animated preview per emote, <key>.webp then
<key>@2.webp and on, in emote order, each made by the kit's own render_anim from that emote's clips (its intro and loop
together). Each one's emotes go to the index ("emotes" for the first, "form_emotes" {<key>@n: [emote]} for the rest), so
its emote sound plays over the right slide."""
EMOTE_PREVIEWS = 8   # the most emotes one mod shows (the app pages <key>@2 to <key>@8)
_kit_render_anim = render_anim


def emote_groups(seqs):
    """The mod's clips by emote, in emote order; clips of no emote (ability animations) only when it has no emote clips."""
    groups = {}
    for p in seqs:
        groups.setdefault(emote_of_clip(p), []).append(p)
    named = sorted(e for e in groups if e)
    return [groups[e] for e in named] if named else [seqs]


def render_anim(work, seqs, out_webp, bl):
    groups = emote_groups(seqs)
    if len(groups) < 2:
        return _kit_render_anim(work, seqs, out_webp, bl)
    made, emotes, forms = 0, [], {}
    for group in groups[:EMOTE_PREVIEWS]:
        shutil.rmtree(work / "frames", ignore_errors=True)   # the kit counts every frame in it
        out = out_webp if not made else out_webp.with_name(f"{out_webp.stem}@{made + 1}.webp")
        EXTRA.pop("emotes", None)
        if _kit_render_anim(work, group, out, bl):
            made += 1
            if made == 1:
                emotes = EXTRA.get("emotes", [])
            else:
                forms[out.stem] = EXTRA.get("emotes", [])
    EXTRA["emotes"], EXTRA["form_emotes"] = emotes, forms
    return made > 0


def emote_first(target, pkgs):
    """(target, clips) for a mod: an emote's own prop mesh (Weapons/, a ring box) does not make an emote wheel a mesh mod,
    its dances are the preview; a skin mesh with animations keeps its still, as the kit does."""
    seqs = anim_sequences(pkgs)
    if target and not (seqs and all("/Weapons/" in t for t in target)):
        return target, []
    return (None, seqs) if seqs else (target, [])


def anim_forms(kind):
    """How many images an animation preview keeps (its emotes); other kinds keep none past the first."""
    return 1 + len(EXTRA.get("form_emotes") or {}) if kind == "anim" else 0


assert [len(g) for g in emote_groups(["/A/Emote_10265012050_Lobby", "/A/Emote_10265012080", "/A/Emote_10265012050_Lobby_Loop", "/A/Idle"])] == [2, 1]
assert emote_groups(["/A/Idle", "/A/Run"]) == [["/A/Idle", "/A/Run"]]
_clip = "/Game/Marvel/Characters/1026/1026001/Animations/Emote_10265012080"
_prop = "/Game/Marvel/Characters/1026/1026001/Weapons/Emote/Ring/Meshes/SK_WP_10265022080_Ring"
assert emote_first([_prop], [_clip, _prop]) == (None, [_clip])
assert emote_first(["/Game/Marvel/Characters/1026/1026001/Meshes/SK_1026_1026001"], [_clip])[1] == []
