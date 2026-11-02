// repakxtra: swaps react-icons / @mui/icons-material imports for Lucide at build time, so upstream
// components keep their imports untouched. Each swapped module re-exports the original package, then
// overrides the mapped names (local exports win over `export *`). Every lucide-react import (the app's own and these swapped
// modules') goes to lucideRivals.tsx (Lucide plus the game's shield and warning icons), or to phosphor.tsx with set.ts on 'phosphor'.
import type { Plugin } from 'vite'
import { REACT_ICONS, MUI_ICONS } from './map'
import { ICON_SET } from './set'

const PREFIX = '\0lucide-swap:'

export default function lucideSwap(): Plugin {
  return {
    name: 'lucide-swap',
    enforce: 'pre',
    resolveId(id, importer) {
      // the icon files' own lucide-react imports reach the real package (fallback names and types)
      if (id === 'lucide-react' && !/\/custom\/icons\/(phosphor|lucideRivals)\.tsx$/.test(importer?.replace(/\\/g, '/') ?? '')) {
        return this.resolve(`/src/custom/icons/${ICON_SET === 'phosphor' ? 'phosphor' : 'lucideRivals'}.tsx`, importer, { skipSelf: true })
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
      // MUI names are all mapped (the package is gone): an unmapped one fails the build instead of pulling MUI back in
      const lines = [...(mui ? [] : [`export * from '${source}'`]), `import { ${wrap} } from '/src/custom/icons/wrap.tsx'`]
      for (const [name, lucide] of Object.entries(map)) {
        lines.push(`import { ${lucide} as L_${name} } from 'lucide-react'`, `export const ${name} = ${wrap}(L_${name})`)
      }
      return lines.join('\n')
    },
  }
}
