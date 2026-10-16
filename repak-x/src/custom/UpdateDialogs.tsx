// repakxtra: the app update dialog and the "What's new" dialog, replacing Repak X's UpdateAppModal and ChangelogModal
// (App.tsx imports these instead; same props). Same build as Setup and Capture: hairline sections, 32px buttons, no emoji.
// Release notes render GitHub-style markdown: headings, "-" or "*" bullets, **bold**, `code` and links. GitHub's generated
// notes lose their "by @user in <PR link>" tails and the "Full Changelog" line, which read as noise in the app.
import { type ReactNode, useEffect } from 'react'
import { motion } from 'framer-motion'
import { Check, Download, ExternalLink } from 'lucide-react'
import { REPAKXTRA_VERSION } from './version'
import './updates.css'

const openUrl = (url: string) => import('@tauri-apps/plugin-shell').then(m => m.open(url)).catch(() => window.open(url, '_blank'))

type Block = { kind: 'h' | 'li' | 'p'; text: string }

/** Release notes as headings, bullets and paragraphs, without GitHub's generated-notes noise. */
export function parseNotes(raw: string): Block[] {
  const out: Block[] = []
  for (const line of raw.replace(/\r/g, '').split('\n')) {
    const t = line.trim()
    if (!t || /^(\*\*)?Full Changelog(\*\*)?:/i.test(t) || t.startsWith('<!--')) continue
    const h = t.match(/^#{1,6}\s+(.*)$/)
    if (h) {
      if (!/^what'?s changed$/i.test(h[1].trim())) out.push({ kind: 'h', text: h[1] })
      continue
    }
    const li = t.match(/^[-*+]\s+(.*)$/)
    out.push({ kind: li ? 'li' : 'p', text: (li ? li[1] : t).replace(/\s+by @[\w-]+ in https?:\/\/\S+$/, '') })
  }
  return out
}

/** **bold**, `code`, [text](url) and bare links (opened in the browser). */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|https?:\/\/[^\s)]+)/g).filter(Boolean).map((part, i) => {
    if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) return <strong key={i}>{part.slice(2, -2)}</strong>
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) return <code key={i}>{part.slice(1, -1)}</code>
    const link = part.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/)
    if (link || /^https?:\/\//.test(part)) {
      const url = link ? link[2] : part
      return <a key={i} onClick={() => openUrl(url)} title={url}>{link ? link[1] : url}</a>
    }
    return part
  })
}

export function ReleaseNotes({ text }: { text: string }) {
  const blocks = parseNotes(text)
  const out: ReactNode[] = []
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    if (b.kind === 'li') {
      const items: Block[] = []
      while (i < blocks.length && blocks[i].kind === 'li') items.push(blocks[i++])
      i--
      out.push(<ul key={out.length}>{items.map((x, k) => <li key={k}>{inline(x.text)}</li>)}</ul>)
    } else out.push(b.kind === 'h' ? <h3 key={out.length}>{inline(b.text)}</h3> : <p key={out.length}>{inline(b.text)}</p>)
  }
  return out.length ? <div className="upd-notes">{out}</div> : <p className="upd-sub">No release notes for this version.</p>
}

function useEscape(onClose: () => void) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', esc, true)
    return () => window.removeEventListener('keydown', esc, true)
  })
}

type UpdateInfo = { latest?: string; url?: string; asset_url?: string; changelog?: string; [key: string]: unknown }

/** A newer repakxtra release: its notes, then Download, then Install and restart (the backend's updater does the rest). */
export function UpdateModal({ isOpen, updateInfo, downloadProgress, downloadedPath, onDownload, onApply, onOpenReleasePage, onClose }: {
  isOpen: boolean
  updateInfo: UpdateInfo | null
  downloadProgress: { status?: string; percentage?: number } | null
  downloadedPath: string | null
  onDownload: () => void
  onApply: () => void
  onOpenReleasePage: (url: string) => void
  onClose: () => void
}) {
  useEscape(onClose)
  if (!isOpen || !updateInfo) return null
  const downloading = downloadProgress?.status === 'downloading'
  const ready = downloadProgress?.status === 'ready' || Boolean(downloadedPath)
  const pct = Math.max(0, Math.round(downloadProgress?.percentage ?? 0))
  return (
    <div className="modal-overlay" onClick={onClose}>
      <motion.div className="modal-content upd-modal" role="dialog" aria-label="Update available" onClick={e => e.stopPropagation()}
        initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.15 }}>
        <div className="modal-header">
          <div>
            <h2>{ready ? 'Ready to install' : 'Update available'}</h2>
            <p className="upd-sub">repakxtra v{updateInfo.latest} · you have v{REPAKXTRA_VERSION}</p>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-body upd-body">
          {ready
            ? <p className="upd-ready"><Check size={16} aria-hidden="true" />Downloaded. Install and restart closes repakxtra, updates it and opens v{updateInfo.latest}.</p>
            : downloading
              ? (
                <div className="upd-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                  <div className="upd-bar"><i style={{ width: `${pct}%` }} /></div>
                  <span>{pct}%</span>
                </div>
              )
              : <ReleaseNotes text={updateInfo.changelog || ''} />}
        </div>
        <div className="modal-footer upd-footer">
          {!ready && !downloading && updateInfo.url && (
            <button type="button" className="lo-text-btn upd-left" onClick={() => onOpenReleasePage(updateInfo.url || '')}><ExternalLink size={14} /> View release</button>
          )}
          <button type="button" className="lo-text-btn" onClick={onClose}>Later</button>
          {ready
            ? <button type="button" className="btn-primary" onClick={onApply}>Install and restart</button>
            : updateInfo.asset_url && <button type="button" className="btn-primary" disabled={downloading} onClick={onDownload}>
                <Download size={14} /> {downloading ? 'Downloading…' : 'Download update'}</button>}
        </div>
      </motion.div>
    </div>
  )
}

/** "What's new": the release notes of a version (after an update, or Settings > View changelog). */
export function WhatsNewModal({ isOpen, version, changelog, onClose }: { isOpen: boolean; version: string; changelog: string; onClose: () => void }) {
  useEscape(onClose)
  if (!isOpen) return null
  return (
    <div className="modal-overlay" onClick={onClose}>
      <motion.div className="modal-content upd-modal" role="dialog" aria-label="What's new" onClick={e => e.stopPropagation()}
        initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.15 }}>
        <div className="modal-header">
          <div>
            <h2>What's new</h2>
            <p className="upd-sub">repakxtra v{version.replace(/^v/, '')}</p>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-body upd-body"><ReleaseNotes text={changelog} /></div>
        <div className="modal-footer upd-footer">
          <button type="button" className="btn-primary" onClick={onClose}>Done</button>
        </div>
      </motion.div>
    </div>
  )
}

if (import.meta.env.DEV) {
  const gen = parseNotes("## What's Changed\n* Sidebar fixes by @someone in https://github.com/x/y/pull/14\n\n**Full Changelog**: https://github.com/x/y/compare/a...b")
  console.assert(gen.length === 1 && gen[0].kind === 'li' && gen[0].text === 'Sidebar fixes', 'parseNotes: generated notes', gen)
  const hand = parseNotes('Intro line\n## New\n- **Loadouts:** one click\n- Second')
  console.assert(hand.map(b => b.kind).join() === 'p,h,li,li' && hand[2].text === '**Loadouts:** one click', 'parseNotes: hand-written', hand)
}
