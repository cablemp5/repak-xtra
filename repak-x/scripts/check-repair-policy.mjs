import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('..', import.meta.url))
const source = file => readFileSync(path.join(root, file), 'utf8')
const compile = code => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
function declaration(file, name) {
  const tree = ts.createSourceFile(file, source(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let found
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === name) found = node.initializer.getText(tree)
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node.getText(tree).replace(/^export /, '')
    ts.forEachChild(node, visit)
  }
  visit(tree)
  assert.ok(found, `${name} exists`)
  return found
}

// Each render has a separate closure. Only changed dependencies replace the memoized callback.
let cached
const useCallback = (fn, deps) => {
  if (!cached || deps.some((d, i) => !Object.is(d, cached.deps[i]))) cached = { fn, deps }
  return cached.fn
}
const stable = Object.fromEntries(['picked', 'usmap', 'paks', 'originals', 'keepName', 'safety', 'needs', 'keepEncrypted', 'addLog'].map(k => [k, {}]))
const run = declaration('src/custom/vfx/VfxUpdaterWindow.tsx', 'run')
const render = repairPolicy => vm.runInNewContext(compile(`globalThis.result = ${run}`), { ...stable, repairPolicy, useCallback })
const strictRun = render('strict')
assert.equal(render('strict'), strictRun)
assert.notEqual(render('bestEffort'), strictRun, 'switching policy must update the callback before Update is clicked')

const quick = declaration('src/custom/vfx/quick.ts', 'updateVfxModInPlace')
for (const kind of [undefined, 'unknown', 'broken', 'vfx', 'risky']) {
  let options
  const scope = {
    reserved: false, nameOf: () => 'Fixture', newRunToken: () => 'fixture', findUsmap: async () => 'fixture.usmap',
    claimRun: async () => true, setUpdating() {}, readOriginals: () => 'off', readNaming: () => 'broken', readSafeOff: () => true, readSafety: () => 'trash', readKeepEncrypted: () => false, readRepairPolicy: () => 'bestEffort',
    readFilter: () => ({}), verdictOf: () => kind ? { kind } : undefined, utocOf: p => p + '.utoc', STEPS: ['Read'],
    fixVfxMod: async o => { options = o; return { status: 'failed' } }, resultToast() {}, releaseRun: async () => {}, verdictsChanged: async () => {},
    invoke: async () => 'C:/Fixture/Paks/~mods',
  }
  vm.runInNewContext(compile(`globalThis.update = (${quick})`), scope)
  await scope.update({ path: 'Fixture.pak' }, { warning() {}, showAlert: () => 1, dismissAlert() {} }, () => {})
  assert.equal(options.safeOff, ['broken', 'vfx', 'risky'].includes(kind), `${kind}: only actionable warnings authorize disabling`)
}

const rel = 'Marvel/Content/X/MI_A'
const dirs = { modExtract: '/fixture/mod', modJson: '/fixture/modjson', editedJson: '/fixture/edited', finalUassets: '/fixture/final', stage: '/fixture/stage', vanillaExtract: '/fixture/game', vanillaJson: '/fixture/gamejson', vanillaIndex: '/fixture/index.json' }
const material = (glow, twoSided) => ({
  Imports: [{ ObjectName: 'MaterialInstanceConstant', ClassName: 'Class', OuterIndex: 0 }],
  Exports: [{ ClassIndex: -1, $type: 'NormalExport', Data: [
    { Name: 'ScalarParameterValues', Value: [{ Name: '0', Value: [{ Name: 'ParameterInfo', Value: [{ Name: 'Name', Value: 'Glow' }] }, { Name: 'ParameterValue', Value: glow }] }] },
    { Name: 'BasePropertyOverrides', Value: [{ Name: 'TwoSided', Value: twoSided }] },
  ] }],
})

