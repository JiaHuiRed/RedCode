#!/usr/bin/env python
"""
Generate Mangekyou Sharingan (万花筒写轮眼) icons for the RedCode desktop app.
Produces: icon.png, icon.ico, and all required size variants.
"""
import math
import os
from PIL import Image, ImageDraw, ImageFilter

# ── colors ───────────────────────────────────────────────────────────────────
RED       = (204,   0,   0, 255)    # main red
DARK_RED  = (140,   0,   0, 255)    # shadow / depth
BLACK     = (  6,   4,   4, 255)    # near-black background
TRANS     = (  0,   0,   0,   0)    # transparent

# ── helpers ──────────────────────────────────────────────────────────────────
def polar(cx, cy, r, deg):
    """Convert polar (r, deg) to screen (x, y)."""
    rad = math.radians(deg - 90)   # 0° = up on screen
    return (cx + r * math.cos(rad), cy + r * math.sin(rad))

def arc_pts(cx, cy, r, a_start, a_end, steps=20):
    """Points along a circular arc from a_start° to a_end°."""
    pts = []
    for i in range(steps):
        a = a_start + (a_end - a_start) * i / (steps - 1)
        pts.append(polar(cx, cy, r, a))
    return pts

def bezier_pts(p0, p1, p2, p3, steps=18):
    """Cubic Bézier — returns `steps` interpolated points."""
    out = []
    for i in range(steps):
        t = i / (steps - 1)
        u = 1 - t
        x = u**3*p0[0] + 3*u**2*t*p1[0] + 3*u*t**2*p2[0] + t**3*p3[0]
        y = u**3*p0[1] + 3*u**2*t*p1[1] + 3*u*t**2*p2[1] + t**3*p3[1]
        out.append((x, y))
    return out

def black_gap(cx, cy, outer_r, gap_idx, n=3):
    """
    Negative-space gap cut between blades.
    Gaps are narrow at the outer ring and wide at the hub — this makes the
    blades appear broad at the rim (Sharingan blade shape).
    The gap is rotated ~30° to give the pinwheel sweep.
    """
    # Gap center sits between two adjacent blades, offset for rotation direction
    gap_center = gap_idx * (360 / n) + 55   # 55°, 175°, 295°

    blade_r  = outer_r * 0.87   # red fill reaches here (just inside outer ring)
    hub_r    = outer_r * 0.24   # inner hub radius

    # Outer arc of gap: narrow (±20°)
    outer_left  = gap_center - 20
    outer_right = gap_center + 20

    # Inner boundary of gap: wide (±55°) to create pointed blade tips
    inner_left  = gap_center - 55
    inner_right = gap_center + 55

    pts = (
        arc_pts(cx, cy, blade_r, outer_left, outer_right, 14) +
        [polar(cx, cy, hub_r * 1.05, inner_right)] +
        [(cx, cy)] +
        [polar(cx, cy, hub_r * 1.05, inner_left)]
    )
    return pts

