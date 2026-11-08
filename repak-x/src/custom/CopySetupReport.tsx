// repakxtra: the Copy setup report button (Settings > Help & Community, and Setup). Text is built in setupReport.ts.
import { useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Check, ClipboardCopy } from 'lucide-react'
import type { useAlert } from '../components/AlertHandler'
import { DISCORD_LIMIT, gatherReport } from './setupReport'

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
  const run = async () => {
    setBusy(true)
    try {
      const text = await gatherReport()
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
    <button type="button" className={className} disabled={busy} onClick={run}
      title="Copies your setup and the mods that are on, ready to paste in a help channel. No folder paths or user name.">
      {copied ? <Check size={14} /> : <ClipboardCopy size={14} />} {busy ? 'Copying…' : copied ? 'Copied' : 'Copy setup report'}
    </button>
  )
}
