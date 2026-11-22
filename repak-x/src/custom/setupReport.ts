import { LOADER_NAME } from './edition'
// repakxtra: Copy setup report (Settings > Help & Community, and Setup). Plain text a helper can read in Discord: what to
// check next first, then why mods might not load (the setup), then what the newest crash shows, recent activity, and the
// mods that are on, so the summary survives Discord's 2,000 character cut. The newest crash's redacted game log comes
// last. No absolute path, user name, account id, or token (scrub.ts): mods are named from ~mods down.
import { invoke } from '@tauri-apps/api/core'
import { REPAKXTRA_VERSION } from './version'
import { groupConflicts } from './ConflictsPanel'
import { plural } from './modName'
import { sourceOf } from './nexusSource'
import { type Verdict, verdictLabel } from './brokenMods'
import { type Tiered, tierLines } from './crashTiers'
import { crashTimeline, timelineLines, timelineRows, whenText, type Timeline } from './crashTimeline'
import { scrub } from './scrub'

export { scrub }

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
  version: string; repakx?: string; launcher: string; bypass: string; galacta: string; kit?: string
  made?: string // when the report was made
  notes?: { trying?: string; instead?: string } // what the player typed (ReportNotes.tsx), both optional
  next?: string[] // What to check next: one plain step each, from the checks below
  folder?: string; gameBuild?: string // the game folder's state and the installed game's build, now
  on: ReportMod[]; off: number; conflicts: string; crash: string
  crashRef?: string // the newest crash's own report (its folder name, cut short): its history and log are read by it
  crashLines?: string[] // more on the newest crash, one indented line each
  flags?: string // how many mods that are on need an update, may crash or carry Niagara
  // from the newest crash file: summary lines, so a pasted summary still carries the diagnosis
  system?: string; faulting?: string; thirdParty?: string; oom?: boolean
  stack?: string[]; thread?: string // the top frames, below the summary
  dumpLines?: string[] // the assets in the crash dump, below the stack: the summary above must fit Discord's cut
  recent?: string[] // the newest five crashes, one line each
  changes?: string[] // recent activity: before the newest crash (crashTimeline.ts, the same rows as its What changed?), or the newest events
  changesBefore?: boolean // `changes` are the ones before the newest crash
  log?: { status?: string; lines?: string[] } // the newest crash's game log, redacted: its last lines, or why there are none
}

