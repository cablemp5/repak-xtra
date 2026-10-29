"""repakxtra's app icon: the logo's lowercase x (custom/Wordmark.tsx), Geist 800, in the logo's solid color, centered on
transparency. With --mesh it is filled with the logo's old mesh gradient instead (the long tilted color blobs that cross
the logo's x, blurred into each other and bent along smooth noise, over the base color; custom/WordmarkMesh.tsx). Writes icons/RepakIcon.png (512) and icons/RepakIcon.ico (16 to
256), which tauri.conf.json bundles into the exe: the taskbar, the window and the desktop shortcut all show it, and
icons/builds/ (each test, dev and repakxploit copy's own color, picked by build.rs). Colors are
theme.css .wm's. Run from repak-x/ with any Python that has Pillow and numpy:
    python scripts/make-icon.py [--mesh] [--test-ico path.ico] [--sheet contact.png]
--test-ico writes the same icon in the test build's green, for the test copy's desktop shortcut (kept outside the repo).
--sheet writes the 16 to 48 px sizes on dark and light, to check them."""
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parents[1]
# Wordmark.tsx's x (font units, y up)
X = [(45, 0), (233, 272), (47, 540), (247, 540), (345, 386), (441, 540), (645, 540), (459, 272),
     (648, 0), (448, 0), (349, 160), (249, 0)]   # Geist 800's x
SOLID, TEST_SOLID = '#346bf1', '#12c85a'   # theme.css .wm --wm-xtra, and its test-build color
BLUES = ['#2a4bff', '#00e1ff', '#6a3dff', '#1d8bff']   # theme.css .wm: --wm-base, then --wm-c1..3
GREENS = ['#12c85a', '#b6ff2e', '#00d4b0', '#00e070']  # its test-build colors
# Wordmark.tsx BLOBS (viewBox units, y down): center, half width, half height, tilt in degrees, color 1 to 3. The logo's x
# sits at viewBox x 2800 + its font u, y 725 - its font v
BLOBS = [(2820, 160, 360, 120, -28, 1), (3120, 600, 380, 110, 22, 2), (3400, 220, 340, 120, 35, 3),
         (3700, 700, 360, 110, -18, 1), (3960, 150, 380, 120, -30, 2), (4200, 520, 340, 110, 40, 3),
         (4480, 180, 360, 120, 18, 1), (4720, 660, 360, 120, -26, 2), (4980, 300, 300, 120, 30, 3)]
X0, BASELINE = 2800, 725   # the x's glyph origin in the logo's viewBox (offset 2840 minus LEFT 40)
BLUR, WARP = 80, 460       # Wordmark.tsx's feGaussianBlur stdDeviation and feDisplacementMap scale (viewBox units)
WAVE = (455, 222)          # its noise's wavelengths across and down (1 / baseFrequency)
SPREAD = 2.2              # the icon's x shows this much of the mesh around its center: the logo's x alone holds one or two
                          # streaks, the whole mesh squeezed in would be noise
UNIT = 4                   # viewBox units per cell of the color field (it is smooth: drawn coarse, sampled smoothly)
SIZES = (16, 20, 24, 32, 40, 48, 64, 128, 256)
SS = 4  # drawn 4x, then averaged down: edges stay smooth


def rgb(h):
    return np.array([int(h[i:i + 2], 16) for i in (1, 3, 5)], float)


def blur(a, sigma):
    """Separable Gaussian blur of an (h, w, c) array; outside counts as empty, like an SVG filter's edge."""
    r = int(sigma * 3)
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    k /= k.sum()
    a = np.apply_along_axis(lambda m: np.convolve(m, k, 'same'), 0, a)
    return np.apply_along_axis(lambda m: np.convolve(m, k, 'same'), 1, a)


