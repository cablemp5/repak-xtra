// repakxtra: Settings > Help & Community > Is repakxtra safe?: what repakxtra does, what it talks to, and how to check this
// copy (the running exe's SHA-256 on VirusTotal, backend: xtra_trust.rs). The same facts as README's FAQ entry.
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Copy, ExternalLink, ShieldCheck } from 'lucide-react'
import { LuShieldCheck } from 'react-icons/lu'
import type { useAlert } from '../components/AlertHandler'
import { REPAKXTRA_VERSION } from './version'
import { APP_NAME, RELEASE_PREFIX } from './edition'

const REPO = 'https://github.com/cablemp5/repak-xtra'
// read once per app run: the exe is tens of MB and every Settings search mounts this page
let hashOnce: Promise<string> | undefined
const open = (url: string) => import('@tauri-apps/plugin-shell').then(m => m.open(url)).catch(() => window.open(url, '_blank'))

export default function IsItSafe({ alert }: { alert: ReturnType<typeof useAlert> }) {
  const [hash, setHash] = useState<string | null | false>(null) // false: could not be read
  useEffect(() => { (hashOnce ??= invoke<string>('xtra_self_sha256')).then(setHash).catch(() => setHash(false)) }, [])
  return (
    <div className="setting-section">
      <h3 className="setting-icon-label"><LuShieldCheck size={18} aria-hidden="true" />Is {APP_NAME} safe?</h3>
      <div className="setting-group">
        {/* One plain lead, then the facts as a list (Chunking): each opens with its claim in bold, so the list scans in a glance */}
        <p className="setting-subtext xs-note">repakxtra is a file manager for mods. Here is what it does, what it talks to, and how to check this copy yourself.</p>
        {/* .setting-item makes the facts one Settings search row, so a search for "telemetry" finds them */}
        <div className="setting-item">
          <ul className="su-facts">{/* Setup's Is it safe? report look (Jakob's Law: one report style across the app) */}
            <li><b>It only moves mod files.</b> .pak, .utoc, and .ucas files in the game's ~mods folder. Setup also puts the signature bypass and its loader (dsound.dll and one .asi) in Binaries\Win64. repakxtra never touches the game's own files or runs inside the game. The bypass does: it only patches the game in memory, with no internet, file, registry, or program-launch calls. Its loader is ThirteenAG's open source Ultimate ASI Loader.</li>
            <li><b>Open source.</b> The full source is public on <a href={REPO} onClick={e => { e.preventDefault(); open(REPO) }}>GitHub</a>, built on Repak X. Releases are built from that code.</li>
            <li><b>Network.</b> It only talks to GitHub (app updates, Project Galacta, the preview kit, and game mappings) and Discord (the server widget), and loads mod images from Nexus Mods and imgur. Blender downloads from blender.org only when you install the preview kit's Blender. The optional Discord role claim signs in with Discord in your browser and passes through a small Cloudflare Worker that only grants the role. No repakxtra account, ads, analytics, or telemetry, and nothing about your PC is uploaded.</li>
            <li><b>Mods can still get you banned.</b> Mods break the game's terms, and repakxtra cannot make any mod safe from a ban. Mods and plugins that trip the anti-cheat get a Ban risk badge.</li>
            <li><b>Windows may warn once.</b> The exe is not code-signed (signing costs money every year), so SmartScreen can show "Windows protected your PC" the first time: More info, then Run anyway. Some antivirus tools flag unsigned mod tools that write into game folders. The scan below shows what the engines say.</li>
          </ul>
        </div>
        {/* The two checks as rows like Help's (Law of Similarity): label, gray note, one button each */}
        <div className="xs-row xs-support-first">
          <div className="xs-text">
            <span className="xs-label xs-label-row">Scan this copy
              {hash
                ? <button type="button" className="su-hash xs-hash" title="Copy the SHA-256" onClick={() => { navigator.clipboard.writeText(hash); alert.success('Copied', `SHA-256 of this ${APP_NAME}.exe`) }}>
                    <code>{hash.slice(0, 12)}</code><Copy size={12} aria-hidden="true" /></button>
                : <span className="su-meta">{hash === false ? 'SHA-256 unavailable' : 'Reading SHA-256'}</span>}
            </span>
            <span className="setting-subtext">If VirusTotal has no report for this exact file yet, its page lets you upload it.</span>
          </div>
          <button type="button" className="action-btn" disabled={!hash} title="Open this exe's VirusTotal page" onClick={() => open(`https://www.virustotal.com/gui/file/${hash}`)}>
            <ShieldCheck size={16} aria-hidden="true" /> Open VirusTotal
          </button>
        </div>
        <div className="xs-row">
          <div className="xs-text">
            <span className="xs-label">This version's release</span>
            <span className="setting-subtext">The release page lists the zip's checksum and VirusTotal scan.</span>
          </div>
          <button type="button" className="action-btn" title="Open this version's release page on GitHub" onClick={() => open(`${REPO}/releases/tag/${RELEASE_PREFIX}${REPAKXTRA_VERSION}`)}>
            <ExternalLink size={16} aria-hidden="true" /> Release {RELEASE_PREFIX}{REPAKXTRA_VERSION}
          </button>
        </div>
      </div>
    </div>
  )
}
