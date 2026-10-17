"""repakxtra's app icon: the logo's dotted x (custom/Wordmark.tsx), 7 by 7 dots in its saturated blues, on transparency.
Writes icons/RepakIcon.png (512) and icons/RepakIcon.ico (16 to 256), which tauri.conf.json bundles into the exe: the
taskbar, the window and the desktop shortcut all show it. Each size is drawn on its own with the dots on whole pixels,
so small sizes stay crisp instead of blurring the grid. Run from repak-x/ with any Python that has Pillow:
    python scripts/make-icon.py [--test-ico path.ico] [--sheet contact.png]
--test-ico writes the same x in the test build's green, for the test copy's desktop shortcut (kept outside the repo).
--sheet writes the 16 to 48 px sizes on dark and light, to check them."""
import sys
from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parents[1]
X = ['XX...XX',   # the x from Wordmark.tsx's LETTERS
     'XX...XX',
     '.XX.XX.',
     '..XXX..',
     '.XX.XX.',
     'XX...XX',
     'XX...XX']
BLUES = ['#1f5bff', '#3d74ff', '#0f46e8', '#4a80ff']   # Wordmark's --wm-0..3
GREENS = ['#3ecf6e', '#5fe08a', '#27b356', '#72e89b']  # its test-build colors
SIZES = (16, 20, 24, 32, 40, 48, 64, 128, 256)
SS = 4  # drawn 4x, then averaged down: whole-pixel dots stay sharp, rounded corners stay smooth


def shade(n, r, c):
    """The same texture as the logo's x (Wordmark.tsx DOTS)."""
    return [0, 0, 0, 0, 0, 0, 0, 1, 2, 3][(n * 7 + c * 3 + r * 5) % 10]


def render(size, colors=BLUES):
    cell = max(2, int(size * 0.92) // 7)           # whole pixels per dot cell, about 4% margin each side
    dot = cell if cell < 3 else cell - max(1, round(cell * 0.14))  # 16 and 20 px: touching dots; larger: a gap of 1 px or more
    left = (size - 7 * cell) // 2
    top = (size - 7 * cell) // 2
    radius = 0 if dot < 4 else dot * 0.25
    big = Image.new('RGBA', (size * SS, size * SS), (0, 0, 0, 0))
    draw = ImageDraw.Draw(big)
    n = 0
    for r, line in enumerate(X):
        for c, v in enumerate(line):
            if v != 'X':
                continue
            x, y = (left + c * cell + (cell - dot) // 2) * SS, (top + r * cell + (cell - dot) // 2) * SS
            draw.rounded_rectangle((x, y, x + dot * SS - 1, y + dot * SS - 1), radius=radius * SS, fill=colors[shade(n, r, c)])
            n += 1
    return big.resize((size, size), Image.BOX)


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
