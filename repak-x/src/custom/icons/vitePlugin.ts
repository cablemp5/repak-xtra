// repakxtra: swaps react-icons / @mui/icons-material imports for Lucide at build time, so upstream
// components keep their imports untouched. Each swapped module re-exports the original package, then
// overrides the mapped names (local exports win over `export *`). With set.ts on 'phosphor', every lucide-react import
// (the app's own and these swapped modules') goes to phosphor.tsx instead.
import type { Plugin } from 'vite'
import { REACT_ICONS, MUI_ICONS } from './map'
import { ICON_SET } from './set'

const PREFIX = '\0lucide-swap:'

export default function lucideSwap(): Plugin {
  return {
    name: 'lucide-swap',
    enforce: 'pre',
    resolveId(id, importer) {
      // phosphor.tsx's own lucide-react import reaches the real package (its fallback names and types)
      if (id === 'lucide-react' && ICON_SET === 'phosphor' && !importer?.replace(/\\/g, '/').endsWith('/custom/icons/phosphor.tsx')) {
        return this.resolve('/src/custom/icons/phosphor.tsx', importer, { skipSelf: true })
      }
      if (importer?.startsWith(PREFIX)) return null // the swapped module itself reaches the real package
      const set = id.match(/^react-icons\/([a-z0-9]+)$/)?.[1]
      if ((set && REACT_ICONS[set]) || id === '@mui/icons-material') return PREFIX + id
      return null
    },
    load(id) {
      if (!id.startsWith(PREFIX)) return null
      const source = id.slice(PREFIX.length)
      const mui = source === '@mui/icons-material'
      const map = mui ? MUI_ICONS : REACT_ICONS[source.split('/')[1]]
      const wrap = mui ? 'muiIcon' : 'riIcon'
      const lines = [`export * from '${source}'`, `import { ${wrap} } from '/src/custom/icons/wrap.tsx'`]
      for (const [name, lucide] of Object.entries(map)) {
        lines.push(`import { ${lucide} as L_${name} } from 'lucide-react'`, `export const ${name} = ${wrap}(L_${name})`)
      }
      return lines.join('\n')
    },
  }
}
