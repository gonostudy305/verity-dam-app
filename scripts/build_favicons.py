#!/usr/bin/env python3
"""Clean source logo image and build production favicons & icons for dam.verity.internal"""

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

REPO_ROOT = Path(__file__).resolve().parents[1]
PUBLIC_DIR = REPO_ROOT / "public"
APP_DIR = REPO_ROOT / "src" / "app"

PUBLIC_DIR.mkdir(parents=True, exist_ok=True)
APP_DIR.mkdir(parents=True, exist_ok=True)

CANVAS_SIZE = 1024
VERITY_BLUE = (22, 65, 127, 255)  # #16417F, sampled from the supplied logo artwork
VERITY_GOLD = (255, 214, 13, 255)  # --gold / #FFD60D
WHITE = (255, 255, 255, 255)
MASTER_SCALE = 4
hi_size = CANVAS_SIZE * MASTER_SCALE
hi_canvas = Image.new("RGBA", (hi_size, hi_size), VERITY_BLUE)
hi_draw = ImageDraw.Draw(hi_canvas)

def scale_box(box: tuple[float, float, float, float]) -> list[int]:
    return [round(value * MASTER_SCALE) for value in box]

def scale_points(points: list[tuple[float, float]]) -> list[tuple[int, int]]:
    return [(round(x * MASTER_SCALE), round(y * MASTER_SCALE)) for x, y in points]

def draw_rounded_box(box: tuple[float, float, float, float], radius: float, fill: tuple[int, int, int, int]) -> None:
    hi_draw.rounded_rectangle(scale_box(box), radius=round(radius * MASTER_SCALE), fill=fill)

# The supplied artwork is a stacked-photo mark: two offset white photo cards,
# a foreground rounded frame, a mountain glyph, and a gold sun. Keep the same
# geometry in the raster and SVG outputs so browser/PWA icons never drift.
draw_rounded_box((730, 318, 824, 716), 44, WHITE)
draw_rounded_box((420, 258, 728, 786), 72, WHITE)
draw_rounded_box((462, 298, 687, 744), 40, VERITY_BLUE)
draw_rounded_box((196, 325, 660, 760), 62, WHITE)
draw_rounded_box((236, 365, 620, 720), 32, VERITY_BLUE)
hi_draw.polygon(
    scale_points([(236, 704), (416, 442), (620, 704), (553, 704), (416, 548), (324, 704)]),
    fill=WHITE,
)
hi_draw.ellipse(
    scale_box((485, 403, 577, 495)),
    fill=VERITY_GOLD,
)
master_canvas = hi_canvas.resize((CANVAS_SIZE, CANVAS_SIZE), Image.Resampling.LANCZOS)

print("Generating favicon and icon formats...")

# 1. Standard PNG sizes
sizes = {
    "favicon-16x16.png": 16,
    "favicon-32x32.png": 32,
    "favicon-48x48.png": 48,
    "apple-touch-icon.png": 180,
    "android-chrome-192x192.png": 192,
    "android-chrome-512x512.png": 512,
    "icon-192.png": 192,
    "icon-512.png": 512,
}

for filename, sz in sizes.items():
    img_resized = master_canvas.resize((sz, sz), Image.Resampling.LANCZOS)
    img_resized.save(PUBLIC_DIR / filename, format="PNG", optimize=True)
    print(f"  -> public/{filename} ({sz}x{sz})")

# 2. Next.js App Router files in src/app/
icon_32 = master_canvas.resize((32, 32), Image.Resampling.LANCZOS)
icon_512 = master_canvas.resize((512, 512), Image.Resampling.LANCZOS)
apple_180 = master_canvas.resize((180, 180), Image.Resampling.LANCZOS)

icon_512.save(APP_DIR / "icon.png", format="PNG", optimize=True)
apple_180.save(APP_DIR / "apple-icon.png", format="PNG", optimize=True)
print("  -> src/app/icon.png & src/app/apple-icon.png")

# 3. Multi-resolution favicon.ico (contains 16, 32, 48)
ico_16 = master_canvas.resize((16, 16), Image.Resampling.LANCZOS)
ico_32 = master_canvas.resize((32, 32), Image.Resampling.LANCZOS)
ico_48 = master_canvas.resize((48, 48), Image.Resampling.LANCZOS)

ico_32.save(
    PUBLIC_DIR / "favicon.ico",
    format="ICO",
    sizes=[(16, 16), (32, 32), (48, 48)],
    append_images=[ico_16, ico_48],
)
ico_32.save(
    APP_DIR / "favicon.ico",
    format="ICO",
    sizes=[(16, 16), (32, 32), (48, 48)],
    append_images=[ico_16, ico_48],
)
print("  -> public/favicon.ico & src/app/favicon.ico (16, 32, 48 embedded)")

