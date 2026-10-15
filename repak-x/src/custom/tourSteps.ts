// repakxtra: the tour (components/OnboardingTour.tsx draws it). Only the essentials: what a loadout is, making one,
// switching and editing it, the Library and adding mods, then Setup and Launch. Each step shows the view its target
// lives in; a target that is missing (no loadouts yet) gets the tip centered instead.
import { openLoadout, setView } from './loadoutStore'

export type Placement = 'top' | 'bottom' | 'left' | 'right'
export type TourStep = { target: string; title: string; description: string; placement: Placement; onEnter?: () => void }

const home = () => { openLoadout(null); setView('home') }

export const TOUR_STEPS: TourStep[] = [
  {
    target: '[data-tour="view-tabs"]',
    title: 'Loadouts and Library',
    description: 'A loadout is a set of mods you switch on and off together: one look, one VFX color, one emote wheel. The Library lists every installed mod. L switches between the two.',
    placement: 'bottom',
    onEnter: home,
  },
  {
    target: '[data-tour="new-loadout"]',
    title: 'Make a loadout',
    description: 'Start one here and add mods on its page. Or select mods in the Library and press +. Installing two or more mods at once can save them as a loadout too.',
    placement: 'bottom',
    onEnter: home,
  },
  {
    target: '[data-loadout], .lo-first-run',
    title: 'Switch it, edit it',
    description: "The switch turns all of a loadout's mods on or off; other mods and loadouts stay as they are. Open the card to add or remove mods, set its picture or group, and generate its preview.",
    placement: 'right',
    onEnter: home,
  },
  {
    target: '[data-tour="add-mod-btn"]',
    title: 'Add mods',
    description: 'Drop .pak, .zip, .rar or .7z files (or mod folders) anywhere on the window, or press here. The Library below has every mod with its switch, filters by hero and type, and a right-click menu.',
    placement: 'bottom',
    onEnter: () => setView('library'),
  },
  {
    target: '[data-tour="setup-btn"]',
    title: 'Setup and Launch',
    description: 'Setup holds the signature bypass, Project Galacta and mod previews; close the game before changing them. Launch Game starts Marvel Rivals, and mods stay locked while it runs. Replay this tour from Settings.',
    placement: 'bottom',
    onEnter: home,
  },
]