const pad = (n: number) => String(n).padStart(2, '0')
const day = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/** "~mods/Sub/Name_9999999_P.pak" for a mod inside the mods folder, else its file name alone. */
export function relativeToMods(path: string, gamePath: string) {
  const p = path.replace(/\\/g, '/'), root = gamePath.replace(/\\/g, '/').replace(/\/+$/, '')
  if (root && p.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return `~mods/${p.slice(root.length + 1)}`
  return p.split('/').pop() || p
}

/** One line of what the player typed: on one line, at most 400 characters. Pure. */
const note = (t?: string) => t?.replace(/\s+/g, ' ').replace(/```/g, "'''").trim().slice(0, 400) || '' // a fence of its own would end the block
const LOG_LINES = 120

/** The report text: inside a code block, so Discord keeps underscores and lines as they are. */
export function buildReport(r: ReportInput) {
  const trying = note(r.notes?.trying), instead = note(r.notes?.instead)
  const crashed = r.crashRef !== undefined
  const lines = [
    '```',
    `repakxtra ${r.version}${r.repakx ? ` (RepakX ${r.repakx})` : ''}, ${r.launcher}`,
    ...(r.made ? [`Report made ${r.made}`] : []),
    '',
    'What to check next:',
    ...(r.next?.length ? r.next.map(l => `  - ${l}`) : ['  Nothing stands out in these checks. Say what you see in your help message.']),
    ...(trying || instead ? ['', ...(trying ? [`What I was trying to do: ${trying}`] : []), ...(instead ? [`What happened instead: ${instead}`] : [])] : []),
    '',
    'Why mods might not load:',
    ...(r.folder ? [`  Game folder: ${r.folder}`] : []),
    ...(r.gameBuild ? [`  Game build: ${r.gameBuild}`] : []),
    `  Signature bypass: ${r.bypass}`,
    `  ${LOADER_NAME}: ${r.galacta}`,
    ...(r.kit ? [`  Preview kit: ${r.kit}`] : []),
    `  Mods: ${r.on.length} on, ${r.off} off`,
    ...(r.flags ? [`  Mods that are on: ${r.flags}`] : []),
    `  Conflicts: ${r.conflicts}`,
    '',
    ...(crashed
      ? [`What the newest crash shows (report ${r.crashRef}):`, `  When: ${r.crash}`, ...(r.crashLines ?? []).map(l => `  ${l}`)]
      : [`Newest crash: ${r.crash}`]),
    ...(r.system ? [`  System: ${r.system}`] : []),
    ...(r.faulting ? [`  Faulting module: ${r.faulting}`] : []),
    ...(r.thirdParty ? [`  Third-party modules: ${r.thirdParty}`] : []),
    ...(r.oom ? ['  Out of memory: yes'] : []),
    '',
    ...(r.changes?.length ? [r.changesBefore ? 'Recent activity before that crash (newest first, what changed, not what caused it):' : 'Recent activity (newest first):', ...r.changes.map(l => `  ${l}`), ''] : []),
    ...(r.stack?.length ? [`Crash stack, top ${r.stack.length}${r.thread ? ` (${r.thread})` : ''}:`, ...r.stack.map(l => `  ${l}`), ''] : []),
    ...(r.dumpLines?.length ? ['Assets in the crash dump (in memory then, not always the cause), held by:', ...r.dumpLines.map(l => `  ${l}`), ''] : []),
    ...(r.recent?.length ? ['Crash reports (newest first, mods matched against what is installed now):', ...r.recent.map(l => `  ${l}`), ''] : []),
    r.on.length ? 'Mods that are on (name | type | hero | file date | notes):' : 'No mods are on.',
    ...r.on.flatMap(m => [
      [m.name, m.type, m.hero || '-', m.date, ...(m.notes?.length ? [m.notes.join(', ')] : []), ...(m.extra ? [m.extra] : [])].join(' | '),
      ...(m.why ? [`  why: ${m.why}`] : []),
    ]),
    // the log may hold a code fence of its own, which would end this block early
    ...(r.log ? ['', r.log.lines?.length ? `Game log of that crash, last ${r.log.lines.length} lines (user name, account ids, and tokens taken out):` : `Game log of that crash: ${r.log.status}`,
      ...(r.log.lines ?? []).map(l => l.replace(/```/g, "'''"))] : []),
    '```',
  ]
  return scrub(lines.join('\n'))
}

/** A game log that gave no text, in words: xtra_crash_log.rs log_status's codes, or the error as it came. Pure. */
export function logStatusText(e: unknown): string {
  const words: Record<string, string> = {
    log_missing: 'This crash has no game log.',
    log_unreadable: 'The game log could not be read. The game may still have it open, or it is too large.',
    log_undecodable: 'The game log could not be decrypted.',
    log_gone: 'That crash report is gone.',
  }
  return words[String(e)] ?? String(e)
}

const settled = <T,>(p: Promise<T>) => p.then(v => v, () => undefined)
type Opt = string | null | undefined
/** xtra_crash.rs NewestCrash, already redacted */
type Crash = {
  id: string; time: number; crash_type?: Opt; asset_path?: Opt; character_id?: Opt; seconds_since_start?: number | null; message?: Opt; detail?: Opt
  build_version?: Opt; engine_version?: Opt; cpu?: Opt; gpu?: Opt; gpu_driver?: Opt; rhi?: Opt; os?: Opt; ram_gb?: number | null
  oom?: boolean; thread?: Opt; faulting_module?: Opt; faulting_class?: Opt; stack?: string[]; third_party?: string[]; dump_assets?: string[]
}
const BYPASS: Record<string, string> = { installed: 'installed', disabled: 'off', partial: 'incomplete', other: 'a different version', missing: 'not installed', outdated: 'an older version', unreadable: 'there, but a file could not be read' }

/** The loader pak (!ProjectGalacta_9999999_P), on or off. Another loader stays listed: on, it means two loaders. */
const isOwnLoader = (path: string) =>
  new RegExp(String.raw`^!?projectgalacta(_\d+)?(_p)?\.(pak|bak_repak)$`, 'i').test(path.split(/[\\/]/).pop() ?? '')

export type ReportStage = 'setup' | 'mods'
/** Reads everything the report needs; whatever cannot be read says "unknown". Two passes: the setup (versions, loaders,
 *  conflicts, crashes), then what the app knows about each mod that is on. `onStage` names the pass that is running. */
export async function gatherReport(onStage?: (stage: ReportStage) => void, notes?: ReportInput['notes']): Promise<string> {
  onStage?.('setup')
  const src = reportSource.get?.() ?? { mods: [], modDetails: {}, launcherType: '', gamePath: '' }
  const [repakx, bypass, galacta, clashes, crash, kit, recent, build] = await Promise.all([
    settled(invoke<string>('get_app_version')),
    settled(invoke<{ state: string; files?: { found: string }[] }>('setup_bypass_status')),
    settled(invoke<Galacta>('setup_galacta_status', { online: false })),
    settled(invoke<{ file_path: string; mod_paths: string[]; files?: string[] }[]>('check_mod_clashes', { quiet: true })),
    settled(invoke<Crash | null>('xtra_newest_crash')),
    settled(invoke<{ version?: string | null }>('preview_kit_status')),
    settled(invoke<{ id?: string; time: number; crash_type?: Opt; asset_path?: Opt }[]>('xtra_recent_crashes')),
    settled(invoke<{ updated: number; cl?: number | null }>('xtra_game_build')),
  ])
  // the loader has its line above, so it is not counted or listed as a mod too
  const mods = src.mods.filter(m => !isOwnLoader(m.path))
  const onPaths = mods.filter(m => m.enabled).map(m => m.path)
  // what the app knows about the mods that are on: checked now, not from the last background scan
  onStage?.('mods')
  const [verdicts, niagara, suspects, onThen, logSummary, log] = await Promise.all([
    settled(invoke<Verdict[]>('xtra_broken_mods', { modPaths: onPaths })),
    settled(invoke<string[]>('xtra_niagara_mods', { modPaths: onPaths })),
    crash?.asset_path || crash?.character_id
      ? settled(invoke<Tiered[]>('xtra_crash_tiers', { assetPath: crash.asset_path ?? '', heroId: crash.character_id ?? null, modPaths: onPaths }))
      : Promise.resolve([] as Tiered[]),
    // the newest crash's own state and log, by its report's id (never another crash's, never by time alone)
    crash ? settled(invoke<string[] | null>('xtra_mods_on_at', { time: crash.time })) : Promise.resolve(undefined),
    crash ? settled(invoke<{ not_mounted?: string[] | null } | null>('xtra_crash_log_summary', { id: crash.id })) : Promise.resolve(undefined),
    crash ? invoke<string>('xtra_crash_log_text', { id: crash.id }).then(text => ({ text }), e => ({ status: logStatusText(e) })) : Promise.resolve(undefined),
  ])
  // the assets the crash dump holds (a crash that names none still has these), and which mods that are on hold each
  const dumpHeld = await Promise.all((crash?.dump_assets ?? []).slice(0, 5).map(async asset => {
    const t = await settled(invoke<Tiered[]>('xtra_crash_tiers', { assetPath: asset, heroId: null, modPaths: onPaths }))
    return { asset, held: t && t.filter(x => x.tier === 'asset').map(x => x.path) }
  }))
  const inDump = dumpHeld.map(({ asset, held }) => `${asset}: ${!held ? 'not checked' : holders(held.map(p => relativeToMods(p, src.gamePath)))}`)
  const key = (p: string) => p.replace(/\//g, '\\').toLowerCase().replace(/\.(pak|bak_repak)$/, '')
  const dumpSuspect = new Set(dumpHeld.flatMap(d => d.held ?? []).map(key)) // hold an asset the crash dump has
  const verdictOf = new Map((verdicts ?? []).map(v => [key(v.path), v]))
  const hasNiagara = new Set((niagara ?? []).map(key))
  const g = galacta && galactaChecked?.installed === galacta.installed ? { ...galacta, ...galactaChecked } : galacta
  const galactaText = !g ? 'could not be read' : !g.installed ? 'not installed' : [
    /[\\/]~mods([\\/]|$)/i.test(g.installed) ? g.installed.replace(/^.*?[\\/]~mods/i, '~mods').replace(/\\/g, '/') : 'outside ~mods',
    g.disabled ? 'off' : 'on',
    g.up_to_date === true ? `${g.latest}, up to date` : g.up_to_date === false ? `older than ${g.latest}` : 'version not checked',
  ].join(', ')
  const suspect = new Set((suspects ?? []).filter(t => t.tier === 'asset').map(t => key(t.path))) // hold the asset the newest crash names
  const on = mods.filter(m => m.enabled).map(m => {
    const d = src.modDetails[m.path]
    const v = verdictOf.get(key(m.path))
    const s = suspect.has(key(m.path))
    const inDumpToo = !s && dumpSuspect.has(key(m.path))
    const changedSince = (s || inDumpToo) && crash && m.modified_date && m.modified_date > crash.time ? ', changed since that crash' : ''
    return {
      name: relativeToMods(m.path, src.gamePath),
      type: d?.category || 'Unknown',
      hero: d?.character_name || '',
      date: m.modified_date ? day(new Date(m.modified_date * 1000)) : '-',
      extra: sourceOf(m.path) ? `Nexus ${sourceOf(m.path)!.id}` : undefined,
      notes: [...(v ? [verdictLabel(v.kind)] : []), ...(s || inDumpToo ? ['Crash suspect'] : []), ...(hasNiagara.has(key(m.path)) ? ['Niagara'] : [])],
      why: [
        v?.reason.split(/\.\s/)[0].slice(0, 140), // the first sentence: a long list of flagged mods must still fit
        s ? `holds the asset the newest crash names${changedSince}` : inDumpToo ? `holds an asset in the newest crash's dump${changedSince}` : undefined,
      ].filter(Boolean).join('. ') || undefined,
    }
  }).sort((a, b) => a.name.localeCompare(b.name))
  const count = (kind: Verdict['kind']) => (verdicts ?? []).filter(v => v.kind === kind).length // only the mods that are on were asked about
  // a crash suspect may crash too, unless it already counts as broken
  const mayCrash = onPaths.filter(p => verdictOf.get(key(p))?.kind === 'risky' || ((suspect.has(key(p)) || dumpSuspect.has(key(p))) && verdictOf.get(key(p))?.kind !== 'broken')).length
  const flags = !verdicts ? 'not checked' : [
    `${count('vfx')} need a VFX update`, `${mayCrash} may crash`, `${count('unknown')} could not be verified`, `${count('broken')} broken`, `${hasNiagara.size} with Niagara`,
  ].join(', ')
  const when = (t: number) => `${day(new Date(t * 1000))} ${pad(new Date(t * 1000).getHours())}:${pad(new Date(t * 1000).getMinutes())}`
  const crashText = crash === undefined ? 'could not be read' : !crash ? 'none found' : [
    when(crash.time),
    crash.crash_type || 'unknown type',
    ...(crash.asset_path ? [`asset ${crash.asset_path}`] : []),
  ].join(', ')
  // the rest of what the crash says: how far into the game, its message, and which mods that are on hold the asset it named
  const thenMods = (onThen ?? []).filter(k => !isOwnLoader(`${k}.pak`)) // the loader has its own line, as in the list now
  const notLoaded = (logSummary?.not_mounted ?? []).map(k => relativeToMods(`${k}.pak`, src.gamePath))
  const crashLines = !crash ? [] : [
    ...(crash.seconds_since_start != null ? [`${Math.round(crash.seconds_since_start / 60)} min into the game`] : []),
    ...(crash.message ? [`message: ${crash.message}`] : []),
    ...(crash.detail && !crash.message?.includes(crash.detail) ? [crash.detail] : []),
    crash.build_version ? `Game build then: ${crash.build_version}${build?.cl && !crash.build_version.includes(String(build.cl)) ? ', the game has updated since' : ''}` : 'Game build then: not recorded',
    !onThen ? 'Mods on then: not recorded, so the list below is what is on now'
      : `Mods on then: ${thenMods.length} (saved as the game started)${(() => { const now = new Set(onPaths.map(onKey)), then = new Set(thenMods), onThen = thenMods; const d = [...now].filter(k => !then.has(k)).length + onThen.filter(k => !now.has(k)).length; return d ? `, ${plural(d, 'mod')} changed on or off since` : ', the same as now' })()}`,
    ...(notLoaded.length ? [`On when the game started but not loaded by it: ${holdersAll(notLoaded)}`] : []),
    ...(crash.asset_path || crash.character_id ? tierLines(suspects, p => relativeToMods(p, src.gamePath)) : []),
  ]
  const recentLines = (await recentCrashes(mods.map(m => m.path), onPaths, recent)).map(c => {
    const head = `${when(c.time)}, ${c.asset ? `crashed loading ${c.asset}` : `crashed (${c.type})`}`
    const held = c.held?.map(p => relativeToMods(p, src.gamePath))
    const on = c.onAt === 'crash' ? 'that was on' : 'that is on now'
    const by = c.onAt === 'crash' ? 'replaced by, on at the time,' : 'replaced by, on now,'
    return !c.asset ? head : `${head}: ${!held ? 'not checked' : held.length ? `${by} ${held.join(', ')}` : `no mod ${on} replaces it`}`
  })
  // recent activity: before the newest crash by its report's id, as its What changed? shows it, or the newest events
  const changes = crash ? timelineLines(await crashTimeline(crash.id)) : activityLines(await settled(invoke<Timeline>('xtra_recent_activity')))
  const conflictGroups = clashes ? groupConflicts(clashes).length : undefined
  const bypassState = bypass?.files?.some(f => f.found === 'blocked') ? 'unreadable' : bypass?.state
  const next = nextSteps({
    // a bypass file that is there but cannot be read reads as its own state, not as incomplete
    folder: !src.gamePath ? 'unset' : build && !build.updated ? 'no-game' : 'ok', bypass: bypassState, galacta: g,
    vfx: count('vfx'), broken: count('broken'), conflicts: conflictGroups,
    mayCrash: verdicts ? onPaths.filter(p => !suspect.has(key(p)) && (verdictOf.get(key(p))?.kind === 'risky' || (dumpSuspect.has(key(p)) && verdictOf.get(key(p))?.kind !== 'broken'))).length : 0, notLoaded: notLoaded.length,
    // only the mods that hold the very asset the crash names (one only in the crash dump is not told to go off)
    suspects: mods.filter(m => m.enabled && suspect.has(key(m.path))).map(m => relativeToMods(m.path, src.gamePath)), crashAsset: crash?.asset_path?.split('/').pop(),
  })
  const gpuInfo = [crash?.gpu_driver, crash?.rhi].filter(Boolean).join(', ')
  const system = [crash?.cpu, crash?.gpu && `${crash.gpu}${gpuInfo ? ` (${gpuInfo})` : ''}`, crash?.ram_gb != null && `${crash.ram_gb} GB`, crash?.os]
    .filter(Boolean).join(', ')
  return buildReport({
    version: REPAKXTRA_VERSION,
    repakx,
    made: when(Date.now() / 1000),
    notes,
    next,
    folder: !src.gamePath ? 'not set' : !build ? 'could not be checked' : build.updated ? 'set, the game files are there' : 'set, but the game files were not found there or could not be read',
    gameBuild: !build ? 'could not be read' : build.cl ? String(build.cl) : 'not found in the game files',
    crashRef: crash ? crash.id.replace(/^UECC-(Windows-)?/i, '').slice(0, 8) : undefined,
    changesBefore: Boolean(crash),
    log: !log ? undefined : 'status' in log ? { status: log.status } : !log.text.trim() ? { status: 'The game log is empty.' }
      : { lines: log.text.split(/\r?\n/).filter((l, i, all) => l.trim() || i < all.length - 1).slice(-LOG_LINES) },
    launcher: src.launcherType === 'epic' ? 'Epic' : src.launcherType === 'steam' ? 'Steam' : src.launcherType === 'loadingbay' ? 'Loading Bay' : 'launcher unknown',
    bypass: bypassState ? BYPASS[bypassState] ?? bypassState : 'could not be read',
    galacta: galactaText,
    kit: kit === undefined ? 'could not be read' : kit.version ? `v${kit.version}` : 'not installed',
    on,
    off: mods.filter(m => !m.enabled).length,
    conflicts: conflictGroups !== undefined ? plural(conflictGroups, 'group') : 'could not be checked',
    crash: crashText,
    crashLines,
    flags,
    system: system || undefined,
    faulting: crash?.faulting_module ? `${crash.faulting_module} (${crash.faulting_class || 'unknown'})` : undefined,
    thirdParty: system ? crash?.third_party?.join(', ') || 'none' : undefined, // no system facts: an old crash file, modules unknown too
    oom: crash?.oom,
    stack: crash?.stack,
    thread: crash?.thread || undefined,
    dumpLines: inDump,
    recent: recentLines,
    changes,
  })
}

/** `onAt`: the mods that were on when it crashed (saved as the game started, xtra_crash.rs), or 'now' when that session was
 *  not saved and `held` lists the mods on now instead */
export type RecentCrash = { id?: string; time: number; type: string; asset?: string; held?: string[]; onAt?: 'crash' | 'now' }
/** A mod's key on or off (xtra_crash.rs on_key). Pure. */
export const onKey = (path: string) => path.replace(/\\/g, '/').toLowerCase().replace(/\.(pak|bak_repak|utoc|ucas)$/, '')
/** The newest five crashes (xtra_recent_crashes): when, what kind, the asset each crashed loading (its name), and the
 *  installed mods (`modPaths`, on or off) that replace that asset and were on when it crashed (`onNow` when that is not
 *  known), undefined when the check failed. For the setup report and Settings > Crash reports. `listed` skips the backend
 *  call when the caller already has the crashes. */
export async function recentCrashes(modPaths: string[], onNow: string[], listed?: { id?: string; time: number; crash_type?: Opt; asset_path?: Opt }[]): Promise<RecentCrash[]> {
  const list = listed ?? await settled(invoke<{ id?: string; time: number; crash_type?: Opt; asset_path?: Opt }[]>('xtra_recent_crashes')) ?? []
  return Promise.all(list.map(async c => {
    const base = { id: c.id, time: c.time, type: c.crash_type || 'Crash', asset: c.asset_path?.split('/').pop() || undefined }
    if (!c.asset_path) return base
    const t = await settled(invoke<Tiered[]>('xtra_crash_tiers', { assetPath: c.asset_path, heroId: null, modPaths }))
    const atCrash = await settled(invoke<string[] | null>('xtra_mods_on_at', { time: c.time }))
    const on = new Set(atCrash ?? onNow.map(onKey))
    return { ...base, held: t?.filter(x => x.tier === 'asset' && on.has(onKey(x.path))).map(x => x.path), onAt: atCrash ? 'crash' as const : 'now' as const }
  }))
}

/** The mods that hold an asset: the first two by name, then how many more (a shared asset must not fill the report). */
const holders = (names: string[]) => !names.length ? 'no mod that is on' : names.length <= 2 ? names.join(', ') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`
const holdersAll = (names: string[]) => names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`

/** Recent activity with no crash: the newest ten rows, or why there are none. Pure. */
export function activityLines(t: Timeline | null | undefined): string[] {
  if (!t) return ['The history could not be read.']
  if (t.coverage === 'none') return ['Nothing recorded yet.']
  const rows = timelineRows(t)
  return rows.length ? rows.slice(0, 10).map(r => `${whenText(r.t)}  ${r.text}`) : ['No changes recorded.']
}

type Facts = {
  folder: 'unset' | 'no-game' | 'ok'; bypass?: string; galacta?: Galacta | null
  vfx: number; broken: number; mayCrash?: number; conflicts?: number; notLoaded: number; suspects: string[]; crashAsset?: string
}
/** What to check next, most likely blocker first, at most five, each one step in the app. Never asks to turn off
 *  antivirus or Windows protection. Pure. */
export function nextSteps(f: Facts): string[] {
  const out: string[] = []
  if (f.folder === 'unset') out.push('No game folder is set. Choose it in Settings > Game folder.')
  if (f.folder === 'no-game') out.push('The game files were not found in the game folder, or could not be read. Choose the Marvel Rivals folder again in Settings.')
  const bypass: Record<string, string> = {
    missing: 'Signature bypass is not installed, so the game skips mods. Open Setup to see what the game needs.',
    partial: 'Signature bypass is incomplete. Open Setup to see which part is missing.',
    other: 'Signature bypass is a different version. Open Setup to check it.',
    disabled: 'Signature bypass is off. Open Setup to see its state.',
    outdated: 'Signature bypass is an older version. Open Setup to check it.',
    unreadable: 'A signature bypass file is there but could not be read. Open Setup to check it again.',
  }
  if (f.bypass && bypass[f.bypass]) out.push(bypass[f.bypass])
  if (f.galacta?.installed && f.galacta.up_to_date === false) out.push(`${LOADER_NAME} is older than ${f.galacta.latest}. Open Setup and update it.`)
  if (f.notLoaded) out.push(`${plural(f.notLoaded, 'mod')} that ${f.notLoaded === 1 ? 'was' : 'were'} on did not load in the game. Check ${f.notLoaded === 1 ? 'it is' : 'they are'} made for this game build.`)
  if (f.suspects.length) out.push(`The newest crash names ${f.crashAsset ?? 'a file'}, and ${holdersAll(f.suspects)} ${f.suspects.length === 1 ? 'replaces' : 'replace'} it. Turn ${f.suspects.length === 1 ? 'it' : 'them'} off and test again.`)
  if (f.broken) out.push(`${plural(f.broken, 'mod')} that ${f.broken === 1 ? 'is' : 'are'} on ${f.broken === 1 ? 'is' : 'are'} broken for this game build. Turn ${f.broken === 1 ? 'it' : 'them'} off or find an update.`)
  const risky = f.mayCrash ?? 0 // without the exact crash suspects, which have their own step above
  if (risky > 0) out.push(`${plural(risky, 'mod')} that ${risky === 1 ? 'is' : 'are'} on may crash the game. Their notes in the list below say why.`)
  if (f.vfx) out.push(`${plural(f.vfx, 'mod')} ${f.vfx === 1 ? 'needs' : 'need'} a VFX update. Open Mod Updater.`)
  if (f.conflicts) out.push(`${plural(f.conflicts, 'conflict group')}. Open Check conflicts and pick which mod wins.`)
  return out.slice(0, 5)
}

if (import.meta.env.DEV) {
  console.assert(onKey('C:\\Mods\\~mods\\Cool Mod_9999999_P.pak') === 'c:/mods/~mods/cool mod_9999999_p' && onKey('C:/Mods/~mods/Cool Mod_9999999_P.bak_repak') === 'c:/mods/~mods/cool mod_9999999_p', 'one key on or off, as xtra_crash.rs on_key')
  const root = 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\MarvelRivals\\MarvelGame\\Marvel\\Content\\Paks\\~mods'
  console.assert(relativeToMods(`${root}\\Sub\\A_9999999_P.pak`, root) === '~mods/Sub/A_9999999_P.pak', 'mods relative to ~mods')
  console.assert(relativeToMods('D:\\Elsewhere\\B.pak', root) === 'B.pak', 'outside ~mods: the file name only')
  console.assert(isOwnLoader(`${root}\\!ProjectGalacta_9999999_P.pak`) && !isOwnLoader(`${root}\\BuckySwap_ProjectGalacta_P.pak`)
    && !isOwnLoader(`${root}\\!ProjectSigeon_9999999_P.pak`), 'only its own loader leaves the mod list')
  const text = buildReport({ version: '1.0.0', launcher: 'Steam', bypass: 'installed', galacta: 'not installed',
    on: [{ name: '~mods/A.pak', type: 'Mesh', hero: 'Black Panther', date: '2026-10-01' }], off: 3, conflicts: '0 groups', crash: 'none found' })
  const listed = buildReport({ version: '1.0.0', launcher: 'Steam', bypass: 'installed', galacta: 'not installed', kit: 'v3', on: [], off: 0, conflicts: '0 groups', crash: 'x',
    recent: ['2026-10-30 00:59, crashed loading MI_1026001_Eyes: no installed mod replaces it'] })
  const changed = buildReport({ version: '1.0.0', launcher: 'Steam', bypass: 'installed', galacta: 'not installed', on: [], off: 0, conflicts: '0 groups', crash: 'x', crashRef: 'ab12cd34', changesBefore: true, changes: ['Nov 21, 9:40 PM  Installed Purple VFX'] })
  console.assert(changed.includes('Recent activity before that crash (newest first, what changed, not what caused it):\n  Nov 21, 9:40 PM  Installed Purple VFX')
    && changed.includes('What the newest crash shows (report ab12cd34):\n  When: x'), 'the crash by its report, its activity in the report', changed)
  const idle = buildReport({ version: '1.0.0', launcher: 'Steam', bypass: 'installed', galacta: 'not installed', on: [], off: 0, conflicts: '0 groups', crash: 'none found', changes: ['Nothing recorded yet.'] })
  console.assert(idle.includes('Newest crash: none found') && idle.includes('Recent activity (newest first):\n  Nothing recorded yet.') && !idle.includes('Game log'), 'no crash: its line, plain recent activity, no log', idle)
  console.assert(listed.includes('\n  Preview kit: v3\n') && listed.includes('Crash reports (newest first') && listed.includes('\n  2026-10-30 00:59, crashed loading MI_1026001_Eyes'), 'kit version and crash list', listed)
  console.assert(text.indexOf('Newest crash') < text.indexOf('~mods/A.pak | Mesh | Black Panther | 2026-10-01'), 'summary before the mod list', text)
  console.assert(text.indexOf('What to check next:\n  Nothing stands out') < text.indexOf('Why mods might not load:\n') && text.indexOf('Why mods might not load:') < text.indexOf('Newest crash'),
    'what to check next first, then the setup, then the crash', text)
  const noted = buildReport({ version: '1.0.0', launcher: 'Steam', bypass: 'installed', galacta: 'not installed', on: [], off: 0, conflicts: '0 groups', crash: 'none found',
    notes: { trying: 'Load  my\nPanther skin from C:\\Users\\Alice\\x.pak', instead: '' }, next: ['Signature bypass is off. Open Setup and turn it on.'] })
  console.assert(noted.includes('\n\nWhat I was trying to do: Load my Panther skin from %USERPROFILE%') && !noted.includes('Alice') && !noted.includes('What happened instead')
    && noted.indexOf('What to check next:\n  - Signature bypass is off') < noted.indexOf('What I was trying'), 'notes after the checks, on one line, scrubbed, the empty one left out', noted)
  const logged = buildReport({ version: '1.0.0', launcher: 'Steam', bypass: 'installed', galacta: 'not installed', on: [], off: 0, conflicts: '0 groups', crash: 'x', crashRef: 'r', log: { lines: ['a', '```', 'b'] } })
  console.assert(logged.endsWith("Game log of that crash, last 3 lines (user name, account ids, and tokens taken out):\na\n'''\nb\n```") , 'the log last, its fences cannot end the block', logged)
  console.assert(buildReport({ version: '1.0.0', launcher: 'Steam', bypass: 'installed', galacta: 'not installed', on: [], off: 0, conflicts: '0 groups', crash: 'x', crashRef: 'r', log: { status: logStatusText('log_undecodable') } })
    .includes('Game log of that crash: The game log could not be decrypted.'), 'a log that gave nothing says why')
  const steps = nextSteps({ folder: 'ok', bypass: 'missing', galacta: { installed: 'x', disabled: false, latest: 'v2', up_to_date: false }, vfx: 2, broken: 1, conflicts: 3, notLoaded: 1, suspects: ['~mods/A.pak'], crashAsset: 'MI_Eyes' })
  console.assert(steps.length === 5 && steps[0].startsWith('Signature bypass is not installed') && steps.some(l => l.startsWith('1 mod that was on did not load'))
    && steps.some(l => l === 'The newest crash names MI_Eyes, and ~mods/A.pak replaces it. Turn it off and test again.'), 'blockers first, five at most', steps)
  console.assert(nextSteps({ folder: 'ok', vfx: 0, broken: 0, mayCrash: 1, notLoaded: 0, suspects: [] })[0] === '1 mod that is on may crash the game. Their notes in the list below say why.'
    && nextSteps({ folder: 'ok', vfx: 0, broken: 0, mayCrash: 0, notLoaded: 0, suspects: ['a'], crashAsset: 'x' }).length === 1, 'a crash suspect has its own step, not a may crash one')
  console.assert(nextSteps({ folder: 'unset', vfx: 0, broken: 0, notLoaded: 0, suspects: [] })[0].startsWith('No game folder is set')
    && nextSteps({ folder: 'ok', bypass: 'installed', vfx: 0, broken: 0, conflicts: 0, notLoaded: 0, suspects: [] }).length === 0, 'folder first, nothing to say: no steps')
  console.assert(!nextSteps({ folder: 'ok', bypass: 'missing', vfx: 1, broken: 1, conflicts: 1, notLoaded: 1, suspects: ['a'] }).some(l => /antivirus|defender|exclusion|quarantine/i.test(l)), 'never asks to weaken protection')
  console.assert(activityLines(null)[0] === 'The history could not be read.' && activityLines({ crash: 9, coverage: 'none', events: [] })[0] === 'Nothing recorded yet.'
    && activityLines({ crash: 9, coverage: 'full', events: [] })[0] === 'No changes recorded.', 'recent activity says when it has nothing')
  const flagged = buildReport({ version: '1.0.0', launcher: 'Steam', bypass: 'installed', galacta: 'not installed', conflicts: '0 groups',
    crash: '2026-10-24 21:03, Access Violation', crashRef: 'r', crashLines: ['7 min into the game', 'message: boom D:\\build\\x\\y.cpp'], flags: '1 need a VFX update, 0 may crash, 0 broken, 1 with Niagara',
    on: [{ name: '~mods/A.pak', type: 'VFX', hero: '', date: '2026-10-01', notes: ['Needs update', 'Niagara'], why: 'made before the game update' }], off: 0 })
  console.assert(flagged.includes('~mods/A.pak | VFX | - | 2026-10-01 | Needs update, Niagara\n  why: made before the game update'), 'notes and reason on the mod line', flagged)
  console.assert(flagged.includes('\n  7 min into the game') && flagged.includes('message: boom y.cpp') && flagged.includes('Mods that are on: 1 need a VFX update'), 'crash lines indented, paths cut to a file name, flags summarised', flagged)
  console.assert(!flagged.includes('System:') && !flagged.includes('Out of memory') && !flagged.includes('Crash stack'), 'no crash file facts, no lines for them', flagged)
  const diagnosed = buildReport({ version: '1.0.0', launcher: 'Steam', bypass: 'installed', galacta: 'not installed', conflicts: '0 groups', off: 0,
    crash: '2026-10-25 20:55, ObjectSerializationError', system: 'AMD Ryzen 5 5600X, AMD Radeon RX 6700 XT (Adrenalin 26.10.1, D3D12), 16 GB, Windows 10',
    faulting: 'nvwgf2umx (GPU driver)', thirdParty: 'dsound.dll, MarvelRivalsUTOCSignatureBypass.asi', oom: true, thread: 'RenderThread 1',
    stack: ['nvwgf2umx + 12ab (GPU driver)', 'Marvel-Win64-Shipping + 10c296b (game)'],
    on: [{ name: '~mods/A.pak', type: 'Mesh', hero: '', date: '2026-10-01' }] })
  const summary = diagnosed.slice(0, diagnosed.indexOf('Crash stack'))
  console.assert(['  System: AMD Ryzen', 'Faulting module: nvwgf2umx (GPU driver)', 'Third-party modules: dsound.dll, MarvelRivalsUTOCSignatureBypass.asi', 'Out of memory: yes']
    .every(l => summary.includes(`\n${l.startsWith('  ') ? l : `  ${l}`}`)), 'crash diagnosis in the top summary block', summary)
  console.assert(diagnosed.includes('\n\nCrash stack, top 2 (RenderThread 1):\n  nvwgf2umx + 12ab (GPU driver)\n  Marvel-Win64-Shipping + 10c296b (game)\n\n')
    && diagnosed.indexOf('Crash stack') < diagnosed.indexOf('~mods/A.pak'), 'stack frames indented, below the summary, above the mods', diagnosed)
  console.assert(!buildReport({ version: '1.0.0', launcher: 'Steam', bypass: 'installed', galacta: 'not installed', conflicts: '0 groups', off: 0, crash: 'x', oom: false, on: [] })
    .includes('Out of memory'), 'out of memory only when true')
  const asset = (n: number) => `/Game/Marvel/VFX/Materials/Characters/1026/Curves/CurveAtlas_1026_${n}`
  const withDump = buildReport({ version: '1.0.0', launcher: 'Steam', bypass: 'installed', galacta: 'not installed', conflicts: '0 groups', off: 0, crash: 'x',
    system: 'Intel i7, NVIDIA RTX 3050 (621.01, D3D12), 16 GB, Windows 11', faulting: 'Marvel-Win64-Shipping (game)', thirdParty: 'none', oom: true, stack: ['a + 1 (game)'], thread: 'FAsyncLoadingThread',
    dumpLines: [1, 2, 3, 4, 5].map(n => `${asset(n)}: ${holders(Array.from({ length: 10 }, (_, i) => `~mods/Some Mod Name ${i}_9999999_P.pak`))}`),
    on: [{ name: '~mods/A.pak', type: 'Mesh', hero: '', date: '2026-10-01' }] })
  console.assert(withDump.indexOf('Out of memory') < DISCORD_LIMIT, 'the summary fits Discord whatever the dump holds', withDump.indexOf('Out of memory'))
  console.assert(withDump.indexOf('Crash stack') < withDump.indexOf('Assets in the crash dump') && withDump.indexOf('Assets in the crash dump') < withDump.indexOf('~mods/A.pak |')
    && withDump.includes('Some Mod Name 1_9999999_P.pak and 8 more'), 'dump lines below the stack, above the mods, holders cut to two and a count', withDump)
}
