// repakxtra: the tour (components/OnboardingTour.tsx draws it). Five steps, the essentials only: Loadouts and the
// Library, switching and editing a loadout, adding mods, the built-ins, then Setup and Launch. One or two short
// sentences each: people skim a tour, the details live in tooltips where the control is. Each step shows the view its
// target lives in; a target that is missing (no loadouts yet) gets the tip centered instead.
import { openLoadout, setView } from './loadoutStore'

export type Placement = 'top' | 'bottom' | 'left' | 'right'
export type TourStep = { target: string; title: string; description: string; placement: Placement; onEnter?: () => void }

const home = () => { openLoadout(null); setView('home') }

export const TOUR_STEPS: TourStep[] = [
  {
    target: '[data-tour="view-tabs"]',
    title: 'Loadouts and Library',
    description: 'A loadout is a set of mods that turn on and off together. The Library lists every installed mod.',
    placement: 'bottom',
    onEnter: home,
  },
  {
    target: '[data-loadout], .lo-first-run',
    title: 'Switch it, edit it',
    description: "The switch turns the loadout's mods on or off. Open the card to change its mods or picture.",
    placement: 'right',
    onEnter: home,
  },
  {
    target: '.bi-section .lo-group-head',
    title: 'Built-in mods',
    description: 'Skip startup logos is made from your own game files. Turn it on and it is rebuilt after every game update.',
    placement: 'top',
    onEnter: () => { home(); document.querySelector('.bi-section')?.scrollIntoView({ block: 'center' }) },
  },
  {
    target: '[data-tour="add-mod-btn"]',
    title: 'Add mods',
    description: 'Drop .pak, .zip, .rar, or .7z files anywhere on the window, or press Install.',
    placement: 'bottom',
    onEnter: () => setView('library'),
  },
  {
    target: '[data-tour="setup-btn"]',
    title: 'Setup and Launch',
    description: 'Setup installs what mods need. Launch starts Marvel Rivals, and Settings replays this tour.',
    placement: 'bottom',
    onEnter: home,
  },
]
