// caleb fork: small pieces shared by Home (LoadoutsScreen.tsx), the loadout page and the New strip.
import { ImagePlus } from 'lucide-react'
import Switch from '../components/ui/Switch'
import type { LoadoutProps } from './Loadouts'
import { useMediaUrl } from './loadoutMedia'
import { type Loadout, type Mod, displayName, flipMods } from './loadoutStore'
import { ModName, typeCode } from './modName'
import { hasPreview, usePreviewUrl, usePreviewVersion } from './previews'

/** The home screen's badge color class for a mod type (caleb.css *-badge sets --badge-dot). */
export const typeClass = (category?: string | null) => `${(category || 'unknown').toLowerCase().replace(/\s+/g, '-')}-badge`

/** The loadout's own image or video, else the generated preview of its first mod that has one. */
export function CardMedia({ l }: { l: Loadout }) {
  const url = useMediaUrl(l.id, l.mediaRev)
  usePreviewVersion()
  const generated = usePreviewUrl(l.on.map(displayName).find(hasPreview))
  const src = url ?? l.image ?? generated
  if (!src) return <span className="lo-card-placeholder"><ImagePlus size={22} /><span>Click to add an image, or hover and paste</span></span>
  return l.mediaType === 'video' && url
    ? <video src={url} autoPlay loop muted playsInline />
    : <img src={src} alt="" />
}

/** Turns single mods on or off from Home, with the same game-running guard as loadouts. */
export async function toggleMod(p: LoadoutProps, mod: Mod) {
  if (p.blocked) {
    p.alert.warning('Game Running', 'Cannot toggle mods while game is running.')
    return
  }
  if (await flipMods([mod])) p.alert.warning('Not switched', `${displayName(mod.path.split(/[/\\]/).pop() || mod.path)} could not be switched.`)
  await p.reload()
}

/** One mod row: optional on/off switch, type code, name (slug + tags + version), then any trailing actions. */
export function ModRow({ p, k, mod, onToggle, children }: {
  p: LoadoutProps; k: string; mod?: Mod; onToggle?: boolean; children?: React.ReactNode
}) {
  const category = mod && p.modDetails?.[mod.path]?.category
  return (
    <li className={`mod-row ${mod ? (mod.enabled ? 'is-on' : '') : 'is-missing'}`}
      title={mod ? `${category ?? 'Unknown type'} · ${mod.enabled ? 'on now' : 'off now'}` : 'Not installed anymore'}>
      {onToggle && (mod
        ? <Switch size="sm" color="primary" checked={Boolean(mod.enabled)} title={mod.enabled ? 'Turn this mod off' : 'Turn this mod on'}
            onChange={() => toggleMod(p, mod)} />
        : <span className="mod-row-switch-gap" />)}
      <span className={`type-code ${typeClass(category)}`}>{typeCode(category)}</span>
      <span className="mod-row-name"><ModName name={k} /></span>
      {children}
    </li>
  )
}
