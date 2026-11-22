// repakxtra: optional notes for Copy setup report (Settings > Help & Community): a fold under the Setup report row with
// two short fields. Copying stays one click: CopySetupReport reads what is typed here, in Settings or in Setup, and the
// notes go at the top of the report. Kept for this session only.
import { useState } from 'react'
import { ChevronRight } from 'lucide-react'

export const reportNotes = { trying: '', instead: '' }

export default function ReportNotes() {
  const [open, setOpen] = useState(false)
  const [notes, setNotes] = useState(reportNotes)
  const set = (key: keyof typeof reportNotes) => (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    reportNotes[key] = e.target.value
    setNotes({ ...reportNotes })
  }
  return (
    <div className="rpn">
      <button type="button" className="su-trust-btn crl-toggle" aria-expanded={open} aria-controls="rpn-fields" onClick={() => setOpen(!open)}>
        <ChevronRight size={14} className="su-caret" aria-hidden="true" />Add what happened (optional)
      </button>
      <div id="rpn-fields" className="t-acc-panel" data-open={open} ref={el => el?.toggleAttribute('inert', !open)}>
        <div className="t-acc-panel-inner">
          <div className="rpn-fields">
            <label className="rpn-field">
              <span className="rpn-label">What were you trying to do?</span>
              <textarea rows={2} maxLength={400} value={notes.trying} onChange={set('trying')} placeholder="Play as Black Panther with my new skin" />
            </label>
            <label className="rpn-field">
              <span className="rpn-label">What happened instead?</span>
              <textarea rows={2} maxLength={400} value={notes.instead} onChange={set('instead')} placeholder="The default skin showed, or the game crashed at the menu" />
            </label>
            <p className="setting-subtext">Copy setup report puts these at the top. Folder paths are taken out.</p>
          </div>
        </div>
      </div>
    </div>
  )
}
