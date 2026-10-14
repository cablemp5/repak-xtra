"""repakxtra's app icon: the lowercase x from the title (Geist, weight 800) in its blue on a transparent background.
Writes icons/RepakIcon.png (512) and icons/RepakIcon.ico (16 to 256), which tauri.conf.json bundles into the exe: the
taskbar, the window and the desktop shortcut all show it. Run from repak-x/ with any Python that has Pillow:
    python scripts/make-icon.py"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parents[1]
FONT = HERE / "src" / "custom" / "fonts" / "Geist-Variable.ttf"
BLUE = (0x34, 0x6B, 0xF1, 255)   # the title's x (--accent-primary)
FILL = 0.86                      # the glyph's share of the square: big enough to read at 16 px


def render(size=1024):
    font = ImageFont.truetype(str(FONT), size)
    font.set_variation_by_axes([800])   # the title's weight
    probe = Image.new("L", (size * 2, size * 2), 0)
    ImageDraw.Draw(probe).text((size // 2, size // 4), "x", font=font, fill=255)
    glyph = probe.crop(probe.getbbox())
    k = FILL * size / max(glyph.size)
    glyph = glyph.resize((round(glyph.width * k), round(glyph.height * k)), Image.LANCZOS)
    icon = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    color = Image.new("RGBA", glyph.size, BLUE)
    icon.paste(color, ((size - glyph.width) // 2, (size - glyph.height) // 2), glyph)
    return icon


if __name__ == "__main__":
    big = render()
    assert big.getpixel((0, 0))[3] == 0 and big.getpixel((512, 512))[:3] == BLUE[:3], "transparent corners, blue center"
    big.resize((512, 512), Image.LANCZOS).save(HERE / "icons" / "RepakIcon.png")
    big.save(HERE / "icons" / "RepakIcon.ico", sizes=[(s, s) for s in (16, 20, 24, 32, 40, 48, 64, 128, 256)])
    # The same x inside the app: the splash and Discord widget images, and ModularLogo's two masks (its accent-colored
    # R layer draws the x in the title's blue; the theme-colored X layer is left empty)
    art = HERE / "src" / "assets" / "app-icons"
    for s in (512, 256):
        big.resize((s, s), Image.LANCZOS).save(art / f"RepakIcon-x{s}.png")
    mask = Image.new("RGBA", big.size, (255, 255, 255, 0))
    mask.putalpha(big.getchannel("A"))
    mask.resize((512, 512), Image.LANCZOS).save(art / "logomask_R.png")
    Image.new("RGBA", (512, 512), (0, 0, 0, 0)).save(art / "logomask_X.png")
    print("wrote icons/RepakIcon.png, icons/RepakIcon.ico and the app's logo images in src/assets/app-icons")
