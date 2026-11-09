// repakxtra: the Copy setup report button (Settings > Help & Community, and Setup). Text is built in setupReport.ts.
// While it reads it takes the header's Checking mods look: quiet, its icon and the pass (Reading setup, then Checking
// mods) shimmering together, shown only past 300 ms and then at least 400 ms.
import { useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Check, ClipboardCopy } from 'lucide-react'
import type { useAlert } from '../components/AlertHandler'
import { DISCORD_LIMIT, gatherReport, type ReportStage } from './setupReport'
import { useShownBusy } from './shownBusy'

type Alert = ReturnType<typeof useAlert>

const copy = (text: string) => navigator.clipboard.writeText(text).catch(() => invoke('copy_to_clipboard', { text }))

async function saveTxt(text: string, alert: Alert) {
  try {
    const { save } = await import('@tauri-apps/plugin-dialog')
    const target = await save({ defaultPath: 'repakxtra-setup-report.txt', filters: [{ name: 'Text', extensions: ['txt'] }] })
    if (!target) return
    const { writeFile } = await import('@tauri-apps/plugin-fs')
    await writeFile(target, new TextEncoder().encode(text.replace(/^```\n|\n```$/g, '')))
    alert.success('Setup report saved', 'Attach the .txt file to your Discord message.')
  } catch (e) {
    alert.warning('Not saved', String(e))
  }
}

export default function CopySetupReport({ alert, className = 'action-btn' }: { alert: Alert; className?: string }) {
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [stage, setStage] = useState<ReportStage>('setup')
  const spin = useShownBusy(busy)
  const run = async () => {
    if (busy) return // one report at a time: a second click never races the first to the clipboard
    setBusy(true)
    try {
      const text = await gatherReport(setStage)
      await copy(text)
      setCopied(true); setTimeout(() => setCopied(false), 3000)
      if (text.length <= DISCORD_LIMIT) {
        alert.success('Setup report copied', 'Paste it in your Discord help message.')
        return
      }
      const id = alert.info('Setup report copied', `It is ${text.length.toLocaleString()} characters, over Discord's ${DISCORD_LIMIT.toLocaleString()} limit. Save it as .txt and attach the file, or paste only the summary at the top.`, {
        duration: 15000,
        action: { label: 'Save as .txt', onClick: () => { alert.dismissAlert(id); saveTxt(text, alert) } },
      })
    } catch (e) {
      alert.warning('Setup report', `Could not copy it: ${String(e)}`)
    } finally {
      setBusy(false)
    }
  }
  return (
    <button type="button" className={`${className}${spin ? ' is-working' : ''}`} disabled={busy} onClick={run}
      title="Copies your setup and the mods that are on, ready to paste in a help channel. No folder paths or user name.">
      {spin
        ? <span key={stage} className="scan-status-in t-shimmer-all" role="status"><ClipboardCopy size={14} aria-hidden="true" />{stage === 'setup' ? 'Reading setup' : 'Checking mods'}</span>
        : <>{copied ? <Check size={14} /> : <ClipboardCopy size={14} />}{' '}
          <span key={copied ? 'copied' : 'idle'} className={copied ? 't-text-in' : undefined}>{copied ? 'Copied' : 'Copy setup report'}</span></>}
    </button>
  )
}
