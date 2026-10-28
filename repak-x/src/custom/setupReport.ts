import { EXTENDED, LOADER_NAME } from './edition'
// repakxtra: Copy setup report (Settings > Help & Community, and Setup). Plain text a helper can read in Discord: the
// app and loader state first, then the mods that are on, so the summary survives Discord's 2,000 character cut. No
// absolute path and no Windows user name: mods are named from ~mods down.
import { invoke } from '@tauri-apps/api/core'
import { REPAKXTRA_VERSION } from './version'
import { groupConflicts } from './ConflictsPanel'
import { plural } from './modName'
import { sourceOf } from './nexusSource'
import { type Verdict, verdictLabel } from './brokenMods'
import { type Tiered, tierLines } from './crashTiers'

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
  // from the newest crash file: summary lines, so a pasted summary still carries the diagnosis
  system?: string; faulting?: string; thirdParty?: string; oom?: boolean
  stack?: string[]; thread?: string // the top frames, below the summary
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
  // a path under a user folder keeps only its file name (or what follows ~mods): folder names (OneDrive - Company) can
  // name the player too
  .replace(new RegExp(String.raw`(?<![A-Za-z])[A-Za-z]:[\\/]+Users[\\/]+(?:${NEXT_DRIVE}(?![\\/]~mods[\\/])[^${ENDS}])*[\\/]`, 'gi'), '%USERPROFILE%\\…\\')
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
    `${LOADER_NAME}: ${r.galacta}`,
    ...(EXTENDED ? [`SigeonLoader.asi config: ${r.sigeon}`] : []),
    `Mods: ${r.on.length} on, ${r.off} off`,
    ...(r.flags ? [`Mods that are on: ${r.flags}`] : []),
    `Conflicts: ${r.conflicts}`,
    `Newest crash: ${r.crash}`,
    ...(r.crashLines ?? []).map(l => `  ${l}`),
    ...(r.system ? [`System: ${r.system}`] : []),
    ...(r.faulting ? [`Faulting module: ${r.faulting}`] : []),
    ...(r.thirdParty ? [`Third-party modules: ${r.thirdParty}`] : []),
    ...(r.oom ? ['Out of memory: yes'] : []),
    '',
    ...(r.stack?.length ? [`Crash stack, top ${r.stack.length}${r.thread ? ` (${r.thread})` : ''}:`, ...r.stack.map(l => `  ${l}`), ''] : []),
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
type Opt = string | null | undefined
/** xtra_crash.rs NewestCrash, already redacted */
type Crash = {
  time: number; crash_type?: Opt; asset_path?: Opt; character_id?: Opt; seconds_since_start?: number | null; message?: Opt; detail?: Opt
  build_version?: Opt; engine_version?: Opt; cpu?: Opt; gpu?: Opt; gpu_driver?: Opt; rhi?: Opt; os?: Opt; ram_gb?: number | null
  oom?: boolean; thread?: Opt; faulting_module?: Opt; faulting_class?: Opt; stack?: string[]; third_party?: string[]
}
const BYPASS: Record<string, string> = { installed: 'installed', disabled: 'off', partial: 'incomplete', other: 'a different version', missing: 'not installed' }

/** This edition's loader pak (!ProjectGalacta_9999999_P, or !ProjectSigeon_9999999_P in repakxploit), on or off. The other
 *  edition's loader stays listed: on, it means two loaders. */
const isOwnLoader = (path: string) =>
  new RegExp(String.raw`^!?project${EXTENDED ? 'sigeon' : 'galacta'}(_\d+)?(_p)?\.(pak|bak_repak)$`, 'i').test(path.split(/[\\/]/).pop() ?? '')

