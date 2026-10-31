// repakxtra: the page turn of Skiper UI's Carousel_005 (a Swiper "creative" effect), redone in CSS (theme.css .cr-slide)
// without Swiper. The picture being left sinks back and darkens while the new one slides in over it: from the right
// going forward, from the left going back. A loadout's previews (loadoutBits.tsx) page with it. Animations off: a plain swap.
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'

type Leaving = { slide: string | number; node: ReactNode; dir: 1 | -1 }

/** `slide` names what is on screen (a change turns the page), `dir` is 1 for next and -1 for previous. The parent is
 *  `position: relative` with `overflow: hidden`, sized without the slide (the slide leaving is laid over it). */
export function CarouselSlide({ slide, dir, children }: { slide: string | number; dir: 1 | -1; children: ReactNode }) {
  const [current, setCurrent] = useState(slide)
  const [leaving, setLeaving] = useState<Leaving | null>(null)
  const lastNode = useRef(children)
  useLayoutEffect(() => { lastNode.current = children })
  // set while rendering, so the slide on screen keeps its element (and its loaded picture) as it turns into the leaving one
  if (slide !== current) {
    setCurrent(slide)
    setLeaving(document.documentElement.dataset.motion === 'off' ? null : { slide: current, node: lastNode.current, dir })
  }
  const way = leaving?.dir === -1 ? 'is-prev' : 'is-next'
  return <>
    {leaving && leaving.slide !== slide && (
      <span key={leaving.slide} className={`cr-slide is-out ${way}`} aria-hidden="true"
        onAnimationEnd={e => { if (e.target === e.currentTarget && !e.pseudoElement) setLeaving(null) }}>{leaving.node}</span>
    )}
    <span key={slide} className={`cr-slide${leaving ? ` is-in ${way}` : ''}`}>{children}</span>
  </>
}
