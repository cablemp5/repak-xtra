// repakxtra: Copy setup report (Settings > Help & Community, and Setup). Plain text a helper can read in Discord: the
// app and loader state first, then the mods that are on, so the summary survives Discord's 2,000 character cut. No
// absolute path and no Windows user name: mods are named from ~mods down.
import { invoke } from '@tauri-apps/api/core'
import { REPAKXTRA_VERSION } from './version'
import { groupConflicts } from './ConflictsPanel'
import { plural } from './modName'
import { sourceOf } from './nexusSource'
import { type Verdict, verdictLabel } from './brokenMods'

type Mod = { path: string; enabled?: boolean; modified_date?: number }
type Details = { category?: string | null; character_name?: string | null }
export type ReportSource = { mods: Mod[]; modDetails: Record<string, Details | undefined>; launcherType: string; gamePath: string }

/** App.tsx keeps this pointed at its current mod list, details and settings. */
export const reportSource: { get?: () => ReportSource } = {}

type Galacta = { installed: string | null; disabled: boolean; latest?: string | null; up_to_date?: boolean | null }
let galactaChecked: Galacta | null = null
/** Setup's online Galacta check: the only place its installed version is known (a byte match with the latest release). */
export const noteGalactaCheck = (g: Galacta) => { galactaChecked = g }

export const DISCORD_LIMIT = 2000

/** notes: what the app knows about the mod (needs a VFX update, may crash, Niagara), why: the reason it gives */
export type ReportMod = { name: string; type: string; hero: string; date: string; extra?: string; notes?: string[]; why?: string }
export type ReportInput = {
  version: string; repakx?: string; launcher: string; bypass: string; galacta: string; sigeon: string
  on: ReportMod[]; off: number; conflicts: string; crash: string
  crashLines?: string[] // more on the newest crash, one indented line each
  flags?: string // how many mods that are on need an update, may crash or carry Niagara
}

