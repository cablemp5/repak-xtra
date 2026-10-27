// Run after npm run build. Check the actual shipped JavaScript, not just the source flags.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'

const dist = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL('../dist/', import.meta.url))
const edition = JSON.parse(readFileSync(join(dist, 'edition.json'), 'utf8')).edition
assert(['standard', 'extended'].includes(edition), 'Missing or invalid edition marker')
const javascript = readdirSync(join(dist, 'assets')).filter(f => f.endsWith('.js'))
  .map(f => readFileSync(join(dist, 'assets', f), 'utf8')).join('\n')
for (const feature of ['Sigeon V2 Editor', 'CustomQuake', 'sigeon_status', 'xtra_quake_progress', 'Project Sigeon', 'extended_access_status', 'extended_unlock', 'Force default skin', 'AMOLED black theme', 'repakxploit']) {
  assert.equal(javascript.includes(feature), edition === 'extended', `${edition}: unexpected feature presence: ${feature}`)
}
assert(!javascript.includes('Native Support Coming Soon'), 'Obsolete Sigeon requirement must not ship')
assert(javascript.includes(edition === 'extended' ? 'extended-v' : 'Project Galacta'))
console.log(`${edition}: shipped feature checks passed`)