async function repair(policy, sameParameters = false, scenario = {}) {
  const mod = material(sameParameters ? 1 : 2, true)
  if (scenario.relayout) mod.Imports.push({ ObjectName: '/Game/CustomParent', ClassName: 'Package', OuterIndex: 0 })
  const calls = [], files = new Map([
    [dirs.modJson + '/' + rel + '.json', JSON.stringify(mod)],
    [dirs.vanillaJson + '/' + rel + '.json', JSON.stringify(material(1, false))],
  ])
  let placement, outcome
  async function invoke(cmd, a = {}) {
    calls.push(cmd)
    switch (cmd) {
      case 'xtra_vfx_source': return a.modPath
      case 'xtra_vfx_usmap_wait': return scenario.wait ? { usmap: 1, game: 2, changed: scenario.wait === 'late' ? 0 : 3 } : null
      case 'xtra_game_build': return { updated: scenario.buildMoves && calls.includes('vfx_pack_to_iostore') ? 200 : 100 }
      case 'xtra_vfx_dirs': return dirs
      case 'vfx_extract_mod_assets': return [dirs.modExtract + '/' + rel + '.uasset', ...(scenario.niagara ? [dirs.modExtract + '/NS_Fixture.uasset'] : []), ...(scenario.unreadable ? [dirs.modExtract + '/' + rel + 'B.uasset'] : [])]
      case 'xtra_vfx_pak_half': return []
      case 'xtra_vfx_classes': return { [rel.toLowerCase()]: 'MaterialInstanceConstant' }
      case 'xtra_vfx_relayout': return { files: scenario.relayout ? [rel] : [], failed: [], unread: [], untold: [], complete: true }
      case 'xtra_vfx_stale': return ['NS_Fixture.uasset']
      case 'xtra_vfx_niagara': return { ready: true, files: [{ file: 'NS_Fixture.uasset', error: 'Fixture omission', retry: scenario.niagara === 'retry' }] }
      case 'xtra_vfx_detect': return { [dirs.modExtract + '/' + rel + '.uasset']: { kind: 'material_instance', class: 'MaterialInstanceConstant' }, ...(scenario.unreadable ? { [dirs.modExtract + '/' + rel + 'B.uasset']: { kind: 'other', class: null, error: 'Fixture unreadable' } } : {}) }
      case 'vfx_copy_uasset_files': return []
      case 'vfx_write_json_file': files.set(a.path, a.content); return
      case 'vfx_convert_uassets_to_json': return [a.outputDir + '/' + rel + '.json']
      case 'vfx_read_json_file': if (!files.has(a.path)) throw Error('Fixture file absent'); return files.get(a.path)
      case 'vfx_extract_vanilla_assets': return [dirs.vanillaExtract + '/' + rel + '.uasset']
      case 'vfx_convert_json_to_uassets': return [dirs.finalUassets + '/' + rel + '.uasset']
      case 'xtra_vfx_verify': return scenario.unverified ? [rel] : []
      case 'vfx_pack_to_iostore': return '/fixture/fixed.utoc'
      case 'xtra_safe_off_kept': return null
      case 'xtra_vfx_place': placement = a; return { fixed: 'Fixture.pak', source: 'Fixture.pak', original: 'Fixture.bak_repak' }
      case 'xtra_vfx_stamp': return
      case 'xtra_vfx_no_update': assert.ok(['Fixture.pak', 'Fixture.bak_repak'].includes(a.modPath), 'clear the placed output and its original'); return
      case 'xtra_vfx_run_done': return
      case 'xtra_vfx_outcome': outcome = a; return
      case 'xtra_vfx_turn_off': calls.push('turn_off:' + a.modPath); return null
      default: throw Error('Unexpected fixture command ' + cmd)
    }
  }
  const modules = new Map()
  function load(file) {
    file = path.resolve(file)
    if (modules.has(file)) return modules.get(file)
    const exports = {}
    modules.set(file, exports)
    vm.runInNewContext(compile(readFileSync(file, 'utf8').replaceAll('import.meta.env.DEV', 'false')), {
      exports, module: { exports }, require: n => n === '@tauri-apps/api/core' ? { invoke } : n === '@tauri-apps/api/event' ? { listen: async () => () => {} } : load(path.resolve(path.dirname(file), n + '.ts')),
      structuredClone, performance, console,
    })
    return exports
  }
  const { fixVfxMod } = load(path.join(root, 'src/custom/vfx/pipeline.ts'))
  const report = await fixVfxMod({ modPath: 'Fixture.utoc', usmapPath: 'fixture.usmap', gamePaksPath: 'fixture', policy, safeOff: Boolean(scenario.safeOff),
    trashOriginal: true, turnOffOriginal: false })
  return { report, calls, placement, outcome }
}

