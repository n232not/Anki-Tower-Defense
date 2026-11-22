"""Turn generated sprite images (solid-colour background) into trimmed, transparent PNGs.

Usage: python3 tools/key_sprites.py <src_dir> <out_dir> [size]
The background colour is sampled from the image border and removed by flood
fill from the edges, so similar colours inside the sprite are kept.
"""

import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter


def key(path: str, size: int) -> Image.Image:
    im = Image.open(path).convert("RGB")
    w, h = im.size
    arr = np.asarray(im).astype(np.float32)
    border = np.concatenate([arr[0], arr[-1], arr[:, 0], arr[:, -1]])
    bg = np.median(border, axis=0)

    is_green = bg[1] > bg[0] and bg[1] > bg[2]
    is_magenta = bg[0] > bg[1] and bg[2] > bg[1]

    # fill marker: the colour opposite the background, so it can't be confused with it
    SENTINEL = tuple(int(255 - c) for c in bg)
    if SENTINEL == (0, 0, 0) or SENTINEL == (255, 255, 255):
        SENTINEL = (13, 200, 97) if is_magenta else (240, 13, 97)
    filled = im.copy()
    # seed from many border points so JPEG noise can't block the fill
    for x in range(0, w, 8):
        for y in (0, h - 1):
            if tuple(filled.getpixel((x, y))) != SENTINEL:
                ImageDraw.floodfill(filled, (x, y), SENTINEL, thresh=70)
    for y in range(0, h, 8):
        for x in (0, w - 1):
            if tuple(filled.getpixel((x, y))) != SENTINEL:
                ImageDraw.floodfill(filled, (x, y), SENTINEL, thresh=70)

    f = np.asarray(filled)
    bgmask = np.all(f == SENTINEL, axis=-1)

    # For saturated chroma keys (green/magenta), also drop enclosed pockets (e.g. loops in tails/arms)
    if is_green:
        pure_key = (arr[:, :, 1] > 180) & (arr[:, :, 0] < 80) & (arr[:, :, 2] < 80)
        bgmask |= pure_key
    elif is_magenta:
        pure_key = (arr[:, :, 0] > 180) & (arr[:, :, 1] < 80) & (arr[:, :, 2] > 180)
        bgmask |= pure_key

    alpha_arr = np.where(bgmask, 0, 255).astype(np.uint8)
    alpha = Image.fromarray(alpha_arr)
    # Eat fringe left by antialiasing, then soften edge
    alpha = alpha.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(0.8))

    # Pull leftover background tint out of edge pixels
    a = np.asarray(alpha).astype(np.float32) / 255.0
    rgb = arr.copy()
    edge = (a > 0.05) & (a < 0.95)

    if is_green:
        # Despill green: pull excess green down to max of red/blue
        excess_g = np.maximum(0, rgb[:, :, 1] - np.maximum(rgb[:, :, 0], rgb[:, :, 2]))
        rgb[:, :, 1] -= excess_g * 0.9
        # Bias dark outlines toward true black
        dark_edge = edge & (np.mean(rgb, axis=-1) < 100)
        rgb[dark_edge] *= 0.5
    elif is_magenta:
        # Despill magenta
        excess_m = np.maximum(0, np.minimum(rgb[:, :, 0], rgb[:, :, 2]) - rgb[:, :, 1])
        rgb[:, :, 0] -= excess_m * 0.85
        rgb[:, :, 2] -= excess_m * 0.85
        dark_edge = edge & (np.mean(rgb, axis=-1) < 100)
        rgb[dark_edge] *= 0.5

    out = np.dstack([np.clip(rgb, 0, 255).astype(np.uint8), (a * 255).astype(np.uint8)])
    img = Image.fromarray(out, "RGBA")

    bbox = img.getchannel("A").point(lambda v: 255 if v > 15 else 0).getbbox()
    if bbox:
        img = img.crop(bbox)
    side = max(img.size)
    # Add a slight padding so sprite borders don't touch edges
    pad = int(side * 0.04)
    side += pad * 2
    sq = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    sq.paste(img, ((side - img.width) // 2, (side - img.height) // 2))
    return sq.resize((size, size), Image.LANCZOS)


def main() -> None:
    src = sys.argv[1] if len(sys.argv) > 1 else "generated_images"
    out = sys.argv[2] if len(sys.argv) > 2 else "study_defense/web/sprites"
    size = int(sys.argv[3]) if len(sys.argv) > 3 else 160
    os.makedirs(out, exist_ok=True)
    names = sorted(n for n in os.listdir(src) if n.lower().endswith((".png", ".jpg", ".jpeg")) and not n.startswith("contact"))
    tiles = []
    for n in names:
        img = key(os.path.join(src, n), size)
        dst = os.path.join(out, os.path.splitext(n)[0] + ".png")
        img.save(dst, optimize=True)
        tiles.append(img)
        print(f"{dst}  {os.path.getsize(dst) // 1024} KB")
    # contact sheet on a checkerboard for review
    cols = 7
    rows = (len(tiles) + cols - 1) // cols
    sheet = Image.new("RGBA", (cols * size, rows * size), (120, 190, 90, 255))
    d = ImageDraw.Draw(sheet)
    for i in range(0, cols * size, 20):
        for j in range(0, rows * size, 20):
            if (i // 20 + j // 20) % 2:
                d.rectangle([i, j, i + 19, j + 19], fill=(100, 170, 75, 255))
    for i, t in enumerate(tiles):
        sheet.alpha_composite(t, ((i % cols) * size, (i // cols) * size))
    sheet.save(os.path.join(src, "contact_sheet.png"))
    print(f"Updated contact_sheet.png ({cols}x{rows})")


if __name__ == "__main__":
    main()