/** Reads everything the report needs; whatever cannot be read says "unknown". */
export async function gatherReport(): Promise<string> {
  const src = reportSource.get?.() ?? { mods: [], modDetails: {}, launcherType: '', gamePath: '' }
  const [repakx, bypass, galacta, sigeon, clashes, crash] = await Promise.all([
    settled(invoke<string>('get_app_version')),
    settled(invoke<{ state: string }>('setup_bypass_status')),
    settled(invoke<Galacta>('setup_galacta_status', { online: false })),
    EXTENDED ? settled(invoke<{ state: string; configured: boolean }>('sigeon_status')) : Promise.resolve(null),
    settled(invoke<{ file_path: string; mod_paths: string[]; files?: string[] }[]>('check_mod_clashes', { quiet: true })),
    settled(invoke<Crash | null>('xtra_newest_crash')),
  ])
  // the edition's own loader has its line above, so it is not counted or listed as a mod too
  const mods = src.mods.filter(m => !isOwnLoader(m.path))
  const onPaths = mods.filter(m => m.enabled).map(m => m.path)
  // what the app knows about the mods that are on: checked now, not from the last background scan
  const [verdicts, niagara, suspects] = await Promise.all([
    settled(invoke<Verdict[]>('xtra_broken_mods', { modPaths: onPaths })),
    settled(invoke<string[]>('xtra_niagara_mods', { modPaths: onPaths })),
    crash?.asset_path || crash?.character_id
      ? settled(invoke<Tiered[]>('xtra_crash_tiers', { assetPath: crash.asset_path ?? '', heroId: crash.character_id ?? null, modPaths: onPaths }))
      : Promise.resolve([] as Tiered[]),
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
  const suspect = new Set((suspects ?? []).filter(t => t.tier === 'asset').map(t => key(t.path))) // hold the asset the newest crash names
  const on = mods.filter(m => m.enabled).map(m => {
    const d = src.modDetails[m.path]
    const v = verdictOf.get(key(m.path))
    const s = suspect.has(key(m.path))
    const changedSince = s && crash && m.modified_date && m.modified_date > crash.time ? ', changed since that crash' : ''
    return {
      name: relativeToMods(m.path, src.gamePath),
      type: d?.category || 'Unknown',
      hero: d?.character_name || '',
      date: m.modified_date ? day(new Date(m.modified_date * 1000)) : '-',
      extra: sourceOf(m.path) ? `Nexus ${sourceOf(m.path)!.id}` : undefined,
      notes: [...(v ? [verdictLabel(v.kind)] : []), ...(s ? ['Crash suspect'] : []), ...(hasNiagara.has(key(m.path)) ? ['Niagara'] : [])],
      why: [
        v?.reason.split(/\.\s/)[0].slice(0, 140), // the first sentence: a long list of flagged mods must still fit
        s ? `holds the asset the newest crash names${changedSince}` : undefined,
      ].filter(Boolean).join('. ') || undefined,
    }
  }).sort((a, b) => a.name.localeCompare(b.name))
  const count = (kind: Verdict['kind']) => (verdicts ?? []).filter(v => v.kind === kind).length // only the mods that are on were asked about
  // a crash suspect may crash too, unless it already counts as broken
  const mayCrash = onPaths.filter(p => verdictOf.get(key(p))?.kind === 'risky' || (suspect.has(key(p)) && verdictOf.get(key(p))?.kind !== 'broken')).length
  const flags = !verdicts ? 'not checked' : [
    `${count('vfx')} need a VFX update`, `${mayCrash} may crash`, `${count('broken')} broken`, `${hasNiagara.size} with Niagara`,
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
    ...(crash.build_version ? [`game build ${crash.build_version}${crash.engine_version ? ` (${crash.engine_version})` : ''}`] : []),
    ...(crash.asset_path || crash.character_id ? tierLines(suspects, p => relativeToMods(p, src.gamePath)) : []),
  ]
  const gpuInfo = [crash?.gpu_driver, crash?.rhi].filter(Boolean).join(', ')
  const system = [crash?.cpu, crash?.gpu && `${crash.gpu}${gpuInfo ? ` (${gpuInfo})` : ''}`, crash?.ram_gb != null && `${crash.ram_gb} GB`, crash?.os]
    .filter(Boolean).join(', ')
  return buildReport({
    version: REPAKXTRA_VERSION,
    repakx,
    launcher: src.launcherType === 'epic' ? 'Epic' : src.launcherType === 'steam' ? 'Steam' : 'launcher unknown',
    bypass: bypass ? BYPASS[bypass.state] ?? bypass.state : 'unknown',
    galacta: galactaText,
    sigeon: !sigeon ? 'unknown' : !sigeon.configured ? 'not set up' : sigeon.state === 'off' ? 'off' : `on, config "${sigeon.state}"`,
    on,
    off: mods.filter(m => !m.enabled).length,
    conflicts: clashes ? plural(groupConflicts(clashes).length, 'group') : 'unknown',
    crash: crashText,
    crashLines,
    flags,
    system: system || undefined,
    faulting: crash?.faulting_module ? `${crash.faulting_module} (${crash.faulting_class || 'unknown'})` : undefined,
    thirdParty: system ? crash?.third_party?.join(', ') || 'none' : undefined, // no system facts: an old crash file, modules unknown too
    oom: crash?.oom,
    stack: crash?.stack,
    thread: crash?.thread || undefined,
  })
}

if (import.meta.env.DEV) {
  const root = 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\MarvelRivals\\MarvelGame\\Marvel\\Content\\Paks\\~mods'
  console.assert(relativeToMods(`${root}\\Sub\\A_9999999_P.pak`, root) === '~mods/Sub/A_9999999_P.pak', 'mods relative to ~mods')
  console.assert(relativeToMods('D:\\Elsewhere\\B.pak', root) === 'B.pak', 'outside ~mods: the file name only')
  console.assert(isOwnLoader(`${root}\\${EXTENDED ? '!ProjectSigeon' : '!ProjectGalacta'}_9999999_P.pak`) && !isOwnLoader(`${root}\\${EXTENDED ? 'ProjectSigeonFan' : 'BuckySwap_ProjectGalacta'}_P.pak`)
    && !isOwnLoader(`${root}\\${EXTENDED ? '!ProjectGalacta' : '!ProjectSigeon'}_9999999_P.pak`), 'only this edition\'s own loader leaves the mod list')
  console.assert(scrub('C:\\Users\\someone\\Desktop\\x and D:/Games/MarvelRivals/~mods/a.pak') === '%USERPROFILE%\\…\\x and ~mods/a.pak', 'no user name, no drive paths', scrub('C:\\Users\\someone\\Desktop\\x and D:/Games/MarvelRivals/~mods/a.pak'))
  console.assert(scrub('at C:\\Users\\First Last\\Marvel\\x.cpp') === 'at %USERPROFILE%\\…\\x.cpp', 'a user folder with a space goes whole', scrub('at C:\\Users\\First Last\\Marvel\\x.cpp'))
  console.assert(scrub('C:\\Users\\x\\OneDrive - Contoso Ltd\\Games\\a.pak') === '%USERPROFILE%\\…\\a.pak', 'no folders under the user folder', scrub('C:\\Users\\x\\OneDrive - Contoso Ltd\\Games\\a.pak'))
  console.assert(scrub('C:\\Users\\x\\Games\\MarvelRivals\\~mods\\Sub\\a.pak') === '%USERPROFILE%\\…\\~mods\\Sub\\a.pak', 'a mods folder under the user folder', scrub('C:\\Users\\x\\Games\\MarvelRivals\\~mods\\Sub\\a.pak'))
  console.assert(scrub('home is C:\\Users\\Alice now') === 'home is %USERPROFILE%', 'the user folder alone, the rest of the line too', scrub('home is C:\\Users\\Alice now'))
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
  console.assert(!flagged.includes('System:') && !flagged.includes('Out of memory') && !flagged.includes('Crash stack'), 'no crash file facts, no lines for them', flagged)
  const diagnosed = buildReport({ version: '1.0.0', launcher: 'Steam', bypass: 'installed', galacta: 'not installed', sigeon: 'off', conflicts: '0 groups', off: 0,
    crash: '2026-10-25 20:55, ObjectSerializationError', system: 'AMD Ryzen 5 5600X, AMD Radeon RX 6700 XT (Adrenalin 26.10.1, D3D12), 16 GB, Windows 10',
    faulting: 'nvwgf2umx (GPU driver)', thirdParty: 'dsound.dll, MarvelRivalsUTOCSignatureBypass.asi', oom: true, thread: 'RenderThread 1',
    stack: ['nvwgf2umx + 12ab (GPU driver)', 'Marvel-Win64-Shipping + 10c296b (game)'],
    on: [{ name: '~mods/A.pak', type: 'Mesh', hero: '', date: '2026-10-01' }] })
  const summary = diagnosed.slice(0, diagnosed.indexOf('\n\n'))
  console.assert(['System: AMD Ryzen', 'Faulting module: nvwgf2umx (GPU driver)', 'Third-party modules: dsound.dll, MarvelRivalsUTOCSignatureBypass.asi', 'Out of memory: yes']
    .every(l => summary.includes(`\n${l}`)), 'crash diagnosis in the top summary block', summary)
  console.assert(diagnosed.includes('\n\nCrash stack, top 2 (RenderThread 1):\n  nvwgf2umx + 12ab (GPU driver)\n  Marvel-Win64-Shipping + 10c296b (game)\n\n')
    && diagnosed.indexOf('Crash stack') < diagnosed.indexOf('~mods/A.pak'), 'stack frames indented, below the summary, above the mods', diagnosed)
  console.assert(!buildReport({ version: '1.0.0', launcher: 'Steam', bypass: 'installed', galacta: 'not installed', sigeon: 'off', conflicts: '0 groups', off: 0, crash: 'x', oom: false, on: [] })
    .includes('Out of memory'), 'out of memory only when true')
}
