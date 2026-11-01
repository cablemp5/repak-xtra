# Repak X — Changelog

## [2.2.0](https://github.com/X-zant/Repak-X/releases/latest)

### ✨ VFX Updater
- Mods made before a game update that couldn't be read now have their materials recovered using older USMAPs, so their parameters carry over
- Materials that still can't be parsed are listed as a warning instead of failing silently
- Mods with no updatable parameters now stop with a clear message instead of producing a bypass-only mod
- Deep dependencies are only pulled in for blueprints, which makes extraction faster for material mods

