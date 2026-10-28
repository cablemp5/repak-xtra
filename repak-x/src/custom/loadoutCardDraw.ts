// repakxtra: draws a loadout's card (loadoutCard.ts cardModel) as a 1200x630 PNG in the app's dark look, with no network:
// its cover is taken from the picture its page's card shows right now (all blob or data URLs, so the canvas stays
// exportable), then copied to the clipboard or saved. Used from the loadout page's More menu.
import { save as pickSavePath } from '@tauri-apps/plugin-dialog'
import { APP_NAME } from './edition'
import { coverOf } from './previews'
import { type Loadout } from './loadoutStore'
import { type CardModel, cardModel, countText, type CardMod } from './loadoutCard'
import { typeClass } from './loadoutBits'
import { cue } from './sounds'

export const W = 1200, H = 630
const COVER_W = 560, X0 = 612, RIGHT = W - 48, BLUE = '#346bf1', MUTED = '#8f8f8f'
const NAMES_KEY = 'repakxtra.cardNames'

export const cardShowsNames = () => localStorage.getItem(NAMES_KEY) !== 'off'
export const setCardShowsNames = (on: boolean) => localStorage.setItem(NAMES_KEY, on ? 'on' : 'off')

type Ctx = CanvasRenderingContext2D
const font = (weight: number, size: number) => `${weight} ${size}px Geist, sans-serif`

/** `text` cut with an ellipsis to fit `max` px, by whole characters (an emoji never splits). */
function fit(ctx: Ctx, text: string, max: number) {
  if (ctx.measureText(text).width <= max) return text
  const c = [...text]
  while (c.length && ctx.measureText(`${c.join('').trimEnd()}…`).width > max) c.pop()
  return `${c.join('').trimEnd()}…`
}

/** Words in lines of at most `max` px, at most `lines` of them, the last cut with an ellipsis. */
function wrap(ctx: Ctx, text: string, max: number, lines: number) {
  const out: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word
    if (ctx.measureText(next).width <= max || !line) { line = next; continue }
    out.push(line); line = word
  }
  if (line) out.push(line)
  if (out.length > lines) { out.length = lines; out[lines - 1] = `${out[lines - 1]}…` }
  return out.map(l => fit(ctx, l, max))
}

/** Draws `src` to fill the box, cropped to keep its shape (CSS object-fit: cover). */
function cover(ctx: Ctx, src: CanvasImageSource & { width: number; height: number }, x: number, y: number, w: number, h: number, sw: number, sh: number) {
  if (!sw || !sh) return
  const s = Math.max(w / sw, h / sh), cw = w / s, ch = h / s
  ctx.drawImage(src, (sw - cw) / 2, (sh - ch) / 2, cw, ch, x, y, w, h)
}

const ready = (el: Element): el is HTMLImageElement | HTMLVideoElement =>
  el instanceof HTMLImageElement ? el.complete && el.naturalWidth > 0 : el instanceof HTMLVideoElement && el.readyState >= 2
const size = (el: HTMLImageElement | HTMLVideoElement) => (el instanceof HTMLImageElement ? [el.naturalWidth, el.naturalHeight] : [el.videoWidth, el.videoHeight])