def draw_sharingan(size: int) -> Image.Image:
    """Render the Mangekyou Sharingan at the given size with 4× supersampling."""
    S  = size * 4          # render at 4× for smooth AA
    cx = cy = S // 2
    R  = int(S * 0.47)     # usable radius (leaves ~3% border)

    img  = Image.new("RGBA", (S, S), TRANS)
    draw = ImageDraw.Draw(img)

    # ── background circle ────────────────────────────────────────────────────
    draw.ellipse([cx-R, cy-R, cx+R, cy+R], fill=BLACK)

    # ── outer ring ───────────────────────────────────────────────────────────
    ring_w = max(2, int(R * 0.055))
    ring_inner_r = R - ring_w
    for i in range(ring_w):
        r = R - i
        draw.ellipse([cx-r, cy-r, cx+r, cy+r], outline=RED)

    # ── solid red fill inside ring (blades carved from this) ─────────────────
    blade_fill_r = ring_inner_r
    draw.ellipse([cx-blade_fill_r, cy-blade_fill_r,
                  cx+blade_fill_r, cy+blade_fill_r], fill=RED)

    # ── three black gaps (negative space → Sharingan blade shapes) ───────────
    for gap in range(3):
        pts = black_gap(cx, cy, R, gap)
        draw.polygon(pts, fill=BLACK)

    # ── inner hub ring (separates blades from center pupil area) ─────────────
    hub_r = int(R * 0.24)
    draw.ellipse([cx-hub_r, cy-hub_r, cx+hub_r, cy+hub_r], fill=BLACK)

    # ── three spokes (dark red, pointing from hub toward each blade center) ───
    spoke_inner = int(R * 0.08)
    spoke_outer = int(R * 0.22)
    spoke_w = max(2, int(R * 0.035))
    # Blade centers are at 0°, 120°, 240° (between each gap)
    # Gaps at 55°, 175°, 295°  → blade centers at ~0°, 120°, 240° (midpoints)
    for blade in range(3):
        angle = blade * 120 - 15   # slight offset toward blade body
        sx1, sy1 = polar(cx, cy, spoke_inner, angle)
        sx2, sy2 = polar(cx, cy, spoke_outer, angle)
        draw.line([sx1, sy1, sx2, sy2], fill=DARK_RED, width=spoke_w)

    # ── pupil (center circle) ─────────────────────────────────────────────────
    pupil_r = int(R * 0.10)
    draw.ellipse([cx-pupil_r, cy-pupil_r, cx+pupil_r, cy+pupil_r], fill=RED)

    # ── blur edges slightly for anti-aliasing ─────────────────────────────────
    img = img.filter(ImageFilter.GaussianBlur(radius=1.2))

    # ── downsample 4× → final size with Lanczos ──────────────────────────────
    img = img.resize((size, size), Image.LANCZOS)
    return img

# ── generate all required sizes ──────────────────────────────────────────────
SIZES = [16, 24, 32, 48, 64, 96, 128, 256, 512, 1024]

ICONS_DIR = os.path.join(os.path.dirname(__file__), "../icons")
os.makedirs(ICONS_DIR, exist_ok=True)

renders: dict[int, Image.Image] = {}
for sz in SIZES:
    renders[sz] = draw_sharingan(sz)
    print(f"  rendered {sz}×{sz}")

# ── icon.png (1024) ───────────────────────────────────────────────────────────
renders[1024].save(os.path.join(ICONS_DIR, "icon.png"))
print("  saved icon.png")

# ── named-size PNGs ───────────────────────────────────────────────────────────
for sz, fname in [
    (32,  "32x32.png"),
    (64,  "64x64.png"),
    (128, "128x128.png"),
    (256, "128x128@2x.png"),
]:
    renders[sz].save(os.path.join(ICONS_DIR, fname))
    print(f"  saved {fname}")

# ── Windows Square logos ──────────────────────────────────────────────────────
square_sizes = [
    (30,  "Square30x30Logo.png"),
    (44,  "Square44x44Logo.png"),
    (71,  "Square71x71Logo.png"),
    (89,  "Square89x89Logo.png"),
    (107, "Square107x107Logo.png"),
    (142, "Square142x142Logo.png"),
    (150, "Square150x150Logo.png"),
    (284, "Square284x284Logo.png"),
    (310, "Square310x310Logo.png"),
]
for sz, fname in square_sizes:
    draw_sharingan(sz).save(os.path.join(ICONS_DIR, fname))
    print(f"  saved {fname}")

# ── dock.png (macOS 512) ──────────────────────────────────────────────────────
renders[512].save(os.path.join(ICONS_DIR, "dock.png"))

# ── StoreLogo.png (50 recommended) ───────────────────────────────────────────
draw_sharingan(50).save(os.path.join(ICONS_DIR, "StoreLogo.png"))

# ── icon.ico (Windows multi-size) ────────────────────────────────────────────
ico_sizes = [16, 24, 32, 48, 64, 128, 256]
ico_images = [renders[s].convert("RGBA") for s in ico_sizes]
ico_images[0].save(
    os.path.join(ICONS_DIR, "icon.ico"),
    format="ICO",
    sizes=[(s, s) for s in ico_sizes],
    append_images=ico_images[1:],
)
print("  saved icon.ico")

# ── apple-touch-icon (180) ────────────────────────────────────────────────────
draw_sharingan(180).save(os.path.join(ICONS_DIR, "apple-touch-icon.png"))

print("\nDone. All icons written to packages/desktop/icons/")
