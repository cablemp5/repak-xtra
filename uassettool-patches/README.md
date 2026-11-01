# UAssetToolRivals patches

repakxtra builds UAssetTool (the in-app `UAssetTool.dll` and `uassettool-cli.exe`) from the `UAssetToolRivals`
submodule, upstream's code, with these patches on top. `build.ps1` and `dev.ps1` apply them for the .NET publish and
take them out again (`apply.ps1`), so the submodule itself is never changed or forked.

| Patch | What it fixes | Measured |
|---|---|---|
| `0001-no-huge-allocations-on-misread-counts.patch` | UAssetAPI reads GPU script data it cannot decode as counts and lengths, then allocates arrays that size (gigabytes) before the read fails and the export falls back to raw bytes. Now a count that cannot fit in the bytes left fails at once, and `ReadBytes` asks only for what is left. Same exports, same JSON. | 89 Niagara files: 65.9 GB to 4.7 GB peak memory, 131 GB to 14 GB allocated, JSON identical |
| `0002-faster-batch-json-and-detect.patch` | `batch_to_json` (only the VFX Updater calls it) writes unindented JSON straight into the file instead of building an indented string first. `detect_type` reads a batch's assets in parallel (as `batch_to_json` does), results in the same order. | 89 Niagara files: 17.2 s to 12.6 s, peak memory 1.9 GB to 0.7 GB, same values |
| `0003-serve-keeps-game-containers-loaded.patch` | `serve`: the command line stays running and takes `extract_iostore_legacy` requests on stdin, keeping the game's 23 containers loaded while their files are unchanged (each request works on its own copy of the index, and no game file stays open between requests). Exits after 90 s idle. `xtra_uat_cli.rs` drives it. | A one-file extract 4.5 s to 0.2 s, a mod extract 5.2 s to 0.9 s, files byte for byte the same |

0004 (one shared JSON contract resolver) and 0005 (`detect_type` reads headers only) were dropped with the move to
upstream `06be1e6`, which has the same fixes (`342eac5`, `06be1e6`). 0002 now runs upstream's header-only read in
its parallel loop.

| `0006-faster-niagara-parse-and-json-members.patch` | Each element of a property array looked its type up again in the USMAP through the array's name and ancestry, which is the lookup the array itself just made: the array now hands its answer to its elements (`Usmap.ArrayHintName/Data`, thread-local, restored around nested arrays). And typed getters and setters for the members every property element carries (`UAssetContractResolver.CreateProperty`), which Newtonsoft otherwise reaches by reflection under NativeAOT. | 89 Niagara files in the app: 11.6 s to 9.6 s, then writing their JSON 33.7 to 25.7 CPU-seconds. JSON and rebuilt assets byte for byte the same |
| `0007-serve-never-answers-from-a-half-loaded-game.patch` | A `serve` load that came back incomplete (a container's name map or the script objects could not be read) was not kept, but still answered the request it was loaded for, and without the script objects every class reads `__ScriptImport_<hash>__`. That request now loads its own, as a one-shot run does. The two reads that failed silently say why on stderr (`xtra_uat_cli.rs` logs them). | Found by review (2026-10-24), not reproduced |

| `0008-extract-can-leave-out-bulk-data.patch` | `extract_iostore_legacy` takes `--no-bulk`: the conversion is told to leave out the bulk data (`.ubulk`, `.uptnl`, `.m.ubulk`), a flag `ZenToLegacyConverter.Convert` already had and nothing set. The `.uasset` and `.uexp` are the same. A read of texture settings needs only those (the game's textures hold 32 GB of pixel data). The command line and `serve` both take it (the library's JSON request does not). An older command line ignores the flag and extracts everything. | 1,000 real textures: 8.8 s to 6.2 s, 1,111 MB to 151 MB, 2,000 of 2,000 `.uasset` and `.uexp` byte for byte the same. 8,000 textures read the same settings as a read with pixel data |

| `0011-cli-to-json-streams-unindented.patch` | The command line's `to_json` writes unindented JSON straight into the file, as `batch_to_json` does since 0002, instead of building an indented string first (a Niagara system's is up to 30 MB). The effect built-ins decode through it, one process per file, several at once. Same values, whitespace only. | 16 Niagara files, 8 one after another 8.0 s to 7.0 s, 8 at once 3.5 s to 2.8 s. The three effect built-ins built from it come out byte for byte the same |

Patches stack: each applies on top of the ones before it, in name order.

`0010-encrypt-existing-iostore.patch` adds `encrypt_iostore` and `encrypt_pak` JSON actions. They write to separate staging
paths, preserve container identity and chunk payloads, and reopen the encrypted output to verify every payload. Empty
companion PAKs are valid. Signed, multipart and memory-mapped containers are refused. The app supplies the selected
on/off companion explicitly, so encrypting a VFX-updated disabled mod does not lose its PAK. Originals are backed up and
disabled before the app publishes the verified bundle. `scripts/check-encryption-roundtrip.py` checks temporary copies
through the native library; run its Python host beside `oo2core_9_win64.dll`.

## Refreshing a patch

When `build.ps1` says a patch no longer applies (the submodule moved to a newer upstream commit):

1. Apply what still applies by hand: `git -C UAssetToolRivals apply --3way uassettool-patches\<name>.patch`
2. Fix the conflict in the submodule's files, then write the patch again from the submodule:
   `git -C UAssetToolRivals diff -- <the files it touches> > uassettool-patches\<name>.patch`
3. Take it out again: `git -C UAssetToolRivals apply --reverse uassettool-patches\<name>.patch`

## The command line's build flags

`build.ps1` and `dev.ps1` compile the command line (`UAssetTool.csproj`, upstream's normal-.NET project) ahead of time
with `-p:PublishAot=true -p:TrimMode=partial`. Without `TrimMode=partial` the trimmer strips the field metadata of
UAssetAPI's `Export`, which `ConvertToChildExport` copies by reflection: every export loaded without parsing (packing
loads them that way) comes back with a null `ClassIndex`, and `create_mod_iostore` failed on every asset ("Object
reference not set"). Extracts never take that path, so the app's use of the command line was never affected. With the
flag, on 467 Niagara and material assets: packing works (1.1 s, every unpacked file the same as the preview kit's own
UAssetTool's output), extracts are byte for byte the same as before, and `serve` matches one-shot runs.