for (const same of [false, true]) {
  const result = await repair('strict', same)
  assert.equal(result.report.status, 'failed')
  assert.ok(result.report.warnings.some(w => /creator edits/.test(w)))
  assert.ok(!result.calls.includes('xtra_vfx_place'), 'strict cannot install an unproven reconstruction')
  assert.ok(!result.calls.includes('xtra_vfx_no_update'), 'matching supported parameters cannot clear the original warning')
  // a rejection only Strict makes: kept as Failed (Needs update clears), its row offers Retry in Best effort
  // a rebuilt material Best effort would install is strict-only, a match alone is not (Best effort refuses it too)
  assert.equal(Boolean(result.report.strictOnly), !same, 'strict-only only when Best effort would install it')
  assert.deepEqual([result.outcome.status, result.outcome.next], ['failed', same ? 'page' : 'best'], 'the failure is kept with the next step that fits')
  assert.ok(!result.calls.some(c => c.startsWith('turn_off:')) && !result.calls.includes('rename_mod'), 'a failure never renames or turns off the mod')
}
// Best effort: a candidate that passes the checks goes in without asking, and clears the kept outcome
const accepted = await repair('bestEffort')
assert.equal(accepted.report.status, 'fixed')
assert.ok(accepted.calls.includes('xtra_vfx_place'), 'best effort places a verified candidate')
assert.equal(accepted.placement.partial, false, 'whole materials must not request the Niagara retry marker')
assert.equal(accepted.placement.trashOriginal, true, 'it follows Originals: the original goes to Recently deleted')
assert.equal(accepted.outcome.status, null, 'an installed update forgets the last failure')
assert.ok(accepted.calls.includes('turn_off:Fixture.bak_repak'), 'the original is kept off before its flag clears')
// a rewritten material that points at its own parent: kept with a warning that it may show gray. Strict stops, Best effort installs it
const relaidStrict = await repair('strict', false, { relayout: 'rewritten' })
assert.equal(relaidStrict.report.status, 'failed')
assert.ok(relaidStrict.report.warnings.some(w => /may show gray/.test(w)))
assert.ok(!relaidStrict.calls.includes('xtra_vfx_place'), 'a kept old-shader material cannot pass Strict')
const relaid = await repair('bestEffort', false, { relayout: 'rewritten' })
assert.ok(relaid.report.warnings.some(w => /may show gray/.test(w)) && relaid.calls.includes('xtra_vfx_place'), 'best effort installs it and says why')
for (const niagara of ['retry', 'permanent']) {
  const result = await repair('bestEffort', false, { niagara })
  assert.equal(result.report.status, 'fixed')
  assert.ok(result.calls.indexOf('xtra_vfx_no_update') > result.calls.indexOf('xtra_vfx_place'), 'an installed partial repair clears Needs update too')
  assert.equal(result.placement.partial, niagara === 'retry', 'only retryable Niagara omissions request the retry marker')
  assert.equal(result.placement.trashOriginal, false, 'omitted content retains its original')
  // strict: the same partial is refused, the mod stays as it was
  const strict = await repair('strict', false, { niagara })
  assert.equal(strict.report.status, 'failed')
  assert.ok(!strict.calls.includes('xtra_vfx_place') && strict.report.strictOnly, 'strict rejects a partial candidate, Retry in Best effort offered')
}
// verification fails: never installed (this fixture's warning stops Strict before it, so Best effort is the case)
for (const policy of ['bestEffort']) {
  const result = await repair(policy, false, { unverified: true })
  assert.equal(result.report.status, 'failed')
  assert.ok(!result.calls.includes('xtra_vfx_place') && !result.report.strictOnly, `${policy}: a file that does not read back is never installed`)
  assert.equal(result.outcome.status, 'failed')
}
// an unread asset blocks Best effort too, and leaves even a flagged mod as it was, on
const unsafe = await repair('bestEffort', false, { unreadable: true, safeOff: true })
assert.equal(unsafe.report.status, 'failed')
assert.ok(!unsafe.calls.includes('xtra_vfx_place'), 'an unread asset blocks placement')
assert.ok(!unsafe.calls.some(c => c.startsWith('turn_off:')), 'a failed update leaves even a flagged mod as it was, on')
// mappings older than the files it left out: Waiting under either policy, never Failed
for (const policy of ['strict', 'bestEffort']) {
  const late = await repair(policy, false, { wait: 'late', niagara: 'retry' })
  assert.equal(late.report.status, 'mappings', `${policy}: an incomplete rebuild with old mappings waits`)
  assert.ok(!late.calls.includes('xtra_vfx_place'))
}
// the game updates while it packs: nothing is installed
const moved = await repair('bestEffort', false, { buildMoves: true })
assert.equal(moved.report.status, 'failed')
assert.ok(!moved.calls.includes('xtra_vfx_place') && /game updated/.test(moved.report.error), 'a candidate built for the previous patch is never installed')
// it needs the game's new mappings first: Waiting, never Failed, and nothing is read or changed
const waits = await repair('bestEffort', false, { wait: true })
assert.equal(waits.report.status, 'mappings')
assert.equal(waits.outcome.status, 'waiting', 'kept as Waiting for mappings')
assert.ok(!waits.calls.includes('vfx_extract_mod_assets') && !waits.calls.includes('xtra_vfx_place'), 'a waiting mod is left alone')
console.log('PASS repair policy: fresh selection, right-click safety, strict and best effort gates, verification, waiting for mappings, and kept outcomes')
