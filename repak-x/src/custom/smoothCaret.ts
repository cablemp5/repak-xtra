// repakxtra: a smooth caret in every text field, in every window (main.tsx). The field's own caret is hidden
// (theme.css .has-smooth-caret) and one bar glides to where it would be, blinking while it rests. Animations off
// (html[data-motion="off"]): nothing is drawn and the field keeps its own caret. A selection shows the field's own
// highlight. Where the bar goes comes from a hidden copy of the field (same font, padding, width, and alignment) holding
// its text with a marker at the caret.

const caret = document.createElement('div')
caret.className = 'smooth-caret'
caret.hidden = true
const mirror = document.createElement('div')
mirror.setAttribute('aria-hidden', 'true')
mirror.style.cssText = 'position:fixed;top:0;left:0;visibility:hidden;overflow:hidden;pointer-events:none'
const marker = document.createElement('span')
marker.textContent = String.fromCharCode(0x200b) // zero width: the caret's spot, one line tall
document.body.append(caret, mirror)

type Field = HTMLInputElement | HTMLTextAreaElement
// number and email inputs have no selection to read (selectionStart is null): they keep their own caret
const isField = (t: EventTarget | null): t is Field => t instanceof HTMLTextAreaElement ||
  (t instanceof HTMLInputElement && /^(text|search|url|password|tel|)$/.test(t.type))
const COPIED = ['boxSizing', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontStretch', 'letterSpacing', 'wordSpacing', 'lineHeight',
  'textTransform', 'textIndent', 'textAlign', 'tabSize', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'direction'] as const

let field: Field | null = null
let shown = false
let last = ''
let ink = '' // the field's own caret color, read when it is first shown
let frame = 0

function hide() {
  field?.classList.remove('has-smooth-caret')
  caret.hidden = true
  shown = false
}

function place() {
  frame = 0
  const el = field
  if (!el || document.activeElement !== el || document.documentElement.dataset.motion === 'off' || el.readOnly || el.disabled ||
    el.selectionStart === null || el.selectionStart !== el.selectionEnd) return hide()
  const cs = getComputedStyle(el)
  if (!shown) ink = cs.caretColor === 'auto' || cs.caretColor === 'transparent' ? cs.color : cs.caretColor // read before the class hides it
  caret.style.background = cs.getPropertyValue('--smooth-caret').trim() || ink // a field can set its own (an empty one its placeholder's gray)
  const area = el instanceof HTMLTextAreaElement
  for (const k of COPIED) mirror.style[k] = cs[k]
  mirror.style.boxSizing = 'content-box'
  mirror.style.width = `${el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)}px` // without the scrollbar
  mirror.style.whiteSpace = area ? 'pre-wrap' : 'pre'
  mirror.style.overflowWrap = area ? cs.overflowWrap : 'normal'
  mirror.style.setProperty('text-wrap-style', cs.getPropertyValue('text-wrap-style'))
  // the whole text, so a centered or balanced line sits where the field's does. Mid-text the caret is a collapsed range
  // in that unbroken text (a marker there would add a line break the field does not have), at the end the marker
  const text = el.type === 'password' ? String.fromCharCode(0x2022).repeat(el.value.length) : el.value
  const start = el.selectionStart
  mirror.textContent = text
  let left: number, top: number, line: number
  if (start < text.length) {
    const range = document.createRange()
    range.setStart(mirror.firstChild!, start)
    const at = range.getClientRects()[0] ?? range.getBoundingClientRect()
    const m = mirror.getBoundingClientRect()
    left = at.left - m.left; top = at.top - m.top; line = at.height
  } else {
    mirror.append(marker)
    left = marker.offsetLeft; top = marker.offsetTop; line = marker.offsetHeight
  }

  const r = el.getBoundingClientRect()
  const size = parseFloat(cs.fontSize)
  line ||= size * 1.2
  const height = Math.round(Math.min(line, size * 1.3))
  const x = r.left + el.clientLeft + left - el.scrollLeft
  // an input centers its one line in its height, a textarea stacks lines from its top padding
  const y = area ? r.top + el.clientTop + top - el.scrollTop + (line - height) / 2 : r.top + (r.height - height) / 2
  if (x < r.left - 1 || x > r.right + 1 || y < r.top - 1 || y + height > r.bottom + 1) return hide() // scrolled out of the field

  el.classList.add('has-smooth-caret')
  const at = `translate(${Math.round(x)}px, ${Math.round(y)}px)`
  caret.style.transition = shown ? '' : 'none' // a newly focused field: the bar starts there, it does not glide in
  caret.style.height = `${height}px`
  caret.style.transform = at
  caret.hidden = false
  shown = true
  if (at !== last) { caret.style.animation = 'none'; void caret.offsetWidth; caret.style.animation = '' } // solid while it moves, blinks once it rests
  last = at
}

const update = () => { if (!frame) frame = requestAnimationFrame(place) }
document.addEventListener('focusin', e => {
  if (!isField(e.target)) return
  if (field !== e.target) hide()
  field = e.target
  update()
}, true)
document.addEventListener('focusout', e => { if (e.target === field) { hide(); field = null } }, true)
for (const type of ['input', 'selectionchange', 'keydown', 'pointerup', 'scroll']) document.addEventListener(type, () => { if (field) update() }, true)
window.addEventListener('resize', () => { if (field) update() })