/** The card's Lucide icon as an image in `color` (it draws in currentColor). */
function iconImage(svg: SVGElement, color: string) {
  const text = new XMLSerializer().serializeToString(svg).replace(/currentColor/g, color)
  const img = new Image()
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`
  return img.decode().then(() => img, () => null)
}

/** The left side: the picture the loadout's card shows (image, capture, preview or typed text), or a quiet panel. */
async function drawCover(ctx: Ctx, l: Loadout, model: CardModel) {
  ctx.fillStyle = '#141416'
  ctx.fillRect(0, 0, COVER_W, H)
  const card = document.querySelector('.lp-media .lo-card-image')
  const kind = coverOf(l)
  if (kind === 'text') {
    const bg = card?.querySelector('.caption-background img')
    if (bg && ready(bg)) {
      ctx.save()
      if (l.captionBlur) ctx.filter = 'blur(14px)'
      cover(ctx, bg, -20, -20, COVER_W + 40, H + 40, ...size(bg) as [number, number])
      ctx.restore()
      if (l.captionDark) { ctx.fillStyle = 'rgba(0, 0, 0, 0.45)'; ctx.fillRect(0, 0, COVER_W, H) }
    }
    const color = l.captionColor || '#ffffff'
    ctx.font = font(800, 46)
    const lines = l.caption?.trim() ? wrap(ctx, l.caption.trim(), COVER_W - 96, 4) : []
    const svg = card?.querySelector<SVGElement>('svg.lo-cap-icon')
    const icon = svg ? await iconImage(svg, color) : null
    const block = (icon ? 104 : 0) + lines.length * 56
    let y = (H - block) / 2
    if (icon) { ctx.drawImage(icon, (COVER_W - 88) / 2, y, 88, 88); y += 104 }
    ctx.fillStyle = color
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    for (const line of lines) { ctx.fillText(line, COVER_W / 2, y); y += 56 }
    ctx.textAlign = 'left'
    return
  }
  const shown = kind ? [...(card?.querySelectorAll('img, video') ?? [])].filter(el => !el.closest('.caption-background')).filter(ready) : []
  if (shown.length) {
    const w = COVER_W / shown.length // several previews on one slide sit side by side, as on the card
    shown.forEach((el, i) => cover(ctx, el, i * w, 0, w, H, ...size(el) as [number, number]))
    return
  }
  // No picture: the name's first letter, large and quiet
  ctx.fillStyle = '#26262b'
  ctx.font = font(800, 260)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText([...model.name][0]?.toUpperCase() ?? '', COVER_W / 2, H / 2 + 10)
  ctx.textAlign = 'left'
}

/** A mod type's badge color, as the Library draws its dot (theme.css *-badge). */
function dotColor(type: string) {
  const probe = document.createElement('span')
  probe.className = typeClass(type)
  document.body.appendChild(probe)
  const c = getComputedStyle(probe).getPropertyValue('--badge-dot').trim()
  probe.remove()
  return c || MUTED
}

export async function drawCard(l: Loadout, mods: CardMod[], showNames: boolean, now = new Date()): Promise<Blob> {
  const model = cardModel(l, mods, { showNames }, now)
  await Promise.all([font(800, 56), font(600, 22), font(400, 22)].map(f => document.fonts.load(f)))
  const canvas = document.createElement('canvas')
  canvas.width = W; canvas.height = H
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#0c0c0e'
  ctx.fillRect(0, 0, W, H)
  await drawCover(ctx, l, model)
  // the picture fades into the page, like a card on the dark theme
  const fade = ctx.createLinearGradient(COVER_W - 120, 0, COVER_W, 0)
  fade.addColorStop(0, 'rgba(12, 12, 14, 0)'); fade.addColorStop(1, 'rgba(12, 12, 14, 1)')
  ctx.fillStyle = fade
  ctx.fillRect(COVER_W - 120, 0, 120, H)

  const width = RIGHT - X0
  ctx.textBaseline = 'alphabetic'
  let y = 84
  if (model.label) { ctx.font = font(500, 22); ctx.fillStyle = MUTED; ctx.fillText(fit(ctx, model.label, width), X0, y); y += 52 } else y += 20
  ctx.font = font(800, 56); ctx.fillStyle = '#ffffff'
  for (const line of wrap(ctx, model.name, width, 2)) { ctx.fillText(line, X0, y); y += 64 }

  // "12 mods" then a dot and count per kind, wrapping inside the column
  y += 6
  ctx.font = font(600, 22); ctx.fillStyle = '#ffffff'
  const total = `${model.total} ${model.total === 1 ? 'mod' : 'mods'}`
  ctx.fillText(total, X0, y)
  let x = X0 + ctx.measureText(total).width + 22
  ctx.font = font(400, 22)
  for (const c of model.counts) {
    const t = countText(c), w = 16 + ctx.measureText(t).width
    if (x + w > RIGHT) { x = X0; y += 34 }
    ctx.fillStyle = dotColor(c.type)
    ctx.beginPath(); ctx.arc(x + 4, y - 7, 4.5, 0, Math.PI * 2); ctx.fill()
    ctx.fillStyle = '#d4d4d4'; ctx.fillText(t, x + 16, y)
    x += w + 22
  }

  y += 50
  ctx.font = font(400, 22)
  if (!model.total) { ctx.fillStyle = MUTED; ctx.fillText('No mods yet', X0, y) }
  for (const n of model.names) { ctx.fillStyle = '#bdbdbd'; ctx.fillText(fit(ctx, n, width), X0, y); y += 32 }
  if (model.more) { ctx.fillStyle = MUTED; ctx.fillText(`+${model.more} more`, X0, y) }

  // the app's name in its wordmark look and the day the card was made
  ctx.font = font(800, 30)
  // the whole word in blue, then "repak" in white over it: the font's own spacing between the two parts holds
  ctx.fillStyle = BLUE; ctx.fillText(APP_NAME, X0, H - 44)
  ctx.save()
  ctx.beginPath(); ctx.rect(X0 - 4, H - 90, ctx.measureText(APP_NAME.slice(0, 5)).width + 4, 60); ctx.clip()
  ctx.fillStyle = '#ffffff'; ctx.fillText(APP_NAME, X0, H - 44)
  ctx.restore()
  ctx.font = font(400, 20); ctx.fillStyle = MUTED; ctx.textAlign = 'right'
  ctx.fillText(model.date, RIGHT, H - 44)
  ctx.textAlign = 'left'

  return new Promise((ok, fail) => canvas.toBlob(b => (b ? ok(b) : fail(new Error('The card could not be encoded'))), 'image/png'))
}

type Alert = { success: (t: string, d?: string) => unknown; warning: (t: string, d?: string) => unknown }
const fileName = (name: string) => name.replace(/[<>:"/\\|?*]+/g, '_').trim() || 'loadout'

/** Puts the card on the clipboard as a PNG (WebView2 allows image/png, checked 2026-10-28). */
export async function copyCard(l: Loadout, mods: CardMod[], alert: Alert) {
  try {
    // drawn first: handing WebView2 the drawing's promise instead makes it ask for clipboard permission (2026-10-28)
    const png = await drawCard(l, mods, cardShowsNames())
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
    cue('success', { emphasis: 'subtle' })
    alert.success('Card copied', 'Paste it in Discord or anywhere that takes a picture.')
  } catch (e) {
    alert.warning('Card not copied', `${String(e)}. Save it as an image instead.`)
  }
}

/** Saves the card where the user picks (the browser preview downloads it). */
export async function saveCard(l: Loadout, mods: CardMod[], alert: Alert) {
  try {
    const blob = await drawCard(l, mods, cardShowsNames())
    const name = `${fileName(l.name)} card.png`
    if ((window as any).__mockBackend) { // the browser preview has no save dialog
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name })
      a.click(); URL.revokeObjectURL(a.href)
    } else {
      const dest = await pickSavePath({ title: `Save ${l.name}'s card`, defaultPath: name, filters: [{ name: 'PNG image', extensions: ['png'] }] })
      if (!dest) return
      const { writeFile } = await import('@tauri-apps/plugin-fs')
      await writeFile(dest, new Uint8Array(await blob.arrayBuffer()))
      cue('success', { emphasis: 'subtle' })
      alert.success('Card saved', dest.split(/[/\\]/).pop())
      return
    }
    cue('success', { emphasis: 'subtle' })
    alert.success('Card saved', name)
  } catch (e) {
    alert.warning('Card not saved', String(e))
  }
}

/** The page's More menu items: copy, save, and the Show mod names switch (Hick's law: two actions, one setting). */
export const cardItems = (l: Loadout, mods: CardMod[], alert: Alert, rerender: () => void) => [
  { label: 'Copy loadout card', onClick: () => void copyCard(l, mods, alert) },
  { label: 'Save loadout card as image', onClick: () => void saveCard(l, mods, alert) },
  { label: 'Show mod names on card', checked: cardShowsNames(), onClick: () => { setCardShowsNames(!cardShowsNames()); rerender() } },
]
