"""The app's newest game mappings (REPAKXTRA_USMAP, xtra_previews.rs app_usmap) over the kit's own: after a game update the
kit's older mappings misread changed structs, and a skin table mod read as no rows showed nothing."""
_kit_cue_config = cue_config


def cue_config():
    cfg = _kit_cue_config()
    usmap = os.environ.get("REPAKXTRA_USMAP")
    if usmap and Path(usmap).is_file():
        cfg["usmap"] = usmap
    return cfg
