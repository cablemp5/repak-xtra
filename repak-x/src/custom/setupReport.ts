// repakxtra: Copy setup report (Settings > Help & Community, and Setup). Plain text a helper can read in Discord: the
// app and loader state first, then the mods that are on, so the summary survives Discord's 2,000 character cut. No
// absolute path and no Windows user name: mods are named from ~mods down.
import { invoke } from '@tauri-apps/api/core'
import { REPAKXTRA_VERSION } from './version'
import { groupConflicts } from './ConflictsPanel'
import { plural } from './modName'
import { sourceOf } from './nexusSource'

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

export type ReportMod = { name: string; type: string; hero: string; date: string; extra?: string }
export type ReportInput = {
  version: string; repakx?: string; launcher: string; bypass: string; galacta: string; sigeon: string
  on: ReportMod[]; off: number; conflicts: string; crash: string
}

const pad = (n: number) => String(n).padStart(2, '0')
const day = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/** "~mods/Sub/Name_9999999_P.pak" for a mod inside the mods folder, else its file name alone. */
export function relativeToMods(path: string, gamePath: string) {
  const p = path.replace(/\\/g, '/'), root = gamePath.replace(/\\/g, '/').replace(/\/+$/, '')
  if (root && p.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return `~mods/${p.slice(root.length + 1)}`
  return p.split('/').pop() || p
}

/** Last line of defense: any absolute Windows path left loses its drive and user folder. */
export const scrub = (text: string) => text
  .replace(/[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s]+/gi, '%USERPROFILE%')
  .replace(/[A-Za-z]:[\\/][^\s|]*[\\/](~mods[\\/])/gi, '$1')

/** The report text: inside a code block, so Discord keeps underscores and lines as they are. */
export function buildReport(r: ReportInput) {
  const lines = [
    '```',
    `repakxtra ${r.version}${r.repakx ? ` (RepakX ${r.repakx})` : ''}, ${r.launcher}`,
    `Signature bypass: ${r.bypass}`,
    `Project Galacta: ${r.galacta}`,
    `Sigeon: ${r.sigeon}`,
    `Mods: ${r.on.length} on, ${r.off} off`,
    `Conflicts: ${r.conflicts}`,
    `Newest crash: ${r.crash}`,
    '',
    r.on.length ? 'Mods that are on (name | type | hero | file date):' : 'No mods are on.',
    ...r.on.map(m => [m.name, m.type, m.hero || '-', m.date, ...(m.extra ? [m.extra] : [])].join(' | ')),
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
    settled(invoke<{ time: number; crash_type?: string | null; asset_path?: string | null } | null>('xtra_newest_crash')),
  ])
  const g = galacta && galactaChecked?.installed === galacta.installed ? { ...galacta, ...galactaChecked } : galacta
  const galactaText = !g ? 'unknown' : !g.installed ? 'not installed' : [
    /[\\/]~mods([\\/]|$)/i.test(g.installed) ? g.installed.replace(/^.*?[\\/]~mods/i, '~mods').replace(/\\/g, '/') : 'outside ~mods',
    g.disabled ? 'off' : 'on',
    g.up_to_date === true ? `${g.latest}, up to date` : g.up_to_date === false ? `older than ${g.latest}` : 'version not checked',
  ].join(', ')
  const on = src.mods.filter(m => m.enabled).map(m => {
    const d = src.modDetails[m.path]
    return {
      name: relativeToMods(m.path, src.gamePath),
      type: d?.category || 'Unknown',
      hero: d?.character_name || '',
      date: m.modified_date ? day(new Date(m.modified_date * 1000)) : '-',
      extra: sourceOf(m.path) ? `Nexus ${sourceOf(m.path)!.id}` : undefined,
    }
  }).sort((a, b) => a.name.localeCompare(b.name))
  const crashText = crash === undefined ? 'unknown' : !crash ? 'none found' : [
    `${day(new Date(crash.time * 1000))} ${pad(new Date(crash.time * 1000).getHours())}:${pad(new Date(crash.time * 1000).getMinutes())}`,
    crash.crash_type || 'unknown type',
    ...(crash.asset_path ? [`asset ${crash.asset_path}`] : []),
  ].join(', ')
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
  })
}

if (import.meta.env.DEV) {
  const root = 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\MarvelRivals\\MarvelGame\\Marvel\\Content\\Paks\\~mods'
  console.assert(relativeToMods(`${root}\\Sub\\A_9999999_P.pak`, root) === '~mods/Sub/A_9999999_P.pak', 'mods relative to ~mods')
  console.assert(relativeToMods('D:\\Elsewhere\\B.pak', root) === 'B.pak', 'outside ~mods: the file name only')
  console.assert(scrub('C:\\Users\\someone\\Desktop\\x and D:/Games/MarvelRivals/~mods/a.pak') === '%USERPROFILE%\\Desktop\\x and ~mods/a.pak', 'no user name, no drive paths', scrub('C:\\Users\\someone\\Desktop\\x and D:/Games/MarvelRivals/~mods/a.pak'))
  const text = buildReport({ version: '1.0.0', launcher: 'Steam', bypass: 'installed', galacta: 'not installed', sigeon: 'off',
    on: [{ name: '~mods/A.pak', type: 'Mesh', hero: 'Black Panther', date: '2026-10-01' }], off: 3, conflicts: '0 groups', crash: 'none found' })
  console.assert(text.indexOf('Newest crash') < text.indexOf('~mods/A.pak | Mesh | Black Panther | 2026-10-01'), 'summary before the mod list', text)
}
