"""The chart page's app icons (chart 1.61.0, plan step 7): the gold A on black, in the page's own Cinzel Bold.

Run by hand from the repo root, `python3 tools/app_icons.py`; it rewrites live/icons/: app-192.png and app-512.png (purpose
"any": the tile with rounded corners and a thin gold trim), app-maskable-512.png (purpose "maskable": full bleed, the
letter inside the 80 percent safe circle) and favicon-32.png. live/manifest.json names them. Needs Pillow
(`python3 -m pip install pillow`); nothing at run time or in the tests uses it.
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[1]
SPEC = dict(letter="A", font=ROOT / "live" / "fonts" / "Cinzel-Bold.woff2",
            fill_top="#15130F", fill_bottom="#0A0908",          # the logo tile's black (house style V2)
            trim="#C9A55C", trim_alpha=0.55, trim_width=0.012,  # gold trim
            color="#E2C687", glow="#C9A55C",                    # the wordmark's gold
            letter_height=0.54, letter_height_maskable=0.42)
OUT = ROOT / "live" / "icons"
SS = 4  # drawn at 4 times the size, then scaled down, for smooth edges


def _rgb(hex_color: str) -> tuple[int, int, int]:
    h = hex_color.lstrip("#")
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def _gradient(size: int, top: str, bottom: str) -> Image.Image:
    """A diagonal gradient from the top left (top) to the bottom right (bottom)."""
    a, b = _rgb(top), _rgb(bottom)
    small = Image.new("RGB", (64, 64))
    px = small.load()
    for y in range(64):
        for x in range(64):
            t = (x + y) / 126
            px[x, y] = tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))
    return small.resize((size, size), Image.BILINEAR).convert("RGBA")


def _letter(size: int, letter: str, font_path: Path, height: float, color: str, nudge_x: float = 0.0,
            glow: str | None = None) -> Image.Image:
    """The letter alone on a transparent layer, its cap height `height` of the side, centred on its own outline."""
    font = ImageFont.truetype(str(font_path), 100)
    x0, y0, x1, y1 = font.getbbox(letter)
    font = ImageFont.truetype(str(font_path), round(100 * size * height / (y1 - y0)))
    x0, y0, x1, y1 = font.getbbox(letter)
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ox = (size - (x1 - x0)) / 2 - x0 + nudge_x * size
    oy = (size - (y1 - y0)) / 2 - y0
    ImageDraw.Draw(layer).text((ox, oy), letter, font=font, fill=_rgb(color) + (255,))
    if glow:
        halo = Image.new("RGBA", (size, size), _rgb(glow) + (0,))
        halo.putalpha(layer.getchannel("A").filter(ImageFilter.GaussianBlur(size * 0.035)).point(lambda v: v * 0.35))
        layer = Image.alpha_composite(halo, layer)
    return layer


def tile(side: int, spec: dict, maskable: bool = False, letter_height: float | None = None) -> Image.Image:
    s = side * SS
    bg = _gradient(s, spec["fill_top"], spec["fill_bottom"])
    if maskable:
        img = bg
    else:
        radius = round(s * spec.get("radius", 0.225))
        mask = Image.new("L", (s, s), 0)
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, s - 1, s - 1), radius=radius, fill=255)
        img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
        img.paste(bg, (0, 0), mask)
        if spec.get("trim"):
            w = max(SS, round(s * spec.get("trim_width", 0.014)))
            ring = Image.new("RGBA", (s, s), (0, 0, 0, 0))
            inset = w / 2
            ImageDraw.Draw(ring).rounded_rectangle((inset, inset, s - 1 - inset, s - 1 - inset), radius=radius - inset,
                                                   outline=_rgb(spec["trim"]) + (round(255 * spec.get("trim_alpha", 1)),),
                                                   width=w)
            img = Image.alpha_composite(img, ring)
    h = letter_height or (spec["letter_height_maskable"] if maskable else spec["letter_height"])
    img = Image.alpha_composite(img, _letter(s, spec["letter"], spec["font"], h, spec["color"], spec.get("nudge_x", 0.0),
                                             spec.get("glow")))
    return img.resize((side, side), Image.LANCZOS)


def write_all(spec: dict, out_dir: Path) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    made = {
        "app-192.png": tile(192, spec),
        "app-512.png": tile(512, spec),
        "app-maskable-512.png": tile(512, spec, maskable=True),
        # A bigger letter at 32 px, so it still reads in a browser tab.
        "favicon-32.png": tile(32, spec, letter_height=spec.get("letter_height_favicon", 0.66)),
    }
    paths = []
    for name, img in made.items():
        path = out_dir / name
        img.save(path, "PNG", optimize=True)
        paths.append(path)
    return paths


if __name__ == "__main__":
    for path in write_all(SPEC, OUT):
        print(path.relative_to(ROOT))
