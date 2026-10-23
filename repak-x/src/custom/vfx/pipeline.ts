// repakxtra: the VFX Updater, one mod at a time: rebuilds a VFX mod's materials and blueprints from the installed game's own
// files and carries the mod's edits onto them (assets.ts), so a game update that changed those files no longer breaks it.
// Started from the upstream VFX Updater's usePipeline; its Rust steps (vfx_updater/) do the UAssetTool work.
//   1 Extract the mod, read each asset's type (Niagara systems, textures and meshes by name: they always pass through)
//   2 The mod's materials and blueprints to JSON (converted in place, from a list)
//   3 Read what to carry: material parameters, color properties
//   4 The game's own copies of those assets, extracted once per game build and kept for the next mod (xtra_vfx.rs)
//   5 Those to JSON
//   6 Carry the edits over. An asset the game does not have is the mod's own and stays as it was.
//   7 Edited JSON back to assets
//   8 Pack, then put the fix in the mod's place: it takes the mod's name, on or off like it, and the original is renamed
//     <name>_BROKEN and turned off (xtra_vfx_place)
// Never throws: the report says what happened, asset by asset.
import { invoke } from '@tauri-apps/api/core'
import { DEFAULT_FILTER, type ColorFilter } from './filter'
import { type ColorProp, type ModParam, applyColor, isMaterialInstance, portParam, readColors, readModParams } from './assets'

export const STEPS = ['Reading the mod', 'Opening its materials', 'Finding its edits', "Reading the game's files", "Opening the game's files", 'Carrying the edits over', 'Rebuilding the assets', 'Packing the update'] as const

export type AssetKind = 'updated' | 'same' | 'added' | 'passed' | 'unreadable' | 'failed'
export type AssetResult = { name: string; path: string; kind: AssetKind; detail: string }
export type VfxStatus = 'fixed' | 'nothing' | 'failed' | 'cancelled'
export type Placed = { fixed: string; original: string; turnedOff: boolean; replaced: boolean; trashed?: boolean; warning?: string | null }
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
  counts: { updated: number; same: number; added: number; passed: number; unreadable: number; changes: number }
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

type Dirs = { modExtract: string; modJson: string; editedJson: string; finalUassets: string; stage: string; vanillaExtract: string; vanillaJson: string; vanillaIndex: string }
type Detected = { kind: 'material_instance' | 'blueprint' | 'maybe' | 'other'; class: string | null; error: string | null }
type VanillaIndex = { have: string[]; absent: string[] }

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

