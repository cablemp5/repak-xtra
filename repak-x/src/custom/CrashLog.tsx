// repakxtra: what the game's own engine log says about one crash (xtra_crash_log.rs), under its row in Settings > Crash
// reports: one grey line (where, as whom, the last event), and a Details fold with the last 10 seconds, the errors near
// the end, the mods the game loaded, and Copy log / Save log (the decrypted log with the player's ids taken out).
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Check, ChevronRight, CircleAlert, ClipboardCopy, Download, Package, Timer, TriangleAlert } from 'lucide-react'
import type { useAlert } from '../components/AlertHandler'
import { onKey } from './setupReport'
import { copyText } from './CopySetupReport'
import { useShownBusy } from './shownBusy'
import { nameKey } from './loadoutStore'
import { ModName } from './modName'

type Alert = ReturnType<typeof useAlert>
type Event = { secs: number; text: string; count: number; kind?: string }
type Summary = {
  map?: string | null; hero?: string | null; hero_id?: string | null
  events: Event[]; events_more?: number
  /** the newest event that is not a bot respawning (xtra_crash_log.rs) */
  headline?: Event | null
  errors: { text: string; count: number }[]; errors_more?: number
  mounted: string[]; iostore: number
  not_mounted?: string[] | null
}

const secs = (s: number) => `${s < 10 ? s.toFixed(1) : Math.round(s)} s`
/** "Practice Range as Namor. Triple kill 1.9 s before the crash." Pure. */
export function summaryLine(s: Summary): string {
  const hero = s.hero || (s.hero_id ? `hero ${s.hero_id}` : '')
  const where = s.map && hero ? `${s.map} as ${hero}` : s.map || (hero ? `As ${hero}` : '')
  const last = s.headline
  const what = last ? `${last.text}${last.count > 1 ? ` (${last.count} at once)` : ''} ${secs(last.secs)} before the crash` : ''
  return [where, what].filter(Boolean).map(t => `${t}.`).join(' ')
}

/** A mounted path under ~mods ("Sub/Cool_9999999_P") as the name the Library shows. */
const mountedName = (rel: string) => nameKey(`${rel}.pak`)

