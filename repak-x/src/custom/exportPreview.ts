import { useState } from 'react'
import { save } from '@tauri-apps/plugin-dialog'
import { writeFile } from '@tauri-apps/plugin-fs'
import type { LoadoutProps } from './Loadouts'

export function previewCanvas(root: ParentNode): HTMLCanvasElement {
  const media = [...root.querySelectorAll('.lp-media .lo-card-image img, .lp-media .lo-card-image video')]
    .filter((el): el is HTMLImageElement | HTMLVideoElement => !el.closest('.is-out') && (el instanceof HTMLImageElement || el instanceof HTMLVideoElement))
  if (!media.length) throw new Error('Choose a preview, capture, or image first.')
  const sizes = media.map(el => ({ w: el instanceof HTMLImageElement ? el.naturalWidth : el.videoWidth, h: el instanceof HTMLImageElement ? el.naturalHeight : el.videoHeight }))
  if (media.some((el, i) => !sizes[i].w || !sizes[i].h || (el instanceof HTMLImageElement ? !el.complete : el.readyState < 2))) {
    throw new Error('The preview is still loading. Try again when it appears.')
  }
  const canvas = document.createElement('canvas')
  const ratio = sizes.reduce((sum, size) => sum + size.w / size.h, 0)
  canvas.height = Math.max(1, Math.floor(Math.min(...sizes.map(size => size.h), 8192, 8192 / ratio)))
  canvas.width = Math.max(1, Math.round(canvas.height * ratio))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Image drawing is unavailable.')
  let x = 0
  media.forEach((el, i) => {
    const width = canvas.height * sizes[i].w / sizes[i].h
    ctx.drawImage(el, x, 0, width, canvas.height)
    x += width
  })
  return canvas
}

export function useExportPreview(name: string, alert: LoadoutProps['alert']) {
  const [busy, setBusy] = useState(false)
  const exportPng = async () => {
    if (busy) return
    setBusy(true)
    try {
      const canvas = previewCanvas(document)
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('Could not encode the preview.')), 'image/png'))
      const path = await save({ defaultPath: `${name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'loadout'}-preview.png`, filters: [{ name: 'PNG image', extensions: ['png'] }] })
      if (path) { await writeFile(path, new Uint8Array(await blob.arrayBuffer())); alert.success('Preview saved', path) }
    } catch (e) { alert.warning('Preview not saved', e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  return { busy, exportPng }
}
