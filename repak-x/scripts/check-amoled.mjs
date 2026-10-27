import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
process.env.NODE_ENV = 'production' // unrelated DOM-only dev assertions do not run against these stubs
const key = 'repakxtra.extended.amoled'
const any = new Proxy(function () {}, {
  get: (_, k) => k === Symbol.toPrimitive ? () => '' : k === 'then' || k === Symbol.iterator ? undefined : any,
  apply: () => any, construct: () => any, set: () => true,
})
for (const name of ['Image', 'Audio', 'AudioContext', 'MutationObserver', 'ResizeObserver', 'requestAnimationFrame']) globalThis[name] = any
globalThis.window = globalThis
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} })
globalThis.__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' } },
  invoke: async () => null, transformCallback: () => 0,
}

for (const edition of ['standard', 'extended']) {
  const saved = new Map([[key, '1']])
  const attributes = new Map()
  const events = new Map()
  globalThis.localStorage = {
    getItem: k => saved.get(k) ?? null,
    setItem: (k, v) => saved.set(k, v),
    removeItem: k => saved.delete(k),
  }
  globalThis.document = new Proxy({}, { get: (_, k) => k === 'documentElement' ? {
    dataset: {},
    toggleAttribute: (name, on) => on ? attributes.set(name, '') : attributes.delete(name),
    setAttribute: (name, value) => attributes.set(name, value),
  } : any })
  globalThis.addEventListener = (name, callback) => events.set(name, [...(events.get(name) ?? []), callback])
  process.env.VITE_REPAKXTRA_EDITION = edition
  const server = await createServer({ root, logLevel: 'error', server: { middlewareMode: true, hmr: false }, appType: 'custom' })
  try {
    const { resetUiPrefs } = await server.ssrLoadModule('/src/custom/uiPrefs.tsx')
    const extended = edition === 'extended'
    assert.equal(attributes.has('data-amoled'), extended, `${edition}: restore saved AMOLED choice`)
    resetUiPrefs()
    assert.equal(attributes.has('data-amoled'), false)
    assert.equal(saved.has(key), !extended, 'Standard reset must preserve the repakxploit preference')
    for (const value of ['0', '1', 'invalid']) {
      saved.set(key, value)
      for (const callback of events.get('storage') ?? []) callback({ key })
      assert.equal(attributes.has('data-amoled'), extended && value === '1', `${edition}: live change ${value}`)
    }
  } finally { await server.close() }
}
console.log('AMOLED: saved choice, live changes, reset, and Standard isolation verified')
