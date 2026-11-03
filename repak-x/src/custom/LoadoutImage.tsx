import { useEffect, useRef, useState } from 'react'
import { save } from '@tauri-apps/plugin-dialog'
import { writeFile } from '@tauri-apps/plugin-fs'
import { ImageDown } from 'lucide-react'
import type { LoadoutProps } from './Loadouts'
import { type Loadout, displayName, memberName, modsByKey } from './loadoutStore'
import { loadoutHero } from './silhouettes'
import { useDialogFocus } from './dialogFocus'
import './loadoutImage.css'

// Split even unbroken names, so user text never escapes the exported image.
export function imageLines(text: string, fits: (s: string) => boolean): string[] {
  const lines: string[] = []
  let line = ''
  for (const char of text.replace(/\s+/g, ' ').trim()) {
    if (line && !fits(line + char)) { lines.push(line.trim()); line = '' }
    line += char
  }
  if (line.trim()) lines.push(line.trim())
  return lines
}

function Editor({ p, l, picture, close }: { p: LoadoutProps; l: Loadout; picture: HTMLCanvasElement; close: () => void }) {
  const focus = useDialogFocus()
  const canvas = useRef<HTMLCanvasElement>(null)
  const [layout, setLayout] = useState<'wide' | 'square'>('wide')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const keys = [...new Set(l.on.map(displayName))]
  const [selected, setSelected] = useState(() => new Set(keys))
  const [credits, setCredits] = useState<Record<string, string>>({})
  const hero = loadoutHero(l.on, p.mods, p.modDetails) || 'Custom loadout'
  const byKey = modsByKey(p.mods)
  useEffect(() => {
    let live = true
    setError('')
    void document.fonts.ready.then(() => {
      if (!live || !canvas.current) return
      try {
        const c = canvas.current, ctx = c.getContext('2d')
        if (!ctx) throw new Error('Image drawing is unavailable.')
        const width = layout === 'wide' ? 1600 : 1200
        const left = layout === 'wide' ? 840 : 660, textWidth = width - left - 64
        ctx.font = '500 24px Geist, sans-serif'
        const rows = keys.filter(k => selected.has(k)).map(k => {
          const mod = byKey.get(k), category = mod && p.modDetails?.[mod.path]?.category
          return imageLines(`${memberName(k)}${category ? ` (${category})` : ''}${credits[k]?.trim() ? ` / ${credits[k].trim()}` : ''}`, s => ctx.measureText(s).width <= textWidth)
        })
        ctx.font = '800 48px Geist, sans-serif'
        const title = imageLines(l.name, s => ctx.measureText(s).width <= textWidth)
        const heroes = imageLines(hero, s => { ctx.font = '500 24px Geist, sans-serif'; return ctx.measureText(s).width <= textWidth })
        const start = 118 + title.length * 56 + heroes.length * 32 + 44
        c.width = width
        c.height = Math.max(layout === 'wide' ? 900 : 1200, start + rows.reduce((n, r) => n + r.length * 32 + 24, 0) + 80)
        ctx.fillStyle = '#101217'; ctx.fillRect(0, 0, c.width, c.height)
        ctx.fillStyle = '#191d26'; ctx.fillRect(32, 32, left - 64, c.height - 64)
        const scale = Math.min((left - 96) / picture.width, (c.height - 96) / picture.height)
        ctx.drawImage(picture, (left - picture.width * scale) / 2, (c.height - picture.height * scale) / 2, picture.width * scale, picture.height * scale)
        ctx.fillStyle = '#346bf1'; ctx.fillRect(left, 64, 48, 5)
        ctx.textBaseline = 'top'; ctx.fillStyle = '#f7f8fa'; ctx.font = '800 48px Geist, sans-serif'
        let y = 100
        for (const line of title) { ctx.fillText(line, left, y); y += 56 }
        ctx.font = '500 24px Geist, sans-serif'; ctx.fillStyle = '#aab4c7'; y += 18
        for (const line of heroes) { ctx.fillText(line, left, y); y += 32 }
        y += 44
        for (const row of rows) {
          ctx.fillStyle = '#e0e5ee'
          for (const line of row) { ctx.fillText(line, left, y); y += 32 }
          y += 24
        }
        ctx.font = '500 18px Geist, sans-serif'; ctx.fillStyle = '#8792a6'
        ctx.fillText('MY LOADOUT', left, c.height - 48)
      } catch (e) { setError(String(e)) }
    })
    return () => { live = false }
  }, [layout, selected, credits, l.name, hero, picture])
  const download = async () => {
    if (!canvas.current || busy || error) return
    setBusy(true)
    try {
      const blob = await new Promise<Blob>((resolve, reject) => canvas.current!.toBlob(b => b ? resolve(b) : reject(new Error('Could not encode image.')), 'image/png'))
      const path = await save({ defaultPath: `${l.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'loadout'}.png`, filters: [{ name: 'PNG image', extensions: ['png'] }] })
      if (path) { await writeFile(path, new Uint8Array(await blob.arrayBuffer())); p.alert.success('Loadout image saved', path) }
    } catch (e) { p.alert.warning('Image not saved', String(e)) }
    finally { setBusy(false) }
  }
  return <div className="modal-overlay" onClick={() => !busy && close()}>
    <div className="modal-content li-dialog" role="dialog" aria-modal="true" aria-label="Share loadout image" tabIndex={-1} ref={focus.ref}
      onClick={e => e.stopPropagation()} onKeyDown={e => { focus.onKeyDown(e); if (e.key === 'Escape') { e.stopPropagation(); if (!busy) close() } }}>
      <div className="modal-header"><h2>Share loadout image</h2><button className="modal-close" aria-label="Close" disabled={busy} onClick={close}>×</button></div>
      <div className="li-body">
        <div className="mod-state-filter" role="group" aria-label="Image layout">
          <button aria-pressed={layout === 'wide'} onClick={() => setLayout('wide')}>Wide</button>
          <button aria-pressed={layout === 'square'} onClick={() => setLayout('square')}>Square</button>
        </div>
        <canvas ref={canvas} className="li-preview" aria-label="Loadout image preview" role="img" />
        {error && <p role="alert">{error}</p>}
        <p>Select components and add creator credits where you know them. Long lists expand the image to keep every credit readable.</p>
        {keys.map(k => <div className="li-component" key={k}>
          <label><input type="checkbox" checked={selected.has(k)} onChange={() => setSelected(s => { const next = new Set(s); if (next.has(k)) next.delete(k); else next.add(k); return next })} />{memberName(k)}</label>
          <input value={credits[k] || ''} aria-label={`Creator credit for ${memberName(k)}`} placeholder="Creator credit (optional)" onChange={e => setCredits(c => ({ ...c, [k]: e.target.value }))} />
        </div>)}
      </div>
      <div className="modal-footer"><button className="btn-primary" disabled={busy || Boolean(error)} onClick={download}>{busy ? 'Saving...' : 'Save PNG'}</button></div>
    </div>
  </div>
}

