// repakxtra: the KO Editor view (the header's third tab). Pick a hero, watch its KO prompt play from the game's own files,
// change its colors, and open the normal installer. Layout: heroes, stage, colors.
import { useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Download, Lock, Pause, RotateCcw, Search } from 'lucide-react'
import ColorPicker, { RAINBOW, hexToHsv, hsvToHex } from './ColorPicker'
import { ROLE_ORDER, heroRole } from './heroRoles'
import { RoleIcon } from '../icons/rivals'
import CustomDropdown from '../../components/CustomDropdown'
import { type LoadoutProps } from '../Loadouts'
import { readLoadouts, useView, writeLoadouts } from '../loadoutStore'
import { useKoHeroPortraits } from './portraits'
import { cue } from '../sounds'
import { modalOpen } from '../dialogFocus'
import { type Role, hexOf, shiftHue } from './model'
import { draw, duration, frameFor } from './render'
import { type KoStep, buildKo, koStem } from './export'
import { type Hero, type Loaded, type Progress, forgetHero, loadHero, usmapPath } from './load'
import sceneBackground from './scene-background.jpg'
import { randomizeColors } from './randomize'
import RandomizeButton from './RandomizeButton'
import './ko.css'
import { useSkeletonFill } from '../useSkeletonFill'

type Saved = Record<string, { colors?: Record<string, string>; name?: string; hue?: number }>
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
/** A wait with no count of its own (the editor starting, a hero's first step): the bar creeps toward 90% of `to`. */
const creep = (since: number, now: number, to: number, k = 3) => 2 + (to - 2) * Math.min(0.9, 1 - Math.exp(-(now - since) / 1000 / k))
const stepText = (p: Progress, hero: string) => p.step === 1 ? `Finding ${hero}'s KO prompt in your game files`
  : p.step === 2 ? 'Reading its layers and animations' : p.step === 3 ? 'Turning its textures into pictures'
    : p.total ? `Loading textures, ${p.done ?? 0} of ${p.total}` : 'Loading textures'

export type KoEditorProps = Pick<LoadoutProps, 'alert' | 'blocked'> & { onInstall: (path: string) => Promise<void> }

export default function KoEditor(p: KoEditorProps) {
  const shown = useView() === 'ko'
  const [seen, setSeen] = useState(shown)
  if (shown && !seen) setSeen(true)
  if (!seen) return null
  return <div className="ko" hidden={!shown}><Editor {...p} shown={shown} /></div>
}

