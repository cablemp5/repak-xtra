import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
process.env.NODE_ENV = 'production'
globalThis.localStorage ??= { getItem: () => null }
globalThis.document ??= { addEventListener() {}, documentElement: { dataset: {} } }
for (const edition of ['standard', 'extended']) {
  process.env.VITE_REPAKXTRA_EDITION = edition
  const server = await createServer({ root, logLevel: 'error', server: { middlewareMode: true, hmr: false }, appType: 'custom' })
  try {
    const { default: Access } = await server.ssrLoadModule('/src/custom/ExtendedAccess.tsx')
    const { default: Wordmark } = await server.ssrLoadModule('/src/custom/Wordmark.tsx')
    const logo = renderToStaticMarkup(React.createElement(Wordmark, { height: 22 }))
    assert(logo.includes(`aria-label="${edition === 'extended' ? 'repakxploit' : 'repakxtra'}"`))
    assert(!logo.includes('<text'), 'Wordmarks must use outlined glyphs, not live font text')
    assert.equal((logo.match(/<path /g) ?? []).length, edition === 'extended' ? 11 : 9)
    let mounted = false
    const Feature = () => { mounted = true; return React.createElement('p', null, 'private-feature-fixture') }
    const html = renderToStaticMarkup(React.createElement(Access, null, React.createElement(Feature)))
    assert.equal(mounted, edition === 'standard', `${edition}: unexpected child rendering before access check`)
    assert.equal(html.includes('private-feature-fixture'), edition === 'standard')
    assert.equal(html.includes('type="password"'), edition === 'extended')
    assert.equal(html.includes('aria-label="Unlock repakxploit"'), edition === 'extended')
    assert.equal(html.includes('Get your key in cable&#x27;s Discord server.'), edition === 'extended')
    assert.equal(html.includes('class="cd-card"'), edition === 'extended')
    assert(!html.includes('Claim role'), 'The unlock screen offers Join without role claiming')
  } finally { await server.close() }
}
console.log('Access and logos: standard passes through; repakxploit gates content and uses its own wordmark')
