import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const server = await createServer({ root, logLevel: 'error', server: { middlewareMode: true, hmr: false }, appType: 'custom' })
try {
  const { installedReleaseNotes } = await server.ssrLoadModule('/src/custom/releaseNotes.ts')
  const releases = [
    { tag_name: 'v0.26.0', body: 'standard notes' },
    { tag_name: 'v0.27.0', body: 'newer notes' },
    { tag_name: 'v0.28.0', body: 'draft notes', draft: true },
  ]
  for (const [prefix, expected] of [['v', 'standard notes']]) {
    const urls = []
    const request = async url => {
      urls.push(url)
      return { ok: !url.includes('/tags/'), json: async () => releases }
    }
    assert.equal(await installedReleaseNotes('0.26.0', prefix, request), expected)
    assert(urls[0].endsWith(`/tags/${prefix}0.26.0`))
    assert(urls.every(url => !url.endsWith('/latest')))
  }
  const direct = async () => ({ ok: true, json: async () => releases[1] })
  assert.equal(await installedReleaseNotes('v0.27.0', 'v', direct), 'newer notes')
  const fallback = async url => ({ ok: !url.includes('/tags/'), json: async () => releases })
  assert.equal(await installedReleaseNotes('0.25.0', 'v', fallback), '')
  assert.equal(await installedReleaseNotes('0.28.0', 'v', fallback), '')
  console.log('Release notes: exact-version, direct, fallback, and draft checks passed')
} finally { await server.close() }