export default function LoadoutImage({ p, l }: { p: LoadoutProps; l: Loadout }) {
  const [picture, setPicture] = useState<HTMLCanvasElement | null>(null)
  const open = (button: HTMLButtonElement) => {
    try {
      const media = [...(button.closest('.lp')?.querySelectorAll('.lp-media .lo-card-image img, .lp-media .lo-card-image video') ?? [])]
        .filter((el): el is HTMLImageElement | HTMLVideoElement => (el instanceof HTMLImageElement && el.complete && el.naturalWidth > 0) || (el instanceof HTMLVideoElement && el.readyState >= 2))
      if (!media.length) throw new Error('Choose a preview, capture, or image first. Wait for it to finish loading.')
      const c = document.createElement('canvas'); c.width = 1200; c.height = 1200
      const ctx = c.getContext('2d')
      if (!ctx) throw new Error('Image drawing is unavailable.')
      media.forEach((el, i) => {
        const w = el instanceof HTMLImageElement ? el.naturalWidth : el.videoWidth
        const h = el instanceof HTMLImageElement ? el.naturalHeight : el.videoHeight
        const cell = c.width / media.length, scale = Math.min(cell / w, c.height / h)
        ctx.drawImage(el, i * cell + (cell - w * scale) / 2, (c.height - h * scale) / 2, w * scale, h * scale)
      })
      setPicture(c)
    } catch (e) { p.alert.info('Choose a loadout picture', String(e)) }
  }
  return <><button type="button" className="lo-text-btn" onClick={e => open(e.currentTarget)}><ImageDown size={15} /> Share image</button>
    {picture && <Editor p={p} l={l} picture={picture} close={() => setPicture(null)} />}</>
}

if (import.meta.env.DEV) {
  console.assert(JSON.stringify(imageLines('abcdef', s => s.length <= 3)) === '["abc","def"]', 'Long names wrap without losing text')
  console.assert(imageLines('  ', () => true).length === 0, 'Empty credits produce no lines')
}
