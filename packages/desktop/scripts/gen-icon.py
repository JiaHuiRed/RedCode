#!/usr/bin/env python
"""
Generate RedCode icons from Red.ico source.
Extracts the 256x256 PNG from Red.ico, resizes to all required sizes,
produces multi-resolution icon.ico, .png, dock.png, StoreLogo, etc.
"""
import io, os, struct
from PIL import Image

ICONS_DIR = os.path.join(os.path.dirname(__file__), "../icons")
SRC_ICO = os.path.join(ICONS_DIR, "Red.ico")

# Read source 256x256 PNG from Red.ico
with open(SRC_ICO, "rb") as f:
    src_bytes = f.read()
count = struct.unpack_from("<H", src_bytes, 4)[0]
# Find 256x256 (w=0 means 256)
png_data = None
for i in range(count):
    off = 6 + i * 16
    w = src_bytes[off]
    offset = struct.unpack_from("<I", src_bytes, off + 12)[0]
    size = struct.unpack_from("<I", src_bytes, off + 8)[0]
    if w == 0:
        png_data = src_bytes[offset : offset + size]
        break
if not png_data:
    raise RuntimeError("No 256x256 entry found in Red.ico")

src = Image.open(io.BytesIO(png_data)).convert("RGBA")

SIZES = [16, 24, 32, 48, 64, 96, 128, 256, 512, 1024]
renders = {sz: src.resize((sz, sz), Image.LANCZOS) for sz in SIZES}
for sz in SIZES:
    print(f"  {sz}x{sz}")

renders[1024].save(os.path.join(ICONS_DIR, "icon.png"))

for sz, fname in [(32,"32x32.png"),(64,"64x64.png"),(128,"128x128.png"),(256,"128x128@2x.png")]:
    renders[sz].save(os.path.join(ICONS_DIR, fname))

for sz, fname in [
    (30,"Square30x30Logo.png"),(44,"Square44x44Logo.png"),(71,"Square71x71Logo.png"),
    (89,"Square89x89Logo.png"),(107,"Square107x107Logo.png"),(142,"Square142x142Logo.png"),
    (150,"Square150x150Logo.png"),(284,"Square284x284Logo.png"),(310,"Square310x310Logo.png"),
]:
    src.resize((sz, sz), Image.LANCZOS).save(os.path.join(ICONS_DIR, fname))

renders[512].save(os.path.join(ICONS_DIR, "dock.png"))
src.resize((50, 50), Image.LANCZOS).save(os.path.join(ICONS_DIR, "StoreLogo.png"))

# ICO — multi-resolution with correct struct format
ico_sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
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
    entries += struct.pack("<BBBBHHII", w, h, 0, 0, 1, 32, len(blob), data_offset)
    data += blob
    data_offset += len(blob)

with open(os.path.join(ICONS_DIR, "icon.ico"), "wb") as f:
    f.write(header + entries + data)

src.resize((180, 180), Image.LANCZOS).save(os.path.join(ICONS_DIR, "apple-touch-icon.png"))
print("Done.")
