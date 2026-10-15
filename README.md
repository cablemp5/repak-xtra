<p align="center">
  <img src=".github/banner.svg" alt="repakxtra, Marvel Rivals mod manager" width="100%">
</p>

<p align="center">
  <a href="https://github.com/cablemp5/repak-xtra/stargazers"><img src="https://img.shields.io/github/stars/cablemp5/repak-xtra?style=flat-square&color=111111&label=stars" alt="Stars"></a>
  <a href="https://github.com/cablemp5/repak-xtra/releases"><img src="https://img.shields.io/github/v/release/cablemp5/repak-xtra?include_prereleases&style=flat-square&color=111111&label=release" alt="Release"></a>
  <a href="https://github.com/cablemp5/repak-xtra/releases"><img src="https://img.shields.io/github/downloads/cablemp5/repak-xtra/total?style=flat-square&color=111111&label=downloads" alt="Downloads"></a>
  <img src="https://img.shields.io/badge/platform-Windows-111111?style=flat-square" alt="Windows">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-111111?style=flat-square" alt="GPL-3.0 license"></a>
  <a href="https://github.com/X-zant/Repak-X"><img src="https://img.shields.io/badge/built%20on-Repak%20X-111111?style=flat-square" alt="Built on Repak X"></a>
</p>

**A Marvel Rivals mod manager built on [Repak X](https://github.com/X-zant/Repak-X), with loadouts, generated previews and one-click setup.**

repakxtra is cable's fork of Repak X. Everything Repak X does is still here; this fork adds a home screen of loadouts, rendered previews of your mods, a guided first launch, a Sigeon V2 config editor and a setup panel for the tools mods need.

<img src=".github/screenshots/loadouts.png" alt="The Loadouts screen" width="100%">

**Contents:** [Built on Repak X](#built-on-repak-x) · [Getting started](#getting-started) · [Features](#features) ([Loadouts](#loadouts), [Previews](#previews), [Library](#library), [Setup](#setup), [Sigeon V2 Editor](#sigeon-v2-editor), [Look and feel](#look-and-feel)) · [Keyboard shortcuts](#keyboard-shortcuts) · [Screenshots](#screenshots) · [Building from source](#building-from-source) · [Credits](#credits) · [License](#license)

## Built on Repak X

repakxtra would not exist without **[Repak X](https://github.com/X-zant/Repak-X)** by **Xzant** (backend, project founder) and **Saturn** (frontend), with thanks to the people they credit: **Trumank** (the original repak and retoc libraries), **Krisan Thyme** (the first Rivals skeletal mesh patcher), **Natimerry** (Repak Rivals GUI, which inspired Repak X), **amMatt** and the **Marvel Rivals Modding Server**. Installing, organizing, conflict checks, the Asset Explorer, the VFX Updater and the rest of the core all come from Repak X. Please support the original project.

> [!NOTE]
> This fork is personal and unofficial: it is not made by the Repak X team, and neither project is affiliated with NetEase or Marvel.

## Getting started

1. Download the newest release (pre-releases included) from [Releases](https://github.com/cablemp5/repak-xtra/releases) and unzip it anywhere.
2. Open `repakxtra.exe`. If Windows SmartScreen warns about an unknown publisher, choose **More info**, then **Run anyway**.
3. Follow the setup screen that opens on first launch:

| Step | What it does |
| --- | --- |
| Game folder | Finds your Marvel Rivals folder. |
| Signature bypass | Installs in one click. Every mod needs it. |
| Project Galacta | Installs in one click. The mod loader for skin mods. |
| Mod previews | Optional. Installs the preview kit and finds or installs Blender. |
| First mods | Adds your first mods. |

4. Take the optional short tour: making a loadout, turning it on and off, editing its mods, the Library, adding mods and Setup.

> [!WARNING]
> Close the game before changing anything in Setup.

> [!TIP]
> Everything from the first launch stays available under **Setup** in the header. To change the game's `~mods` folder later, use **Settings** (Auto Detect finds a Steam install).

## Features

### Loadouts

| Feature | What it does |
| --- | --- |
| Loadouts screen | A grid of cards, one per loadout, that opens with the app. Each card has a picture, an on and off switch and a count like `3/7 on`. |
| One switch per look | Turns a whole loadout on or off. Loadouts are independent: switching one never touches mods outside it. A warning appears when two loadouts that are on change the same hero. |
| Groups | Sort loadouts into named groups (create, rename, reorder, delete with Undo, drag cards between them), or view them by hero. |
| Loadout pages | Name, group, picture or video, every mod in the loadout with its own switch, and a searchable list to add more by type. |
| Make loadouts anywhere | From the Library's selection, the right-click menu (`Add to loadout`), the sidebar's `+`, or while installing. The install panel adds each mod to the loadouts you pick, or saves the install as a new loadout. |
| Undo everywhere | Removing mods, replacing a loadout, deleting a group or a loadout. |
| New this week | Recently installed mods, with one click to add them to a loadout or swap in a newer version. |

### Previews

| Feature | What it does |
| --- | --- |
| Rendered previews | Character mods are rendered on the hero in the lobby pose with the game's toon outline. Previews read the mods' real materials: inherited textures and colors, cosmic galaxies, glassy "jelly" skins, chrome and gold, Human Torch's burning body and flame shells, and Damisa-style eyes. |
| Combined loadout renders | A loadout's mesh, textures and its VFX eye and body-light colors render together on one character. |
| Animation previews | Animation mods get a looping clip of the animation on a gray model, shown with the loadout's other previews. |
| Cards for every kind of mod | VFX mods get a palette of the colors they actually change, UI mods a sheet of their icons (a whole emote wheel), and sound mods a list of the sounds they replace, with emotes by their in-game names. |
| Carousel | Each card pages through the loadout's pictures in a fixed order: mesh, texture, material, animation, VFX, UI, text, audio. |
| Generate all previews | A queue, a progress line, Stop, and the choice to redo only loadouts without a preview. Unchanged mods are not rendered again. |
| Capture in game | Takes the loadout's image from the game itself (steps below). |

**Capture a loadout's image in game**

1. Open the page of a loadout that has mesh or texture mods.
2. With the game open, go to that hero's **Overview** or **Cosmetics** screen.
3. Press `Ctrl+Shift+X` in the game, or **Capture now** in the app.

The screenshot is cropped to the character at any resolution and becomes the loadout's image.

> [!NOTE]
> Rendered previews need the preview kit (the generator, Python and tools), a separate download, plus [Blender](https://www.blender.org/download/), which is free. **Setup > Mod previews** installs both.

### Library

| Feature | What it does |
| --- | --- |
| Sidebar and filters | A loadout sidebar, hero and type filters, and a filter title that stays readable. |
| Quick edits | Double-click a mod to rename it; right-click for `Add to loadout`. |
| Tags toggle | A clear `Tags shown` or `Tags hidden` toggle, with **Delete all tags** (with Undo). |
| Undo for deletes | Deleted mods go to a trash folder and come back exactly as they were. |

### Setup

| Feature | What it does |
| --- | --- |
| Signature bypass | Ships with repakxtra. Install it in one click, turn it off or on, or remove it. `Is it safe?` shows the VirusTotal result, that the loader is byte for byte ThirteenAG's Ultimate ASI Loader 7.7.0, what the bypass can and cannot do, and every file's SHA-256. |
| Project Galacta | Checks GitHub for the newest release, updates in one click into the folder you choose, and shows the release notes. |
| Mod previews | Installs the preview kit in one click with download progress, and checks for kit updates at start. Finds Blender, installs it (winget), or lets you pick `blender.exe`. A kit zip dropped on the window installs it too. |

### Sigeon V2 Editor

| Feature | What it does |
| --- | --- |
| Configs | Create, duplicate, rename and delete Sigeon V2 configs, pick the base config, flip its switches, and set stretched resolution, gamma and sharpening. |
| Console overrides | Add, edit or remove console overrides, with search. |
| Your files stay yours | Your notes in the files stay where they are. |
| Folder and switching | Choose where your Sigeon folder lives. Switch configs from the header's Sigeon menu. |
| First-time setup | No Sigeon yet? The header reads `Sigeon not configured` and opens a short setup: where to buy it ([oinkerhub.com/CABLE](https://oinkerhub.com/CABLE)), the signature bypass it loads through, and its folder. |

> [!NOTE]
> The license key is never shown or touched by the app. You type it into the config file yourself (`Open in Notepad`).

### Look and feel

| Feature | What it does |
| --- | --- |
| Theme | A quiet dark interface with one blue accent, the Geist typeface, and a lowercase logo with `xtra` in blue. |
| Sound and motion | Optional sound effects ([cuelume](https://cuelume-site.pages.dev/), mechanical theme) and motion ([transitions.dev](https://transitions.dev/) recipes), each with an off switch in Settings. |
| Minimal toasts | Off by default. Skips the toasts for everyday actions (switching loadouts, installs, previews) and keeps errors, warnings, updates and deletions you can undo. |
| UI scale | From 90% to 150%. |

## Keyboard shortcuts

| Keys | Action |
| --- | --- |
| `F1` | Show every shortcut |
| `L` | Switch between Loadouts and the Library |
| `Ctrl+1` to `Ctrl+9` | Turn loadout 1 to 9 on or off (sidebar order) |
| `Ctrl+G` | Launch the game |
| `Ctrl+O` | Install PAKs or archives |
| `S` | Cycle Sigeon: Off, Base, High |
| `Ctrl+Shift+X` (in game) | [Capture the loadout's image](#previews) |

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
# Builds the folder as it is, uncommitted edits included, into dist\Repak-X-Test\repakxtra.exe
.\build.ps1 -Test

# The stable build: only from a clean main. Open it as dist\repakxtra\repakxtra.exe (always the newest stable build)
.\build.ps1
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
