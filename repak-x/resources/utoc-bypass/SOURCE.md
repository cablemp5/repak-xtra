# Marvel Rivals UTOC Signature Bypass, bundled with repakxtra

Installed by repakxtra's Setup panel (src/caleb_setup.rs). These are the files of the Nexus Mods release, unchanged:
https://www.nexusmods.com/marvelrivals/mods/2940 (archive "Marvel Rivals UTOC Signature Bypass Patch-2940-1-0-0-1746280225.7z",
sha256 251d2830ec8c1f3ed804ce4d8340705264642435cd3218308d18c7ee314db776; VirusTotal 0 of 63 engines on 2026-10-14:
https://www.virustotal.com/gui/file/251d2830ec8c1f3ed804ce4d8340705264642435cd3218308d18c7ee314db776).

| File | Goes to | Size | SHA-256 |
|---|---|---|---|
| dsound.dll | Binaries\Win64 | 415232 | bb8767f918c52a2ad055d2de9baffd2478598643b9894f09abd20d1f1ffd170c |
| MarvelRivalsUTOCSignatureBypass.asi | Binaries\Win64\plugins | 44032 | 2f8b183149f30c94319a5f6636491ff39aa22afbbf3f5cbc5fb8f7ecc287a62d |
| Ultimate ASI Loader License.txt | (shown in the app) | 1086 | d6a3ebe8c7b2beec1acc44ec722b53692d1cea53b065ee5b1893588aa83b0b91 |

dsound.dll is ThirteenAG's Ultimate ASI Loader x64 v7.7.0 (MIT), byte for byte the dinput8.dll of the official release
https://github.com/ThirteenAG/Ultimate-ASI-Loader/releases/tag/v7.7.0 (Ultimate-ASI-Loader_x64.zip), renamed.
The .asi imports only memory and thread patching from KERNEL32 (VirtualProtect, FlushInstructionCache, Suspend/ResumeThread)
plus the C runtime: no network, file, registry or process-launch calls. It is unsigned and closed source.
