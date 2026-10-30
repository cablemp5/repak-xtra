// repakxtra: the VFX Updater, one mod at a time: rebuilds a VFX mod's materials and blueprints from the installed game's own
// files and carries the mod's edits onto them (assets.ts), so a game update that changed those files no longer breaks it.
// Started from the upstream VFX Updater's usePipeline; its Rust steps (vfx_updater/) do the UAssetTool work.
//   1 Extract the mod, rewrite materials and blueprints cooked in an older property layout in today's (xtra_mi_layout.rs),
//     read each asset's type (Niagara systems, textures and meshes by name: they always pass through)
//   2 The mod's materials and blueprints to JSON (converted in place, from a list)
//   3 Read what to carry: material parameters, color properties
//   4 The game's own copies of those assets, extracted once per game build and kept for the next mod (xtra_vfx.rs)
//   5 Those to JSON
//   6 Carry the edits over. An asset the game does not have is the mod's own and stays as it was.
//   7 Niagara files a game update rewrote after the mod was made: the mod's changed value tables go into the game's new
//     copies, byte for byte (xtra_niagara.rs). Only when the USMAP matches the game. One that cannot be carried is left out
//   8 Edited JSON back to assets
//   9 Pack, then put the fix in the mod's place: it takes the mod's name, on or off like it, and the original is renamed
//     <name>_BROKEN and turned off (xtra_vfx_place). A partial update (Niagara files left out) is <name>_PARTIAL beside
//     its kept <name>_ORIGINAL, and updating either later starts from the original
// Never throws: the report says what happened, asset by asset.
import { invoke } from '@tauri-apps/api/core'
import { DEFAULT_FILTER, type ColorFilter } from './filter'
import { type ColorProp, type ModParam, applyColor, isMaterialInstance, packageImports, portParam, readColors, readModParams, uncarriedPackages } from './assets'

export const STEPS = ['Reading the mod', 'Opening its materials', 'Finding its edits', "Reading the game's files", "Opening the game's files", 'Carrying the edits over', 'Rebuilding Niagara effects', 'Rebuilding the assets', 'Packing the update'] as const

export type AssetKind = 'updated' | 'same' | 'added' | 'passed' | 'left' | 'unreadable' | 'failed'
export type AssetResult = { name: string; path: string; kind: AssetKind; detail: string }
export type VfxStatus = 'fixed' | 'nothing' | 'failed' | 'cancelled'
export type Placed = { fixed: string; source: string; original: string; turnedOff: boolean; replaced: boolean; trashed?: boolean; warning?: string | null }
export type VfxReport = {
  mod: string
  name: string
  status: VfxStatus
  /** What went wrong, or why nothing was made */
  error?: string
  /** The fixed mod: its .pak or .bak_repak beside the original (or the .utoc packed into outputDir) */
  output?: string
  placed?: Placed
  assets: AssetResult[]
  warnings: string[]
  /** left: Niagara files made for an older game build, left out until a USMAP for the game is out (a partial update).
   *  relaid: materials and blueprints rewritten from an older game build's property layout (they crash the game as they were).
   *  ownGame: ones the Niagara step could not carry with today's USMAP, left out for good: the game's own is used, and
   *  the update is still a full one (no later USMAP would change them) */
  counts: { updated: number; same: number; added: number; passed: number; left: number; ownGame: number; unreadable: number; changes: number; relaid: number }
  ms: number
  steps: { step: number; ms: number }[]
}

export type FixOptions = {
  modPath: string
  usmapPath: string
  gamePaksPath: string
  /** Pack into this folder and stop there (the benchmark). Without it the fix goes beside the original. */
  outputDir?: string
  turnOffOriginal?: boolean
  /** The update takes the mod's name and the original becomes <name>_BROKEN (the default). Off: the update is <name>_UPDATED. */
  keepName?: boolean
  /** The original goes to Recently deleted (off, so a restore never clashes with the update) */
  trashOriginal?: boolean
  filter?: ColorFilter
  log?: (message: string, type?: 'info' | 'success' | 'warning' | 'error') => void
  onStep?: (s: { step: number; title: string }) => void
  /** Progress inside a step that runs here (reading files); Rust steps send vfx_progress events */
  onProgress?: (current: number, total: number, message: string) => void
  /** Checked between steps and files: true stops the run once the call in flight returns */
  cancelled?: () => boolean
}

