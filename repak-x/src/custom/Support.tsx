import { open } from '@tauri-apps/plugin-shell'
import { Heart, Star } from 'lucide-react'

export default function Support({ onError }: { onError: (error: string) => void }) {
  const visit = (url: string) => { void open(url).catch(error => onError(String(error))) }
  return <>
    <div className="xs-row">
      <div className="xs-text"><span className="xs-label">Support cablebp</span><span className="setting-subtext">Help support repakxtra development.</span></div>
      <button type="button" className="action-btn" onClick={() => visit('https://ko-fi.com/cablebp')}><Heart size={16} />Support on Ko-fi</button>
    </div>
    <div className="xs-row">
      <div className="xs-text"><span className="xs-label">Star repakxtra on GitHub</span><span className="setting-subtext">Show your support for the project.</span></div>
      <button type="button" className="action-btn" onClick={() => visit('https://github.com/cablemp5/repak-xtra')}><Star size={16} />Star on GitHub</button>
    </div>
  </>
}
