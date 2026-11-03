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
const stable = Object.fromEntries(['picked', 'usmap', 'paks', 'originals', 'keepName', 'safeOff', 'needs', 'addLog'].map(k => [k, {}]))
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
    claimRun: async () => true, setUpdating() {}, readOriginals: () => 'off', readNaming: () => 'broken', readSafeOff: () => true,
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

async function repair(policy, accept = false, sameParameters = false) {
  const calls = [], files = new Map([
    [dirs.modJson + '/' + rel + '.json', JSON.stringify(material(sameParameters ? 1 : 2, true))],
    [dirs.vanillaJson + '/' + rel + '.json', JSON.stringify(material(1, false))],
  ])
  let candidate
  async function invoke(cmd, a = {}) {
    calls.push(cmd)
    switch (cmd) {
      case 'xtra_vfx_source': return a.modPath
      case 'xtra_vfx_usmap_wait': return null
      case 'xtra_game_build': return { updated: 100 }
      case 'xtra_vfx_dirs': return dirs
      case 'vfx_extract_mod_assets': return [dirs.modExtract + '/' + rel + '.uasset']
      case 'xtra_vfx_pak_half': return []
      case 'xtra_vfx_classes': return { [rel.toLowerCase()]: 'MaterialInstanceConstant' }
      case 'xtra_vfx_relayout': return { files: [], surgical: [], failed: [], unread: [], untold: [], complete: true }
      case 'xtra_vfx_detect': return { [dirs.modExtract + '/' + rel + '.uasset']: { kind: 'material_instance', class: 'MaterialInstanceConstant' } }
      case 'vfx_copy_uasset_files': return []
      case 'vfx_write_json_file': files.set(a.path, a.content); return
      case 'vfx_convert_uassets_to_json': return [a.outputDir + '/' + rel + '.json']
      case 'vfx_read_json_file': if (!files.has(a.path)) throw Error('Fixture file absent'); return files.get(a.path)
      case 'vfx_extract_vanilla_assets': return [dirs.vanillaExtract + '/' + rel + '.uasset']
      case 'vfx_convert_json_to_uassets': return [dirs.finalUassets + '/' + rel + '.uasset']
      case 'xtra_vfx_verify': return []
      case 'vfx_pack_to_iostore': return '/fixture/fixed.utoc'
      case 'xtra_safe_off_kept': return null
      case 'xtra_vfx_place': return { fixed: 'Fixture.pak', source: 'Fixture.pak', original: 'Fixture.bak_repak' }
      case 'xtra_vfx_stamp': return
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
      exports, module: { exports }, require: n => n === '@tauri-apps/api/core' ? { invoke } : load(path.resolve(path.dirname(file), n + '.ts')),
      structuredClone, performance, console,
    })
    return exports
  }
  const { fixVfxMod } = load(path.join(root, 'src/custom/vfx/pipeline.ts'))
  const report = await fixVfxMod({ modPath: 'Fixture.utoc', usmapPath: 'fixture.usmap', gamePaksPath: 'fixture', policy, safeOff: false,
    review: async r => { calls.push('review'); candidate = r; assert.ok(!calls.includes('xtra_vfx_place')); return accept },
  })
  return { report, calls, candidate }
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
const accepted = await repair('bestEffort', true)
assert.equal(accepted.report.status, 'fixed')
assert.ok(accepted.calls.indexOf('review') < accepted.calls.indexOf('xtra_vfx_place'))
console.log('PASS repair policy: fresh selection, inconclusive right-click safety, strict preservation gate, and reviewed candidates')
