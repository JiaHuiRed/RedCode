#!/usr/bin/env python
"""
Generate Mangekyou Sharingan icons for RedCode.
Design: black bg, white 勾玉 (magatama), red ring + pupil.
Colors adjusted: bg slightly lighter, red softer.
"""
import math, os, io, struct
from PIL import Image, ImageDraw, ImageFilter

# ── colors ───────────────────────────────────────────────────────────────────
RED       = (200,  60,  70, 255)    # softer rose-red (ring + pupil)
BG        = ( 25,  23,  23, 255)    # slightly lighter than pure black
WHITE     = (235, 235, 235, 255)    # off-white for magatama
TRANS     = (  0,   0,   0,   0)

# ── helpers ──────────────────────────────────────────────────────────────────
def polar(cx, cy, r, deg):
    rad = math.radians(deg - 90)
    return (cx + r * math.cos(rad), cy + r * math.sin(rad))

def bezier_pts(p0, p1, p2, p3, steps=20):
    out = []
    for i in range(steps):
        t = i / (steps - 1)
        u = 1 - t
        x = u**3*p0[0] + 3*u**2*t*p1[0] + 3*u*t**2*p2[0] + t**3*p3[0]
        y = u**3*p0[1] + 3*u**2*t*p1[1] + 3*u*t**2*p2[1] + t**3*p3[1]
        out.append((x, y))
    return out

def arc_pts(cx, cy, r, a_start, a_end, steps=20):
    return [polar(cx, cy, r, a_start + (a_end - a_start) * i / (steps - 1))
            for i in range(steps)]

def draw_magatama(draw, cx, cy, R, blade_idx, n=3):
    """One 勾玉: round head + curved tail, single continuous shape."""
    angle = blade_idx * (360 / n)

    head_r = R * 0.47
    head_cx, head_cy = polar(cx, cy, head_r, angle)
    head_radius = R * 0.27

    # Tail angles
    tail_base_outer = angle + 25
    tail_base_inner = angle - 10
    tail_tip_angle = angle + 72
    tail_tip = polar(cx, cy, R * 0.80, tail_tip_angle)

    # Outer edge
    tail_outer_start = polar(cx, cy, head_radius * 0.95, tail_base_outer)
    ctrl_outer = polar(cx, cy, R * 0.72, angle + 48)
    outer_edge = bezier_pts(tail_outer_start, ctrl_outer, ctrl_outer, tail_tip, 18)

    # Inner edge
    tail_inner_start = polar(cx, cy, head_radius * 0.65, tail_base_inner)
    ctrl_inner = polar(cx, cy, head_r * 0.55, angle + 38)
    inner_edge = bezier_pts(tail_tip, ctrl_inner, ctrl_inner, tail_inner_start, 18)

    # Head arc (the round part not covered by tail)
    head_arc = arc_pts(head_cx, head_cy, head_radius, tail_base_outer, tail_base_inner + 360, 24)

    pts = outer_edge + [tail_tip] + inner_edge + head_arc
    draw.polygon(pts, fill=WHITE)

def draw_sharingan(size: int) -> Image.Image:
    S  = size * 4
    cx = cy = S // 2
    R  = int(S * 0.47)

    img  = Image.new("RGBA", (S, S), TRANS)
    draw = ImageDraw.Draw(img)

    # Background circle
    draw.ellipse([cx-R, cy-R, cx+R, cy+R], fill=BG)

    # Red outer ring
    ring_w = max(2, int(R * 0.05))
    for i in range(ring_w):
        r = R - i
        draw.ellipse([cx-r, cy-r, cx+r, cy+r], outline=RED)

    # Three white 勾玉
    for i in range(3):
        draw_magatama(draw, cx, cy, R, i)

    # Red center pupil
    pupil_r = int(R * 0.09)
    draw.ellipse([cx-pupil_r, cy-pupil_r, cx+pupil_r, cy+pupil_r], fill=RED)

    # Anti-alias + downsample
    img = img.filter(ImageFilter.GaussianBlur(radius=1.0))
    img = img.resize((size, size), Image.LANCZOS)
    return img

# ── generate ─────────────────────────────────────────────────────────────────
SIZES = [16, 24, 32, 48, 64, 96, 128, 256, 512, 1024]
ICONS_DIR = os.path.join(os.path.dirname(__file__), "../icons")
os.makedirs(ICONS_DIR, exist_ok=True)

renders = {}
for sz in SIZES:
    renders[sz] = draw_sharingan(sz)
    print(f"  {sz}x{sz}")

renders[1024].save(os.path.join(ICONS_DIR, "icon.png"))

for sz, fname in [(32,"32x32.png"),(64,"64x64.png"),(128,"128x128.png"),(256,"128x128@2x.png")]:
    renders[sz].save(os.path.join(ICONS_DIR, fname))

for sz, fname in [
    (30,"Square30x30Logo.png"),(44,"Square44x44Logo.png"),(71,"Square71x71Logo.png"),
    (89,"Square89x89Logo.png"),(107,"Square107x107Logo.png"),(142,"Square142x142Logo.png"),
    (150,"Square150x150Logo.png"),(284,"Square284x284Logo.png"),(310,"Square310x310Logo.png"),
]:
    draw_sharingan(sz).save(os.path.join(ICONS_DIR, fname))

renders[512].save(os.path.join(ICONS_DIR, "dock.png"))
draw_sharingan(50).save(os.path.join(ICONS_DIR, "StoreLogo.png"))

# icon.ico
ico_sizes = [16, 24, 32, 48, 64, 128, 256]
png_blobs = []
for s in ico_sizes:
    buf = io.BytesIO()
    renders[s].save(buf, format="PNG")
    png_blobs.append(buf.getvalue())

header = struct.pack("<HHH", 0, 1, len(ico_sizes))
data_offset = 6 + len(ico_sizes) * 16
entries = b""
data = b""
for s, blob in zip(ico_sizes, png_blobs):
    w = 0 if s >= 256 else s
    h = 0 if s >= 256 else s
    entries += struct.pack("<BBBBHHIH", w, h, 0, 0, 1, 32, len(blob), data_offset)
    data += blob
    data_offset += len(blob)

with open(os.path.join(ICONS_DIR, "icon.ico"), "wb") as f:
    f.write(header + entries + data)

draw_sharingan(180).save(os.path.join(ICONS_DIR, "apple-touch-icon.png"))
print("Done.")
