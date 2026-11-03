import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Checkbox from '../components/ui/Checkbox'
import { save } from '@tauri-apps/plugin-dialog'
import { writeFile } from '@tauri-apps/plugin-fs'
import { Forward } from 'lucide-react'
import type { LoadoutProps } from './Loadouts'
import { type Loadout, displayName, memberName } from './loadoutStore'
import { loadoutHero } from './silhouettes'
import { useDialogFocus } from './dialogFocus'
import './loadoutImage.css'
import { REPAK, XTRA, LEFT, TOP, W, H } from './Wordmark'
import { resolveHeroImage, useHeroImages } from '../utils/heroImages'
import characters from '../data/character_data.json'

export function coverSize(w: number, h: number, width: number, height: number) {
  const scale = Math.max(width / w, height / h)
  return { x: (width - w * scale) / 2, y: 0, width: w * scale, height: h * scale }
}

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
  const [ready, setReady] = useState(false)
  const keys = [...new Set(l.on.map(displayName))]
  const [selected, setSelected] = useState(() => new Set(keys))
  const [credits, setCredits] = useState<Record<string, string>>({})
  const hero = loadoutHero(l.on, p.mods, p.modDetails) || 'Custom loadout'
  useHeroImages()
  const portraitUrl = resolveHeroImage(hero, characters)
  useEffect(() => {
    let live = true
    setError('')
    setReady(false)
    const portrait = new Image()
    if (portraitUrl) portrait.src = portraitUrl
    void Promise.all([document.fonts.load('800 48px Geist'), portraitUrl ? portrait.decode().then(() => portrait).catch(() => null) : null]).then(([, icon]) => {
      if (!live || !canvas.current) return
      try {
        const c = canvas.current, ctx = c.getContext('2d')
        if (!ctx) throw new Error('Image drawing is unavailable.')
        const width = layout === 'wide' ? 1600 : 1200
        const panel = layout === 'wide' ? 960 : 700, left = panel + 48, textWidth = width - left - 48
        ctx.font = '500 23px Geist, sans-serif'
        const rows = keys.filter(k => selected.has(k)).map(k => ({
          name: imageLines(memberName(k), s => ctx.measureText(s).width <= textWidth),
          credit: imageLines(credits[k]?.trim() ? `by ${credits[k].trim()}` : '', s => ctx.measureText(s).width <= textWidth),
        }))
        ctx.font = '800 46px Geist, sans-serif'
        const title = imageLines(l.name, s => ctx.measureText(s).width <= textWidth)
        ctx.font = '500 22px Geist, sans-serif'
        const heroes = imageLines(hero, s => ctx.measureText(s).width <= textWidth - (icon ? 64 : 0))
        const titleY = 48 + Math.max(48, heroes.length * 28) + 40
        const start = titleY + title.length * 54 + 44
        c.width = width
        c.height = Math.max(layout === 'wide' ? 900 : 1200, start + rows.reduce((n, r) => n + (r.name.length + r.credit.length) * 30 + 26, 0) + 120)
        ctx.fillStyle = '#111214'; ctx.fillRect(0, 0, c.width, c.height)
        const crop = coverSize(picture.width, picture.height, panel, c.height)
        ctx.save(); ctx.beginPath(); ctx.rect(0, 0, panel, c.height); ctx.clip()
        ctx.drawImage(picture, crop.x, crop.y, crop.width, crop.height)
        ctx.restore()
        ctx.textBaseline = 'top'; ctx.fillStyle = '#a4a5a8'; ctx.font = '500 22px Geist, sans-serif'
        if (icon) {
          ctx.save(); ctx.beginPath(); ctx.arc(left + 24, 72, 24, 0, Math.PI * 2); ctx.clip()
          ctx.drawImage(icon, left, 48, 48, 48); ctx.restore()
        }
        let y = 58
        for (const line of heroes) { ctx.fillText(line, left + (icon ? 64 : 0), y); y += 28 }
        ctx.fillStyle = '#f5f5f5'; ctx.font = '800 46px Geist, sans-serif'; y = titleY
        for (const line of title) { ctx.fillText(line, left, y); y += 54 }
        y += 44
        for (const row of rows) {
          ctx.font = '500 23px Geist, sans-serif'; ctx.fillStyle = '#e6e6e7'
          for (const line of row.name) { ctx.fillText(line, left, y); y += 30 }
          ctx.font = '400 20px Geist, sans-serif'; ctx.fillStyle = '#929397'
          for (const line of row.credit) { ctx.fillText(line, left, y); y += 30 }
          y += 26
        }
        const logoScale = 190 / W
        ctx.save(); ctx.translate(left - LEFT * logoScale, c.height - 48 - H * logoScale + TOP * logoScale); ctx.scale(logoScale, -logoScale)
        for (const [glyphs, color] of [[REPAK, '#f5f5f5'], [XTRA, '#346bf1']] as const) {
          ctx.fillStyle = color
          for (const [x, path] of glyphs) { ctx.save(); ctx.translate(x, 0); ctx.fill(new Path2D(path)); ctx.restore() }
        }
        ctx.restore()
        setReady(true)
      } catch (e) { setError(String(e)) }
    })
    return () => { live = false }
  }, [layout, selected, credits, l.name, hero, picture, portraitUrl])
  const download = async () => {
    if (!canvas.current || busy || error || !ready) return
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
          <Checkbox size="sm" aria-label={`Include ${memberName(k)}`} checked={selected.has(k)} onChange={() => setSelected(s => { const next = new Set(s); if (next.has(k)) next.delete(k); else next.add(k); return next })}>{memberName(k)}</Checkbox>
          <input value={credits[k] || ''} aria-label={`Creator credit for ${memberName(k)}`} placeholder="Creator credit (optional)" onChange={e => setCredits(c => ({ ...c, [k]: e.target.value }))} />
        </div>)}
      </div>
      <div className="modal-footer"><button className="btn-primary" disabled={busy || Boolean(error) || !ready} onClick={download}>{busy ? 'Saving...' : 'Save PNG'}</button></div>
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
      const sizes = media.map(el => ({ w: el instanceof HTMLImageElement ? el.naturalWidth : el.videoWidth, h: el instanceof HTMLImageElement ? el.naturalHeight : el.videoHeight }))
      const c = document.createElement('canvas')
      const ratio = sizes.reduce((sum, size) => sum + size.w / size.h, 0)
      c.height = Math.min(1600, Math.floor(8192 / ratio)); c.width = Math.round(c.height * ratio)
      const ctx = c.getContext('2d')
      if (!ctx) throw new Error('Image drawing is unavailable.')
      let x = 0
      media.forEach((el, i) => {
        const width = c.height * sizes[i].w / sizes[i].h
        ctx.drawImage(el, x, 0, width, c.height)
        x += width
      })
      setPicture(c)
    } catch (e) { p.alert.info('Choose a loadout picture', String(e)) }
  }
  return <><button type="button" className="lo-text-btn lo-icon li-share" title="Share loadout image" aria-label="Share loadout image" onClick={e => open(e.currentTarget)}><Forward size={16} aria-hidden="true" /></button>
    {picture && createPortal(<Editor p={p} l={l} picture={picture} close={() => setPicture(null)} />, document.body)}</>
}

if (import.meta.env.DEV) {
  console.assert(JSON.stringify(imageLines('abcdef', s => s.length <= 3)) === '["abc","def"]', 'Long names wrap without losing text')
  console.assert(imageLines('  ', () => true).length === 0, 'Empty credits produce no lines')
  const filled = coverSize(1600, 900, 700, 1200)
  console.assert(filled.height === 1200 && filled.width >= 700 && filled.x < 0 && filled.y === 0, 'Wide images fill portrait panels without padding')
}
