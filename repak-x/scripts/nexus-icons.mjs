// repakxtra: writes resources/nexus-icons.json, the Lucide icons the Nexus window draws in place of Nexus's own: every
// icon name between ICONS START and ICONS END in resources/nexus-theme.js, from the installed lucide-react, as SVG
// children. Run it after changing those names: node scripts/nexus-icons.mjs (in repak-x)
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const js = readFileSync('resources/nexus-theme.js', 'utf8')
const block = js.slice(js.indexOf('// ICONS START'), js.indexOf('// ICONS END'))
// the Lucide names: the maps' values, a 'name' after a colon or a comma and not itself a key
const names = [...new Set([...block.matchAll(/[:,]\s*'([a-z0-9-]+)'(?!\s*:)/g)].map(m => m[1]))].sort()
const escape = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
const out = {}
for (const name of names) {
  const file = pathToFileURL(`node_modules/lucide-react/dist/esm/icons/${name}.js`).href
  const { __iconNode } = await import(file).catch(() => { throw new Error(`No Lucide icon named ${name}`) })
  out[name] = __iconNode.map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).filter(([k]) => k !== 'key').map(([k, v]) => `${k}="${escape(v)}"`).join(' ')}/>`).join('')
}
writeFileSync('resources/nexus-icons.json', JSON.stringify(out, null, 0) + '\n')
console.log(`${names.length} icons`)
