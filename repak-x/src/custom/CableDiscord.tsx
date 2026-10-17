// repakxtra: Discord servers in Settings > Help & Community as one quiet card each: the Repak X server (in place of
// upstream's banner widget, so the two look alike) and cable's own. Discord's public invite lookup gives the name, icon,
// online and member counts without the server widget.
import { useEffect, useState } from 'react'
import { open as openUrl } from '@tauri-apps/plugin-shell'

type Invite = { guild?: { id: string; name: string; icon?: string | null }; approximate_presence_count?: number; approximate_member_count?: number }

export function DiscordCard({ invite, fallbackName }: { invite: string; fallbackName: string }) {
  const [info, setInfo] = useState<Invite | null>(null)
  useEffect(() => {
    fetch(`https://discord.com/api/v10/invites/${invite}?with_counts=true`)
      .then(r => (r.ok ? r.json() : null))
      .then(setInfo)
      .catch(() => undefined)
  }, [invite])
  const g = info?.guild
  return (
    <div className="cd-card">
      {g?.icon
        ? <img className="cd-icon" src={`https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=96`} alt="" />
        : <span className="cd-icon" />}
      <div className="cd-text">
        <span className="cd-name">{g?.name ?? fallbackName}</span>
        <span className="cd-meta">
          <span className="cd-dot" />{info?.approximate_presence_count ?? '…'} online
          {info?.approximate_member_count !== undefined && <span className="cd-members">{info.approximate_member_count} members</span>}
        </span>
      </div>
      <button type="button" className="lo-text-btn" onClick={() => openUrl(`https://discord.gg/${invite}`)}>Join</button>
    </div>
  )
}

/** The Repak X community server (upstream's invite). */
export const RepakXDiscord = () => <DiscordCard invite="nrud2gjUJk" fallbackName="Repak X" />

export default function CableDiscord() {
  return <DiscordCard invite="C7geHdWBP5" fallbackName="cable's server" />
}
