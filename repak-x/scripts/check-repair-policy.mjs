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
const stable = Object.fromEntries(['picked', 'usmap', 'paks', 'originals', 'keepName', 'safety', 'needs', 'askReview', 'addLog'].map(k => [k, {}]))
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
    claimRun: async () => true, setUpdating() {}, readOriginals: () => 'off', readNaming: () => 'broken', readSafeOff: () => true, readSafety: () => 'trash', readRepairPolicy: () => 'bestEffort', readAskReview: () => false, incompleteAssets: () => 0,
    readFilter: () => ({}), verdictOf: () => kind ? { kind } : undefined, utocOf: p => p + '.utoc', STEPS: ['Read'],
    fixVfxMod: async o => { options = o; return { status: 'failed' } }, resultToast() {}, releaseRun: async () => {},
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

async function repair(policy, accept = false, sameParameters = false, scenario = {}) {
  const mod = material(sameParameters ? 1 : 2, true)
  if (scenario.relayout) mod.Imports.push({ ObjectName: '/Game/CustomParent', ClassName: 'Package', OuterIndex: 0 })
  const calls = [], files = new Map([
    [dirs.modJson + '/' + rel + '.json', JSON.stringify(mod)],
    [dirs.vanillaJson + '/' + rel + '.json', JSON.stringify(material(1, false))],
  ])
  let candidate, placement
  async function invoke(cmd, a = {}) {
    calls.push(cmd)
    switch (cmd) {
      case 'xtra_vfx_source': return a.modPath
      case 'xtra_vfx_usmap_wait': return null
      case 'xtra_game_build': return { updated: 100 }
      case 'xtra_vfx_dirs': return dirs
      case 'vfx_extract_mod_assets': return [dirs.modExtract + '/' + rel + '.uasset', ...(scenario.niagara ? [dirs.modExtract + '/NS_Fixture.uasset'] : []), ...(scenario.unreadable ? [dirs.modExtract + '/' + rel + 'B.uasset'] : [])]
      case 'xtra_vfx_pak_half': return []
      case 'xtra_vfx_classes': return { [rel.toLowerCase()]: 'MaterialInstanceConstant' }
      case 'xtra_vfx_relayout': return { files: scenario.relayout ? [rel] : [], surgical: scenario.relayout === 'surgical' ? [rel] : [], failed: [], unread: [], untold: [], complete: true }
      case 'xtra_vfx_stale': return ['NS_Fixture.uasset']
      case 'xtra_vfx_niagara': return { ready: true, files: [{ file: 'NS_Fixture.uasset', error: 'Fixture omission', retry: scenario.niagara === 'retry' }] }
      case 'xtra_vfx_detect': return { [dirs.modExtract + '/' + rel + '.uasset']: { kind: 'material_instance', class: 'MaterialInstanceConstant' }, ...(scenario.unreadable ? { [dirs.modExtract + '/' + rel + 'B.uasset']: { kind: 'other', class: null, error: 'Fixture unreadable' } } : {}) }
      case 'vfx_copy_uasset_files': return []
      case 'vfx_write_json_file': files.set(a.path, a.content); return
      case 'vfx_convert_uassets_to_json': return [a.outputDir + '/' + rel + '.json']
      case 'vfx_read_json_file': if (!files.has(a.path)) throw Error('Fixture file absent'); return files.get(a.path)
      case 'vfx_extract_vanilla_assets': return [dirs.vanillaExtract + '/' + rel + '.uasset']
      case 'vfx_convert_json_to_uassets': return [dirs.finalUassets + '/' + rel + '.uasset']
      case 'xtra_vfx_verify': return []
      case 'vfx_pack_to_iostore': return '/fixture/fixed.utoc'
      case 'xtra_safe_off_kept': return null
      case 'xtra_vfx_place': placement = a; return { fixed: 'Fixture.pak', source: 'Fixture.pak', original: 'Fixture.bak_repak' }
      case 'xtra_vfx_stamp': return
      case 'xtra_vfx_no_update': assert.ok(['Fixture.pak', 'Fixture.bak_repak'].includes(a.modPath), 'clear the placed output and its original'); return
      case 'xtra_vfx_run_done': return
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
  const report = await fixVfxMod({ modPath: 'Fixture.utoc', usmapPath: 'fixture.usmap', gamePaksPath: 'fixture', policy, safeOff: Boolean(scenario.safeOff), autoAccept: scenario.autoAccept,
    trashOriginal: true, turnOffOriginal: false,
    review: async r => { calls.push('review'); candidate = r; assert.ok(!calls.includes('xtra_vfx_place')); return accept },
  })
  return { report, calls, candidate, placement }
}

for (const same of [false, true]) {
  const result = await repair('strict', false, same)
  assert.equal(result.report.status, 'failed')
  assert.ok(result.report.warnings.some(w => /creator edits/.test(w)))
  assert.ok(!result.calls.includes('xtra_vfx_place'), 'strict cannot install an unproven reconstruction')
  assert.ok(!result.calls.includes('xtra_vfx_no_update'), 'matching supported parameters cannot clear the original warning')
}
const declined = await repair('bestEffort')
assert.ok(declined.calls.includes('vfx_pack_to_iostore') && declined.calls.includes('review'))
assert.ok(declined.candidate.warnings.some(w => /creator edits/.test(w)))
assert.ok(!declined.calls.includes('xtra_vfx_place'), 'declining leaves the original unchanged')
assert.equal(declined.report.status, 'declined', 'a declined candidate is not a failure')
const accepted = await repair('bestEffort', true)
assert.equal(accepted.report.status, 'fixed')
assert.ok(accepted.calls.indexOf('review') < accepted.calls.indexOf('xtra_vfx_place'))
assert.equal(accepted.placement.partial, false, 'reviewed materials must not request the Niagara retry marker')
assert.equal(accepted.placement.trashOriginal, true, 'a reviewed candidate follows Originals: the original goes to Recently deleted')
const relaidStrict = await repair('strict', false, false, { relayout: 'reconstructed' })
assert.equal(relaidStrict.report.status, 'failed')
assert.ok(relaidStrict.report.warnings.some(w => /creator edits/.test(w)))
assert.ok(!relaidStrict.calls.includes('xtra_vfx_place'), 'different-parent passthrough cannot bypass strict preservation checks')
for (const accept of [false, true]) {
  const relaid = await repair('bestEffort', accept, false, { relayout: 'reconstructed' })
  assert.ok(relaid.candidate.warnings.some(w => /creator edits/.test(w)), 'review includes non-surgical relayout warning')
  assert.equal(relaid.calls.includes('xtra_vfx_place'), accept)
}
const surgical = await repair('strict', false, false, { relayout: 'surgical' })
assert.equal(surgical.report.status, 'fixed', 'proven surgical repair remains installable in strict mode')
assert.equal(surgical.report.warnings.length, 0)
assert.ok(surgical.calls.indexOf('xtra_vfx_no_update') > surgical.calls.indexOf('xtra_vfx_place'), 'complete repair clears only after installation')
for (const niagara of ['retry', 'permanent']) {
  const result = await repair('bestEffort', true, false, { niagara })
  assert.equal(result.report.status, 'fixed')
  assert.ok(result.calls.indexOf('xtra_vfx_no_update') > result.calls.indexOf('xtra_vfx_place'), 'an installed partial repair clears Needs update too')
  assert.equal(result.placement.partial, niagara === 'retry', 'only retryable Niagara omissions request the retry marker')
  assert.equal(result.placement.trashOriginal, false, 'omitted content retains its original')
}
// no review (the default): a clean candidate goes in without asking, one keeping an unread asset fails and turns off
const auto = await repair('bestEffort', false, false, { autoAccept: true })
assert.equal(auto.report.status, 'fixed')
assert.ok(!auto.calls.includes('review') && auto.calls.includes('xtra_vfx_place'), 'automatic acceptance places without a review')
assert.ok(auto.calls.includes('turn_off:Fixture.bak_repak'), 'the original is kept off before its flag clears')
const autoUnsafe = await repair('bestEffort', false, false, { autoAccept: true, unreadable: true, safeOff: true })
assert.equal(autoUnsafe.report.status, 'failed')
assert.ok(!autoUnsafe.calls.includes('xtra_vfx_place') && !autoUnsafe.calls.includes('review'), 'an unread asset blocks automatic placement')
assert.ok(autoUnsafe.calls.includes('turn_off:Fixture.utoc'), 'a flagged mod whose candidate was refused turns off')
console.log('PASS repair policy: fresh selection, inconclusive right-click safety, strict preservation gate, and reviewed candidates')
