// Exercise the actual loadout switch and warning path with in-memory settings and mocked native calls.
import assert from 'node:assert/strict'
import { createServer } from 'vite'
process.env.NODE_ENV = 'production'
const memoryStorage = (store = new Map()) => ({
  getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k),
  clear: () => store.clear(), key: i => [...store.keys()][i] ?? null, get length() { return store.size },
})
globalThis.localStorage = memoryStorage()
globalThis.sessionStorage = memoryStorage()
globalThis.window ??= globalThis
// document and other DOM objects: a stand-in that accepts any property read, call or `new` (top levels only wire things up)
const any = new Proxy(function () {}, {
  get: (_, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' || k === Symbol.iterator ? undefined : any),
  apply: () => any, construct: () => any, set: () => true,
})
for (const k of ['document', 'Image', 'Audio', 'AudioContext', 'MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'indexedDB', 'requestAnimationFrame', 'cancelAnimationFrame']) globalThis[k] ??= any
// @tauri-apps/api reads this when a module asks for its window at load time
globalThis.__TAURI_INTERNALS__ ??= {
  metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' } },
  invoke: async () => null, transformCallback: () => 0, convertFileSrc: p => p,
}
globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
globalThis.addEventListener ??= () => {}
globalThis.removeEventListener ??= () => {}
globalThis.dispatchEvent ??= () => true


const root = new URL('..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')
const server = await createServer({ root, mode: 'production', logLevel: 'error', server: { middlewareMode: true, hmr: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } })
try {
  const { runChanges } = await server.ssrLoadModule('/src/custom/Loadouts.tsx')
  const { writeLoadouts, modKey } = await server.ssrLoadModule('/src/custom/loadoutStore.ts')
  const a = { path: 'C:/Game/~mods/CatboyPantherMesh.pak', enabled: true }
  const b = { path: 'C:/Game/~mods/ElectricBluePantherBPMESH.bak_repak', enabled: false }
  const defaultPath = 'Marvel/Content/Marvel/Characters/1026/1026001/Meshes/SK_1026_1026001.uasset'
  const multiPath = 'Marvel/Content/Marvel/Characters/1026/1026100/Meshes/SK_1026_1026100.uasset'
  const otherPath = 'Marvel/Content/Marvel/Characters/1026/1026300/Meshes/SK_1026_1026300.uasset'
  const first = { id: 'first', name: 'Catboy', label: 'Other', on: [modKey(a.path)], scope: [modKey(a.path)] }
  const second = { id: 'second', name: 'Electric', label: 'Other', on: [modKey(b.path)], scope: [modKey(b.path)] }
  for (const scenario of ['same', 'different', 'missing', 'failed']) {
    localStorage.clear()
    writeLoadouts([first, second])
    const source = {
      [a.path]: { character_name: 'Black Panther', category: 'Mesh', files: [defaultPath] },
      [b.path]: { character_name: "Black Panther - Bast's Chosen", category: 'Material', files: scenario === 'different' ? [otherPath] : [multiPath, defaultPath] },
    }
    const details = scenario === 'missing' ? {} : { ...source }
    const calls = [], warnings = []
    __TAURI_INTERNALS__.invoke = async (command, args) => {
      calls.push(command)
      if (command === 'get_mod_details') return source[args.modPath]
      if (command === 'toggle_mod' && scenario === 'failed') throw new Error('file locked')
      return null
    }
    const alert = { warning: (...args) => { warnings.push(args); return 'warning' }, info: () => '', success: () => '', dismissAlert() {} }
    await runChanges({ mods: [a, b], scopeMods: [], scopeLabel: '', blocked: false, isBlocked: () => false, modDetails: details, alert,
      reload: async () => { for (const path of Object.keys(details)) delete details[path] },
    }, second, [b], 'on')
    const conflicts = warnings.filter(([title]) => title === 'Catboy is also on')
    assert.equal(conflicts.length, scenario === 'same' || scenario === 'missing' ? 1 : 0, scenario)
    if (scenario === 'missing') assert.equal(calls.filter(c => c === 'get_mod_details').length, 2)
    console.log('PASS loadout warning: ' + scenario)
  }
} finally { await server.close() }
