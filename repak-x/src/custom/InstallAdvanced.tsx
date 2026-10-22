// repakxtra: the install card's four switches (Obfuscation, Hybrid IoStore, Legacy PAK Format, Send to Repak) behind an
// Advanced row. It opens the way it was last left (repakxtra.install.advanced): whoever opened it on the last install
// sees it open on the next one, whoever closed it does not. Only open or closed is remembered, never the switches.
// Closed, the row names the options that are on (forced ones included), so nothing hidden goes unnoticed.
import { type ReactNode, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { savedItem } from './storageCarryOver'

const KEY = 'repakxtra.install.advanced'
type Mod = { contains_uassets?: boolean; contains_raw_assets?: boolean }
type Settings = { obfuscate?: boolean; hybrid?: boolean; forceLegacy?: boolean; toRepak?: boolean } | undefined

/** The options that end up on for this mod, the way InstallModPanel's switches show them (forced ones included). */
export function optionsOn(mod: Mod, s: Settings) {
  const legacy = mod.contains_uassets === false || (!s?.hybrid && Boolean(s?.forceLegacy))
  const repak = mod.contains_uassets !== false && Boolean(s?.hybrid || s?.toRepak)
  return [s?.obfuscate && 'Obfuscation', s?.hybrid && 'Hybrid IoStore', legacy && 'Legacy PAK', repak && 'Send to Repak'].filter((x): x is string => Boolean(x))
}

export default function InstallAdvanced({ mod, settings, children }: { mod: Mod; settings: Settings; children: ReactNode }) {
  const [open, setOpen] = useState(() => savedItem(KEY) === '1')
  const on = optionsOn(mod, settings)
  const toggle = () => {
    const next = !open
    setOpen(next)
    localStorage.setItem(KEY, next ? '1' : '0')
  }
  return (
    <div className={`ia${open ? ' is-open' : ''}`}>
      <button type="button" className="ia-toggle" aria-expanded={open} onClick={toggle}>
        <ChevronRight size={14} className="ia-caret" aria-hidden="true" />
        Advanced
        {!open && on.length > 0 && <span className="ia-on">{on.join(' · ')}</span>}
      </button>
      <div className="t-acc-panel" data-open={open} ref={el => el?.toggleAttribute('inert', !open)}>
        <div className="t-acc-panel-inner">{children}</div>
      </div>
    </div>
  )
}

if (import.meta.env.DEV) {
  const m = (u?: boolean, r?: boolean): Mod => ({ contains_uassets: u, contains_raw_assets: r })
  console.assert(optionsOn(m(false), {}).join() === 'Legacy PAK', 'a mod without UAssets is forced to Legacy PAK')
  console.assert(optionsOn(m(true, true), { hybrid: true, forceLegacy: true }).join() === 'Hybrid IoStore,Send to Repak', 'Hybrid turns Repak on and Legacy off')
  console.assert(optionsOn(m(true), { obfuscate: true, toRepak: true }).join() === 'Obfuscation,Send to Repak', 'plain switches')
  console.assert(optionsOn(m(true), undefined).length === 0, 'nothing on')
}
