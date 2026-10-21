// repakxtra: the tour (components/OnboardingTour.tsx draws it). Only the essentials: what a loadout is, making one,
// switching and editing it, collections, the Library and adding mods, its filters, then Setup and Launch. Each step shows the view its target
// lives in; a target that is missing (no loadouts yet) gets the tip centered instead.
import { openLoadout, setView } from './loadoutStore'

export type Placement = 'top' | 'bottom' | 'left' | 'right'
export type TourStep = { target: string; title: string; description: string; placement: Placement; onEnter?: () => void }

const home = () => { openLoadout(null); setView('home') }

export const TOUR_STEPS: TourStep[] = [
  {
    target: '[data-tour="view-tabs"]',
    title: 'Loadouts and Library',
    description: "A loadout is a set of mods you switch on and off together: one look, one VFX color, one hero's full set of mods. The Library lists every installed mod. L switches between the two.",
    placement: 'bottom',
    onEnter: home,
  },
  {
    target: '[data-tour="new-loadout"]',
    title: 'Make a loadout',
    description: 'Start one here and add mods on its page. Or select mods in the Library and pick Add to loadout in the bar below them. Installing mods saves them as a new loadout too, unless you pick Install without a loadout.',
    placement: 'bottom',
    onEnter: home,
  },
  {
    target: '[data-loadout], .lo-first-run',
    title: 'Switch it, edit it',
    description: "The switch turns all of a loadout's mods on or off. Other mods and loadouts stay as they are. Open the card to add, remove or rename mods and set its collection. Click its picture to add an image or generate a preview.",
    placement: 'right',
    onEnter: home,
  },
  {
    target: '[data-tour="new-collection"]',
    title: 'Collections',
    description: "A collection is a named shelf for loadouts that belong together, like Panther looks or VFX colors. Make one here, then drag cards onto it or pick it on a loadout's page. Loadouts in no collection sit under Unsorted. The pencil renames it, and Collection | Hero sorts the cards by hero instead.",
    placement: 'bottom',
    onEnter: home,
  },
  {
    target: '[data-tour="add-mod-btn"]',
    title: 'Add mods',
    description: 'Drop .pak, .zip, .rar or .7z files (or mod folders) anywhere on the window, or press here. The Library below lists every mod with its switch and a right-click menu.',
    placement: 'bottom',
    onEnter: () => setView('library'),
  },
  {
    target: '[data-tour="filters"]',
    title: 'Filter by hero and type',
    description: "Click a hero to show only their mods. The arrow beside a hero lists its skins. Types narrow it to Skins, VFX, Audio and the rest. Pick as many as you like. Heroes and types add up, the list title says what is showing, and Clear resets them.",
    placement: 'right',
    onEnter: () => setView('library'),
  },
  {
    target: '[data-tour="mod-state"]',
    title: 'On, off, broken',
    description: 'All, On and Off show mods by their switch. Broken appears when a mod will not work in this game version or may crash it: hover its badge for why. Ctrl+F searches by name.',
    placement: 'bottom',
    onEnter: () => setView('library'),
  },
  {
    target: '[data-tour="setup-btn"]',
    title: 'Setup and Launch',
    description: 'Setup holds the signature bypass, Project Galacta and mod previews. Close the game before changing them. Launch Game starts Marvel Rivals, and mods stay locked while it runs. Replay this tour from Settings.',
    placement: 'bottom',
    onEnter: home,
  },
]
