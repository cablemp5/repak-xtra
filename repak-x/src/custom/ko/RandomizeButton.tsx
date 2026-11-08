import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Contrast, Droplets, Palette, Shuffle, Sun } from 'lucide-react'
import { cue } from '../sounds'
import { DEFAULT_RANDOMIZE, type RandomizeOptions } from './randomize'

export default function RandomizeButton({ disabled, onRandomize }: { disabled: boolean; onRandomize: (options: RandomizeOptions) => void }) {
  const [open, setOpen] = useState(false)
  const [options, setOptions] = useState(DEFAULT_RANDOMIZE)
  const wrap = useRef<HTMLDivElement>(null)
  const arrow = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => { if (e.target instanceof Node && !wrap.current?.contains(e.target)) setOpen(false) }
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); arrow.current?.focus() }
    }
    window.addEventListener('pointerdown', away)
    window.addEventListener('keydown', esc, true)
    return () => { window.removeEventListener('pointerdown', away); window.removeEventListener('keydown', esc, true) }
  }, [open])
  const selected = options.hue || options.saturation || options.value
  const toggle = (key: keyof RandomizeOptions, checked: boolean) => { setOptions(o => ({ ...o, [key]: checked })); cue('toggle') }
  return (
    <div className="ko-random-control" ref={wrap} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false) }}>
      <button type="button" className="lo-text-btn ko-random-main" disabled={disabled || !selected}
        title={selected ? 'Randomize colors' : 'Choose a channel in Randomize settings'} onClick={() => onRandomize(options)}>
        <Shuffle size={14} aria-hidden />Randomize
      </button>
      <button type="button" className="lo-text-btn ko-random-more" ref={arrow} aria-label="Randomize settings" title="Randomize settings"
        aria-haspopup="menu" aria-expanded={open} aria-controls={open ? 'ko-random-settings' : undefined}
        onClick={() => { setOpen(v => !v); cue(open ? 'close' : 'open') }}><ChevronDown className="lo-new-chev" size={14} aria-hidden /></button>
      {open && <div className="xtra-menu ko-random-card" id="ko-random-settings" role="menu" aria-label="Randomize settings"
        onMouseDown={e => { if (e.target instanceof Element && !e.target.closest('button')) e.preventDefault() }}>
        <button type="button" className="xtra-item" role="menuitemcheckbox" aria-checked={options.hue} onClick={() => toggle('hue', !options.hue)}><span className="ko-random-option"><Palette size={14} aria-hidden />Hue</span>{options.hue && <Check size={14} aria-hidden />}</button>
        <button type="button" className="xtra-item" role="menuitemcheckbox" aria-checked={options.saturation} onClick={() => toggle('saturation', !options.saturation)}><span className="ko-random-option"><Droplets size={14} aria-hidden />Saturation</span>{options.saturation && <Check size={14} aria-hidden />}</button>
        <button type="button" className="xtra-item" role="menuitemcheckbox" aria-checked={options.value} onClick={() => toggle('value', !options.value)}><span className="ko-random-option"><Sun size={14} aria-hidden />Value (brightness)</span>{options.value && <Check size={14} aria-hidden />}</button>
        <div className="ko-random-separator" role="separator" />
        <button type="button" className="xtra-item" role="menuitemcheckbox" aria-checked={options.keepNeutral} onClick={() => toggle('keepNeutral', !options.keepNeutral)}><span className="ko-random-option"><Contrast size={14} aria-hidden />Ignore black &amp; white</span>{options.keepNeutral && <Check size={14} aria-hidden />}</button>
      </div>}
    </div>
  )
}