/** xtra_broken.rs UsmapWait, while the USMAP is older than the game: its game build, the installed game's, and how many
 *  of the files the update decodes the newer patch rewrote (the update waits when that is not 0). */
export type UsmapWait = { usmap: number; game: number; changed: number }
/** Why an update waits. A patch can insert properties into a class, and an older USMAP then reads every later one under
 *  the wrong name without any error. Files the patch left alone read right, so only a mod whose files it changed waits. */
export const usmapWaitText = (w: UsmapWait) =>
  `The game update changed ${plural(w.changed, 'file')} it rebuilds, and the saved USMAP (game build ${w.usmap}) would read ${w.changed === 1 ? 'it' : 'them'} wrong. It can be updated once the USMAP for game build ${w.game} is out.`

type Dirs = { modExtract: string; modJson: string; editedJson: string; finalUassets: string; stage: string; vanillaExtract: string; vanillaJson: string; vanillaIndex: string }
type Detected = { kind: 'material_instance' | 'blueprint' | 'maybe' | 'other'; class: string | null; error: string | null }
type VanillaIndex = { have: string[] } // an older index's "absent" list is not read (see step 4)
type NiagaraRun = { ready: boolean; why?: string | null; oldBuild?: number | null; files: { file: string; edits: number; error?: string | null }[] }

class Cancelled extends Error {}

const slash = (p: string) => p.replace(/\\/g, '/')
/** Comparison key: forward slashes, no leading slash or extension, lowercase. */
export const assetKey = (rel: string) => slash(rel).replace(/^\/+/, '').replace(/\.(uasset|json)$/i, '').toLowerCase()
/** `path` relative to `base`, tolerant of mixed slashes and case. */
export function relativeTo(path: string, base: string) {
  const p = slash(path), b = slash(base).replace(/\/+$/, '')
  return (p.toLowerCase().startsWith(`${b.toLowerCase()}/`) ? p.slice(b.length + 1) : p).replace(/^\/+/, '')
}
const fileName = (p: string) => slash(p).split('/').pop() ?? p
const stem = (p: string) => fileName(p).replace(/\.[^.]+$/, '')

/** Niagara systems and emitters, textures and meshes: never edited, and reading their type parses them whole (about a
 *  second each, most of a run for a typical VFX mod), so they pass through by their Unreal name prefix.
 *  shortcut: trusts the prefix convention, an asset misnamed with one of these passes through unedited. */
export const PASS_BY_NAME = /^(NS|NE|T|SK|SM)_/i

/** Niagara systems, emitters and curve atlases: copied as they are, and one cooked before a patch that renumbered Niagara
 *  properties crashes the game (3962284), so step 7 rebuilds it or it is left out. shortcut: by name prefix, like
 *  PASS_BY_NAME. */
export const NIAGARA_BY_NAME = /^(NS_|NE_|CurveAtlas_)/i
/** The upstream name: without its _<priority>_P suffix, spaces as underscores (xtra_vfx.rs fixed_stem matches). */
export const fixedName = (modPath: string) => {
  const b = stem(modPath).replace(/(_\d+)?_P$/i, '').trim().replace(/\s+/g, '_')
  const v = b.match(/^(.+)_UPDATED(?:_V(\d+))?$/i) // an update of an update is its next version
  return v ? `${v[1]}_UPDATED_V${(Number(v[2]) || 1) + 1}_9999999_P` : `${b}_UPDATED_9999999_P`
}

async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await worker(items[i], i) }
  }))
  return out
}

const plural = (n: number, word: string, many = `${word}s`) => `${n.toLocaleString()} ${n === 1 ? word : many}`

