// repakxtra: decides whether a pull request needs the Rust tests (checks.yml). Prints "true" or "false".
//   node .github/scripts/needs-rust.mjs < changed-files.txt
// Rust is skipped only when every changed file is frontend-only: TypeScript, CSS and assets under repak-x/src, the
// frontend's own config and scripts, and docs. A file the Rust code embeds (include_str!/include_bytes!, read from the
// .rs sources on every run, e.g. custom/version.ts) counts as Rust. Anything else, an empty list or a failure: Rust runs.
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, posix, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Every file the Rust sources embed, as repo paths with forward slashes. */
function embeddedFiles(root = ROOT) {
  const out = new Set()
  const walk = dir => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) { if (e.name !== 'target' && e.name !== 'node_modules') walk(p) } else if (e.name.endsWith('.rs')) {
        for (const m of readFileSync(p, 'utf8').matchAll(/include_(?:str|bytes)!\(\s*"([^"]+)"\s*\)/g)) {
          out.add(relative(root, join(dirname(p), m[1])).split('\\').join('/'))
        }
      }
    }
  }
  for (const d of ['repak-x', 'uasset_toolkit']) walk(join(root, d))
  return out
}

const FRONTEND_CONFIG = new Set(['repak-x/package.json', 'repak-x/package-lock.json', 'repak-x/index.html', 'repak-x/vite.config.ts'])

/** Whether a change to `file` (a repo path) can leave the Rust tests untouched. */
export function frontendOnly(file, embedded) {
  const f = posix.normalize(file.replace(/\\/g, '/'))
  if (embedded.has(f)) return false
  if (f.startsWith('repak-x/src/')) return !f.endsWith('.rs')
  if (f.startsWith('repak-x/public/') || f.startsWith('repak-x/scripts/') || f.startsWith('release-notes/')) return true
  if (FRONTEND_CONFIG.has(f) || /^repak-x\/tsconfig[^/]*\.json$/.test(f)) return true
  return f.endsWith('.md')
}

/** "false" only when there is at least one file and every one is frontend-only. */
export const needsRust = (files, embedded) => !(files.length > 0 && files.every(f => frontendOnly(f, embedded)))

// Checked on every run, so a broken rule fails the run instead of quietly skipping the Rust tests
const embedded = embeddedFiles()
const cases = [
  [['repak-x/src/custom/theme.css', 'repak-x/src/App.tsx'], false],
  [['README.md', 'release-notes/v0.42.0.md'], false],
  [['repak-x/src/main_tauri.rs'], true],
  [['repak-x/src/custom/version.ts'], true], // xtra_update.rs embeds it
  [['repak-x/src/data/character_data.json'], true], // character_data.rs embeds it
  [['repak-x/tauri.conf.json'], true],
  [['.github/workflows/checks.yml'], true],
  [['Cargo.lock'], true],
  [['repak-x/src/App.tsx', 'repak-x/src/xtra_bundle.rs'], true],
  [[], true],
]
for (const [files, want] of cases) {
  if (needsRust(files, embedded) !== want) {
    console.error(`needs-rust self-check failed: ${JSON.stringify(files)} should give ${want}`)
    process.exit(1)
  }
}
if (!embedded.has('repak-x/src/custom/version.ts')) {
  console.error('needs-rust self-check failed: the embedded file scan found nothing (include_str! moved or the walk broke)')
  process.exit(1)
}

const files = readFileSync(0, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean)
const result = needsRust(files, embedded)
console.error(`${files.length} changed file(s); Rust ${result ? 'runs' : 'skipped'}${result ? '' : ' (all frontend-only)'}`)
for (const f of files) if (!frontendOnly(f, embedded)) console.error(`  needs Rust: ${f}`)
console.log(result ? 'true' : 'false')
