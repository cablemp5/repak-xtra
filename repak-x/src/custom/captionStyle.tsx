// repakxtra: the look of a loadout's typed card (loadoutBits.tsx CardMedia): an optional Lucide icon above its words
// and a color from a few swatches, picked while typing. Stored on the loadout as captionIcon (a name below) and
// captionColor (a hex). The bar's buttons keep focus in the text field (mousedown is prevented), so picking never ends
// the typing.
import { useState } from 'react'
import {
  Ban, Bomb, Cat, ChevronUp, Crosshair, Crown, Droplet, Eye, Flame, Gamepad2, Gem, Ghost, Headphones, Heart, Leaf, Moon, Mountain, Music,
  Palette, PawPrint, Plus, Rocket, Shield, Skull, Snowflake, Sparkles, Star, Sun, Swords, Target, Trophy, Wand2, Waves, Wind, Zap,
} from 'lucide-react'

type Icon = typeof Flame
/** The icons on offer, by the name stored on the loadout. Picked for loadouts: looks, elements, modes, music. */
export const CAPTION_ICONS: Record<string, [Icon, string]> = {
  PawPrint: [PawPrint, 'Paw'], Cat: [Cat, 'Cat'], Skull: [Skull, 'Skull'], Ghost: [Ghost, 'Ghost'], Crown: [Crown, 'Crown'],
  Gem: [Gem, 'Gem'], Star: [Star, 'Star'], Sparkles: [Sparkles, 'Sparkles'], Wand2: [Wand2, 'Magic'], Heart: [Heart, 'Heart'],
  Flame: [Flame, 'Fire'], Snowflake: [Snowflake, 'Ice'], Zap: [Zap, 'Lightning'], Droplet: [Droplet, 'Water'], Waves: [Waves, 'Waves'],
  Wind: [Wind, 'Wind'], Leaf: [Leaf, 'Nature'], Mountain: [Mountain, 'Earth'], Sun: [Sun, 'Sun'], Moon: [Moon, 'Moon'],
  Swords: [Swords, 'Swords'], Shield: [Shield, 'Shield'], Crosshair: [Crosshair, 'Aim'], Target: [Target, 'Target'], Bomb: [Bomb, 'Bomb'],
  Trophy: [Trophy, 'Ranked'], Gamepad2: [Gamepad2, 'Casual'], Rocket: [Rocket, 'Rocket'], Eye: [Eye, 'Eye'],
  Music: [Music, 'Music'], Headphones: [Headphones, 'Sound'], Palette: [Palette, 'Colors'],
}
/** Swatches for the words and icon (no red: the app keeps red for warnings). White is the default. Six fit one row on
 *  the page's card; a color saved from an older, longer list still shows, with no swatch picked. */
export const CAPTION_COLORS = ['#ffffff', '#ffb648', '#3ecf6e', '#5cc8ff', '#9d7bff', '#ff7ad9']

/** The loadout's icon, or nothing (an unknown name draws nothing). */
export function CaptionIcon({ name, className }: { name?: string; className?: string }) {
  const entry = name ? CAPTION_ICONS[name] : undefined
  if (!entry) return null
  const [I] = entry
  return <I className={className} aria-hidden="true" />
}

const keep = (e: React.MouseEvent) => e.preventDefault() // the text field keeps focus

/** Icon and color for the typed card, under the text field while typing. */
export function CaptionStyleBar({ icon, color, onIcon, onColor }: {
  icon?: string; color?: string; onIcon: (name: string | undefined) => void; onColor: (hex: string | undefined) => void
}) {
  const [picking, setPicking] = useState(false)
  const shown = color ?? CAPTION_COLORS[0]
  return (
    <div className="cap-bar" onMouseDown={keep}>
      {picking && (
        <div className="cap-icons" role="listbox" aria-label="Icon">
          <button type="button" role="option" aria-selected={!icon} className="cap-icon-opt" title="No icon"
            onClick={() => { onIcon(undefined); setPicking(false) }}><Ban /></button>
          {Object.entries(CAPTION_ICONS).map(([name, [I, label]]) => (
            <button key={name} type="button" role="option" aria-selected={icon === name} className="cap-icon-opt" title={label} aria-label={label}
              onClick={() => { onIcon(name); setPicking(false) }}><I /></button>
          ))}
        </div>
      )}
      <button type="button" className={`cap-icon-btn${icon ? ' has-icon' : ''}`} aria-expanded={picking} onClick={() => setPicking(v => !v)}
        title={icon ? 'Change the icon' : 'Add an icon above the text'} aria-label={icon ? 'Change the icon' : 'Add an icon'}>
        {icon ? <><CaptionIcon name={icon} /><ChevronUp className="cap-caret" /></> : <><Plus />Icon</>}
      </button>
      <span className="cap-swatches" role="radiogroup" aria-label="Color">
        {CAPTION_COLORS.map(c => (
          <button key={c} type="button" role="radio" aria-checked={shown === c} className="cap-swatch" style={{ background: c, '--sw': c } as React.CSSProperties}
            title={c === CAPTION_COLORS[0] ? 'White' : c} aria-label={`Color ${c}`} onClick={() => onColor(c === CAPTION_COLORS[0] ? undefined : c)} />
        ))}
      </span>
    </div>
  )
}
