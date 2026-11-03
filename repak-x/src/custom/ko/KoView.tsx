// repakxtra: the KO Editor's code (its renderer, color picker and export) loads the first time its view opens, not with
// the app: most launches never open it.
import { lazy, Suspense, useState } from 'react'
import type { KoEditorProps } from './KoEditor'
import { useView } from '../loadoutStore'

const KoEditor = lazy(() => import('./KoEditor'))

export default function KoView(p: KoEditorProps) {
  const shown = useView() === 'ko'
  const [seen, setSeen] = useState(shown)
  if (shown && !seen) setSeen(true)
  return seen ? <Suspense fallback={null}><KoEditor {...p} /></Suspense> : null
}
