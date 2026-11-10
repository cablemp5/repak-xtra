// repakxtra: Rotate in 3D's look switches: the black outline and the rim light (the show rim band and the rig's rim
// lights), the outline on by default and the rim light off, and the lobby sounds (the sound cues of the lobby idle), off
// by default. Set from the
// viewer's Options menu or Settings > Previews > Outline in 3D, kept in this browser's storage, and an open viewer follows a
// change at once (OUTLINE_EVENT).
const KEYS = { outline: 'repakxtra.viewerOutline', rim: 'repakxtra.viewerRim', sound: 'repakxtra.viewerSound' } as const
export const OUTLINE_EVENT = 'repakxtra:viewer-outline'
export type ViewerLook = { outline: boolean; rim: boolean; sound: boolean }
/** Whether the Outline and Rim light switches show (the viewer's Options, Settings > Previews > Outline in 3D). While
 *  false both read as off whatever is stored, so no one is left with a look they cannot switch off. */
export const LOOK_SWITCHES = false

export function viewerLook(): ViewerLook {
  const read = (k: string) => { try { return localStorage.getItem(k) } catch { return null } }
  return { outline: LOOK_SWITCHES && read(KEYS.outline) !== '0', rim: LOOK_SWITCHES && read(KEYS.rim) === '1', sound: read(KEYS.sound) === '1' }
}

export function setViewerLook(next: Partial<ViewerLook>) {
  for (const k of Object.keys(next) as (keyof ViewerLook)[]) {
    try { localStorage.setItem(KEYS[k], next[k] ? '1' : '0') } catch { /* storage blocked: the default stays */ }
  }
  window.dispatchEvent(new Event(OUTLINE_EVENT))
}

export const viewerOutlineOn = () => viewerLook().outline
export const setViewerOutline = (on: boolean) => setViewerLook({ outline: on })