export default function CrashLog({ id, time, alert, modPaths }: { id: string; time: number; alert: Alert; modPaths: string[] }) {
  const [s, setS] = useState<Summary | null>(null)
  const [open, setOpen] = useState(false)
  const [names, setNames] = useState(false)
  const [copied, setCopied] = useState(false)
  // reading and redacting a long log takes a second or more: the button says it is working (Doherty)
  const [busy, setBusy] = useState<'copy' | 'pick' | 'save' | null>(null)
  const spin = useShownBusy(busy === 'copy' || busy === 'save')
  useEffect(() => {
    let live = true
    invoke<Summary | null>('xtra_crash_log_summary', { id }).then(r => { if (live) setS(r) }).catch(() => {})
    return () => { live = false }
  }, [id])
  if (!s) return null

  const logText = () => invoke<string>('xtra_crash_log_text', { id })
  const copy = async () => {
    if (busy) return
    setBusy('copy')
    try {
      await copyText(await logText())
      setCopied(true); setTimeout(() => setCopied(false), 3000)
      alert.success('Game log copied', 'Your user name, account ids, and login tokens were taken out.')
    } catch (e) { alert.warning('Not copied', String(e)) } finally { setBusy(null) }
  }
  const save = async () => {
    if (busy) return
    setBusy('pick') // both buttons off while the Save dialog is open, no working look
    try {
      const stamp = new Date(time * 1000).toISOString().slice(0, 16).replace(/[-:T]/g, '')
      const { save } = await import('@tauri-apps/plugin-dialog')
      const target = await save({ defaultPath: `marvel-rivals-crash-${stamp}.txt`, filters: [{ name: 'Text', extensions: ['txt'] }] })
      if (!target) return
      setBusy('save')
      const { writeFile } = await import('@tauri-apps/plugin-fs')
      await writeFile(target, new TextEncoder().encode(await logText()))
      alert.success('Game log saved', 'Your user name, account ids, and login tokens were taken out.')
    } catch (e) { alert.warning('Not saved', String(e)) } finally { setBusy(null) }
  }
  const byKey = new Map(modPaths.map(p => [onKey(p), p]))
  const missing = s.not_mounted ?? []
  const line = summaryLine(s)

  return (
    <>
      {line && <span className="rd-meta">{line}</span>}
      <button type="button" className="su-trust-btn crl-toggle" aria-expanded={open} aria-controls={`crl-${id}`} onClick={() => setOpen(!open)}>
        <ChevronRight size={14} className="su-caret" aria-hidden="true" />Details from the game's log
      </button>
      <div id={`crl-${id}`} className="t-acc-panel" data-open={open} ref={el => el?.toggleAttribute('inert', !open)}>
        <div className="t-acc-panel-inner">
          <div className="crl-body">
            {s.events.length > 0 && (
              <section className="crl-part" aria-label="Last 10 seconds">
                <h4 className="crl-label"><Timer size={14} aria-hidden="true" />Last 10 seconds</h4>
                {/* a timeline down to the crash: each kind of event has its dot color, the words say what it was */}
                <ul className="crl-events">
                  {s.events.map((e, i) => (
                    <li key={i}><span className="crl-secs">{secs(e.secs)}</span><span className="crl-dot" data-kind={e.kind} aria-hidden="true" /><span>{e.text}{e.count > 1 && <span className="lo-group-count crl-count" title={`${e.count} at once`}>{e.count}</span>}</span></li>
                  ))}
                  <li className="crl-crash"><span className="crl-secs">0.0 s</span><span className="crl-dot" aria-hidden="true" /><span>The game crashed</span></li>
                </ul>
                {!!s.events_more && <p className="crl-more">{s.events_more} earlier {s.events_more === 1 ? 'event' : 'events'} in the log</p>}
              </section>
            )}
            {s.errors.length > 0 && (
              <section className="crl-part" aria-label="Errors near the end">
                <h4 className="crl-label"><CircleAlert size={14} aria-hidden="true" />Errors in the last 30 seconds</h4>
                <ul className="crl-errors">
                  {s.errors.map((e, i) => <li key={i}><span className="lo-group-count crl-count" title={`${e.count} times`}>{e.count}</span><code>{e.text}</code></li>)}
                </ul>
                {!!s.errors_more && <p className="crl-more">{s.errors_more} more {s.errors_more === 1 ? 'kind' : 'kinds'} in the log</p>}
              </section>
            )}
            <section className="crl-part" aria-label="Mods the game loaded">
              <h4 className="crl-label"><Package size={14} aria-hidden="true" />Mods the game loaded</h4>
              <p className="crl-text">
                {s.mounted.length === 0 ? 'None.'
                  : s.mounted.length === 1 ? `1 mod${s.iostore ? ', an IoStore one' : ''}.`
                  : `${s.mounted.length} mods${s.iostore ? `, ${s.iostore} of them IoStore` : ''}.`}
                {s.not_mounted && !missing.length && s.mounted.length > 0 && ` Every mod that was on when the game started loaded.`}
                {s.mounted.length > 0 && (
                  <button type="button" className="su-trust-btn crl-names-btn" aria-expanded={names} onClick={() => setNames(!names)}>
                    <ChevronRight size={14} className="su-caret" aria-hidden="true" />{names ? 'Hide names' : 'Show names'}
                  </button>
                )}
              </p>
              {missing.length > 0 && (
                <p className="setting-warn crl-warn"><TriangleAlert size={14} aria-hidden="true" />
                  <span>On when the game started, but the game did not load {missing.length === 1 ? 'it' : 'them'}: {missing.map((k, i) => <span key={k}>{i ? ', ' : ''}<ModName name={nameKey(byKey.get(k) ?? `${k}.pak`)} /></span>)}</span>
                </p>
              )}
              {names && <ul className="crl-names">{s.mounted.map(m => <li key={m}><ModName name={mountedName(m)} /></li>)}</ul>}
            </section>
            <div className="crl-actions">
              <button type="button" className={`lo-text-btn${spin && busy === 'copy' ? ' is-working' : ''}`} disabled={busy !== null} onClick={copy} title={`Copies the game's log without your user name, account ids, or login tokens`}>
                {spin && busy === 'copy'
                  ? <span className="scan-status-in t-shimmer-all" role="status"><ClipboardCopy size={14} aria-hidden="true" />Copying</span>
                  : <>{copied ? <Check size={14} aria-hidden="true" /> : <ClipboardCopy size={14} aria-hidden="true" />}
                    <span key={copied ? 'copied' : 'idle'} className={copied ? 't-text-in' : undefined}>{copied ? 'Copied' : 'Copy log'}</span></>}
              </button>
              <button type="button" className={`lo-text-btn${spin && busy === 'save' ? ' is-working' : ''}`} disabled={busy !== null} onClick={save} title="Saves the game's log as a .txt to send to a modder or support">
                {spin && busy === 'save'
                  ? <span className="scan-status-in t-shimmer-all" role="status"><Download size={14} aria-hidden="true" />Saving</span>
                  : <><Download size={14} aria-hidden="true" /> Save log</>}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

if (import.meta.env.DEV) {
  const base = { events: [], errors: [], mounted: [], iostore: 0 }
  console.assert(summaryLine({ ...base, map: 'Practice Range', hero: 'Namor', headline: { secs: 1.853, text: 'Triple kill', count: 1 } }) === 'Practice Range as Namor. Triple kill 1.9 s before the crash.', 'where, who, and the event to name')
  console.assert(summaryLine({ ...base, map: 'Practice Range', headline: { secs: 3, text: 'A bot died', count: 3 } }) === 'Practice Range. A bot died (3 at once) 3.0 s before the crash.', 'how many at once')
  console.assert(summaryLine({ ...base, hero_id: '1099' }) === 'As hero 1099.', 'an unknown hero by id')
  console.assert(summaryLine(base) === '', 'nothing known: no line')
  console.assert(mountedName('Sub/Cool_9999999_P') === nameKey('Sub/Cool_9999999_P.pak'), 'a mounted path names the mod as the Library does')
}
