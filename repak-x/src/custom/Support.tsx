import { useEffect, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { open } from '@tauri-apps/plugin-shell'
import { Heart, Star } from 'lucide-react'
import { modalOpen, useDialogFocus } from './dialogFocus'
import './support.css'

const COUNT = 'repakxtra.support.installs.v1'
const SHOWN = 'repakxtra.support.prompt.v1'
const KOFI = 'https://ko-fi.com/cablebp'
const REPO = 'https://github.com/cablemp5/repak-xtra'

/** Counts actual successful mods, including successes in a partly failed batch. No historical backfill. */
export function installCount(previous: number, successful: number) {
  return Math.min(10, Math.max(0, Number.isFinite(previous) ? previous : 0) + Math.max(0, Math.floor(Number.isFinite(successful) ? successful : 0)))
}

export function recordInstalls(store: Pick<Storage, 'getItem' | 'setItem'>, successful: number) {
  const count = installCount(Number(store.getItem(COUNT)), successful)
  store.setItem(COUNT, String(count))
  return count >= 10 && !store.getItem(SHOWN)
}

export default function Support() {
  const [pending, setPending] = useState(() => !localStorage.getItem(SHOWN) && Number(localStorage.getItem(COUNT)) >= 10)
  const [show, setShow] = useState(false)
  const dialog = useDialogFocus(show)
  const visit = (url: string) => { void open(url).catch(console.error) }
  useEffect(() => {
    const unlisten = listen<number>('xtra_mods_installed', e => {
      if (recordInstalls(localStorage, e.payload)) setPending(true)
    })
    return () => { void unlisten.then(stop => stop()) }
  }, [])
  useEffect(() => {
    if (!pending) return
    const timer = setInterval(() => {
      if (modalOpen()) return
      localStorage.setItem(SHOWN, '1')
      setPending(false)
      setShow(true)
    }, 500)
    return () => clearInterval(timer)
  }, [pending])
  return <>
    <button type="button" className="btn-settings" title="Support cablebp on Ko-fi" aria-label="Support cablebp on Ko-fi" onClick={() => visit(KOFI)}><Heart size={18} /></button>
    <button type="button" className="btn-settings" title="Star repak-xtra on GitHub" aria-label="Star repak-xtra on GitHub" onClick={() => visit(REPO)}><Star size={18} /></button>
    {show && <div className="modal-overlay support-overlay" onClick={() => setShow(false)}>
      <div {...dialog} role="dialog" aria-modal="true" aria-labelledby="support-title" tabIndex={-1} className="support-dialog" onClick={e => e.stopPropagation()}
        onKeyDown={e => { dialog.onKeyDown(e); if (e.key === 'Escape') setShow(false) }}>
        <h2 id="support-title">10 mods installed!</h2>
        <p>If repakxtra has been useful, you can support my work on Ko-fi or star the repository. Thank you for using it.</p>
        <div className="support-actions">
          <button type="button" className="lo-text-btn" onClick={() => visit(KOFI)}><Heart size={16} />Support on Ko-fi</button>
          <button type="button" className="lo-text-btn" onClick={() => visit(REPO)}><Star size={16} />Star on GitHub</button>
          <button type="button" className="lo-text-btn" onClick={() => setShow(false)}>Close</button>
        </div>
      </div>
    </div>}
  </>
}

if (import.meta.env.DEV) {
  console.assert(installCount(8, 3) === 10, 'a batch crosses ten once')
  console.assert(installCount(4, 0) === 4 && installCount(4, 2) === 6, 'only successful individual mods count')
  console.assert(installCount(NaN, 1) === 1 && installCount(0, -1) === 0, 'invalid counts are bounded')
  const values = new Map<string, string>()
  const store = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
  console.assert(!recordInstalls(store, 6) && !recordInstalls(store, 3), 'normal and quick installs share one counter')
  const restarted = { ...store }
  console.assert(recordInstalls(restarted, 1), 'the tenth new mod triggers after a restart')
  restarted.setItem(SHOWN, '1')
  console.assert(!recordInstalls(restarted, 5), 'the support prompt stays dismissed across restarts')
  values.clear()
  console.assert(!recordInstalls(store, 9) && !recordInstalls(store, 0) && recordInstalls(store, 1), 'one received bundle reaches ten; failed and cancelled receives add nothing')
}