def sample(a, fx, fy):
    """Bilinear lookup of a at fractional cells (fx, fy), clamped to its edge."""
    h, w = a.shape[:2]
    fx, fy = np.clip(fx, 0, w - 1.001), np.clip(fy, 0, h - 1.001)
    x0, y0 = fx.astype(int), fy.astype(int)
    tx, ty = (fx - x0)[..., None], (fy - y0)[..., None]
    top = a[y0, x0] * (1 - tx) + a[y0, x0 + 1] * tx
    bottom = a[y0 + 1, x0] * (1 - tx) + a[y0 + 1, x0 + 1] * tx
    return top * (1 - ty) + bottom * ty


def mesh(colors):
    """The logo's mesh around its x, as a field of colors in viewBox cells: (field, left, top). The blobs are painted
    over transparency, blurred, bent along smooth two-octave noise (fixed seed), then laid over the base color."""
    left, top, w, h = X0 - 300, -400, 2600, 1700
    cw, ch = w // UNIT, h // UNIT
    yy, xx = (np.mgrid[0:ch, 0:cw] * UNIT).astype(float)
    xx += left
    yy += top
    layer = np.zeros((ch, cw, 4))   # premultiplied color and alpha
    for cx, cy, rx, ry, tilt, c in BLOBS:
        t = np.radians(tilt)
        dx, dy = xx - cx, yy - cy
        inside = ((dx * np.cos(t) + dy * np.sin(t)) / rx) ** 2 + ((-dx * np.sin(t) + dy * np.cos(t)) / ry) ** 2 <= 1
        layer[inside] = np.append(rgb(colors[c]), 1)
    layer = blur(layer, BLUR / UNIT)
    rng = np.random.default_rng(7)
    noise = np.zeros((ch, cw, 2))
    for octave, amp in ((1, 2 / 3), (2, 1 / 3)):
        gw, gh = int(w * octave / WAVE[0]) + 2, int(h * octave / WAVE[1]) + 2
        grid = rng.random((gh, gw, 2))
        noise += amp * sample(grid, np.linspace(0, gw - 1, cw)[None, :].repeat(ch, 0), np.linspace(0, gh - 1, ch)[:, None].repeat(cw, 1))
    bent = sample(layer, (xx - left + WARP * (noise[..., 0] - 0.5)) / UNIT, (yy - top + WARP * (noise[..., 1] - 0.5)) / UNIT)
    field = rgb(colors[0]) * (1 - bent[..., 3:]) + bent[..., :3]
    return field, left, top


def render(size, colors=SOLID):   # colors: one '#rrggbb' for the solid icon, or a mesh's [base, c1, c2, c3]
    n = size * SS
    pts = X
    u0, u1 = min(u for u, _ in pts), max(u for u, _ in pts)
    v0, v1 = min(v for _, v in pts), max(v for _, v in pts)
    scale = n * 0.92 / max(u1 - u0, v1 - v0)                # about 4% margin on the long side
    ox, oy = (n - (u1 - u0) * scale) / 2 - u0 * scale, (n + (v1 - v0) * scale) / 2 + v0 * scale  # centered

    def shape(poly):
        im = Image.new('L', (n, n), 0)
        ImageDraw.Draw(im).polygon([(ox + u * scale, oy - v * scale) for u, v in poly], fill=255)
        return np.asarray(im, float)[..., None] / 255

    # Each pixel back to the logo's viewBox (u across, v up from the baseline), then its color from the mesh
    yy, xx = np.mgrid[0:n, 0:n].astype(float)
    cu, cv = (u0 + u1) / 2, (v0 + v1) / 2
    vx = X0 + cu + ((xx - ox) / scale - cu) * SPREAD
    vy = BASELINE - cv - ((oy - yy) / scale - cv) * SPREAD
    if isinstance(colors, str):
        fill = np.broadcast_to(rgb(colors), (n, n, 3))
    else:
        field, left, top = mesh(colors)
        fill = sample(field, (vx - left) / UNIT, (vy - top) / UNIT)
    img = np.dstack([fill, shape(X) * 255]).round().clip(0, 255).astype(np.uint8)
    return Image.fromarray(img, 'RGBA').resize((size, size), Image.BOX)


