// Exercise the queue's actual declarations in isolated windows, without rendering or touching user storage.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('../src/custom/previews.tsx', import.meta.url), 'utf8')
const ast = ts.createSourceFile('previews.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const names = new Set(`queue active batchDone run runPaths version listeners notify subscribe current leftArmed leftSaved leftPending LEFT_KEY
readLeft unfinished saveLeft armLeft running generatePreviews refuse start startNext finish stop usePreviewFailureToast
resuming retryAt tries RETRY_MS TRIES retryLater launched`.split(/\s+/))
const declarations = ast.statements.filter(n => names.has(n.name?.text) || n.declarationList?.declarations.some(d => names.has(d.name.text)))
assert.equal(declarations.length, names.size, 'Every queue declaration must be exercised')
const code = ts.transpileModule(declarations.map(n => n.getText(ast).replace(/^export /, '')).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText
const KEY = 'repakxtra.previewQueue'
const storage = new Map()
const job = n => ({ paths: [`C:/zz/${n}.pak`], name: n, force: true })
function session(available = true) {
  const calls = [], toasts = [], cleanups = []
  const context = vm.createContext({
    console, Date, setTimeout: () => 0, pending: new Set(), outcome: new Map(), failureListeners: new Set(), warnListeners: new Set(), koKeys: new Set(),
    available, FAILED: 'failed', SET_FAILED: 'set failed', APP_NAME: 'test', KO_KEYS: 'ko',
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
    jobId: j => j.set ?? j.paths.join(), nameKey: p => p.split('/').at(-1), keysOf: j => j.paths,
    koPreview: async () => false, invoke: async (command, args) => { calls.push({ command, args }); return true },
    play() {}, showPreviewCover() {}, verdictOf() {}, syncPreviewList() {},
    useEffect: fn => cleanups.push(fn()), plural: (n, word) => `${n} ${word}`, previewSetKey: n => `loadout-${n}`,
    alert: { info: (...args) => { toasts.push(args); return 1 }, dismissAlert() {}, error() {}, warning() {} },
  })
  vm.runInContext(code, context)
  const run = text => vm.runInContext(text, context)
  return { calls, toasts, run, mount: () => run('usePreviewFailureToast(alert)'), flush: async () => { await Promise.resolve(); await Promise.resolve() } }
}
const saved = () => JSON.parse(storage.get(KEY) ?? 'null')
let s = session()
s.mount()
await s.run(`generatePreviews(${JSON.stringify(job('a'))})`)
await s.run(`generatePreviews(${JSON.stringify(job('b'))})`)
assert.deepEqual(saved().jobs.map(j => j.name), ['a', 'b'])
s.run('pending.clear(); run.made = 1; finish(true)')
await s.flush()
assert.equal(saved().done, 1)
assert.deepEqual(saved().jobs.map(j => j.name), ['b'])
// A fresh window receives startup notifications before and after mounting, while the kit is unavailable.
s = session(false)
s.run('notify()')
s.mount()
s.run('notify()')
s.mount()
assert.equal(saved().done, 1)
assert.equal(s.calls.length, 0)
s.run('available = true; notify()')
await s.flush()
assert.equal(s.calls.filter(c => c.command === 'generate_mod_previews').length, 1)
assert.equal(s.toasts.length, 1)
assert.equal(saved().done, 1)
assert.equal(s.calls.find(c => c.command === 'generate_mod_previews').args.force, true)
assert.equal(s.calls[0].command, 'cancel_mod_previews', 'a generator the closed session left running is told to stop first')
s.run('stop()')
assert.equal(saved(), null)
s.run('finish(false)')
assert.equal(saved(), null)
// Startup failure keeps the entire batch for the next launch.
storage.set(KEY, JSON.stringify({ jobs: [job('a'), job('b')], done: 7 }))
s = session()
s.mount()
await s.flush()
s.run("refuse(current, 'generator unavailable')")
assert.deepEqual(saved().jobs.map(j => j.name), ['a', 'b'])
assert.equal(saved().done, 7)
await s.run(`generatePreviews(${JSON.stringify(job('b'))})`)
await s.flush()
assert.deepEqual(saved().jobs.map(j => j.name), ['a', 'b'])
s = session()
s.mount()
await s.flush()
s.run('pending.clear(); run.made = 1; finish(true)')
await s.flush()
assert.equal(saved().done, 8)
s.run('pending.clear(); run.made = 1; finish(true)')
assert.equal(saved(), null)
storage.set(KEY, JSON.stringify({ jobs: [job('a'), job('b')], done: 7 }))
s = session()
s.mount()
await s.flush()
s.run("refuse(current, 'generator still running')")
// While the closed session's generator still holds the lock, a refusal waits and tries again: no immediate restart, no
// failure, one toast. Once the wait is over, the next start goes through
const starts = () => s.calls.filter(c => c.command === 'generate_mod_previews').length
const before = starts()
s.run('notify()')
await s.flush()
assert.equal(starts(), before, 'no new start before the retry time')
assert.equal(s.run('run.summary'), '', 'no failure line while it waits')
s.run('retryAt = 0; notify()')
await s.flush()
assert.equal(starts(), before + 1, 'the retry starts the batch again')
assert.equal(s.toasts.length, 1, 'one toast for the whole pickup')
s.run('pending.clear(); run.made = 1; finish(true)')
await s.flush()
assert.equal(s.run('resuming'), false, 'a pickup that ran is over')
s.run('pending.clear(); run.made = 1; finish(true)')
storage.delete(KEY)
for (const bad of ['{', '{"jobs":[{}],"done":0}', '{"jobs":[],"done":-1}', '{"jobs":[{"paths":[2],"name":"x"}],"done":0}']) {
  storage.set(KEY, bad)
  s = session()
  s.mount()
  assert.equal(saved(), null)
  assert.equal(s.calls.length, 0)
}
s = session()
s.mount()
await s.run(`generatePreviews(${JSON.stringify({ ...job('quiet'), quiet: true })})`)
assert.equal(saved(), null)
console.log('Preview queue: restart, a generator left running, startup race, unavailable kit, remount, counts, stop, failure, completion, invalid data, and quiet jobs passed')
