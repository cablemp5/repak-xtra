// repakxtra: the tour (components/OnboardingTour.tsx draws it), played once when Install is pressed on the first mod after
// the welcome flow (FirstRun.tsx) and again from Settings. Written for someone new to modding: five steps, one short idea
// each, in the order they use the app (loadouts, switching one on, getting more mods, fixing a mod that does not show,
// playing). Each step shows the view its target lives in; a target that is missing gets the tip centered instead.
import { openLoadout, setView } from './loadoutStore'

export type Placement = 'top' | 'bottom' | 'left' | 'right'
export type TourStep = { target: string; title: string; description: string; placement: Placement; onEnter?: () => void }

const home = () => { openLoadout(null); setView('home') }

export const TOUR_STEPS: TourStep[] = [
  {
    target: '[data-tour="view-tabs"]',
    title: 'Your mods live here',
    description: 'Loadouts are sets of mods that switch on together. Library lists every mod you installed.',
    placement: 'bottom',
    onEnter: home,
  },
  {
    target: '[data-loadout], .lo-first-run',
    title: 'Switch a loadout on',
    description: 'Turn on the switch, then start the game. Open the card to add or remove mods.',
    placement: 'right',
    onEnter: home,
  },
  {
    target: '[data-tour="add-mod-btn"]',
    title: 'Get more mods',
    description: 'Download a mod from Nexus Mods, then drop the file on this window or press Install.',
    placement: 'bottom',
    onEnter: () => setView('library'),
  },
  {
    target: '[data-tour="setup-btn"]',
    title: 'Mod not showing?',
    description: 'Setup checks what the game needs to load mods and installs anything missing.',
    placement: 'bottom',
    onEnter: home,
  },
  {
    target: '[data-tour="launch-btn"]',
    title: 'Play',
    description: 'Launch starts Marvel Rivals with your mods. Settings plays this tour again.',
    placement: 'bottom',
    onEnter: home,
  },
]