def save_ico(path, colors=SOLID, degrees=0):
    frames = [render(s, colors) for s in sorted(SIZES, reverse=True)]
    if degrees:
        frames = [turned(f, degrees) for f in frames]
    frames[0].save(path, sizes=[f.size for f in frames], append_images=frames[1:])


# Each other copy's exe icon (build.rs picks one; Task Manager and Explorer show it): the stable icon's hues turned as far
# as xtra_buildmark.rs turns the window icon, so the two always match
BUILDS = {'test': -80, 'dev': 170, 'xploit': 140, 'xploit-test': 60, 'xploit-dev': 100}


def turned(img, degrees):
    """The icon with every hue turned, saturation, brightness and alpha kept: what xtra_buildmark.rs does at run time."""
    h, s, v = img.convert('RGB').convert('HSV').split()
    h = h.point(lambda x: int(x + degrees / 360 * 256) % 256)
    out = Image.merge('HSV', (h, s, v)).convert('RGB').convert('RGBA')
    out.putalpha(img.getchannel('A'))
    return out


def contact_sheet(path, BLUE, GREEN):
    """16 to 48 px on dark and light: the blue icon, the test shortcut's green one, then the window icons the dev and test
    copies turn out of the blue one (xtra_buildmark.rs: +170 and -80 degrees)."""
    pad, cell = 12, 60
    rows = [lambda s: render(s, BLUE), lambda s: render(s, GREEN),
            lambda s: turned(render(s, BLUE), 170), lambda s: turned(render(s, BLUE), -80)]
    sheet = Image.new('RGBA', (pad + cell * 8, pad + cell * len(rows)), (128, 128, 128, 255))
    for row, draw in enumerate(rows):
        for half, bg in enumerate([(10, 10, 10, 255), (245, 245, 245, 255)]):
            for col, s in enumerate((16, 24, 32, 48)):
                tile = Image.new('RGBA', (48, 48), bg)
                tile.alpha_composite(draw(s), ((48 - s) // 2, (48 - s) // 2))
                sheet.paste(tile, (pad + (half * 4 + col) * cell, pad + row * cell))
    sheet.resize((sheet.width * 2, sheet.height * 2), Image.NEAREST).save(path)


if __name__ == '__main__':
    args = sys.argv[1:]
    BLUE, GREEN = (BLUES, GREENS) if '--mesh' in args else (SOLID, TEST_SOLID)
    big = render(512, BLUE)
    assert big.getpixel((0, 0))[3] == 0, 'transparent corners'
    big.save(HERE / 'icons' / 'RepakIcon.png', optimize=True)
    save_ico(HERE / 'icons' / 'RepakIcon.ico', BLUE)
    # The same x inside the app: the splash image and ModularLogo's accent-colored R mask. RepakIcon-x256.png stays
    # Repak X's own logo (the Discord widget shows it), and ModularLogo's X mask stays empty
    art = HERE / 'src' / 'assets' / 'app-icons'
    big.save(art / 'RepakIcon-x512.png', optimize=True)
    mask = Image.new('RGBA', big.size, (255, 255, 255, 0))
    mask.putalpha(big.getchannel('A'))
    mask.save(art / 'logomask_R.png', optimize=True)
    builds = HERE / 'icons' / 'builds'
    builds.mkdir(exist_ok=True)
    for kind, degrees in BUILDS.items():
        save_ico(builds / f'RepakIcon-{kind}.ico', BLUE, degrees)
    if '--test-ico' in args:
        save_ico(args[args.index('--test-ico') + 1], GREEN)
    if '--sheet' in args:
        contact_sheet(args[args.index('--sheet') + 1], BLUE, GREEN)
    print('wrote icons/RepakIcon.png, icons/RepakIcon.ico, each build\'s icons/builds/*.ico and the app\'s logo images in src/assets/app-icons')