function Editor({ onInstall, alert, blocked, shown }: KoEditorProps & { shown: boolean }) {
  const [usmap, setUsmap] = useState<string | null>(null)
  const [heroes, setHeroes] = useState<Hero[] | null>(null)
  const portrait = useKoHeroPortraits(heroes)
  const [listError, setListError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [heroId, setHeroId] = useState<string | null>(() => localStorage.getItem(`${STORE}.hero`))
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [loading, setLoading] = useState<{ hero: Hero; since: number } | null>(null)
  const [progress, setProgress] = useState<Progress | null>(null)
  // the editor starting: the game's property layout, then the heroes in the game files (no counts: the bar creeps)
  const [init, setInit] = useState<{ step: string; at: number } | null>(() => ({ step: "Getting the game's property layout", at: Date.now() }))
  const first = useRef(true) // the first hero after starting: its bar goes on from where starting left it
  const [, setNow] = useState(0)
  useEffect(() => { // the bar creeps on while a step with no count of its own runs
    if (!loading && !init) return
    const t = setInterval(() => setNow(Date.now()), 120)
    return () => clearInterval(t)
  }, [loading, init])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saved, setSaved] = useState<Saved>(readSaved)
  const [focus, setFocus] = useState<string[] | null>(null)
  const [playing, setPlaying] = useState(true)
  const [speed, setSpeed] = useState(0.5)
  const kills = 4
  const [time, setTime] = useState(0)
  const [sceneBg, setSceneBg] = useState(() => localStorage.getItem(`${STORE}.background`) === 'scene')
  const [backdrop, setBackdrop] = useState<HTMLImageElement | null>(null)
  useEffect(() => {
    const img = new Image()
    img.onload = () => setBackdrop(img)
    img.src = sceneBackground
    return () => { img.onload = null }
  }, [])
  const [step, setStep] = useState<KoStep | null>(null)
  const [taken, setTaken] = useState<string | null>(null) // the name a mod already installed has: Install asks before replacing it

  const hero = heroes?.find(h => h.id === heroId) ?? null
  // one bar from the editor starting to the first hero's prompt: starting fills the first 30%, the hero the rest
  const lead = init ? 0 : first.current ? 30 : 0
  const own = progress ? percent(progress, Date.now()) : loading ? creep(loading.since, Date.now(), SPAN[1][1]) : 2
  const bar = init ? creep(init.at, Date.now(), 30, 2) : lead + (100 - lead) * own / 100
  const entry = (hero && saved[hero.id]) || {}
  const name = entry.name ?? (hero ? `${hero.name} KO Prompt` : '')
  const roles = useMemo(() => (loaded?.hero.id === heroId ? loaded.scene.w.roles : []), [loaded, heroId])
  const heroSkeleton = useSkeletonFill<HTMLDivElement>(!heroes && !listError)
  const roleSkeleton = useSkeletonFill<HTMLUListElement>(!roles.length, heroId)
  const hue = entry.hue ?? 0
  // what each role shows and installs: its pick (or the game's color), turned by the hue shift. Only the ones that differ
  const colors = useMemo(() => new Map(roles.flatMap(r => {
    const game = hexOf(r.rgba), hex = shiftHue(entry.colors?.[r.id] ?? game, hue)
    return hex !== game ? [[r.id, hex] as const] : []
  })), [roles, entry.colors, hue])
  const edited = roles.filter(r => colors.has(r.id))
  // Keep the track readable after edits: only its hue follows the main color.
  const defaultMain = roles[0] ? hexOf(roles[0].rgba) : '#346BF1'
  const [mainHue] = hexToHsv((roles[0] ? entry.colors?.[roles[0].id] ?? defaultMain : defaultMain).slice(1))
  const [, mainSaturation, mainValue] = hexToHsv(defaultMain.slice(1))
  const main = '#' + hsvToHex(mainHue, mainSaturation, mainValue)
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
    usmapPath().then(u => { if (!on) return null; setUsmap(u); setInit(i => ({ step: 'Finding the heroes in your game files', at: i?.at ?? Date.now() })); return invoke<Hero[]>('xtra_ko_heroes', { usmapPath: u }) })
      .then(list => { if (on && list) { setHeroes(list); setHeroId(id => (id && list.some(h => h.id === id) ? id : list[0]?.id ?? null)) } })
      .catch(e => on && setListError(String(e)))
      .finally(() => on && setInit(null))
    return () => { on = false }
  }, [])

  useEffect(() => {
    if (!hero || !usmap || loaded?.hero.id === hero.id) return
    let on = true
    localStorage.setItem(`${STORE}.hero`, hero.id)
    setLoadError(null); setFocus(null); setTime(0)
    setLoading({ hero, since: Date.now() }); setProgress(null)
    let read = false // a first read of this hero (the bar showed): a ready cue when it lands
    loadHero(hero, usmap, p => { if (on) { setProgress(p); read = true } }).then(l => { if (on) { setLoaded(l); setPlaying(true); if (read) cue('ready') } }, e => { if (on) { setLoadError(String(e)); cue('warning') } })
      .finally(() => { if (on) { setLoading(null); first.current = false } })
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
    draw(ctx, scene, timeRef.current, size, { kills, colors, focus: focus ?? undefined, checker: !sceneBg || !backdrop, backdrop: sceneBg ? backdrop ?? undefined : undefined, frame: frameFor(scene.core, size, 2.4) })
  }
  const paintRef = useRef(paint)
  paintRef.current = paint
  useEffect(() => {
    const c = canvas.current
    if (!c) return
    // sized here, not per frame: reading the layout every frame costs a reflow
    const fit = () => {
      const rect = c.getBoundingClientRect(), dpr = devicePixelRatio || 1
      if (!rect.width || !rect.height) return
      const width = Math.round(rect.width * dpr), height = Math.round(rect.height * dpr)
      if (c.width !== width || c.height !== height) { c.width = width; c.height = height }
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
  }, [scene, playing, speed, shown, kills, colors, focus, sceneBg, backdrop]) // eslint-disable-line react-hooks/exhaustive-deps
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
      if (e.key !== ' ' || modalOpen() || (e.target as HTMLElement)?.closest('input, textarea, button, [contenteditable]')) return // a dialog on top keeps its Space
      e.preventDefault(); document.querySelector<HTMLButtonElement>('.ko-play')?.click()
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
      // the install replaces a mod of the same file name without asking, so this asks first
      const stem = koStem(name).toLowerCase()
      const installed = replace ? [] : await invoke<{ path: string }[]>('get_pak_files').catch(() => [])
      if (installed.some(m => (m.path.split(/[\\/]/).pop() ?? '').replace(/\..*$/, '').replace(/(_\d+)?_P$/i, '').toLowerCase() === stem)) { setTaken(name); cue('warning'); return }
      // a game update while the app was open: the prompt is read again before anything is built from it
      setStep('Writing the colors')
      const now = await usmapPath()
      const fresh = await invoke<{ widgetJson: string }>('xtra_ko_load', { usmapPath: now, widget: hero.widget })
      if (now !== usmap || fresh.widgetJson !== loaded.widgetJson) {
        forgetHero(hero.id); setUsmap(now); setLoaded(null); cue('warning')
        alert.warning('The game updated', 'Its KO prompt was read again with your colors on it. Check them, then install again.')
        return
      }
      const path = await buildKo({ usmapPath: usmap, widgetJson: loaded.widgetJson, widgetRel: hero.widget, roles, colors, name, step: setStep })
      await onInstall(path)
    } catch (e) {
      cue('warning'); alert.warning('Could not prepare the KO prompt', e instanceof Error ? e.message : String(e))
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
  const why = !scene ? 'Load a KO prompt first' : blocked ? 'Close Marvel Rivals first' : !edited.length ? 'Change a color first' : !name.trim() ? 'Give it a name first' : null
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
        <div ref={heroSkeleton.ref} className="ko-hero-list" role="listbox" aria-label="Hero" aria-busy={!heroes && !listError} onKeyDown={moveInList}>
          {!heroes && !listError && Array.from({ length: heroSkeleton.count }, (_, i) => <div key={i} className="ko-hero is-ghost" aria-hidden="true" />)}
          {listError && <p className="ko-note ko-pad">{listError}</p>}
          {heroes && !shownHeroes.length && <p className="ko-note ko-pad">No hero matches “{query.trim()}”.</p>}
          {ROLE_ORDER.map(group => {
            const inGroup = shownHeroes.filter(h => heroRole(h.id) === group)
            return inGroup.length > 0 && (
              <div key={group} role="group" aria-label={group} className="ko-hero-group">
                <div className="ko-group-head" aria-hidden><RoleIcon role={group} size={20} />{group}</div>
                {inGroup.map(h => (
                  <button key={h.id} type="button" role="option" aria-selected={h.id === heroId} className="ko-hero" onClick={() => { setHeroId(h.id); cue('select') }}
                    tabIndex={h.id === (shownHeroes.some(x => x.id === heroId) ? heroId : shownHeroes[0]?.id) ? 0 : -1}>
                    <img src={portrait(h.id)} alt="" />
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
        <div className="ko-preview-options">
          <div className="ob-seg" role="radiogroup" aria-label="Preview background">
            <button type="button" role="radio" aria-checked={!sceneBg} onClick={() => { setSceneBg(false); localStorage.setItem(`${STORE}.background`, 'grid'); cue('toggle') }}>Grid</button>
            <button type="button" role="radio" aria-checked={sceneBg} onClick={() => { setSceneBg(true); localStorage.setItem(`${STORE}.background`, 'scene'); cue('toggle') }}>Scene</button>
          </div>
        </div>

          <canvas ref={canvas} className={scene ? 'is-ready' : ''} aria-label={hero ? `${hero.name}'s KO prompt` : 'KO prompt'} />
          {!scene && (
            <div className="ko-stage-msg" role="status">
              {loadError ? <><strong>Could not open this KO prompt</strong><span>{loadError}</span></>
                : loading || (!listError && !scene) ? (
                  <div className="ko-load">
                    <strong>{loading ? `Opening ${loading.hero.name}'s KO prompt` : 'Initializing the KO prompt editor'}</strong>
                    <div className="ko-load-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(bar)}>
                      <span style={{ width: `${bar}%` }} />
                    </div>
                    <span key={progress ? `${progress.step}` : init?.step ?? 'wait'} className="ko-load-step">
                      <span className="ko-shimmer">{progress ? stepText(progress, loading?.hero.name ?? 'the hero') : loading ? `Finding ${loading.hero.name}'s KO prompt in your game files` : init?.step ?? 'Starting'}</span>
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
        <div className="ko-random">
          <RandomizeButton disabled={!roles.length} onRandomize={options => {
            save({ colors: randomizeColors(roles, colors, options), hue: 0 }); cue('select')
          }} />
        </div>
        <ul key={heroId ?? 'none'} ref={roleSkeleton.ref} className="ko-roles" aria-busy={!roles.length} onMouseLeave={() => setFocus(null)}>
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
          {!roles.length && Array.from({ length: roleSkeleton.count }, (_, i) => <li key={i} className="ko-role is-ghost" aria-hidden="true" />)}
        </ul>
        <div className="ko-out">
          <label className="ko-label" htmlFor="ko-name">Name</label>
          <input id="ko-name" className="ko-input" value={name} maxLength={60} onChange={e => save({ name: e.target.value })} disabled={!hero} />
          <button type="button" className={`lo-text-btn ko-install${step ? ' is-working' : why ? ' is-locked' : ' is-primary'}`}
            onClick={() => { if (!step) void install() }} aria-busy={Boolean(step)} aria-disabled={!step && Boolean(why)} disabled={Boolean(step) || Boolean(why)}
            title={why ?? 'Choose installation options in the install window'} aria-describedby={why && !step ? 'ko-install-why' : undefined}>
            {step ? <span key={step} className="t-text-in"><span className="t-shimmer">{step}</span></span>
              : <span className="ko-btn-in">{why ? <Lock size={16} aria-hidden /> : <Download size={16} aria-hidden />}Install</span>}
          </button>
          {why && !step && <p id="ko-install-why" className="ko-note">{why}.</p>}
          {taken === name && !step && !why && (
            <div className="ko-taken" role="alert">
              <span>A mod named {name.trim()} is already installed. Replace it?</span>
              <div><button type="button" className="lo-text-btn" onClick={() => { setTaken(null); cue('close') }}>Cancel</button>
                <button type="button" className="lo-text-btn is-primary" onClick={() => void install(true)}>Replace</button></div>
            </div>
          )}
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

/* Play and pause as solid glyphs, as media players draw them (option A, cable 2026-11-01): Lucide's are hollow outlines
   that looked out of place on the transport. The icon swap (t-icon-swap) crossfades them by data-icon. */
const PauseGlyph = () => <Pause className="t-icon" data-icon="a" size={14} fill="currentColor" stroke="none" aria-hidden />
const PlayGlyph = () => <svg className="t-icon" data-icon="b" width={14} height={14} viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M7 4.8a1.4 1.4 0 0 1 2.1-1.2l11 6.9a1.6 1.6 0 0 1 0 2.8l-11 6.9A1.4 1.4 0 0 1 7 19.2z" /></svg>
