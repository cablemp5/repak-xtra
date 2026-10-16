// repakxtra: cable's own Discord server in Settings > Community, under the Repak X one. Discord's public invite lookup
// gives its name, icon and online count without the server widget.
import { useEffect, useState } from 'react'
import { open as openUrl } from '@tauri-apps/plugin-shell'

const INVITE = 'C7geHdWBP5'

type Invite = { guild?: { id: string; name: string; icon?: string | null }; approximate_presence_count?: number; approximate_member_count?: number }

export default function CableDiscord() {
  const [info, setInfo] = useState<Invite | null>(null)
  useEffect(() => {
    fetch(`https://discord.com/api/v10/invites/${INVITE}?with_counts=true`)
      .then(r => (r.ok ? r.json() : null))
      .then(setInfo)
      .catch(() => undefined)
  }, [])
  const g = info?.guild
  return (
    <div className="cd-card">
      {g?.icon
        ? <img className="cd-icon" src={`https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=96`} alt="" />
        : <span className="cd-icon" />}
      <div className="cd-text">
        <span className="cd-name">{g?.name ?? "cable's server"}</span>
        <span className="cd-meta">
          <span className="cd-dot" />{info?.approximate_presence_count ?? '—'} online
          {info?.approximate_member_count !== undefined && <span className="cd-members">{info.approximate_member_count} members</span>}
        </span>
      </div>
      <button type="button" className="lo-text-btn" onClick={() => openUrl(`https://discord.gg/${INVITE}`)}>Join</button>
    </div>
  )
}