export async function fixVfxMod(o: FixOptions): Promise<VfxReport> {
  const filter = o.filter ?? DEFAULT_FILTER
  const log = o.log ?? (() => {})
  const t0 = performance.now()
  const report: VfxReport = { mod: o.modPath, name: stem(o.modPath).replace(/(_\d+)?_P$/i, ''), status: 'failed', assets: [], warnings: [],
    counts: { updated: 0, same: 0, added: 0, passed: 0, left: 0, ownGame: 0, unreadable: 0, changes: 0, relaid: 0 }, ms: 0, steps: [] }
  let step = 0, stepAt = t0
  const enter = (n: number) => {
    if (o.cancelled?.()) throw new Cancelled()
    const now = performance.now()
    if (step) report.steps.push({ step, ms: now - stepAt })
    step = n; stepAt = now
    o.onStep?.({ step: n, title: STEPS[n - 1] })
  }
  const check = () => { if (o.cancelled?.()) throw new Cancelled() }
  const relaid = new Set<string>() // file names rewritten in today's layout
  let layoutUnknown = false // the layout check failed: a Nothing to update is then not trusted (xtra_broken.rs)
  const asset = (path: string, kind: AssetKind, detail: string) => {
    if (relaid.has(fileName(path).toLowerCase())) detail = detail.replace(/kept as it was/i, m => `${m[0]}ept, rewritten in the new game build's layout`)
    report.assets.push({ name: stem(path), path, kind, detail }); if (kind in report.counts) report.counts[kind as keyof typeof report.counts]++
  }
  const warn = (w: string) => { report.warnings.push(w); log(w, 'warning') }

  try {
    // ---- 1: extract and sort ----
    enter(1)

    // a partial update lacks the Niagara files it left out: its kept original is what gets updated
    const src = await invoke<string>('xtra_vfx_source', { modPath: o.modPath }).catch(() => o.modPath)
    if (src !== o.modPath) log(`Starting from ${stem(src)}, the original kept with its Niagara files.`)
    // the USMAP may be older than the game: fine unless the patch rewrote files this update decodes
    const wait = await invoke<UsmapWait | null>('xtra_vfx_usmap_wait', { modPath: src, gamePaks: o.gamePaksPath, usmapPath: o.usmapPath }).catch(() => null)
    if (wait?.changed) { report.error = `Not updated yet. ${usmapWaitText(wait)}`; return report }
    const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const dirs = await invoke<Dirs>('xtra_vfx_dirs', { gamePaks: o.gamePaksPath, runId, usmapPath: o.usmapPath }) // the game files' cache is per USMAP too
    const extracted = await invoke<string[]>('vfx_extract_mod_assets', { gamePaks: o.gamePaksPath, modPath: src, outputDir: dirs.modExtract })
    check()
    if (!extracted.length) throw new Error('No assets could be read from the mod. Check the game folder in Setup and that the mod is a .utoc mod.')
    const rel = (p: string) => relativeTo(p, dirs.modExtract)
    const manifest = extracted.map(rel)
    const ask = extracted.filter(p => !PASS_BY_NAME.test(fileName(p)))
    // a patch that inserts properties into a class moves every later one (3984769: material overrides), and a file cooked
    // before it crashes the game and reads as nothing to change. Rewritten in today's layout here, every step below reads it
    const older = ask.filter(p => !NIAGARA_BY_NAME.test(fileName(p))).map(p => rel(p).replace(/\.uasset$/i, ''))
    const re = older.length ? await invoke<{ files: string[]; failed: string[]; oldBuild: number | null }>('xtra_vfx_relayout', { modPath: src, gamePaks: o.gamePaksPath, usmapPath: o.usmapPath, modExtract: dirs.modExtract, files: older, stageDir: dirs.stage })
      .catch(e => { layoutUnknown = true; warn(`Could not check its material layout (${e}).`); return null }) : null
    check()
    re?.files.forEach(f => relaid.add(fileName(f).toLowerCase() + '.uasset'))
    report.counts.relaid = re?.files.length ?? 0
    // in the old layout but not rewritten safely: passed on as they are they can crash the game, so the update stops below
    const unrewritten = re?.failed.length ?? 0
    if (unrewritten) warn(`${plural(unrewritten, 'material or blueprint', 'materials and blueprints')} in an older game build's layout could not be rewritten.`)
    if (re?.files.length) log(`Rewrote ${plural(re.files.length, 'material or blueprint', 'materials and blueprints')} cooked in an older game build's layout${re.oldBuild ? ` (build ${re.oldBuild})` : ''}.`, 'warning')
    log(`Read ${plural(extracted.length, 'asset')}. Reading the type of ${ask.length}.`)
    const found = ask.length ? await invoke<Record<string, Detected>>('xtra_vfx_detect', { usmapPath: o.usmapPath, paths: ask }) : {}
    check()
    // a class read as __ScriptImport_<hash>__: the extract could not name the game's classes, so every material would
    // read as something else and the run would wrongly find Nothing to update. xtra_uat_cli.rs already reads such an
    // extract again one-shot: this is when that did not help either
    if (Object.values(found).some(d => d.class?.startsWith('__ScriptImport_'))) throw new Error("The mod's files were read without the game's class names, so what to rebuild is not known. Try again")
    const types = new Map(Object.entries(found).map(([p, d]) => [assetKey(slash(p)), d]))
    let editable: string[] = [], keep: string[] = []
    const maybe = new Map<string, string>()
    for (const p of extracted) {
      const d = PASS_BY_NAME.test(fileName(p)) ? undefined : types.get(assetKey(slash(p)))
      if (d && d.kind !== 'other') { editable.push(p); if (d.kind === 'maybe') maybe.set(assetKey(rel(p)), d.class ?? ''); continue }
      keep.push(p)
      if (d?.error) asset(p, 'unreadable', `Could not be read (${d.error}). Kept as it was.`)
      else if (!d && !PASS_BY_NAME.test(fileName(p))) asset(p, 'unreadable', 'Its type could not be read. Kept as it was.')
      else asset(p, 'passed', d?.class ? `${d.class}, kept as it was.` : 'Kept as it was.')
    }
    // Niagara files a game update rewrote after the mod was made are still cooked for the old game and can crash it. They
    // are left out here (the game uses its own), and step 7 puts back each one it can rebuild
    const niagara = keep.filter(p => NIAGARA_BY_NAME.test(fileName(p)))
    let staleList = niagara.length ? await invoke<string[]>('xtra_vfx_stale', { modPath: src, gamePaks: o.gamePaksPath, files: niagara.map(rel) }) : []
    // newer than the update but still in the old layout (an earlier update made with an old USMAP, an old mod installed
    // again): its date says current, so one of its Niagara systems is decoded to tell (xtra_niagara.rs)
    if (niagara.length && !staleList.length) {
      staleList = await invoke<string[]>('xtra_vfx_old_layout', { modPath: src, gamePaks: o.gamePaksPath, usmapPath: o.usmapPath, files: niagara.map(rel), modExtract: dirs.modExtract }).catch(() => [])
      if (staleList.length) log(`Its Niagara files are in an older game build's layout, although the mod is newer. Rebuilding ${plural(staleList.length, 'Niagara file')}.`, 'warning')
    }
    const stale = new Set(staleList.map(assetKey))
    const staleFiles = niagara.filter(p => stale.has(assetKey(rel(p))))
    if (stale.size) {
      for (const a of report.assets) if (stale.has(assetKey(rel(a.path)))) {
        report.counts.passed--; report.counts.left++
        a.kind = 'left'; a.detail = 'Made for an older game build. Left out, so the game uses its own.'
      }
      keep = keep.filter(p => !stale.has(assetKey(rel(p))))
      log(`Leaving out ${plural(stale.size, 'Niagara file')} made for an older game build.`, 'warning')
    }
    const allStale = () => `Not updated: everything it changes is ${plural(report.counts.left + report.counts.ownGame, 'Niagara file')} made for an older game build that could not be rebuilt, and the game can crash on them. Turn the mod off until its author updates it.`
    if (keep.length) await invoke('vfx_copy_uasset_files', { sourcePaths: keep, sourceBaseDir: dirs.modExtract, destBaseDir: dirs.finalUassets })

    // ---- 7 (after 6, or early when the mod changes only Niagara files): rebuild the stale Niagara files ----
    let niagaraDone = 0, niagaraUpdated = 0 // carried, and of those the ones counted as updated (the rest match the game)
    const rebuildNiagara = async () => {
      if (!staleFiles.length) return
      enter(7)
      const r = await invoke<NiagaraRun>('xtra_vfx_niagara', { gamePaks: o.gamePaksPath, usmapPath: o.usmapPath, modExtract: dirs.modExtract, files: staleFiles.map(rel),
        finalUassets: dirs.finalUassets, stageDir: dirs.stage, vanillaExtract: dirs.vanillaExtract })
      if (!r.ready) { log(`The Niagara files stay left out: ${r.why}.`, 'warning'); return }
      const results = new Map(r.files.map(f => [assetKey(f.file), f]))
      for (const a of report.assets) {
        const f = a.kind === 'left' ? results.get(assetKey(rel(a.path))) : undefined
        if (!f) continue
        // rebuilt with today's USMAP or not at all: no later USMAP changes that, so it is final and the update stays full
        if (f.error) { report.counts.left--; report.counts.ownGame++; a.detail = `Made for an older game build and could not be carried (${f.error}). Left out, so the game uses its own.`; continue }
        report.counts.left--; niagaraDone++
        if (f.edits) { a.kind = 'updated'; report.counts.updated++; niagaraUpdated++; report.counts.changes += f.edits; a.detail = `Rebuilt on the game's new file with ${plural(f.edits, 'edit')}.` }
        else { a.kind = 'same'; report.counts.same++; a.detail = "Matches the game: the game's own new file is used." }
      }
      const stuck = r.files.filter(f => f.error).length
      log(`Rebuilt ${plural(niagaraDone, 'Niagara file')}${r.oldBuild ? `, reading the mod's as build ${r.oldBuild}` : ''}${stuck ? `. ${stuck} stay left out` : ''}.`, stuck ? 'warning' : 'info')
    }

    // ---- 9 (also reached early when the mod changes only Niagara files): pack and place ----
    const packAndPlace = async () => {
      // while the USMAP is older than the game only a whole update goes in: one with files left out would not look the
      // same in the game, so it waits for the USMAP instead
      // ownGame: a Niagara file whose edits could not be carried, so the game's own plays instead of the mod's
      const missing = report.counts.left + report.counts.ownGame + report.counts.unreadable + report.assets.filter(a => a.kind === 'failed').length
      if (wait && missing) {
        report.error = `Not updated yet. With the saved USMAP (game build ${wait.usmap}) ${plural(missing, 'file')} of it could not be rebuilt, so the update would not look the same in the game. It can be updated once the USMAP for game build ${wait.game} is out.`
        log(report.error, 'warning')
        return
      }
      enter(9)
      const base = o.outputDir ? `${slash(o.outputDir)}/${fixedName(o.modPath)}` : `${dirs.stage}/fixed`
      const utoc = await invoke<string>('vfx_pack_to_iostore', { usmapPath: o.usmapPath, inputDir: dirs.finalUassets, outputBase: base, allowedAssets: manifest })
      if (o.outputDir) report.output = utoc
      else {
        report.placed = await invoke<Placed>('xtra_vfx_place', { source: src, stagedBase: base, turnOffOriginal: o.turnOffOriginal ?? true, keepName: o.keepName ?? true, trashOriginal: o.trashOriginal ?? false, partial: report.counts.left > 0 })
        report.output = report.placed.fixed
        if (report.placed.warning) warn(report.placed.warning)
      }
      report.status = 'fixed'
      log(`${report.counts.left ? 'Partially updated' : 'Updated'}: ${fileName(report.output)}`, 'success')
    }

    if (!editable.length) {
      if (report.counts.unreadable) {
        report.error = `${plural(report.counts.unreadable, 'asset')} could not be read, so it is not known whether ${report.counts.unreadable === 1 ? 'it needs' : 'they need'} rebuilding. Check the USMAP in Advanced, then try again.`
        return report // failed: Try again stays
      }
      if (report.counts.left || report.counts.relaid) {
        await rebuildNiagara()
        // the rebuilt Niagara files, or at least the rest without the stale ones, which no longer crashes the game
        if (keep.length || niagaraDone) await packAndPlace()
        else report.error = allStale()
        return report
      }
      report.status = 'nothing'
      report.error = 'Nothing to update: the mod has no materials or blueprints to rebuild.'
      return report
    }
    // convert only these, in place (the extract's list names every asset)
    await invoke('vfx_write_json_file', { path: `${dirs.modExtract}/uasset_list.txt`, content: editable.map(p => rel(p).replace(/\.uasset$/i, '')).join('\n') })

    // ---- 2: the mod's editable assets to JSON ----
    enter(2)
    const modJson = await invoke<string[]>('vfx_convert_uassets_to_json', { usmapPath: o.usmapPath, inputDir: dirs.modExtract, outputDir: dirs.modJson })
    log(`Converted ${plural(modJson.length, 'material or blueprint', 'materials and blueprints')} to JSON.`)

    // ---- 3: what to carry ----
    enter(3)
    const edits = new Map<string, { params: ModParam[]; colors: ColorProp[]; packages: Set<string> }>()
    const notMine = new Set<string>()
    let read = 0
    await mapLimit(modJson, 6, async path => {
      check()
      const key = assetKey(relativeTo(path, dirs.modJson))
      try {
        const json = JSON.parse(await invoke<string>('vfx_read_json_file', { path }))
        // a 'maybe' (its first export was user data) is edited only when it holds a material instance after all
        if (maybe.has(key) && !isMaterialInstance(json)) notMine.add(key)
        else edits.set(key, { params: readModParams(json, filter), colors: readColors(json, filter), packages: packageImports(json) })
      } catch (e) {
        warn(`${stem(path)}: could not read its JSON (${e}). The mod's copy is kept.`)
      }
      o.onProgress?.(++read, modJson.length, `Read ${read} of ${modJson.length}`)
    })
    if (notMine.size) {
      const pass = editable.filter(p => notMine.has(assetKey(rel(p))))
      pass.forEach(p => asset(p, 'passed', `${maybe.get(assetKey(rel(p))) || 'Not a material'}, kept as it was.`))
      await invoke('vfx_copy_uasset_files', { sourcePaths: pass, sourceBaseDir: dirs.modExtract, destBaseDir: dirs.finalUassets })
      keep.push(...pass)
      editable = editable.filter(p => !notMine.has(assetKey(rel(p))))
    }
    const params = [...edits.values()].reduce((n, e) => n + e.params.length, 0), colors = [...edits.values()].reduce((n, e) => n + e.colors.length, 0)
    log(`Found ${plural(params, 'material parameter')} and ${plural(colors, 'color property', 'color properties')} to carry.`)

    // ---- 4: the game's own copies, cached per game build ----
    enter(4)
    let index: VanillaIndex = { have: [] }
    try { index = JSON.parse(await invoke<string>('vfx_read_json_file', { path: dirs.vanillaIndex })) } catch { /* first run on this game build */ }
    // only what was extracted is kept between runs: a file one extract missed (a container Steam held a moment, a package
    // that failed to convert) is asked for again next time, never saved as "not in the game" for the whole build
    const have = new Set(index.have), absent = new Set<string>()
    const wanted = editable.map(p => assetKey(rel(p)))
    const missing = editable.filter((p, i) => !have.has(wanted[i]) && !absent.has(wanted[i]))
    let fresh: string[] = []
    if (missing.length) {
      log(`Extracting ${plural(missing.length, 'game file')} (${wanted.length - missing.length} already extracted).`)
      // material instances come without their dependencies: their JSON is the same, and those were most of the extract.
      // Blueprints and the rest keep theirs (a parent class's properties can come from another asset)
      const noDeps = missing.filter(p => types.get(assetKey(slash(p)))?.kind === 'material_instance').map(p => rel(p).replace(/\.uasset$/i, ''))
      const got = await invoke<string[]>('vfx_extract_vanilla_assets', { gamePaks: o.gamePaksPath, outputDir: dirs.vanillaExtract, filterPatterns: missing.map(p => rel(p).replace(/\.uasset$/i, '')), noDeps })
      const asked = new Set(missing.map(p => assetKey(rel(p))))
      fresh = [...new Set(got.map(p => assetKey(relativeTo(p, dirs.vanillaExtract))).filter(k => asked.has(k)))]
      for (const k of asked) if (!fresh.includes(k)) absent.add(k)
    } else log(`All ${plural(wanted.length, 'game file')} already extracted.`)

    // ---- 5: those to JSON ----
    enter(5)
    if (fresh.length) {
      // the extract wrote the list of exactly these, so only they convert (the dependencies stay for schemas)
      const converted = new Set((await invoke<string[]>('vfx_convert_uassets_to_json', { usmapPath: o.usmapPath, inputDir: dirs.vanillaExtract, outputDir: dirs.vanillaJson }))
        .map(p => assetKey(relativeTo(p, dirs.vanillaJson))))
      fresh.filter(k => converted.has(k)).forEach(k => have.add(k))
    }
    const saveIndex = () => invoke('vfx_write_json_file', { path: dirs.vanillaIndex, content: JSON.stringify({ have: [...have] }) })
    await saveIndex()

    // ---- 6: carry the edits ----
    enter(6)
    const own: string[] = []
    let done = 0, lost = false, swapped = 0 // swapped: kept for references an update cannot carry
    await mapLimit(editable, 6, async p => {
      check()
      const r = rel(p), key = assetKey(r)
      const e = edits.get(key)
      const jsonRel = r.replace(/\.uasset$/i, '.json')
      const json = have.has(key) && e ? await invoke<string>('vfx_read_json_file', { path: `${dirs.vanillaJson}/${jsonRel}` }).then(JSON.parse).catch(() => null) : null
      if (absent.has(key)) { own.push(p); asset(p, 'added', 'Not in the game: the mod\'s own, kept as it was.') }
      else if (!e) { own.push(p); asset(p, 'failed', 'Its JSON could not be read: the mod\'s copy is kept, unfixed.') }
      else if (!json) {
        // gone from the cache (a temp folder cleanup): extracted again by the next try, not trusted from the index
        if (have.delete(key)) lost = true
        own.push(p); asset(p, 'failed', 'The game\'s copy could not be read: the mod\'s copy is kept, unfixed.')
      }
      else if (uncarriedPackages(e.packages, json, e.params).length) {
        // it points at another parent material, mesh or material than the game's: rebuilding it on the game's copy would
        // lose that, so the mod's own copy stays (a skin's material swap, a Blueprint's mesh)
        const extra = uncarriedPackages(e.packages, json, e.params).map(k => k.split('/').pop())
        swapped++; own.push(p); asset(p, 'passed', `Kept as it was: it uses ${extra.slice(0, 2).join(', ')}${extra.length > 2 ? ` and ${extra.length - 2} more` : ''} where the game's file does not, which an update cannot carry.`)
      }
      else {
        const changed: string[] = [], notes: string[] = []
        for (const prm of e.params) {
          const res = portParam(json, prm)
          if (res === 'changed') changed.push(prm.id.name)
          else if (res === 'missing') notes.push(`${prm.id.name} is no longer in the game's material`)
          else if (res === 'unportable') notes.push(`${prm.id.name} points at a texture inside the mod's own file, which cannot be carried`)
        }
        for (const c of e.colors) {
          const res = applyColor(json, c)
          if (res === 'changed') changed.push(c.label)
          else if (res === 'missing') notes.push(`${c.label} is no longer in the game's file`)
        }
        notes.forEach(n => warn(`${stem(p)}: ${n}.`))
        if (!changed.length && notes.length) {
          // its edits had nowhere to go: the game's file is not known to match the mod's
          own.push(p); asset(p, 'failed', `Its edits could not be carried (${notes.slice(0, 2).join(', ')}${notes.length > 2 ? ', and more' : ''}): the mod's copy is kept, unfixed.`)
        } else if (changed.length) {
          await invoke('vfx_write_json_file', { path: `${dirs.editedJson}/${jsonRel}`, content: JSON.stringify(json) })
          report.counts.changes += changed.length
          asset(p, 'updated', `Rebuilt on the game's file with ${plural(changed.length, 'edit')}: ${changed.slice(0, 6).join(', ')}${changed.length > 6 ? `, and ${changed.length - 6} more` : ''}.`)
        } else asset(p, 'same', 'Matches the game: left out, so the game\'s own is used.')
      }
      o.onProgress?.(++done, editable.length, `Carried ${done} of ${editable.length}`)
    })
    if (lost) await saveIndex()
    if (own.length) await invoke('vfx_copy_uasset_files', { sourcePaths: own, sourceBaseDir: dirs.modExtract, destBaseDir: dirs.finalUassets })
    log(`Rebuilt ${plural(report.counts.updated, 'asset')} with ${plural(report.counts.changes, 'edit')}, ${report.counts.same} match the game, ${report.counts.added} are the mod's own.`)

    // an incomplete rebuild is not placed: one failed or unread asset may be the one that broke, so the mod stays as it was
    const failedN = report.assets.filter(a => a.kind === 'failed').length
    if (failedN || report.counts.unreadable || unrewritten) {
      const why = [failedN && plural(failedN, 'material or blueprint', 'materials and blueprints') + ' could not be rebuilt', report.counts.unreadable && plural(report.counts.unreadable, 'asset') + ' could not be read',
        unrewritten && plural(unrewritten, 'material or blueprint', 'materials and blueprints') + " could not be rewritten in the new game build's layout"].filter(Boolean).join(', and ')
      report.error = `Not updated: ${why}. The mod was not changed. Check the USMAP in Advanced, then try again.`
      log(report.error, 'warning')
      return report // failed: Try again stays
    }

    await rebuildNiagara()

    // ---- 8: back to assets ----
    enter(8)
    // rewritten in today's layout and still in the update (one that matches the game is left out)
    const relaidKept = report.assets.filter(a => relaid.has(fileName(a.path).toLowerCase()) && a.kind !== 'same').length
    if (report.counts.updated > niagaraUpdated) {
      const built = await invoke<string[]>('vfx_convert_json_to_uassets', { usmapPath: o.usmapPath, inputDir: dirs.editedJson, outputDir: dirs.finalUassets })
      const expected = keep.length + own.length + report.counts.updated - niagaraUpdated
      if (built.length < expected) warn(`Only ${built.length} of ${expected} assets are in the rebuilt mod.`)
    }
    // nothing rebuilt or left out, only kept: the "update" would be the original again, under a new name
    if (swapped && !report.counts.updated && !report.counts.same && !report.counts.left && !niagaraDone && !relaidKept) {
      report.status = 'nothing'
      report.error = "Nothing to update: its materials and blueprints use other materials or meshes than the game's, which an update cannot carry, so the original stays as it is."
      return report
    }
    if (!report.counts.updated && !report.counts.added && !niagaraDone && !relaidKept && !((report.counts.left || report.counts.ownGame) && keep.length)) {
      if (report.counts.left || report.counts.ownGame) { report.error = allStale(); return report }
      // every material and blueprint was read and matches the game (anything else stopped above): it works as it is
      if (report.counts.same || swapped) {
        report.status = 'nothing'
        report.error = swapped
          ? "Nothing to update: its materials and blueprints use other materials or meshes than the game's, which an update cannot carry, so the original stays as it is."
          : report.counts.relaid
            ? "Nothing to update: every material and blueprint matches the game, but the original was made for an older game build and can crash it. Turn it off, the game's own files look the same."
            : 'Nothing to update: every material and blueprint already matches the game, so the original works as it is.'
      } else report.error = 'Not updated: none of its materials or blueprints could be rebuilt. Check the USMAP in Advanced, then try again.'
      return report
    }

    await packAndPlace()
  } catch (e) {
    if (e instanceof Cancelled) { report.status = 'cancelled'; report.error = 'Cancelled.' }
    else {
      // a tool's own message, said as what it is: the run stopped on it (Copy report keeps it word for word)
      const why = String(e instanceof Error ? e.message : e).replace(/^\[VFX\]\s*/, '').replace(/[.!]?\s*$/, '')
      report.status = 'failed'; report.error = `Stopped on an unexpected problem: ${why}.`; log(report.error, 'error')
    }
  } finally {
    const now = performance.now()
    if (step) report.steps.push({ step, ms: now - stepAt })
    report.ms = now - t0
    // here, where the early returns pass too: Needs VFX update stops flagging it until the mod or the game changes (xtra_broken.rs)
    // not when its materials were rewritten: the original stays installed in the old layout and still needs turning off
    if (report.status === 'nothing' && !layoutUnknown && !report.counts.relaid) await invoke('xtra_vfx_no_update', { modPath: o.modPath }).catch(e => log(`Could not note that it needs nothing: ${e}`, 'warning'))
  }
  return report
}

if (import.meta.env.DEV) {
  console.assert(fixedName('C:/m/BlueColoredVFX_9999999_P.utoc') === 'BlueColoredVFX_UPDATED_9999999_P', 'fixed name drops the priority')
  console.assert(fixedName('C:/m/A b_UPDATED_9999999_P.utoc') === 'A_b_UPDATED_V2_9999999_P', 'an update of an update is its next version')
  console.assert(fixedName('C:/m/A_UPDATED_V2_9999999_P.utoc') === 'A_UPDATED_V3_9999999_P', 'then V3')
  console.assert(assetKey('/Marvel/Content/X/MI_A.json') === assetKey('Marvel\\Content\\X\\MI_A.uasset'), 'keys ignore slashes and extensions')
  console.assert(relativeTo('C:\\T\\a/B/c.uasset', 'c:/t/A/') === 'B/c.uasset', 'relative across slash styles')
  console.assert(PASS_BY_NAME.test('NS_Fire.uasset') && !PASS_BY_NAME.test('MI_NS_Fire.uasset'), 'only the prefix passes by name')
}
