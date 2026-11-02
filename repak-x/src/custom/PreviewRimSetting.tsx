// repakxtra: Settings > General > Previews, the rim light on preview renders, on or off (backend: xtra_previews.rs). Off by
// default, and changing it never renders anything: it applies to previews made from then on, so the person regenerates
// the ones they want to see change.
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Sun } from 'lucide-react'
import Checkbox from '../components/ui/Checkbox'

export function PreviewRimSetting() {
  const [on, setOn] = useState(false)
  const [changed, setChanged] = useState(false)
  useEffect(() => { invoke<boolean>('preview_rim_get').then(setOn).catch(() => undefined) }, [])
  const change = (next: boolean) => {
    setOn(next)
    invoke('preview_rim_set', { on: next }).then(() => setChanged(true)).catch(() => setOn(!next))
  }
  return (
    <div className="setting-section">
      <h3 className="setting-icon-label"><Sun size={18} aria-hidden="true" />Previews</h3>
      <div className="setting-group">
        <div className="setting-item">
          <Checkbox checked={on} onChange={change}><span>Rim lighting</span></Checkbox>
          <p className="setting-subtext">A bright edge light along the model's right side, like the in-game model viewer. It applies to previews made from now on.</p>
          {changed && <p className="setting-subtext" role="status">Saved. Regenerate your previews to see the change.</p>}
        </div>
      </div>
    </div>
  )
}
