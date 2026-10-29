// repakxtra: the look of a loadout's typed card (loadoutBits.tsx CardMedia): an optional Lucide icon above its words
// and a color from a few swatches, picked in the card's tools (CardTools.tsx). Stored on the loadout as captionIcon
// (a name below) and captionColor (a hex).
import {
  Bomb, Cat, Crosshair, Crown, Droplet, Eye, Flame, Gamepad2, Gem, Ghost, Headphones, Heart, Leaf, Moon, Mountain, Music,
  Palette, PawPrint, Rocket, Shield, Skull, Snowflake, Sparkles, Star, Sun, Swords, Target, Trophy, Wand2, Waves, Wind, Zap,
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
export const CAPTION_COLORS = ['#ffffff', '#3ecf6e', '#5cc8ff', '#9d7bff', '#ff7ad9'] // no yellow (cable, 2026-10-21): a card already set to it keeps it

/** The loadout's icon, or nothing (an unknown name draws nothing). */
export function CaptionIcon({ name, className }: { name?: string; className?: string }) {
  const entry = name ? CAPTION_ICONS[name] : undefined
  if (!entry) return null
  const [I] = entry
  return <I className={className} aria-hidden="true" />
}
