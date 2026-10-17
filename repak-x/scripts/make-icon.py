"""repakxtra's app icon: the logo's lowercase x (custom/Wordmark.tsx), Geist 800, filled with the logo's mesh gradient (a
deep blue base under three radial glows: ice blue top left, bright blue top right, azure bottom middle), centered on
transparency. Writes icons/RepakIcon.png (512) and icons/RepakIcon.ico (16 to
256), which tauri.conf.json bundles into the exe: the taskbar, the window and the desktop shortcut all show it. Colors are
theme.css .wm's. Run from repak-x/ with any Python that has Pillow and numpy:
    python scripts/make-icon.py [--test-ico path.ico] [--sheet contact.png]
--test-ico writes the same icon in the test build's green, for the test copy's desktop shortcut (kept outside the repo).
--sheet writes the 16 to 48 px sizes on dark and light, to check them."""
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parents[1]
# Wordmark.tsx's x (font units, y up)
X = [(45, 0), (233, 272), (47, 540), (247, 540), (345, 386), (441, 540), (645, 540), (459, 272),
     (648, 0), (448, 0), (349, 160), (249, 0)]
BLUES = ['#0a2499', '#9fd0ff', '#1f5bff', '#2f7dff']   # theme.css .wm: --wm-base, then glows --wm-c1..3
GREENS = ['#27b356', '#c6f7d6', '#5fe08a', '#3ecf6e']  # its test-build colors
GLOWS = [(0.0, 1.0), (1.0, 1.0), (0.5, 0.0)]           # glow centers as fractions of the x's box (y up): top left, top right, bottom middle
RADIUS = 0.8                                           # in x heights
SIZES = (16, 20, 24, 32, 40, 48, 64, 128, 256)
SS = 4  # drawn 4x, then averaged down: edges stay smooth


def rgb(h):
    return np.array([int(h[i:i + 2], 16) for i in (1, 3, 5)], float)


def render(size, colors=BLUES):
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

    yy, xx = np.mgrid[0:n, 0:n].astype(float)
    xu0, xu1 = min(u for u, _ in X), max(u for u, _ in X)
    xh = max(v for _, v in X)
    fill = np.zeros((n, n, 3)) + rgb(colors[0])
    for (fu, fv), c in zip(GLOWS, colors[1:]):
        cx, cy = ox + (xu0 + fu * (xu1 - xu0)) * scale, oy - fv * xh * scale
        d = np.hypot(xx - cx, yy - cy) / (RADIUS * xh * scale)
        a = np.clip((1 - d) / 0.7, 0, 1)[..., None]  # the logo's stops: opaque to 30% of the radius, then fading out
        fill = fill * (1 - a) + rgb(c) * a
    img = np.dstack([fill, shape(X) * 255]).round().astype(np.uint8)
    return Image.fromarray(img, 'RGBA').resize((size, size), Image.BOX)


def save_ico(path, colors=BLUES):
    frames = [render(s, colors) for s in sorted(SIZES, reverse=True)]
    frames[0].save(path, sizes=[f.size for f in frames], append_images=frames[1:])


def contact_sheet(path):
    pad, cell = 12, 60
    sheet = Image.new('RGBA', (pad + cell * 8, pad + cell * 2), (128, 128, 128, 255))
    for row, colors in enumerate([BLUES, GREENS]):
        for half, bg in enumerate([(10, 10, 10, 255), (245, 245, 245, 255)]):
            for col, s in enumerate((16, 24, 32, 48)):
                tile = Image.new('RGBA', (48, 48), bg)
                tile.alpha_composite(render(s, colors), ((48 - s) // 2, (48 - s) // 2))
                sheet.paste(tile, (pad + (half * 4 + col) * cell, pad + row * cell))
    sheet.resize((sheet.width * 2, sheet.height * 2), Image.NEAREST).save(path)


if __name__ == '__main__':
    args = sys.argv[1:]
    big = render(512)
    assert big.getpixel((0, 0))[3] == 0, 'transparent corners'
    big.save(HERE / 'icons' / 'RepakIcon.png', optimize=True)
    save_ico(HERE / 'icons' / 'RepakIcon.ico')
    # The same x inside the app: the splash image and ModularLogo's accent-colored R mask. RepakIcon-x256.png stays
    # Repak X's own logo (the Discord widget shows it), and ModularLogo's X mask stays empty
    art = HERE / 'src' / 'assets' / 'app-icons'
    big.save(art / 'RepakIcon-x512.png', optimize=True)
    mask = Image.new('RGBA', big.size, (255, 255, 255, 0))
    mask.putalpha(big.getchannel('A'))
    mask.save(art / 'logomask_R.png', optimize=True)
    if '--test-ico' in args:
        save_ico(args[args.index('--test-ico') + 1], GREENS)
    if '--sheet' in args:
        contact_sheet(args[args.index('--sheet') + 1])
    print('wrote icons/RepakIcon.png, icons/RepakIcon.ico and the app\'s logo images in src/assets/app-icons')
