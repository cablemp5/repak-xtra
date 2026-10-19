// repakxtra: the logo's mesh gradient version, kept but not used (the app draws the solid Wordmark.tsx). To bring it back:
// render <WordmarkMesh/> where <Wordmark/> is used, import ./wordmark-mesh.css in main.tsx and drop the matching .wm rules
// from theme.css (see the notes at the top of wordmark-mesh.css), and run scripts/make-icon.py --mesh for the icon.
// "xtra" is filled with a mesh gradient: long tilted blobs of three bright colors over a bright base, blurred into each
// other and warped by soft noise so the colors flow in streaks. While the app works and on hover the blobs drift.
import { useId } from 'react'
import { usePreviewBatch } from './previews'
import { REPAK, XTRA, LEFT, TOP, W, H, type Glyph } from './Wordmark'
/** The mesh's box (viewBox units) around "xtra" (its letters span about x 2800 to 4950, y 58 to 737) */
const BOX = { x: 2700, y: 0, w: 2350, h: 900 }
/** The blobs: [center x, center y, half width, half height, tilt in degrees, color 1 to 3]. Long and tilted against
 *  each other, so after the blur and the warp they cross as streaks; each letter gets a different mix. */
const BLOBS: [number, number, number, number, number, number][] = [
  [2820, 160, 360, 120, -28, 1],
  [3120, 600, 380, 110, 22, 2],
  [3400, 220, 340, 120, 35, 3],
  [3700, 700, 360, 110, -18, 1],
  [3960, 150, 380, 120, -30, 2],
  [4200, 520, 340, 110, 40, 3],
  [4480, 180, 360, 120, 18, 1],
  [4720, 660, 360, 120, -26, 2],
  [4980, 300, 300, 120, 30, 3],
]

/** `height` in px; `busy`: the app is working (the header passes its mods-loading state; preview runs count anywhere). */
export default function WordmarkMesh({ height, busy = false, className = '' }: { height: number; busy?: boolean; className?: string }) {
  const previews = usePreviewBatch()   // every hook on every render: `busy || usePreviewBatch()` skipped it while busy
  const live = busy || previews !== null
  const id = useId().replace(/:/g, '')   // the filter and the mask need ids unique on the page (header and Credits at once)
  const glyphs = (items: Glyph[]) => items.map(([x, d]) => <path key={x} transform={`translate(${x} 0)`} d={d} />)
  const letters = `translate(${-LEFT} ${TOP}) scale(1 -1)`
  return (
    <svg className={`wm${live ? ' is-live' : ''} ${className}`} viewBox={`0 0 ${W} ${H}`} height={height} width={(height * W) / H}
      role="img" aria-label="repakxtra">
      <defs>
        {/* Blur the blobs into each other, then bend the result along low, stretched noise: flowing streaks */}
        <filter id={`${id}f`} filterUnits="userSpaceOnUse" x={BOX.x} y={BOX.y} width={BOX.w} height={BOX.h} colorInterpolationFilters="sRGB">
          <feGaussianBlur stdDeviation="80" result="soft" />
          <feTurbulence type="fractalNoise" baseFrequency="0.0022 0.0045" numOctaves="2" seed="7" result="noise" />
          <feDisplacementMap in="soft" in2="noise" scale="460" xChannelSelector="R" yChannelSelector="G" />
        </filter>
        <mask id={`${id}m`} maskUnits="userSpaceOnUse" x={BOX.x} y={BOX.y} width={BOX.w} height={BOX.h}>
          <g transform={letters} fill="#fff">{glyphs(XTRA)}</g>
        </mask>
      </defs>
      <g className="wm-repak" transform={letters}>{glyphs(REPAK)}</g>
      <g mask={`url(#${id}m)`}>
        <rect className="wm-base" x={BOX.x} y={BOX.y} width={BOX.w} height={BOX.h} />
        <g filter={`url(#${id}f)`}>
          {BLOBS.map(([cx, cy, rx, ry, tilt, c], i) => (
            <g key={i} transform={`translate(${cx} ${cy}) rotate(${tilt})`}>
              <ellipse className={`wm-blob wm-blob${i + 1} wm-c${c}`} rx={rx} ry={ry} />
            </g>
          ))}
        </g>
      </g>
    </svg>
  )
}
