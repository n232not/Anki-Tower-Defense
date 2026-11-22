"""Process animal sprites to look like human-made 2D vector/cel-shaded cartoon art.

Eliminates AI airbrush gradients, cleans messy fringes, enhances bold ink outlines,
and applies crisp 2-to-3 tone cartoon cel shading.
"""

import os
import numpy as np
from PIL import Image, ImageFilter, ImageEnhance, ImageOps


def clean_sprite(in_path: str, out_path: str, size: int = 160) -> Image.Image:
    im = Image.open(in_path).convert("RGBA")
    
    # 1. Clean up alpha fringe: remove soft white/light halos
    arr = np.asarray(im).astype(np.float32)
    alpha = arr[:, :, 3] / 255.0
    
    # Extract RGB
    rgb = arr[:, :, :3].copy()
    
    # Edge pixels that have translucent alpha (fringe)
    edge = (alpha > 0.02) & (alpha < 0.98)
    
    # The original background was white or light: edge pixels got lightened
    # Bias fringe toward dark ink outline
    rgb[edge] = rgb[edge] * np.minimum(1.0, alpha[edge, None] ** 0.8)
    
    # 2. Cel-shading / posterization of internal colors to look human-drawn
    # Slight bilateral/median smoothing to remove micro-textures and airbrush dither
    base_rgb = Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8))
    smoothed = base_rgb.filter(ImageFilter.MedianFilter(3))
    
    # Boost saturation and contrast for punchy cartoon feel
    vibrant = ImageEnhance.Color(smoothed).enhance(1.22)
    contrasted = ImageEnhance.Contrast(vibrant).enhance(1.15)
    
    s_arr = np.asarray(contrasted).astype(np.float32)
    
    # Calculate luminance
    lum = s_arr[:, :, 0] * 0.299 + s_arr[:, :, 1] * 0.587 + s_arr[:, :, 2] * 0.114
    max_c = np.max(s_arr, axis=-1)
    
    # Smooth cel-shading curve: quantize luminance into 3 clean cartoon steps
    # (shadow tone, base tone, specular highlight)
    norm_lum = lum / 255.0
    cel_factor = np.where(
        norm_lum < 0.32, 0.72,
        np.where(norm_lum < 0.72, 0.95,
        np.where(norm_lum < 0.90, 1.08, 1.18))
    )
    
    # Preserve white/bright highlights (e.g. eyes gleam, blade shine)
    is_specular = (norm_lum > 0.88) & (np.min(s_arr, axis=-1) > 200)
    
    cel_rgb = s_arr * cel_factor[:, :, None]
    cel_rgb[is_specular] = np.array([255, 255, 255], dtype=np.float32)
    
    # 3. Bold ink outlines: find existing ink lines and make them solid dark vector ink
    is_dark = (lum < 75) & (alpha > 0.4)
    ink_mask = Image.fromarray((is_dark * 255).astype(np.uint8))
    ink_mask = ink_mask.filter(ImageFilter.MaxFilter(3)) # slightly reinforce ink
    reinforced_ink = np.asarray(ink_mask) > 120
    
    # Ink color: deep rich warm dark charcoal #221c1a
    ink_col = np.array([34, 28, 26], dtype=np.float32)
    cel_rgb[reinforced_ink] = cel_rgb[reinforced_ink] * 0.35 + ink_col * 0.65
    
    # 4. Crisp outer silhouette: zero halos
    # Threshold alpha to get clean boundary
    solid = alpha > 0.35
    solid_im = Image.fromarray((solid * 255).astype(np.uint8))
    # 1px smooth antialiasing
    final_alpha = np.asarray(solid_im.filter(ImageFilter.GaussianBlur(0.7)), dtype=np.float32) / 255.0
    
    # Ensure outermost rim is clean ink
    outer_rim = (final_alpha > 0.05) & (final_alpha < 0.92)
    cel_rgb[outer_rim] = ink_col
    
    # Composite result
    out_arr = np.dstack([
        np.clip(cel_rgb, 0, 255).astype(np.uint8),
        np.clip(final_alpha * 255, 0, 255).astype(np.uint8)
    ])
    result = Image.fromarray(out_arr, "RGBA")
    
    # Crop to content and center with padding
    bbox = result.getchannel("A").point(lambda v: 255 if v > 15 else 0).getbbox()
    if bbox:
        result = result.crop(bbox)
        
    side = max(result.size)
    pad = int(side * 0.05)
    side += pad * 2
    sq = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    sq.paste(result, ((side - result.width) // 2, (side - result.height) // 2))
    sq = sq.resize((size, size), Image.LANCZOS)
    
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    sq.save(out_path, optimize=True)
    return sq


def main():
    os.makedirs("stylized_sprites", exist_ok=True)
    names = sorted(os.listdir("original_sprites"))
    tiles = []
    for n in names:
        if not n.endswith(".png"):
            continue
        src = os.path.join("original_sprites", n)
        dst = os.path.join("stylized_sprites", n)
        img = clean_sprite(src, dst, 160)
        tiles.append(img)
        print(f"Processed {n} -> {dst}")
        
    cols = 7
    size = 160
    rows = (len(tiles) + cols - 1) // cols
    sheet = Image.new("RGBA", (cols * size, rows * size), (120, 190, 90, 255))
    from PIL import ImageDraw
    d = ImageDraw.Draw(sheet)
    for i in range(0, cols * size, 20):
        for j in range(0, rows * size, 20):
            if (i // 20 + j // 20) % 2:
                d.rectangle([i, j, i + 19, j + 19], fill=(100, 170, 75, 255))
    for i, t in enumerate(tiles):
        sheet.alpha_composite(t, ((i % cols) * size, (i // cols) * size))
    sheet.save("stylized_sprites/contact_sheet.png")
    print("Saved stylized_sprites/contact_sheet.png")

if __name__ == "__main__":
    main()
