import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Checkbox from '../components/ui/Checkbox'
import { save } from '@tauri-apps/plugin-dialog'
import { writeFile } from '@tauri-apps/plugin-fs'
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
  for (const word of text.trim().split(/\s+/)) {
    const next = line ? `${line} ${word}` : word
    if (fits(next)) { line = next; continue }
    if (line) { lines.push(line); line = '' }
    for (const char of word) {
      if (line && !fits(line + char)) { lines.push(line); line = '' }
      line += char
    }
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
    void Promise.all([document.fonts.load('800 56px Geist'), document.fonts.load('500 28px Geist'), document.fonts.load('400 24px Geist'), portraitUrl ? portrait.decode().then(() => portrait).catch(() => null) : null]).then(([, , , icon]) => {
      if (!live || !canvas.current) return
      try {
        const c = canvas.current, ctx = c.getContext('2d')
        if (!ctx) throw new Error('Image drawing is unavailable.')
        const width = layout === 'wide' ? 1600 : 1200
        const wide = layout === 'wide'
        const panel = wide ? 880 : width, left = wide ? panel + 64 : 64
        const textWidth = width - left - 64
        const titleY = wide ? 64 : 736
        ctx.font = '500 28px Geist, sans-serif'
        const rows = keys.filter(k => selected.has(k)).map(k => ({
          name: imageLines(memberName(k), s => ctx.measureText(s).width <= textWidth),
          credit: credits[k]?.trim() || '',
        }))
        ctx.font = '800 56px Geist, sans-serif'
        const title = imageLines(l.name, s => ctx.measureText(s).width <= textWidth)
        ctx.font = '400 24px Geist, sans-serif'
        const heroes = imageLines(hero, s => ctx.measureText(s).width <= textWidth - (icon ? 56 : 0))
        const components = rows.map(row => ({ ...row, credit: imageLines(row.credit ? `by ${row.credit}` : '', s => ctx.measureText(s).width <= textWidth) }))
        const heroY = titleY + title.length * 64 + 20
        const start = heroY + Math.max(40, heroes.length * 32) + 56
        c.width = width
        c.height = Math.max(wide ? 900 : 1200, start + components.reduce((n, r) => n + r.name.length * 36 + r.credit.length * 30 + (r.credit.length ? 8 : 0) + 28, 0) + 112)
        ctx.fillStyle = '#111214'; ctx.fillRect(0, 0, c.width, c.height)
        const imageHeight = wide ? c.height : 672
        const crop = coverSize(picture.width, picture.height, panel, imageHeight)
        ctx.save(); ctx.beginPath(); ctx.rect(0, 0, panel, imageHeight); ctx.clip()
        ctx.drawImage(picture, crop.x, crop.y, crop.width, crop.height)
        ctx.restore()
        ctx.textBaseline = 'top'; ctx.fillStyle = '#f5f5f5'; ctx.font = '800 56px Geist, sans-serif'
        let y = titleY
        for (const line of title) { ctx.fillText(line, left, y); y += 64 }
        ctx.fillStyle = '#a4a5a8'; ctx.font = '400 24px Geist, sans-serif'
        if (icon) {
          ctx.drawImage(icon, left, heroY, 40, 40)
        }
        y = heroY + 4
        for (const line of heroes) { ctx.fillText(line, left + (icon ? 56 : 0), y); y += 32 }
        y = start
        for (const row of components) {
          ctx.font = '500 28px Geist, sans-serif'; ctx.fillStyle = '#e6e6e7'
          for (const line of row.name) { ctx.fillText(line, left, y); y += 36 }
          if (row.credit.length) y += 8
          ctx.font = '400 24px Geist, sans-serif'; ctx.fillStyle = '#929397'
          for (const line of row.credit) { ctx.fillText(line, left, y); y += 30 }
          y += 28
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
    <div className="modal-content li-dialog" role="dialog" aria-modal="true" aria-label="Share loadout card" tabIndex={-1} ref={focus.ref}
      onClick={e => e.stopPropagation()} onKeyDown={e => { focus.onKeyDown(e); if (e.key === 'Escape') { e.stopPropagation(); if (!busy) close() } }}>
      <div className="modal-header"><h2>Share loadout card</h2><button className="modal-close" aria-label="Close" disabled={busy} onClick={close}>×</button></div>
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

export default function useLoadoutImage(p: LoadoutProps, l: Loadout) {
  const [picture, setPicture] = useState<HTMLCanvasElement | null>(null)
  const open = () => {
    try {
      const media = [...document.querySelectorAll('.lp .lp-media .lo-card-image img, .lp .lp-media .lo-card-image video')]
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
  return { open, dialog: picture && createPortal(<Editor p={p} l={l} picture={picture} close={() => setPicture(null)} />, document.body) }
}

if (import.meta.env.DEV) {
  console.assert(JSON.stringify(imageLines('abcdef', s => s.length <= 3)) === '["abc","def"]', 'Long names wrap without losing text')
  console.assert(imageLines('  ', () => true).length === 0, 'Empty credits produce no lines')
  console.assert(JSON.stringify(imageLines('Midnight Panther', s => s.length <= 12)) === '["Midnight","Panther"]', 'Names wrap at word boundaries')
  const filled = coverSize(1600, 900, 700, 1200)
  console.assert(filled.height === 1200 && filled.width >= 700 && filled.x < 0 && filled.y === 0, 'Wide images fill portrait panels without padding')
}

