<p align="center">
  <img src=".github/banner.svg" alt="repakxtra" width="560">
</p>

<p align="center">
  <a href="https://github.com/cablemp5/repak-xtra/stargazers"><img src="https://img.shields.io/github/stars/cablemp5/repak-xtra?style=flat-square&color=111111&label=stars" alt="Stars"></a>
  <a href="https://github.com/cablemp5/repak-xtra/releases"><img src="https://img.shields.io/github/v/release/cablemp5/repak-xtra?include_prereleases&sort=semver&style=flat-square&color=111111&label=release" alt="Release"></a>
  <a href="https://github.com/cablemp5/repak-xtra/releases"><img src="https://img.shields.io/github/downloads/cablemp5/repak-xtra/total?style=flat-square&color=111111&label=downloads" alt="Downloads"></a>
  <img src="https://img.shields.io/badge/platform-Windows-111111?style=flat-square" alt="Windows">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-111111?style=flat-square" alt="GPL-3.0 license"></a>
  <a href="https://github.com/X-zant/Repak-X"><img src="https://img.shields.io/badge/built%20on-Repak%20X-111111?style=flat-square" alt="Built on Repak X"></a>
</p>

**A Marvel Rivals mod manager built on [Repak X](https://github.com/X-zant/Repak-X), with loadouts, generated previews and one-click setup.**

<img src=".github/screenshots/loadouts.png" alt="The Loadouts screen" width="100%">

## Built on Repak X

repakxtra is a fork of **[Repak X](https://github.com/X-zant/Repak-X)** by **Xzant** (backend, founder) and **Saturn** (frontend), with thanks to **Trumank**, **Krisan Thyme**, **Natimerry**, **amMatt** and the **Marvel Rivals Modding Server**. It adds loadouts, previews and guided setup on top; installing, conflict checks, the Asset Explorer, the VFX Updater and the rest of the core are Repak X's work. Please support the original project.

> [!NOTE]
> repakxtra is an unofficial fork: not made by the Repak X team, and not affiliated with NetEase or Marvel.

## Getting started

1. Download the newest release from [Releases](https://github.com/cablemp5/repak-xtra/releases) and unzip it anywhere.
2. Open `repakxtra.exe` (on a SmartScreen warning: **More info**, then **Run anyway**).
3. Follow the first-launch setup: game folder, signature bypass, Project Galacta, optional mod previews, first mods. All of it stays under **Setup** later.

> [!WARNING]
> Close the game before changing anything in Setup.

## Features

**Loadouts**
- One click turns a set of mods on or off. Loadouts are independent, and you are warned when two that are on change the same hero.
- Groups (drag cards between them) or a view by hero.
- Make one from the Library selection, the right-click menu, the sidebar or while installing. Undo for every removal.
- The Library sidebar lists them for quick switching, the ones that are on first.

**Previews**
- Character mods render on the hero in the lobby pose, using the mods' real materials. A loadout's mods render together.
- Animations get a looping clip, VFX mods a palette of the colors they change, UI mods an icon sheet, sound mods a list.
- **Generate all previews** queues every loadout. Mods with nothing to show are marked "No preview possible".
- **Capture in game:** on a loadout's page, press `Ctrl+Shift+X` on the hero's Overview or Cosmetics screen to use a screenshot instead.

> [!NOTE]
> Rendered previews need the preview kit and [Blender](https://www.blender.org/download/) (free). **Setup > Mod previews** installs both.

**Library:** hero and type filters, double-click to rename, deletes go to a trash folder with Undo.

**Setup:** the signature bypass ships inside the app (with an "Is it safe?" report), Project Galacta installs and updates in one click, and the preview kit and Blender install from here.

**Sigeon V2 Editor:** create and edit configs and console overrides, and switch configs from the header. Your license key is never shown or touched.

## Keyboard shortcuts

| Keys | Action |
| --- | --- |
| `F1` | Show every shortcut |
| `L` | Switch between Loadouts and the Library |
| `Ctrl+1` to `Ctrl+9` | Turn loadout 1 to 9 on or off (Loadouts page order) |
| `Ctrl+G` | Launch the game |
| `Ctrl+O` | Install PAKs or archives |
| `S` | Cycle Sigeon: Off, Base, High |
| `Ctrl+Shift+X` (in game) | [Capture the loadout's image](#features) |

## Screenshots

<table>
  <tr>
    <td width="50%"><img src=".github/screenshots/loadout-page.png" alt="A loadout's page"><br><sub>A loadout's page</sub></td>
    <td width="50%"><img src=".github/screenshots/generating.png" alt="Previews generating"><br><sub>Generating all previews</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src=".github/screenshots/library.png" alt="Library"><br><sub>Library</sub></td>
    <td width="50%"><img src=".github/screenshots/setup.png" alt="Setup"><br><sub>Setup</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src=".github/screenshots/sigeon-editor.png" alt="Sigeon V2 Editor"><br><sub>Sigeon V2 Editor</sub></td>
    <td width="50%"><img src=".github/screenshots/settings.png" alt="Settings"><br><sub>Settings: UI scale, sound and motion</sub></td>
  </tr>
</table>

## FAQ

<details>
<summary><strong>Is repakxtra the official Repak X?</strong></summary>

No. repakxtra is an unofficial fork of [Repak X](https://github.com/X-zant/Repak-X). Installing, conflict checks,
the Asset Explorer and the VFX Updater are Repak X's work; repakxtra adds loadouts, previews and guided setup.
Bugs in repakxtra belong here, not with the Repak X team.

</details>

<details>
<summary><strong>Why does every mod need the signature bypass?</strong></summary>

Marvel Rivals only loads files it has signed, so a mod that replaces game files is ignored without the bypass.
repakxtra ships the bypass inside the app: **Setup** installs, repairs or turns it off, and its
**Is it safe?** report shows what gets installed. Close the game before changing anything in Setup.

</details>

<details>
<summary><strong>What is Project Galacta, and do I need it?</strong></summary>

Most skin mods need it. It loads more mod types and swaps mesh mods live in game. **Setup** installs the newest
[Project Galacta](https://github.com/0xSaturno/ProjectGalacta) release in one click and tells you when an update is out.

</details>

<details>
<summary><strong>Why can't I switch mods or loadouts right now?</strong></summary>

The game is running. Mods and loadouts only switch while Marvel Rivals is closed. Close the game, switch, then
launch it again (`Ctrl+G`).

</details>

<details>
<summary><strong>How do I get mod previews?</strong></summary>

Rendered previews need the preview kit and [Blender](https://www.blender.org/download/) (free).
**Setup > Mod previews** downloads the newest kit and installs Blender if it's missing; a kit zip dropped on the
window installs too. Without either, **Capture in game** on a loadout's page uses a screenshot of the hero instead.

</details>

<details>
<summary><strong>How do I update repakxtra?</strong></summary>

**Settings > Updates > Check Now.** When a newer release is out, **Download update** fetches it and
**Install and restart** replaces the app and opens the new version. Loadouts, settings and pictures carry over.

</details>

<details>
<summary><strong>Does the Sigeon V2 Editor see my license key?</strong></summary>

No. The editor never reads, shows or saves the key: **Open in Notepad** opens the config so you can paste the key
after `licenseKey=` yourself, and every save writes the key line back exactly as it was. The editor follows the
current `SigeonLoader.ini` format (base, n64, low, mid and high configs, Hide UID, gamma and sharpening).

</details>

<details>
<summary><strong>What should I do if I hit a bug?</strong></summary>

Update first (**Settings > Updates > Check Now**); a newer release may already fix it. If it persists, ask on
[Discord](https://discord.gg/C7geHdWBP5) with your repakxtra version (shown in the header), what you
did, and what happened.

</details>

## Building from source

**Requirements (Windows):** Git with [Git LFS](https://git-lfs.com/), [rustup](https://rustup.rs/) (`rust-toolchain.toml` picks the toolchain and the MSVC target), [Node.js](https://nodejs.org/) 22, the [.NET 8 SDK](https://dotnet.microsoft.com/download/dotnet/8.0), and Visual Studio Build Tools with the C++ workload (the MSVC linker).

Clone with submodules (the asset tool lives in `UAssetToolRivals`):

```powershell
git lfs install
git clone --recurse-submodules https://github.com/cablemp5/repak-xtra.git
cd repak-xtra
```

Build:

```powershell
# Live dev copy: the real app from the folder as it is, interface edits reloading on save (the first start compiles a debug build)
.\dev.ps1

# Builds the folder as it is, uncommitted edits included, into dist\Repak-X-Test\repakxtra.exe
.\build.ps1 -Test

# The stable build: only from a clean main. Open it as dist\repakxtra\repakxtra.exe (always the newest stable build)
.\build.ps1

# A release: builds main into dist\repak-xtra-v<version>-windows.zip and copies the gh command that publishes it
.\build.ps1 -Release
```

> [!NOTE]
> The app runs one copy at a time and both builds share `%APPDATA%\Repak-X`: close the stable repakxtra before opening the test one.

<details>
<summary>What <code>build.ps1</code> runs (the same steps as the release workflow)</summary>

```powershell
dotnet publish UAssetToolRivals/src/UAssetTool/UAssetToolNative.csproj -c Release -r win-x64 -p:DebugType=none -p:DebugSymbols=false -o target/uassettool
cd repak-x
npm install
npm run build
cd ..
$env:SKIP_UASSET_TOOL_BUILD = '1'
cargo build --release --target x86_64-pc-windows-msvc --features custom-protocol
```

It then copies `REPAK-X.exe` as `repakxtra.exe`, with the asset tool and `data\character_data.json`, into the output folder.
</details>

### Checks

Pull requests into `main` must pass **Typecheck, build and test** (`.github/workflows/checks.yml`). Run the same locally:

```powershell
cd repak-x
npm ci
npx tsc --noEmit -p .
npm run build
cd ..
$env:SKIP_UASSET_TOOL_BUILD = '1'
cargo test -p repak-x --bin REPAK-X
```

### Browser preview

```powershell
cd repak-x
npm run dev
```

This serves the interface in a normal browser with a mock backend (`src/dev/mockBackend.ts`) instead of the Rust one, so what it shows is fake data.

## Credits

- **[Repak X](https://github.com/X-zant/Repak-X)** by Xzant and Saturn, and everyone credited in its Credits panel.
- **Ultimate ASI Loader** by [ThirteenAG](https://github.com/ThirteenAG/Ultimate-ASI-Loader) (MIT), and the **Marvel Rivals UTOC Signature Bypass** from [Nexus Mods](https://www.nexusmods.com/marvelrivals/mods/2940).
- **[Project Galacta](https://github.com/0xSaturno/ProjectGalacta)** by 0xSaturno.
- **Sigeon V2** by its authors ([Discord](https://discord.gg/oinkers)); repakxtra only edits your own configs.
- [cuelume](https://cuelume-site.pages.dev/) sounds, [transitions.dev](https://transitions.dev/) motion recipes, [Geist](https://vercel.com/font) and [Lucide](https://lucide.dev/) icons.

## License

GPL-3.0, the same as Repak X. See [LICENSE](LICENSE).