const pad = (n: number) => String(n).padStart(2, '0')
const day = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/** "~mods/Sub/Name_9999999_P.pak" for a mod inside the mods folder, else its file name alone. */
export function relativeToMods(path: string, gamePath: string) {
  const p = path.replace(/\\/g, '/'), root = gamePath.replace(/\\/g, '/').replace(/\/+$/, '')
  if (root && p.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return `~mods/${p.slice(root.length + 1)}`
  return p.split('/').pop() || p
}

/** Last line of defense: any absolute Windows path left loses its drive and folders. Folder names may hold spaces
 *  (C:\Users\First Last\..., D:/Build Farm/...), so a path runs to its last separator before the line, a | or quote, a
 *  square bracket, or the next drive path ends it: too much goes rather than a name staying. A network path (\\server\share or
 *  //server/share) goes whole. */
const ENDS = String.raw`\r\n|"'<>\]` // not ): Program Files (x86) is one folder
const NEXT_DRIVE = String.raw`(?![A-Za-z]:[\\/])`
export const scrub = (text: string) => text
  // the // of https:// follows a colon, so it is not a network path
  .replace(new RegExp(String.raw`(?<![:\w])[\\/]{2}[^\s\\/|"']+[\\/][^${ENDS}]*`, 'g'), '<network path>')
  // a drive letter stands alone: the s: of https:// is not one
  .replace(/(?<![A-Za-z])[A-Za-z]:[\\/]+Users[\\/]+[^\\/\r\n|"']+/gi, '%USERPROFILE%')
  .replace(new RegExp(String.raw`(?<![A-Za-z])[A-Za-z]:[\\/](?:${NEXT_DRIVE}[^${ENDS}])*?[\\/](~mods[\\/])`, 'gi'), '$1')
  .replace(new RegExp(String.raw`(?<![A-Za-z])[A-Za-z]:[\\/](?:${NEXT_DRIVE}[^${ENDS}])*[\\/]`, 'g'), '') // any other drive path keeps only its file name
  .replace(/(?<![A-Za-z])[A-Za-z]:[\\/](?=[^\\/]*$)/gm, '') // a file at a drive's root

/** The report text: inside a code block, so Discord keeps underscores and lines as they are. */
export function buildReport(r: ReportInput) {
  const lines = [
    '```',
    `repakxtra ${r.version}${r.repakx ? ` (RepakX ${r.repakx})` : ''}, ${r.launcher}`,
    `Signature bypass: ${r.bypass}`,
    `Project Galacta: ${r.galacta}`,
    `Sigeon: ${r.sigeon}`,
    `Mods: ${r.on.length} on, ${r.off} off`,
    ...(r.flags ? [`Mods that are on: ${r.flags}`] : []),
    `Conflicts: ${r.conflicts}`,
    `Newest crash: ${r.crash}`,
    ...(r.crashLines ?? []).map(l => `  ${l}`),
    '',
    r.on.length ? 'Mods that are on (name | type | hero | file date | notes):' : 'No mods are on.',
    ...r.on.flatMap(m => [
      [m.name, m.type, m.hero || '-', m.date, ...(m.notes?.length ? [m.notes.join(', ')] : []), ...(m.extra ? [m.extra] : [])].join(' | '),
      ...(m.why ? [`  why: ${m.why}`] : []),
    ]),
    '```',
  ]
  return scrub(lines.join('\n'))
}

const settled = <T,>(p: Promise<T>) => p.then(v => v, () => undefined)
const BYPASS: Record<string, string> = { installed: 'installed', disabled: 'off', partial: 'incomplete', other: 'a different version', missing: 'not installed' }

/** Reads everything the report needs; whatever cannot be read says "unknown". */
export async function gatherReport(): Promise<string> {
  const src = reportSource.get?.() ?? { mods: [], modDetails: {}, launcherType: '', gamePath: '' }
  const [repakx, bypass, galacta, sigeon, clashes, crash] = await Promise.all([
    settled(invoke<string>('get_app_version')),
    settled(invoke<{ state: string }>('setup_bypass_status')),
    settled(invoke<Galacta>('setup_galacta_status', { online: false })),
    settled(invoke<{ state: string; configured: boolean }>('sigeon_status')),
    settled(invoke<{ file_path: string; mod_paths: string[]; files?: string[] }[]>('check_mod_clashes', { quiet: true })),
    settled(invoke<{ time: number; crash_type?: string | null; asset_path?: string | null; seconds_since_start?: number | null; message?: string | null; detail?: string | null } | null>('xtra_newest_crash')),
  ])
  const onPaths = src.mods.filter(m => m.enabled).map(m => m.path)
  // what the app knows about the mods that are on: checked now, not from the last background scan
  const [verdicts, niagara, suspects] = await Promise.all([
    settled(invoke<Verdict[]>('xtra_broken_mods', { modPaths: onPaths })),
    settled(invoke<string[]>('xtra_niagara_mods', { modPaths: onPaths })),
    crash?.asset_path ? settled(invoke<string[]>('xtra_crash_suspects', { assetPath: crash.asset_path, modPaths: onPaths })) : Promise.resolve([] as string[]),
  ])
  const key = (p: string) => p.replace(/\//g, '\\').toLowerCase().replace(/\.(pak|bak_repak)$/, '')
  const verdictOf = new Map((verdicts ?? []).map(v => [key(v.path), v]))
  const hasNiagara = new Set((niagara ?? []).map(key))
  const g = galacta && galactaChecked?.installed === galacta.installed ? { ...galacta, ...galactaChecked } : galacta
  const galactaText = !g ? 'unknown' : !g.installed ? 'not installed' : [
    /[\\/]~mods([\\/]|$)/i.test(g.installed) ? g.installed.replace(/^.*?[\\/]~mods/i, '~mods').replace(/\\/g, '/') : 'outside ~mods',
    g.disabled ? 'off' : 'on',
    g.up_to_date === true ? `${g.latest}, up to date` : g.up_to_date === false ? `older than ${g.latest}` : 'version not checked',
  ].join(', ')
  const on = src.mods.filter(m => m.enabled).map(m => {
    const d = src.modDetails[m.path]
    const v = verdictOf.get(key(m.path))
    return {
      name: relativeToMods(m.path, src.gamePath),
      type: d?.category || 'Unknown',
      hero: d?.character_name || '',
      date: m.modified_date ? day(new Date(m.modified_date * 1000)) : '-',
      extra: sourceOf(m.path) ? `Nexus ${sourceOf(m.path)!.id}` : undefined,
      notes: [...(v ? [verdictLabel(v.kind)] : []), ...(hasNiagara.has(key(m.path)) ? ['Niagara'] : [])],
      why: v?.reason.split(/\.\s/)[0].slice(0, 140), // the first sentence: a long list of flagged mods must still fit
    }
  }).sort((a, b) => a.name.localeCompare(b.name))
  const count = (kind: Verdict['kind']) => (verdicts ?? []).filter(v => v.kind === kind).length // only the mods that are on were asked about
  const flags = !verdicts ? 'not checked' : [
    `${count('vfx')} need a VFX update`, `${count('risky')} may crash`, `${count('broken')} broken`, `${hasNiagara.size} with Niagara`,
  ].join(', ')
  const when = (t: number) => `${day(new Date(t * 1000))} ${pad(new Date(t * 1000).getHours())}:${pad(new Date(t * 1000).getMinutes())}`
  const crashText = crash === undefined ? 'unknown' : !crash ? 'none found' : [
    when(crash.time),
    crash.crash_type || 'unknown type',
    ...(crash.asset_path ? [`asset ${crash.asset_path}`] : []),
  ].join(', ')
  // the rest of what the crash says: how far into the game, its message, and which mods that are on hold the asset it named
  const crashLines = !crash ? [] : [
    ...(crash.seconds_since_start != null ? [`${Math.round(crash.seconds_since_start / 60)} min into the game`] : []),
    ...(crash.message ? [`message: ${crash.message}`] : []),
    ...(crash.detail && !crash.message?.includes(crash.detail) ? [crash.detail] : []),
    ...(crash.asset_path
      ? [suspects === undefined ? 'mods holding that asset: could not check'
        : suspects.length ? `mods holding that asset: ${suspects.map(p => relativeToMods(p, src.gamePath)).join(', ')}` : 'no mod that is on holds that asset']
      : []),
  ]
  return buildReport({
    version: REPAKXTRA_VERSION,
    repakx,
    launcher: src.launcherType === 'epic' ? 'Epic' : src.launcherType === 'steam' ? 'Steam' : 'launcher unknown',
    bypass: bypass ? BYPASS[bypass.state] ?? bypass.state : 'unknown',
    galacta: galactaText,
    sigeon: !sigeon ? 'unknown' : !sigeon.configured ? 'not set up' : sigeon.state === 'off' ? 'off' : `on, config "${sigeon.state}"`,
    on,
    off: src.mods.filter(m => !m.enabled).length,
    conflicts: clashes ? plural(groupConflicts(clashes).length, 'group') : 'unknown',
    crash: crashText,
    crashLines,
    flags,
  })
}

if (import.meta.env.DEV) {
  const root = 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\MarvelRivals\\MarvelGame\\Marvel\\Content\\Paks\\~mods'
  console.assert(relativeToMods(`${root}\\Sub\\A_9999999_P.pak`, root) === '~mods/Sub/A_9999999_P.pak', 'mods relative to ~mods')
  console.assert(relativeToMods('D:\\Elsewhere\\B.pak', root) === 'B.pak', 'outside ~mods: the file name only')
  console.assert(scrub('C:\\Users\\someone\\Desktop\\x and D:/Games/MarvelRivals/~mods/a.pak') === '%USERPROFILE%\\Desktop\\x and ~mods/a.pak', 'no user name, no drive paths', scrub('C:\\Users\\someone\\Desktop\\x and D:/Games/MarvelRivals/~mods/a.pak'))
  console.assert(scrub('at C:\\Users\\First Last\\Marvel\\x.cpp') === 'at %USERPROFILE%\\Marvel\\x.cpp', 'a user folder with a space goes whole', scrub('at C:\\Users\\First Last\\Marvel\\x.cpp'))
  console.assert(scrub('see \\\\SERVER\\Shared Folder\\Users\\someone\\file.cpp\nnext') === 'see <network path>\nnext', 'a network path goes whole, spaces too', scrub('see \\\\SERVER\\Shared Folder\\Users\\someone\\file.cpp\nnext'))
  console.assert(scrub('https://github.com/x/y') === 'https://github.com/x/y', 'a web address is not a path')
  console.assert(scrub('[File:D:/Build Farm/Alice Smith/project/crash.cpp]') === '[File:crash.cpp]', 'folders with spaces go whole', scrub('[File:D:/Build Farm/Alice Smith/project/crash.cpp]'))
  console.assert(scrub('at //SERVER/Shared Folder/Alice/file.cpp') === 'at <network path>', 'a forward-slash network path goes whole', scrub('at //SERVER/Shared Folder/Alice/file.cpp'))
  console.assert(scrub('C:/Program Files (x86)/Steam/MarvelRivals/~mods/a.pak') === '~mods/a.pak', 'a mods folder under a spaced path', scrub('C:/Program Files (x86)/Steam/MarvelRivals/~mods/a.pak'))
  console.assert(scrub('C:/a/b.pak and D:/c d/e.pak') === 'b.pak and e.pak', 'two paths on a line keep both file names', scrub('C:/a/b.pak and D:/c d/e.pak'))
  const text = buildReport({ version: '1.0.0', launcher: 'Steam', bypass: 'installed', galacta: 'not installed', sigeon: 'off',
    on: [{ name: '~mods/A.pak', type: 'Mesh', hero: 'Black Panther', date: '2026-10-01' }], off: 3, conflicts: '0 groups', crash: 'none found' })
  console.assert(text.indexOf('Newest crash') < text.indexOf('~mods/A.pak | Mesh | Black Panther | 2026-10-01'), 'summary before the mod list', text)
  const flagged = buildReport({ version: '1.0.0', launcher: 'Steam', bypass: 'installed', galacta: 'not installed', sigeon: 'off', conflicts: '0 groups',
    crash: '2026-10-24 21:03, Access Violation', crashLines: ['7 min into the game', 'message: boom D:\\build\\x\\y.cpp'], flags: '1 need a VFX update, 0 may crash, 0 broken, 1 with Niagara',
    on: [{ name: '~mods/A.pak', type: 'VFX', hero: '', date: '2026-10-01', notes: ['Needs VFX update', 'Niagara'], why: 'made before the game update' }], off: 0 })
  console.assert(flagged.includes('~mods/A.pak | VFX | - | 2026-10-01 | Needs VFX update, Niagara\n  why: made before the game update'), 'notes and reason on the mod line', flagged)
  console.assert(flagged.includes('  7 min into the game') && flagged.includes('message: boom y.cpp') && flagged.includes('Mods that are on: 1 need a VFX update'), 'crash lines indented, paths cut to a file name, flags summarised', flagged)
}