/** The upstream name: without its _<priority>_P suffix, spaces as underscores (xtra_vfx.rs fixed_stem matches). */
export const fixedName = (modPath: string) => `${stem(modPath).replace(/(_\d+)?_P$/i, '').replace(/_UPDATED$/i, '').trim().replace(/\s+/g, '_')}_UPDATED_9999999_P`

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
    counts: { updated: 0, same: 0, added: 0, passed: 0, unreadable: 0, changes: 0 }, ms: 0, steps: [] }
  let step = 0, stepAt = t0
  const enter = (n: number) => {
    if (o.cancelled?.()) throw new Cancelled()
    const now = performance.now()
    if (step) report.steps.push({ step, ms: now - stepAt })
    step = n; stepAt = now
    o.onStep?.({ step: n, title: STEPS[n - 1] })
  }
  const check = () => { if (o.cancelled?.()) throw new Cancelled() }
  const asset = (path: string, kind: AssetKind, detail: string) => { report.assets.push({ name: stem(path), path, kind, detail }); if (kind in report.counts) report.counts[kind as keyof typeof report.counts]++ }
  const warn = (w: string) => { report.warnings.push(w); log(w, 'warning') }

  try {
    // ---- 1: extract and sort ----
    enter(1)
    const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const dirs = await invoke<Dirs>('xtra_vfx_dirs', { gamePaks: o.gamePaksPath, runId, usmapPath: o.usmapPath }) // the game files' cache is per USMAP too
    const extracted = await invoke<string[]>('vfx_extract_mod_assets', { gamePaks: o.gamePaksPath, modPath: o.modPath, outputDir: dirs.modExtract })
    check()
    if (!extracted.length) throw new Error('No assets could be read from the mod. Check the game folder in Setup and that the mod is a .utoc mod.')
    const rel = (p: string) => relativeTo(p, dirs.modExtract)
    const manifest = extracted.map(rel)
    const ask = extracted.filter(p => !PASS_BY_NAME.test(fileName(p)))
    log(`Read ${plural(extracted.length, 'asset')}. Reading the type of ${ask.length}.`)
    const found = ask.length ? await invoke<Record<string, Detected>>('xtra_vfx_detect', { usmapPath: o.usmapPath, paths: ask }) : {}
    check()
    const types = new Map(Object.entries(found).map(([p, d]) => [assetKey(slash(p)), d]))
    let editable: string[] = []
    const keep: string[] = [], maybe = new Map<string, string>()
    for (const p of extracted) {
      const d = PASS_BY_NAME.test(fileName(p)) ? undefined : types.get(assetKey(slash(p)))
      if (d && d.kind !== 'other') { editable.push(p); if (d.kind === 'maybe') maybe.set(assetKey(rel(p)), d.class ?? ''); continue }
      keep.push(p)
      if (d?.error) asset(p, 'unreadable', `Could not be read (${d.error}). Kept as it was.`)
      else if (!d && !PASS_BY_NAME.test(fileName(p))) asset(p, 'unreadable', 'Its type could not be read. Kept as it was.')
      else asset(p, 'passed', d?.class ? `${d.class}, kept as it was.` : 'Kept as it was.')
    }
    if (keep.length) await invoke('vfx_copy_uasset_files', { sourcePaths: keep, sourceBaseDir: dirs.modExtract, destBaseDir: dirs.finalUassets })
    if (!editable.length) {
      if (report.counts.unreadable) {
        report.error = `${plural(report.counts.unreadable, 'asset')} could not be read, so it is not known whether ${report.counts.unreadable === 1 ? 'it needs' : 'they need'} rebuilding. Check the USMAP in Advanced, then try again.`
        return report // failed: Try again stays
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
    const edits = new Map<string, { params: ModParam[]; colors: ColorProp[] }>()
    const notMine = new Set<string>()
    let read = 0
    await mapLimit(modJson, 6, async path => {
      check()
      const key = assetKey(relativeTo(path, dirs.modJson))
      try {
        const json = JSON.parse(await invoke<string>('vfx_read_json_file', { path }))
        // a 'maybe' (its first export was user data) is edited only when it holds a material instance after all
        if (maybe.has(key) && !isMaterialInstance(json)) notMine.add(key)
        else edits.set(key, { params: readModParams(json, filter), colors: readColors(json, filter) })
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
    let index: VanillaIndex = { have: [], absent: [] }
    try { index = JSON.parse(await invoke<string>('vfx_read_json_file', { path: dirs.vanillaIndex })) } catch { /* first run on this game build */ }
    const have = new Set(index.have), absent = new Set(index.absent)
    const wanted = editable.map(p => assetKey(rel(p)))
    const missing = editable.filter((p, i) => !have.has(wanted[i]) && !absent.has(wanted[i]))
    let fresh: string[] = []
    if (missing.length) {
      log(`Extracting ${plural(missing.length, 'game file')} (${wanted.length - missing.length} already extracted).`)
      const got = await invoke<string[]>('vfx_extract_vanilla_assets', { gamePaks: o.gamePaksPath, outputDir: dirs.vanillaExtract, filterPatterns: missing.map(p => rel(p).replace(/\.uasset$/i, '')) })
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
    await invoke('vfx_write_json_file', { path: dirs.vanillaIndex, content: JSON.stringify({ have: [...have], absent: [...absent] }) })

    // ---- 6: carry the edits ----
    enter(6)
    const own: string[] = []
    let done = 0
    await mapLimit(editable, 6, async p => {
      check()
      const r = rel(p), key = assetKey(r)
      const e = edits.get(key)
      const jsonRel = r.replace(/\.uasset$/i, '.json')
      const json = have.has(key) && e ? await invoke<string>('vfx_read_json_file', { path: `${dirs.vanillaJson}/${jsonRel}` }).then(JSON.parse).catch(() => null) : null
      if (absent.has(key)) { own.push(p); asset(p, 'added', 'Not in the game: the mod\'s own, kept as it was.') }
      else if (!e) { own.push(p); asset(p, 'failed', 'Its JSON could not be read: the mod\'s copy is kept, unfixed.') }
      else if (!json) { own.push(p); asset(p, 'failed', 'The game\'s copy could not be read: the mod\'s copy is kept, unfixed.') }
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
    if (own.length) await invoke('vfx_copy_uasset_files', { sourcePaths: own, sourceBaseDir: dirs.modExtract, destBaseDir: dirs.finalUassets })
    log(`Rebuilt ${plural(report.counts.updated, 'asset')} with ${plural(report.counts.changes, 'edit')}, ${report.counts.same} match the game, ${report.counts.added} are the mod's own.`)

    // an incomplete rebuild is not placed: one failed or unread asset may be the one that broke, so the mod stays as it was
    const failedN = report.assets.filter(a => a.kind === 'failed').length
    if (failedN || report.counts.unreadable) {
      const why = [failedN && plural(failedN, 'material or blueprint', 'materials and blueprints') + ' could not be rebuilt', report.counts.unreadable && plural(report.counts.unreadable, 'asset') + ' could not be read'].filter(Boolean).join(', and ')
      report.error = `Not updated: ${why}. The mod was not changed. Check the USMAP in Advanced, then try again.`
      log(report.error, 'warning')
      return report // failed: Try again stays
    }

    // ---- 7: back to assets ----
    enter(7)
    if (report.counts.updated) {
      const built = await invoke<string[]>('vfx_convert_json_to_uassets', { usmapPath: o.usmapPath, inputDir: dirs.editedJson, outputDir: dirs.finalUassets })
      const expected = keep.length + own.length + report.counts.updated
      if (built.length < expected) warn(`Only ${built.length} of ${expected} assets are in the rebuilt mod.`)
    }
    if (!report.counts.updated && !report.counts.added) {
      // every material and blueprint was read and matches the game (anything else stopped above): it works as it is
      if (report.counts.same) {
        report.status = 'nothing'
        report.error = 'Nothing to update: every material and blueprint already matches the game, so the original works as it is.'
      } else report.error = 'Not updated: none of its materials or blueprints could be rebuilt. Check the USMAP in Advanced, then try again.'
      return report
    }

    // ---- 8: pack and place ----
    enter(8)
    const base = o.outputDir ? `${slash(o.outputDir)}/${fixedName(o.modPath)}` : `${dirs.stage}/fixed`
    const utoc = await invoke<string>('vfx_pack_to_iostore', { usmapPath: o.usmapPath, inputDir: dirs.finalUassets, outputBase: base, allowedAssets: manifest })
    if (o.outputDir) report.output = utoc
    else {
      report.placed = await invoke<Placed>('xtra_vfx_place', { source: o.modPath, stagedBase: base, turnOffOriginal: o.turnOffOriginal ?? true, keepName: o.keepName ?? true, trashOriginal: o.trashOriginal ?? false })
      report.output = report.placed.fixed
      if (report.placed.warning) warn(report.placed.warning)
    }
    report.status = 'fixed'
    log(`Updated: ${fileName(report.output)}`, 'success')
  } catch (e) {
    if (e instanceof Cancelled) { report.status = 'cancelled'; report.error = 'Cancelled.' }
    else { report.status = 'failed'; report.error = String(e instanceof Error ? e.message : e).replace(/^\[VFX\]\s*/, ''); log(report.error, 'error') }
  } finally {
    const now = performance.now()
    if (step) report.steps.push({ step, ms: now - stepAt })
    report.ms = now - t0
  }
  return report
}

if (import.meta.env.DEV) {
  console.assert(fixedName('C:/m/BlueColoredVFX_9999999_P.utoc') === 'BlueColoredVFX_UPDATED_9999999_P', 'fixed name drops the priority')
  console.assert(fixedName('C:/m/A b_UPDATED_9999999_P.utoc') === 'A_b_UPDATED_9999999_P', 'a fixed mod keeps one _UPDATED')
  console.assert(assetKey('/Marvel/Content/X/MI_A.json') === assetKey('Marvel\\Content\\X\\MI_A.uasset'), 'keys ignore slashes and extensions')
  console.assert(relativeTo('C:\\T\\a/B/c.uasset', 'c:/t/A/') === 'B/c.uasset', 'relative across slash styles')
  console.assert(PASS_BY_NAME.test('NS_Fire.uasset') && !PASS_BY_NAME.test('MI_NS_Fire.uasset'), 'only the prefix passes by name')
}
