# repakxtra and repakxploit

One codebase, one GitHub repository, two Windows editions. The legacy internal name `extended` is retained for repakxploit update compatibility. Standard is the default.
Shared application changes reach both editions when both are rebuilt and released.

| | Standard | repakxploit |
| --- | --- | --- |
| Loader offered in Setup | Project Galacta, downloaded from upstream | Project Sigeon 2.0.0 Minimal, bundled |
| Force default skin / Custom Quake | Not offered | Included |
| AMOLED black theme | Not offered | Optional in Settings > Interface; saved separately from Standard's appearance |
| Sigeon V2 editor and switch | Not compiled or offered | Included; requires the user's separate SigeonLoader.asi |
| GitHub release tag | `v<version>` | `extended-v<version>` |
| ZIP | `repak-xtra-standard-v<version>-windows.zip` | `repak-xtra-extended-v<version>-windows.zip` |

## Try a local build

From the repository root:

```powershell
.\build.ps1 -Test -Edition Standard
.\build.ps1 -Test -Edition Repakxploit
```

Output: `dist\Repak-X-Test\repakxtra.exe` and
`dist\Repak-X-Test-Extended\repakxtra.exe`. They retain the existing app identifier,
share settings, and run one edition at a time. Close the other copy before opening one.
If a test copy is running, the next build uses the alternate `Test-next` folder.
`dist\repakxtra-Test` and `dist\repakxtra-Test-Extended` always point at the newest
test builds, so desktop shortcuts can follow rebuilds without closing the old copy.

Installed stable copies are updated **only through the in-app updater**. Direct
stable builds are blocked. Use `-Test` for local work. `-Release` stages an update
archive separately; it never replaces an installed stable copy.
`-SkipTools` reuses existing native tools for test builds and is rejected for releases.
repakxploit stable branding is red; its test branding is purple, including the
wordmark, splash, and taskbar icon. Run
`powershell -File scripts/New-ExtendedShortcuts.ps1` after building both tests to
update the green repakxtra test shortcut and the red/purple repakxploit shortcuts.
The stable shortcut's new name and red icon do not alter its installed executable;
the rest of its rebranding arrives through the next in-app update.

repakxploit needs the supplied archive on its first build on a new machine:

```powershell
.\build.ps1 -Test -Edition Repakxploit -SigeonArchive 'C:\Downloads\ProjectSigeon-V2.0.0.zip'
```

Configure the shared unlock code locally before building extended:

```powershell
powershell -File scripts/Set-ExtendedUnlockCode.ps1
```

The prompt hides input. Only a SHA-256 hash is written to the ignored
`repak-x/resources/extended/activation.sha256`; the plaintext code is never bundled.
Keep the same hash for updates to preserve unlocks. Changing it requires users to
enter the new code. Do not commit either the code or local activation resources.
Every extended window starts with an unlock screen; its application content and
extended commands stay locked until the backend verifies the code or saved receipt.
standard has no unlock screen or activation commands.

The script stages it in `repak-x/resources/extended/ProjectSigeon.zip`, which is ignored
by Git. It is embedded only in the repakxploit executable. Standard can build without it.
The supplied ZIP holds Minimal, Splash, Settings, and Splash + Settings variants;
Setup currently installs Minimal only. To change the bundled version, update the ZIP
and its version/description in `xtra_setup.rs` together.

The Project Sigeon mod ZIP does not contain `SigeonLoader.asi`. Its V2 editor still
uses the ASI folder the user selects. These are separate inputs.

## Live dev copies

Close any running stable, test, or dev copy, then run from the repository root:

```powershell
.\dev.ps1 -Edition Repakxploit
```

repakxploit dev uses pink in its outlined header logo, splash, and taskbar icon.
It uses the same local Sigeon archive, shared unlock code, real library, and saved
settings as the other copies. Interface edits refresh live; Rust edits rebuild
and restart the dev app. Stop it with Ctrl+C in its terminal. No stable installation
is rebuilt or replaced. `dev.ps1` without an edition still starts standard dev in amber.

