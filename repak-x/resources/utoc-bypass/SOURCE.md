# Marvel Rivals UTOC Signature Bypass, bundled with repakxtra

Installed by repakxtra's Setup panel (src/xtra_setup.rs). These are the files of the Nexus Mods release, unchanged:
https://www.nexusmods.com/marvelrivals/mods/14652, "UTOC Signature Bypass (Performance DLC Compatible)" 1.0, archive
"UTOC Signature Bypass (Performance DLC Compatible) 14652 1.0 2026-11-15T16-49Z V1FmjUDgP.zip",
sha256 8037cd79fdaded52efc7849cfea8ceef71af78304d8515b642fa57611973cbed. It loads mods in the base game and in the game's
performance DLC launcher, which the older release (Nexus mod 2940) does not.

| File | Goes to | Size | SHA-256 |
|---|---|---|---|
| dsound.dll | Binaries\Win64 | 415232 | bb8767f918c52a2ad055d2de9baffd2478598643b9894f09abd20d1f1ffd170c |
| MarvelRivalsUTOCSignatureBypass.asi | Binaries\Win64\plugins | 45056 | 39a5ec6e27f419e019402a362ad02ea37b1f8f4b3550882ab924ca775d774282 |
| Ultimate ASI Loader License.txt | (shown in the app) | 1086 | d6a3ebe8c7b2beec1acc44ec722b53692d1cea53b065ee5b1893588aa83b0b91 |

dsound.dll is ThirteenAG's Ultimate ASI Loader x64 v7.7.0 (MIT), byte for byte the dinput8.dll of the official release
https://github.com/ThirteenAG/Ultimate-ASI-Loader/releases/tag/v7.7.0 (Ultimate-ASI-Loader_x64.zip), renamed. It is the
same file the older release shipped.
The .asi imports only memory and thread patching from KERNEL32 (VirtualProtect, FlushInstructionCache, Suspend/ResumeThread)
plus the C runtime: no network, file, registry or process-launch calls. Its import list is identical to the older
release's. It is unsigned and closed source.

The older release's .asi (Nexus mod 2940, archive sha256 251d2830ec8c1f3ed804ce4d8340705264642435cd3218308d18c7ee314db776,
.asi 44032 bytes, sha256 2f8b183149f30c94319a5f6636491ff39aa22afbbf3f5cbc5fb8f7ecc287a62d) is what repakxtra shipped
before. xtra_setup.rs OLD_BYPASS knows its hash: Setup shows it as "Update available" and replaces it in one click.
