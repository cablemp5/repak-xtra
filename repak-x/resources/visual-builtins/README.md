# repakxploit visual built-ins

These resources come from the four packages supplied for this feature. They are compiled only with `extended`.

- `impact.txt`: the 559 asset paths in `zNoImpact_9999999_P.zip`.
- `tracers.txt`: the 415 asset paths in `zNoTracersAll_9999999_P.zip`.
- `screen-shake.txt`: the 1991 asset paths in `noss_9999999_P`: camera shake blueprints and montages.
- `fov-logic.zip`: JSON source for the seven mod-owned `/Game/FOV/` assets decoded from `!FOVSlider_9999999_P`. Game assets are excluded.
- `fov-widget.json`: names, import identities, export identities, and the two added widget exports from FOV Slider. This is a recipe for extending the current game widget, not a replacement for that widget.

No Impact and No Tracers extract the listed assets from the installed game. They decode emitter and renderer platform rules, locate their serialized quality masks within the corresponding export, and zero only those masks. Original headers and all other export bytes are retained. Hero exclusions select which assets are rebuilt. New asset paths outside the supplied mods' coverage are not guessed. Missing assets or an ambiguous/unsupported serialization stop installation.

FOV Slider edits the current settings table and hero-select widget, remapping references by identity. A decode after rebuilding verifies imports and export data before packing. The app also rebuilds all seven custom FOV assets from their JSON source with the current mappings. Their blueprint logic and in-game controls are preserved. Structural changes to game widgets or blueprint APIs can still require a recipe update.

All three packaged mods use the existing staged IoStore and PAK encryption, whose encryption operation verifies the decrypted payloads. Project Sigeon is a compatibility reference only; none of its attached assets are bundled here.

Skip login video is a loose-file mod. It uses the supplied `yakuzadeso` placeholder for each existing seasonal `LoginAndLobby/*/Transition.bk2`. Its originals and digest records are retained under `.repakxtra-builtin`, and turning it off restores only placeholders still owned by this operation. Game updates and third-party replacements are preserved. Loose movies cannot be encrypted without changing how the game reads them.

Movie publication uses atomic file replacement with a separate rollback copy for each season. Recorded movies missing after an interrupted older install recover from verified backups. Tests cover twelve seasons through the production publisher, interrupted publication, missing files, and rollback after a replacement fails.

The ignored Rust tests `visual_reference_assets`, `effects_real`, and `fov_real` use `REPAKXTRA_REFERENCES` to point at a local reference workspace. The former compares regenerated exports against both supplied effect mods byte for byte. `effects_real` checks encrypted effect builds and hero exclusions. `fov_real` rebuilds FOV in a temporary folder, encrypts it, and decodes all nine packages. These tests do not install into the game. Movie recovery tests use temporary game folders.

No Screen Shake extracts the listed camera shakes and montages from the installed game. It zeroes the amplitude and frequency floats of each camera shake oscillator, and the keys and default value of each montage CameraLocationOffset and CameraRotationOffset curve. Each struct is located by its header and current values. Other curves, headers, and bytes are retained, and an ambiguous match stops installation.
