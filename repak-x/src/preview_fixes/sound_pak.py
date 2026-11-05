"""Give the kit's sound renderer a named copy of a PAK with a stripped directory."""


def sound_pak(work, cfg, pak):
    if run([REPAK, "list", pak], 120).stdout.strip():
        return pak
    tool = os.environ.get("REPAKXTRA_UAT")
    if not tool:
        raise RuntimeError("This PAK needs the app's asset reader to recover its filenames. Update the app.")
    paths = run([tool, "list_pak", pak, "--paths-only", "--aes", cfg["aes"]], 120).stdout.splitlines()
    if not paths:
        return pak
    # The native extractor joins names to its output folder. Refuse paths that could leave it.
    for path in paths:
        parts = path.replace("\\", "/").split("/")
        if any(p in ("", ".", "..") or ":" in p for p in parts):
            raise RuntimeError("This sound PAK contains an unsafe file path.")
    folder = work / "sound-files"
    folder.mkdir(parents=True, exist_ok=True)
    run([tool, "extract_pak", pak, folder, "--aes", cfg["aes"]], 120)
    named = work / "sound.pak"
    run([REPAK, "pack", folder, named, "--compression", "Zlib"], 120)
    return named
