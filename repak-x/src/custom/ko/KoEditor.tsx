// repakxtra: the KO Editor view (the header's third tab). Pick a hero, watch its KO prompt play from the game's own files,
// change its colors, install it as a mod (and a loadout with this frame as its picture). Layout: heroes, stage, colors.
import { useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { Check, Download, RotateCcw, Search } from 'lucide-react'
import ColorPicker, { RAINBOW } from './ColorPicker'
import { ROLE_ORDER, heroRole } from './heroRoles'
import { RoleIcon } from '../icons/rivals'
import CustomDropdown from '../../components/CustomDropdown'
import { type LoadoutProps, createFromMods } from '../Loadouts'
import { modKey, patchLoadout, readLoadouts, useView, writeLoadouts } from '../loadoutStore'
import { putMedia } from '../loadoutMedia'
import { useHeroPortrait } from '../heroFilter'
import { cue } from '../sounds'
import { type Material, type Role, hexOf, readMaterial, readWidget, shiftHue } from './model'
import { type Images, type Scene, KO_BEAT, KO_FONT, draw, drawClear, duration, frameFor, makeScene } from './render'
import { type KoStep, NameTaken, installKo } from './export'
import { type Hero, type Loaded, type Progress, forgetHero, loadHero, usmapPath } from './load'
import { recordClip } from './record'
import './ko.css'

type Saved = Record<string, { colors?: Record<string, string>; name?: string; hue?: number; loadout?: string }> // loadout: the one this editor made
const STORE = 'repakxtra.koEditor'
const readSaved = (): Saved => { try { return JSON.parse(localStorage.getItem(STORE) || '{}') } catch { return {} } }
const SPEEDS = [0.1, 0.25, 0.5, 1]

// each step's share of the bar, and how fast a step with no count of its own creeps toward its end (seconds)
const SPAN: Record<Progress['step'], [number, number, number]> = { 1: [0, 45, 3], 2: [45, 60, 1], 3: [60, 88, 4], 4: [88, 100, 1] }
const percent = (p: Progress, now: number) => {
  const [a, b, k] = SPAN[p.step]
  const f = p.total ? (p.done ?? 0) / p.total : Math.min(0.95, 1 - Math.exp(-(now - p.at) / 1000 / k))
  return a + (b - a) * f
}
const stepText = (p: Progress, hero: string) => p.step === 1 ? `Finding ${hero}'s KO prompt in your game files`
  : p.step === 2 ? 'Reading its layers and animations' : p.step === 3 ? 'Turning its textures into pictures'
    : p.total ? `Loading textures, ${p.done ?? 0} of ${p.total}` : 'Loading textures'

export default function KoEditor(p: Pick<LoadoutProps, 'reload' | 'alert' | 'blocked'>) {
  const shown = useView() === 'ko'
  const [seen, setSeen] = useState(shown)
  if (shown && !seen) setSeen(true)
  if (!seen) return null
  return <div className="ko" hidden={!shown}><Editor {...p} shown={shown} /></div>
}

function Editor({ reload, alert, blocked, shown }: Pick<LoadoutProps, 'reload' | 'alert' | 'blocked'> & { shown: boolean }) {
  const portrait = useHeroPortrait()
  const [usmap, setUsmap] = useState<string | null>(null)
  const [heroes, setHeroes] = useState<Hero[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [heroId, setHeroId] = useState<string | null>(() => localStorage.getItem(`${STORE}.hero`))
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [loading, setLoading] = useState<{ hero: Hero; since: number } | null>(null)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [, setNow] = useState(0)
  useEffect(() => { // the bar creeps on while a step with no count of its own runs
    if (!loading) return
    const t = setInterval(() => setNow(Date.now()), 120)
    return () => clearInterval(t)
  }, [loading])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saved, setSaved] = useState<Saved>(readSaved)
  const [focus, setFocus] = useState<string[] | null>(null)
  const [playing, setPlaying] = useState(true)
  const [speed, setSpeed] = useState(0.5)
  const kills = 4 // QUAD: the prompt everyone knows, the same picture on every loadout card
  const [time, setTime] = useState(0)
  const [makeLoadout, setMakeLoadout] = useState(true)
  const [step, setStep] = useState<KoStep | null>(null)
  const [taken, setTaken] = useState<string | null>(null)
  const [installed, setInstalled] = useState(false) // a moment of Installed on the button after a good install

  const hero = heroes?.find(h => h.id === heroId) ?? null
  const entry = (hero && saved[hero.id]) || {}
  const name = entry.name ?? (hero ? `${hero.name} KO Prompt` : '')
  const roles = useMemo(() => (loaded?.hero.id === heroId ? loaded.scene.w.roles : []), [loaded, heroId])
  const hue = entry.hue ?? 0
  // what each role shows and installs: its pick (or the game's color), turned by the hue shift. Only the ones that differ
  const colors = useMemo(() => new Map(roles.flatMap(r => {
    const game = hexOf(r.rgba), hex = shiftHue(entry.colors?.[r.id] ?? game, hue)
    return hex !== game ? [[r.id, hex] as const] : []
  })), [roles, entry.colors, hue])
  const edited = roles.filter(r => colors.has(r.id))
  // the slider's track: the main color turned all the way around, with no shift in the middle
  const main = roles[0] ? entry.colors?.[roles[0].id] ?? hexOf(roles[0].rgba) : '#346BF1'
  const hueTrack = `linear-gradient(90deg, ${[-180, -120, -60, 0, 60, 120, 180].map(d => shiftHue(main, d)).join(', ')})`
  const save = (patch: Saved[string]) => {
    if (!hero) return
    const next = { ...saved, [hero.id]: { ...entry, ...patch } }
    setSaved(next); localStorage.setItem(STORE, JSON.stringify(next))
  }

  // once: loadouts the first KO Editor made keyed their mod by its .utoc, which never matches the Library's name for it
  useEffect(() => {
    const fix = (k: string) => (/\.utoc$/i.test(k) ? k.replace(/\.utoc$/i, '').replace(/(_\d+_P)+$/i, '') : k)
    const list = readLoadouts()
    if (list.some(l => l.on.some(k => /\.utoc$/i.test(k)))) writeLoadouts(list.map(l => ({ ...l, on: l.on.map(fix), scope: l.scope.map(fix) })))
  }, [])

  // the heroes the installed game has, read once the page is first shown
  useEffect(() => {
    let on = true
    usmapPath().then(u => { if (!on) return null; setUsmap(u); return invoke<Hero[]>('xtra_ko_heroes', { usmapPath: u }) })
      .then(list => { if (on && list) { setHeroes(list); setHeroId(id => (id && list.some(h => h.id === id) ? id : list[0]?.id ?? null)) } })
      .catch(e => on && setListError(String(e)))
    return () => { on = false }
  }, [])

  useEffect(() => {
    if (!hero || !usmap || loaded?.hero.id === hero.id) return
    let on = true
    localStorage.setItem(`${STORE}.hero`, hero.id)
    setLoadError(null); setFocus(null); setTime(0)
    setLoading({ hero, since: Date.now() }); setProgress(null)
    let read = false // a first read of this hero (the bar showed): a ready cue when it lands
    loadHero(hero, usmap, p => { if (on) { setProgress(p); read = true } }).then(l => { if (on) { setLoaded(l); setPlaying(true); if (read) cue('ready') } }, e => { if (on) { setLoadError(String(e)); cue('error') } })
      .finally(() => { if (on) setLoading(null) })
    return () => { on = false }
  }, [hero, usmap, loaded]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- the stage: one canvas, drawn every frame while playing, on demand while paused ----
  const canvas = useRef<HTMLCanvasElement>(null)
  const timeRef = useRef(0)
  const scene = loaded?.hero.id === heroId ? loaded.scene : null
  const total = scene ? duration(scene) : 1
  const paint = () => {
    const c = canvas.current
    if (!c || !scene) return
    const ctx = c.getContext('2d')!
    const size = { w: c.width, h: c.height }
    // close on the ring and the kill text, as it reads in the game: the banner's far tail runs off the left
    draw(ctx, scene, timeRef.current, size, { kills, colors, focus: focus ?? undefined, checker: true, frame: frameFor(scene.core, size, 2.4) })
  }
  const paintRef = useRef(paint)
  paintRef.current = paint
  useEffect(() => {
    const c = canvas.current
    if (!c) return
    const fit = () => {
      const r = c.getBoundingClientRect(), d = devicePixelRatio || 1, w = Math.max(1, Math.round(r.width * d)), h = Math.max(1, Math.round(r.height * d))
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h }
      paintRef.current()
    }
    const ro = new ResizeObserver(fit); ro.observe(c); fit()
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    if (!scene || !playing || !shown) { paint(); return }
    let raf = 0, last = performance.now(), shownAt = 0
    const tick = (now: number) => {
      // a short beat of rest after the fade out (0.6 s felt slow, cable 2026-11-01), then again from the kill
      timeRef.current += ((now - last) / 1000) * speed
      last = now
      if (timeRef.current > total + 0.15) timeRef.current = 0
      paint()
      glide(timeRef.current) // the playhead every frame, so it glides
      if (now - shownAt > 80) { shownAt = now; setTime(timeRef.current) } // the phase names' highlight needs less
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [scene, playing, speed, shown, kills, colors, focus]) // eslint-disable-line react-hooks/exhaustive-deps
  const seek = (t: number) => { timeRef.current = t; setTime(t); glide(t); paint() }
  /** The slider and its filled part, set on the element itself: through React state it moved in steps. */
  const range = useRef<HTMLInputElement>(null)
  const glide = (t: number) => {
    const el = range.current
    if (!el) return
    const v = Math.min(t, total)
    el.value = String(v)
    el.style.setProperty('--ko-at', `${(v / total) * 100}%`)
  }

  useEffect(() => {
    if (!shown) return
    const key = (e: KeyboardEvent) => {
      if (e.key !== ' ' || (e.target as HTMLElement)?.closest('input, textarea, button, [contenteditable]')) return
      e.preventDefault(); setPlaying(v => !v)
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [shown])

  /** A role's color as shown (the hue shift included): kept as the pick that turns into it. null: the game's color. */
  const setColor = (r: Role, hex: string | null) => {
    const next = { ...(entry.colors ?? {}) }, game = hexOf(r.rgba)
    const pick = shiftHue(hex ?? game, -hue)
    if (pick !== game || hue) next[r.id] = pick; else delete next[r.id]
    save({ colors: next })
  }

  const install = async (replace = false) => {
    if (!loaded || !hero || !usmap || step) return
    setTaken(null)
    try {
      // a game update while the app was open: the prompt is read again before anything is built from it
      setStep('Writing the colors')
      const now = await usmapPath()
      const fresh = await invoke<{ widgetJson: string }>('xtra_ko_load', { usmapPath: now, widget: hero.widget })
      if (now !== usmap || fresh.widgetJson !== loaded.widgetJson) {
        forgetHero(hero.id); setUsmap(now); setLoaded(null); cue('warning')
        alert.warning('The game updated', 'Its KO prompt was read again with your colors on it. Check them, then install again.')
        return
      }
      const done = await installKo({ usmapPath: usmap, widgetJson: loaded.widgetJson, widgetRel: hero.widget, roles, colors, name, replace, step: setStep })
      await reload()
      if (makeLoadout) {
        // made again: the loadout this editor made for it gets the new picture. Any other loadout holding the mod keeps its own
        const mine = readLoadouts().find(x => x.id === entry.loadout && x.on.includes(modKey(done.path)))
        const l = mine ?? createFromMods([done.path], name)
        if (!mine) save({ loadout: l.id })
        // the card plays the prompt: a short video of it, or a still frame where recording is not possible
        setStep("Recording the card's animation")
        const video = await recordClip(loaded.scene, { w: 680, h: 960 }, kills, colors).catch(() => null) // .lo-card-image is 1358 by 1920
        const blob = video ?? await snapshot(loaded.scene, kills, colors)
        if (blob) { await putMedia(l.id, blob); patchLoadout(l.id, { mediaType: video ? 'video' : 'image', mediaRev: Date.now(), mediaBeat: video ? KO_BEAT : undefined, cover: 'image' }) }
      }
      cue('success'); setInstalled(true); setTimeout(() => setInstalled(false), 2400)
      alert.success(done.replaced ? 'KO prompt updated' : 'KO prompt installed',
        `${name} is ${done.replaced ? 'replaced' : 'on'} in the Library${makeLoadout ? ', with its own loadout' : ''}.`)
    } catch (e) {
      if (e instanceof NameTaken) { setTaken(e.message); cue('warning') }
      else { cue('error'); alert.warning('Not installed', e instanceof Error ? e.message : String(e)) }
    } finally { setStep(null) }
  }

  /** Arrow keys, Home and End move focus through the heroes (one Tab stop for the list), Enter or Space picks. */
  const moveInList = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const all = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]')]
    const at = all.indexOf(document.activeElement as HTMLButtonElement)
    const to = e.key === 'ArrowDown' ? at + 1 : e.key === 'ArrowUp' ? at - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : null
    if (to === null || !all.length) return
    e.preventDefault()
    all[Math.max(0, Math.min(all.length - 1, to))].focus()
  }
  // why Install is off, said under it (a tooltip alone hid it)
  const why = !scene ? null : blocked ? 'Close Marvel Rivals first' : !edited.length ? 'Change a color first' : !name.trim() ? 'Give it a name first' : null
  const shownHeroes = (heroes ?? []).filter(h => h.name.toLowerCase().includes(query.trim().toLowerCase()))
  const phases = scene?.phases ?? []
  // a gap in the track where each phase starts, under the labels above it
  const gaps = phases.slice(1).map(ph => { const at = (ph.start / total) * 100; return `linear-gradient(90deg, transparent calc(${at}% - 1.5px), var(--bg-darkest) calc(${at}% - 1.5px), var(--bg-darkest) calc(${at}% + 1.5px), transparent calc(${at}% + 1.5px))` }).join(', ') || 'none'

  return (
    <div className="ko-grid">
      <aside className="ko-col ko-heroes" aria-label="Heroes">
        <div className="ko-col-head"><h2 className="ko-h">Heroes</h2></div>
        <label className="ko-search">
          <Search size={16} aria-hidden />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search heroes" aria-label="Search heroes" />
        </label>
        <div className="ko-hero-list" role="listbox" aria-label="Hero" onKeyDown={moveInList}>
          {!heroes && !listError && Array.from({ length: 10 }, (_, i) => <div key={i} className="ko-hero is-ghost" />)}
          {listError && <p className="ko-note ko-pad">{listError}</p>}
          {heroes && !shownHeroes.length && <p className="ko-note ko-pad">No hero matches “{query.trim()}”.</p>}
          {ROLE_ORDER.map(group => {
            const inGroup = shownHeroes.filter(h => heroRole(h.id) === group)
            return inGroup.length > 0 && (
              <div key={group} role="group" aria-label={group} className="ko-hero-group">
                <div className="ko-group-head" aria-hidden><RoleIcon role={group} size={17} />{group}</div>
                {inGroup.map(h => (
                  <button key={h.id} type="button" role="option" aria-selected={h.id === heroId} className="ko-hero" onClick={() => { setHeroId(h.id); cue('select') }}
                    tabIndex={h.id === (shownHeroes.some(x => x.id === heroId) ? heroId : shownHeroes[0]?.id) ? 0 : -1}>
                    <img src={portrait(h.name)} alt="" />
                    <span>{h.name}</span>
                    {(Object.keys(saved[h.id]?.colors ?? {}).length > 0 || Boolean(saved[h.id]?.hue)) && <span className="ko-dot" title="Has your colors" />}
                  </button>
                ))}
              </div>
            )
          })}
        </div>
      </aside>

      <section className="ko-center" aria-label="Preview">
        <header className="ko-center-head">
          <h2 className="ko-title">{hero ? `${hero.name} KO Prompt Editor` : 'KO Prompt Editor'}</h2>
        </header>
        <div className="ko-stage">
          <canvas ref={canvas} className={scene ? 'is-ready' : ''} aria-label={hero ? `${hero.name}'s KO prompt` : 'KO prompt'} />
          {!scene && (
            <div className="ko-stage-msg" role="status">
              {loadError ? <><strong>Could not open this KO prompt</strong><span>{loadError}</span></>
                : loading || (!listError && !scene) ? (
                  <div className="ko-load">
                    <strong>Opening {loading?.hero.name ?? 'the game'}'s KO prompt</strong>
                    <div className="ko-load-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress ? percent(progress, Date.now()) : 2)}>
                      <span style={{ width: `${progress ? percent(progress, Date.now()) : 2}%` }} />
                    </div>
                    <span key={progress ? `${progress.step}` : 'wait'} className="ko-load-step">
                      <span className="ko-shimmer">{progress ? stepText(progress, loading?.hero.name ?? 'the hero') : 'Starting'}</span>
                    </span>
                  </div>
                )
                  : <span>{listError ?? 'Pick a hero'}</span>}
            </div>
          )}
        </div>
        <div className="ko-transport">
          <button type="button" className="ko-play t-icon-swap" data-state={playing ? 'a' : 'b'} onClick={() => { setPlaying(v => !v); cue('toggle') }} disabled={!scene}
            aria-label={playing ? 'Pause' : 'Play'} title={playing ? 'Pause (Space)' : 'Play (Space)'}>
            <PauseGlyph /><PlayGlyph />
          </button>
          <div className={`ko-timeline${scene ? '' : ' is-loading'}`}>
            {!scene && <span className="ko-track-wait" aria-hidden />}
            <input ref={range} type="range" min={0} max={total} step={0.001} defaultValue={0} disabled={!scene} aria-label="Time"
              aria-valuetext={`${phases.find(ph => time >= ph.start && time < ph.start + ph.length)?.label ?? 'End'}, ${time.toFixed(1)} seconds`}
              onChange={e => { setPlaying(false); seek(Number(e.target.value)) }} style={{ '--ko-gaps': gaps } as React.CSSProperties} />
            <div className="ko-phases" aria-hidden>
              {!scene && <span className="ko-phase-wait">Waiting for timestamps</span>}{/* the labels' place while it loads */}
              {phases.map(ph => (
                <button key={ph.label} type="button" tabIndex={-1} style={{ flexGrow: ph.length }} className={time >= ph.start && time < ph.start + ph.length ? 'is-now' : ''}
                  onClick={() => { setPlaying(false); seek(ph.start + 0.001) }}>{ph.label}</button>
              ))}
            </div>
          </div>
          <CustomDropdown className="ko-speed" ariaLabel="Playback speed" value={String(speed)} onChange={v => { setSpeed(Number(v)); cue('select') }}
            options={SPEEDS.map(s => ({ value: String(s), label: `${s}x` }))} />
        </div>
      </section>

      <aside className="ko-col ko-colors" aria-label="Colors">
        <div className="ko-col-head">
          <h2 className="ko-h">Colors</h2>
          {edited.length > 0 && <button type="button" className="fp-clear" onClick={() => { save({ colors: {}, hue: 0 }); cue('toggle') }}><RotateCcw size={12} aria-hidden />Reset all</button>}
        </div>
        <div className={`ko-role ko-all${hue ? ' is-changed' : ''}`} title="Turns every color around the color wheel at once"
          onMouseEnter={() => setFocus(roles.map(r => r.id))} onMouseLeave={() => setFocus(null)}>
          <span className="ko-wheel" aria-hidden />
          <label className="ko-role-name" htmlFor="ko-hue">All colors</label>
          <input id="ko-hue" type="range" min={-180} max={180} step={1} value={hue} disabled={!roles.length} style={{ '--ko-hue-track': hueTrack } as React.CSSProperties}
            onChange={e => save({ hue: Number(e.target.value) })} onPointerUp={() => cue('select')} onDoubleClick={() => { save({ hue: 0 }); cue('toggle') }}
            aria-label="Shift every color's hue" aria-valuetext={`${hue} degrees`} />
          <button type="button" className="ko-reset" disabled={!hue} onClick={() => { save({ hue: 0 }); cue('toggle') }} title="No hue shift" aria-label="Reset the hue shift">
            <RotateCcw size={14} />
          </button>
        </div>
        <ul key={heroId ?? 'none'} className="ko-roles" onMouseLeave={() => setFocus(null)}>
          {groupRoles(roles).flatMap(([group, rs]) => [
            <li key={`g:${group}`} className={`ko-group-head${focus?.length === rs.length && rs.every(r => focus.includes(r.id)) ? ' is-focus' : ''}`} tabIndex={0}
              onMouseEnter={() => setFocus(rs.map(r => r.id))} onFocus={() => setFocus(rs.map(r => r.id))} onBlur={() => setFocus(null)}
              title={`Hover or focus to see only the ${group.toLowerCase()}`}>{group}</li>,
            ...rs.map(r => {
              const game = hexOf(r.rgba), hex = colors.get(r.id) ?? game, changed = hex !== game
              return (
                <li key={r.id} className={`ko-role${changed ? ' is-changed' : ''}${focus?.length === 1 && focus[0] === r.id ? ' is-focus' : ''}`} onMouseEnter={() => setFocus([r.id])} onFocus={() => setFocus([r.id])}>
                <ColorPicker value={hex.slice(1).toLowerCase()} onChange={v => setColor(r, `#${v}`)} label={`${r.name} color`}
                  presets={[game.slice(1).toLowerCase(), ...RAINBOW.filter(p => p !== game.slice(1).toLowerCase())]} />
                  <span className="ko-role-name" title={r.parts.length ? `Colors the ${list(r.parts.map(x => x.toLowerCase()))}` : undefined}>{r.name}</span>
                  <HexField value={hex} onCommit={v => { setColor(r, v); cue('select') }} label={`${r.name} hex`} />
                  <button type="button" className="ko-reset" disabled={!changed} onClick={() => { setColor(r, null); cue('toggle') }} title={`Back to the game's ${game}`} aria-label={`Reset ${r.name}`}>
                    <RotateCcw size={14} />
                  </button>
                </li>
              )
            }),
          ])}
          {!roles.length && Array.from({ length: 8 }, (_, i) => <li key={i} className="ko-role is-ghost" />)}
        </ul>
        <div className="ko-out">
          <label className="ko-label" htmlFor="ko-name">Name</label>
          <input id="ko-name" className="ko-input" value={name} maxLength={60} onChange={e => save({ name: e.target.value })} disabled={!hero} />
          <div className="ob-seg ko-make" role="radiogroup" aria-label="What to make">
            <button type="button" role="radio" aria-checked={!makeLoadout} onClick={() => { if (makeLoadout) cue('toggle'); setMakeLoadout(false) }}>Mod only</button>
            <button type="button" role="radio" aria-checked={makeLoadout} onClick={() => { if (!makeLoadout) cue('toggle'); setMakeLoadout(true) }}>Mod and loadout</button>
          </div>
          {taken ? (
            <div className="ko-taken" role="alert">
              <span>A mod named {name.trim()} is already installed. Replace it?</span>
              <div><button type="button" className="lo-text-btn" onClick={() => setTaken(null)}>Cancel</button>
                <button type="button" className="lo-text-btn is-primary" onClick={() => install(true)}>Replace</button></div>
            </div>
          ) : (
            // the Nexus Mods card's states: Install, then the step's words shimmering in a quiet button (no spinner), then green Installed
            <button type="button" className={`lo-text-btn ko-install${step ? ' is-working' : installed ? ' is-installed' : ' is-primary'}`}
              onClick={() => { if (!step && !installed) install() }} aria-busy={Boolean(step)}
              disabled={!step && !installed && (!scene || !edited.length || !name.trim() || blocked)}
              title={step ? undefined : why ?? "Built from your game's current files"}>
              {step ? <span key={step} className="t-text-in"><span className="t-shimmer">{step}</span></span>
                : installed ? <span key="done" className="t-text-in ko-btn-in"><Check size={16} aria-hidden />Installed</span>
                  : <span key="idle" className="ko-btn-in"><Download size={16} aria-hidden />Install</span>}
            </button>
          )}
          {!taken && !step && !installed && why && <p className="ko-why">{why}</p>}
        </div>
      </aside>
    </div>
  )
}

/** Suggested colors in the picker, after the game's own: white, then around the wheel. */

/** The color rows by the part of the prompt they color, in the order the eye reads it. */
const PART_GROUPS = ['Banner', 'Text', 'Slashes', 'Bar', 'Other'] as const
const partGroup = (r: Role): (typeof PART_GROUPS)[number] => {
  if (r.name === 'Main' || r.name === 'Highlight') return 'Banner'
  if (/^Text/.test(r.name)) return 'Text'
  const p = r.parts[0] ?? r.name
  if (/slash|^Effect/i.test(p)) return 'Slashes'
  if (/^(Bar|Line|Hero logo)/i.test(p)) return 'Bar'
  return 'Other'
}
const groupRoles = (roles: Role[]) => PART_GROUPS.map(g => [g, roles.filter(r => partGroup(r) === g)] as const).filter(([, rs]) => rs.length > 0)

const list = (xs: string[]) => (xs.length < 3 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')}, and ${xs[xs.length - 1]}`)

/** A hex field that commits on Enter or leaving it, and goes back to the color when what was typed is not one. */
function HexField({ value, onCommit, label }: { value: string; onCommit: (hex: string) => void; label: string }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = () => {
    const v = draft.trim().replace(/^#?/, '#')
    if (/^#[0-9a-f]{6}$/i.test(v)) onCommit(v); else setDraft(value)
  }
  return <input className="ko-hex" value={draft} aria-label={label} spellCheck={false} maxLength={7}
    onChange={e => setDraft(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setDraft(value) }} />
}

/** The loadout card's picture: the icon and kill text at full show (early in the loop), in the card's portrait shape. */
async function snapshot(scene: Scene, kills: number, colors: Map<string, string>): Promise<Blob | null> {
  const c = document.createElement('canvas'); c.width = 679; c.height = 960 // .lo-card-image is 1358 by 1920
  const loop = scene.phases.find(p => p.loop) ?? scene.phases[0]
  const size = { w: c.width, h: c.height }
  drawClear(c.getContext('2d')!, scene, (loop?.start ?? 0) + 0.25, size, { kills, colors, frame: frameFor(scene.core, size) })
  return new Promise(res => c.toBlob(b => res(b), 'image/png'))
}

/* Play and pause as solid glyphs, as media players draw them (option A, cable 2026-11-01): Lucide's are hollow outlines
   that looked out of place on the transport. The icon swap (t-icon-swap) crossfades them by data-icon. */
const PauseGlyph = () => <svg className="t-icon" data-icon="a" width={14} height={14} viewBox="0 0 24 24" fill="currentColor" aria-hidden><rect x={6} y={4} width={4} height={16} rx={1.2} /><rect x={14} y={4} width={4} height={16} rx={1.2} /></svg>
const PlayGlyph = () => <svg className="t-icon" data-icon="b" width={14} height={14} viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M7 4.8a1.4 1.4 0 0 1 2.1-1.2l11 6.9a1.6 1.6 0 0 1 0 2.8l-11 6.9A1.4 1.4 0 0 1 7 19.2z" /></svg>
