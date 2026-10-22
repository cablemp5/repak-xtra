// repakxtra: runs every `if (import.meta.env.DEV) { console.assert(...) }` self-check in src through Vite (no new test
// framework) and exits 1 when any fails, so CI executes them instead of only the dev copy's console.
// Usage: node scripts/run-asserts.mjs [path filter]
import { createServer } from 'vite'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = new URL('..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')
const filter = process.argv[2] ?? ''

const files = []
const walk = dir => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else if (/\.(ts|tsx)$/.test(e.name) && !p.includes(`${join('src', 'dev')}`) && readFileSync(p, 'utf8').includes('console.assert')) files.push(p)
  }
}
walk(join(root, 'src'))

// Just enough browser for module top levels (stores read localStorage, some modules touch window or document)
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

// Checks that build real elements (document.createElement) cannot pass against the stand-in above: they are counted
// as skipped and named, never as passed. The dev copy and the browser preview still run them.
const NEEDS_DOM = ['src/custom/sounds.ts']
let failed = 0
let passed = 0
let skipped = 0
const owner = () => (new Error().stack?.match(/src[\\/][^:?)]+/g) ?? []).map(p => p.replaceAll('\\', '/'))[0] ?? '?'
console.assert = (ok, ...msg) => {
  if (ok) { passed++; return }
  const file = owner()
  const text = msg.map(m => (typeof m === 'string' ? m : JSON.stringify(m))).join(' ')
  if (NEEDS_DOM.includes(file)) { skipped++; console.log(`SKIP ${file}: ${text} (needs a real DOM)`); return }
  failed++
  console.error(`FAIL ${file}: ${text}`)
}

const server = await createServer({ root, logLevel: 'error', server: { middlewareMode: true, hmr: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } })
let broken = 0
for (const f of files.filter(f => f.includes(filter))) {
  const current = relative(root, f).replaceAll('\\', '/')
  try {
    await server.ssrLoadModule(f)
  } catch (e) {
    broken++
    console.error(`LOAD ${current}: ${e?.message ?? e}`)
  }
}
await server.close()
console.log(`${passed} self-checks passed, ${failed} failed, ${skipped} skipped, ${broken} files could not load (${files.length} files)`)
process.exit(failed || broken ? 1 : 0)
