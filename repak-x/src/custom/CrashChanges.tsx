// repakxtra: a crash's What changed? (Settings > Crash reports): the changes since the game launch before the one that
// crashed, through that crash and never after it (crashTimeline.ts). The same fold and timeline look as the row's
// Details from the game's log (CrashLog.tsx): newest first, the latest few, Show all for the rest.
import { useState } from 'react'
import { ChevronRight, History } from 'lucide-react'
import { NOT_A_CAUSE, coverageText, crashTimeline, timelineRows, whenText, type Timeline } from './crashTimeline'

const FEW = 5

export default function CrashChanges({ id }: { id: string }) {
  const [open, setOpen] = useState(false)
  const [all, setAll] = useState(false)
  // read when first opened, then kept: it is history, it does not change under the row
  const [t, setT] = useState<Timeline | null | undefined>(undefined)
  const toggle = () => {
    if (!open && t === undefined) void crashTimeline(id).then(setT)
    setOpen(!open)
  }
  const rows = t ? timelineRows(t) : []
  const note = t === undefined ? null : coverageText(t, rows.length)
  const shown = all ? rows : rows.slice(0, FEW)
  const hasChanges = rows.some(r => r.text !== 'Started the game')
  return (
    <>
      <button type="button" className="su-trust-btn crl-toggle" aria-expanded={open} aria-controls={`crc-${id}`} onClick={toggle}>
        <ChevronRight size={14} className="su-caret" aria-hidden="true" />What changed?
      </button>
      <div id={`crc-${id}`} className="t-acc-panel" data-open={open} ref={el => el?.toggleAttribute('inert', !open)}>
        <div className="t-acc-panel-inner">
          <div className="crl-body">
            <section className="crl-part" aria-label="Changes before this crash">
              <h4 className="crl-label"><History size={14} aria-hidden="true" />Changes before this crash</h4>
              {t === undefined ? <p className="crl-more">Reading…</p> : <>
                {note && <p className="crl-more">{note}</p>}
                {hasChanges && (
                  <ul className="crl-events crc-events">
                    {shown.map((r, i) => (
                      <li key={i} className={r.text === 'Started the game' ? 'crc-launch' : undefined}>
                        <span className="crl-secs">{whenText(r.t)}</span>
                        <span className="crl-dot" data-kind={r.problem ? 'problem' : r.text === 'Started the game' ? 'launch' : undefined} aria-hidden="true" />
                        <span>{r.text}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {hasChanges && rows.length > FEW && (
                  <button type="button" className="su-trust-btn crl-names-btn crc-all" aria-expanded={all} onClick={() => setAll(!all)}>
                    <ChevronRight size={14} className="su-caret" aria-hidden="true" />{all ? 'Show fewer' : `Show all ${rows.length}`}
                  </button>
                )}
                {hasChanges && <p className="crl-more">{NOT_A_CAUSE}</p>}
              </>}
            </section>
          </div>
        </div>
      </div>
    </>
  )
}
