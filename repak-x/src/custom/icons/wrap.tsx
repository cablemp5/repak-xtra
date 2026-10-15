// repakxtra: adapters so Lucide icons accept the props upstream passes to react-icons and MUI icons.
import { forwardRef, type ComponentType } from 'react'
import type { LucideProps } from 'lucide-react'

type Lucide = ComponentType<LucideProps>
const STROKE = 1.75

// Upstream paints some icons with the Settings accent swatches (Repak red etc.); icons stay neutral instead
const ACCENT_SWATCHES = ['#be1c1c', '#4a9eff', '#9c27b0', '#4caf50', '#ff9800', '#ff96bc']
const neutral = (color?: string) => (color && ACCENT_SWATCHES.includes(color.toLowerCase()) ? 'currentColor' : color)
const neutralStyle = (style?: any) => (style?.color ? { ...style, color: neutral(style.color) } : style)

// react-icons default to 1em, so icons follow the surrounding text size
export const riIcon = (Icon: Lucide) =>
  forwardRef<SVGSVGElement, any>(({ size, title, color, style, ...rest }, ref) => (
    <Icon ref={ref} size={size ?? '1em'} strokeWidth={STROKE} aria-label={title} color={neutral(color)} style={neutralStyle(style)} {...rest} />
  ))

const MUI_SIZE: Record<string, number | string> = { small: 20, medium: 24, large: 35, inherit: '1em' }

export const muiIcon = (Icon: Lucide) =>
  forwardRef<SVGSVGElement, any>(({ fontSize = 'medium', sx, htmlColor, titleAccess, style, ...rest }, ref) => {
    const sxStyle = sx && typeof sx === 'object' && !Array.isArray(sx) ? sx : {}
    const size = sxStyle.fontSize ?? style?.fontSize ?? MUI_SIZE[fontSize] ?? 24
    return (
      <Icon ref={ref} size={size} color={neutral(htmlColor)} strokeWidth={STROKE} aria-label={titleAccess}
        style={neutralStyle({ ...sxStyle, ...style })} {...rest} />
    )
  })
