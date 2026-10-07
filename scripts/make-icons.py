#!/usr/bin/env python3
"""Generate the extension icons (16/32/48/128 px) with Pillow.

    python3 scripts/make-icons.py
"""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "icons"
S = 512  # master size


def rounded(draw, box, r, fill):
    draw.rounded_rectangle(box, radius=r, fill=fill)


def master():
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # background: blue rounded square with a subtle vertical gradient
    bg = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    gd = ImageDraw.Draw(bg)
    top, bottom = (37, 99, 235), (29, 78, 216)
    for y in range(S):
        t = y / (S - 1)
        c = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)) + (255,)
        gd.line([(0, y), (S, y)], fill=c)
    mask = Image.new("L", (S, S), 0)
    rounded(ImageDraw.Draw(mask), (0, 0, S - 1, S - 1), 110, 255)
    img.paste(bg, (0, 0), mask)

    # the "page": tall white sheet, slightly taller than the icon to suggest "full page"
    px0, px1 = 128, 384
    py0, py1 = 96, 470
    shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    rounded(ImageDraw.Draw(shadow), (px0 + 6, py0 + 10, px1 + 6, py1 + 10), 22, (0, 0, 0, 70))
    img.alpha_composite(shadow)
    d = ImageDraw.Draw(img)
    rounded(d, (px0, py0, px1, py1), 22, (255, 255, 255, 255))
    # text lines on the page
    line = (170, 180, 196, 255)
    for i, y in enumerate(range(py0 + 70, py1 - 40, 46)):
        w = (px1 - px0) - 64 - (44 if i % 3 == 2 else 0)
        rounded(d, (px0 + 32, y, px0 + 32 + w, y + 18), 9, line)
    # clipboard clip on top
    rounded(d, (S // 2 - 74, 60, S // 2 + 74, 126), 24, (15, 46, 120, 255))
    rounded(d, (S // 2 - 46, 82, S // 2 + 46, 104), 11, (190, 205, 235, 255))
    # down-arrow badge (bottom-right) = "to the very bottom"
    cx, cy, r = 400, 392, 76
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=(22, 163, 74, 255))
    d.ellipse((cx - r + 10, cy - r + 10, cx + r - 10, cy + r - 10), outline=(255, 255, 255, 255), width=8)
    d.line([(cx, cy - 38), (cx, cy + 30)], fill=(255, 255, 255, 255), width=16)
    d.polygon([(cx - 30, cy + 8), (cx + 30, cy + 8), (cx, cy + 40)], fill=(255, 255, 255, 255))
    return img


def main():
    OUT.mkdir(exist_ok=True)
    m = master()
    for size in (16, 32, 48, 128):
        m.resize((size, size), Image.LANCZOS).save(OUT / f"icon{size}.png")
        print("wrote", OUT / f"icon{size}.png")


if __name__ == "__main__":
    main()
