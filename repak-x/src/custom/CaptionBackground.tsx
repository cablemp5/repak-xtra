import { useRef } from 'react'
import { ImagePlus } from 'lucide-react'
import Switch from '../components/ui/Switch'
import { captionBackgroundKey, type Loadout, patchLoadout } from './loadoutStore'
import { deleteMedia, prepareMedia, putMedia } from './loadoutMedia'
import type { LoadoutProps } from './Loadouts'

export default function CaptionBackground({ l, alert }: { l: Loadout; alert: LoadoutProps['alert'] }) {
  const file = useRef<HTMLInputElement>(null)
  return <div className="caption-background-controls">
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
    <button type="button" className="lo-text-btn" onClick={() => file.current?.click()}><ImagePlus size={14} />{l.captionBackgroundRev ? 'Change background' : 'Add background'}</button>
    {l.captionBackgroundRev && <>
      <label>Blur <Switch checked={Boolean(l.captionBlur)} onChange={(captionBlur: boolean) => patchLoadout(l.id, { captionBlur })} size="sm" /></label>
      <label>Dark tint <Switch checked={Boolean(l.captionDark)} onChange={(captionDark: boolean) => patchLoadout(l.id, { captionDark })} size="sm" /></label>
      <button type="button" className="lo-text-btn" onClick={() => {
        patchLoadout(l.id, { captionBackgroundRev: undefined })
        void deleteMedia(captionBackgroundKey(l.id))
      }}>Remove background</button>
    </>}
  </div>
}
