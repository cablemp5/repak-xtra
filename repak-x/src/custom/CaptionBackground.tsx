import { useRef } from 'react'
import { ImagePlus, X } from 'lucide-react'
import { captionBackgroundKey, type Loadout, patchLoadout } from './loadoutStore'
import { deleteMedia, prepareMedia, putMedia, useMediaUrl } from './loadoutMedia'
import type { LoadoutProps } from './Loadouts'

/** A picture behind a card's typed words, in the card's tools (CardTools.tsx) while Text is picked: one Add chip, then
 *  (with a picture) its thumbnail to change it, Blur, Dim, and remove. */
export default function CaptionBackground({ l, alert }: { l: Loadout; alert: LoadoutProps['alert'] }) {
  const file = useRef<HTMLInputElement>(null)
  const url = useMediaUrl(captionBackgroundKey(l.id), l.captionBackgroundRev)
  const choose = () => file.current?.click()
  return <div className="cap-bg" role="group" aria-label="Background behind the text">
    <input ref={file} type="file" accept="image/*" hidden onChange={async e => {
      const image = e.target.files?.[0]
      e.target.value = ''
      if (!image) return
      try {
        if (!image.type.startsWith('image/')) throw new Error('Choose an image file.')
        const { blob } = await prepareMedia(image)
        await putMedia(captionBackgroundKey(l.id), blob)
        patchLoadout(l.id, { captionBackgroundRev: Date.now() })
      } catch (err) { alert.warning('Background not saved', String(err)) }
    }} />
    {!l.captionBackgroundRev
      ? <button type="button" className="ct-chip cap-bg-add" onClick={choose} title="Put a picture behind the text"><ImagePlus size={14} aria-hidden="true" />Add picture</button>
      : <>
          <button type="button" className="ct-chip cap-bg-thumb" onClick={choose} title="Change the background" aria-label="Change the background">
            {url && <img src={url} alt="" />}
          </button>
          <button type="button" className="ct-chip" aria-pressed={Boolean(l.captionBlur)} title="Blur the background"
            onClick={() => patchLoadout(l.id, { captionBlur: l.captionBlur ? undefined : true })}>Blur</button>
          <button type="button" className="ct-chip" aria-pressed={Boolean(l.captionDark)} title="Darken the background so the text stands out"
            onClick={() => patchLoadout(l.id, { captionDark: l.captionDark ? undefined : true })}>Dim</button>
          <button type="button" className="ct-chip cap-bg-remove" title="Remove the background" aria-label="Remove the background" onClick={() => {
            patchLoadout(l.id, { captionBackgroundRev: undefined, captionBlur: undefined, captionDark: undefined })
            void deleteMedia(captionBackgroundKey(l.id))
          }}><X size={14} aria-hidden="true" /></button>
        </>}
  </div>
}