# 4. Scalable Vector SVG icon (favicon.svg & icon.svg)
svg_content = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024" role="img" aria-label="VerityDAM" shape-rendering="geometricPrecision">
  <rect width="1024" height="1024" fill="#16417F" />
  <rect x="730" y="318" width="94" height="398" rx="44" fill="#FFFFFF" />
  <rect x="420" y="258" width="308" height="528" rx="72" fill="#FFFFFF" />
  <rect x="462" y="298" width="225" height="446" rx="40" fill="#16417F" />
  <rect x="196" y="325" width="464" height="435" rx="62" fill="#FFFFFF" />
  <rect x="236" y="365" width="384" height="355" rx="32" fill="#16417F" />
  <path d="M236 704 416 442 620 704H553L416 548 324 704Z" fill="#FFFFFF" />
  <circle cx="531" cy="449" r="46" fill="#FFD60D" />
</svg>
'''

(PUBLIC_DIR / "favicon.svg").write_text(svg_content, encoding="utf-8")
(PUBLIC_DIR / "icon.svg").write_text(svg_content, encoding="utf-8")
(APP_DIR / "icon.svg").write_text(svg_content, encoding="utf-8")
print("  -> public/favicon.svg, public/icon.svg, src/app/icon.svg")

# 5. Web App Manifests
site_manifest = '''{
  "name": "VerityDAM — Kho ảnh & video gốc",
  "short_name": "VerityDAM",
  "description": "Hệ thống quản lý tài sản số VerityDAM Platform (dam.verity.internal)",
  "start_url": "/library",
  "display": "standalone",
  "background_color": "#0d1b2a",
  "theme_color": "#16417F",
  "icons": [
    {
      "src": "/android-chrome-192x192.png",
      "sizes": "192x192",
      "type": "image/png"
    },
    {
      "src": "/android-chrome-512x512.png",
      "sizes": "512x512",
      "type": "image/png"
    },
    {
      "src": "/android-chrome-512x512.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "maskable"
    },
    {
      "src": "/icon.svg",
      "sizes": "any",
      "type": "image/svg+xml"
    }
  ]
}
'''

(PUBLIC_DIR / "site.webmanifest").write_text(site_manifest, encoding="utf-8")
(PUBLIC_DIR / "manifest.json").write_text(site_manifest, encoding="utf-8")
print("  -> public/site.webmanifest & public/manifest.json")

# 6. Social Share OpenGraph card (1200x630)
og_canvas = Image.new("RGBA", (1200, 630), (13, 27, 42, 255))
draw = ImageDraw.Draw(og_canvas)

# Gradient background simulation
for y in range(630):
    ratio = y / 630.0
    r_val = int(13 * (1 - ratio) + 22 * ratio)
    g_val = int(27 * (1 - ratio) + 64 * ratio)
    b_val = int(42 * (1 - ratio) + 127 * ratio)
    draw.line([(0, y), (1200, y)], fill=(r_val, g_val, b_val, 255))

# Draw subtle glow behind logo
logo_size = 280
logo_resized = master_canvas.resize((logo_size, logo_size), Image.Resampling.LANCZOS)
logo_x = 100
logo_y = (630 - logo_size) // 2
og_canvas.paste(logo_resized, (logo_x, logo_y), logo_resized)

# Draw typography
try:
    font_title = ImageFont.truetype("arial.ttf", 60)
    font_sub = ImageFont.truetype("arial.ttf", 28)
    font_url = ImageFont.truetype("arialbd.ttf", 26)
    font_tag = ImageFont.truetype("arial.ttf", 20)
except Exception:
    font_title = font_sub = font_url = font_tag = ImageFont.load_default()

text_x = logo_x + logo_size + 60

# Tag badge
draw.rounded_rectangle([text_x, 150, text_x + 230, 186], radius=8, fill=(22, 64, 127, 200), outline=(253, 211, 19, 180), width=1)
draw.text((text_x + 16, 158), "Verity home appliance", font=font_tag, fill=(253, 211, 19, 255))

# Title
draw.text((text_x, 210), "VerityDAM Studio", font=font_title, fill=(255, 255, 255, 255))

# Subtitle
draw.text((text_x, 295), "Kho ảnh & video sản phẩm chính thức", font=font_sub, fill=(203, 213, 225, 255))
draw.text((text_x, 335), "Quản lý & phân phối tài sản số chất lượng cao", font=font_sub, fill=(148, 163, 184, 255))

# Official domain badge
draw.rounded_rectangle([text_x, 400, text_x + 360, 448], radius=10, fill=(253, 211, 19, 255))
draw.text((text_x + 20, 412), "🌐 https://dam.verity.internal", font=font_url, fill=(13, 27, 42, 255))

og_canvas.save(PUBLIC_DIR / "og-image.png", format="PNG", optimize=True)
print("  -> public/og-image.png (1200x630)")

print("\nAll favicons and web assets successfully generated!")