## Release both editions

Bump `REPAKXTRA_VERSION` in `repak-x/src/custom/version.ts` and add
`release-notes/v<version>.md` as usual. Commit and merge those changes, then
build each edition from a clean, current main:

```powershell
.\build.ps1 -Release -Edition Standard
.\build.ps1 -Release -Edition Repakxploit
```

Each command produces its ZIP, checksum, release notes, and a publish command.
Publishing remains a separate manual action. Save/run the first publish command
before the second build replaces it on the clipboard.

Both releases live in `cablemp5/repak-xtra`. repakxploit is marked prerelease and does
not become GitHub's Latest release. Share its release/download link directly.
The prerelease label separates distribution; it does not mean a different codebase.

Keep the two ZIPs on separate tags. Existing apps choose the first ZIP of a `v<semver>`
release and do not understand editions. They ignore `extended-v<semver>` tags, so
they receive Standard. Never attach repakxploit to a Standard tag.

### Existing users move to Standard through their normal update button

Publish the first Standard build under a normal `v<version>` tag with a version
higher than the currently published app. Keep `cablemp5/repak-xtra`, `repakxtra.exe`,
the application identifier, and the update ZIP layout unchanged. The ZIP filename
may include `standard`: the old updater accepts any app ZIP on that release.
The existing install is updated in place, keeping its settings and loadouts.
Users do not need a new download, key, or channel selection.

Do not publish the same version number again: installed apps only offer a higher
version. Do not put repakxploit on a `v<version>` tag, even as a prerelease: the old
updater considers prereleases too. Use `extended-v<version>` exclusively.

Regression tests run the pre-edition updater's selection and ZIP checks from
commit `7b5e239` against a mixed standard/repakxploit release feed and a Standard ZIP.

New builds select their own tag prefix and exact ZIP filename, skip incomplete
releases, and reject ZIPs whose `edition.json` does not match. The edition marker is
a compatibility check, not a cryptographic signature. This change retains the
existing updater rather than adding a signing service.

## Verify changes

```powershell
cd repak-x
$env:VITE_REPAKXTRA_EDITION = 'standard' # repeat with 'extended'
npm run build
node scripts/check-edition.mjs
```

Rust production builds reject a frontend built for the other edition. Direct
production builds must set the matching frontend edition and Cargo `extended`
feature; `build.ps1` does both. Development builds default to Standard.

## Current limits

The shared offline code is a convenience gate, not strong licensing. Public source
remains publicly buildable and a modified build can remove local checks. There is
no online activation service, per-user key, or remote revocation.

After migration, standard detects active Project Sigeon, its V2 ASI loader, and the
app's Custom Quake files. It offers an explicit cleanup action that disables them
by renaming them to unique `.repakxtra-disabled-…` backups. Other mods and INI files
stay untouched. Nothing is disabled automatically or while the game is running.
The saved Force default skin and Quake choices are set off, so reopening repakxploit does not rebuild it on its
own. To restore a backed-up file manually, close the game and rename it back to its
original name. Setup refuses to install either loader while the other is enabled,
including copies in other subfolders. No game files are changed by building.

Run `powershell -File scripts/Test-BuildOutput.ps1` for the junction/file-lock
regression and `node repak-x/scripts/check-release-notes.mjs` for release-note
edition checks. The file-lock test uses its own temporary processes and files.

GitHub Checks runs a Standard/repakxploit matrix: typecheck, frontend self-checks,
`npm run test:editions`, shipped JavaScript edition checks, and Rust tests for each
edition. repakxploit CI creates a synthetic Sigeon ZIP and dummy unlock hash in
the fresh checkout. It does not need the real archive or shared code, and it never
publishes those test builds. Local checks keep using your configured resources.
