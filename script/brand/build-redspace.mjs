// Run with node script/brand/build-redspace.mjs after bun install.
// Source of truth: packages/ui/src/assets/brand/redspace-mark.svg.
import fs from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const modules = path.join(root, "node_modules/.bun")
const dependency = (await fs.readdir(modules))
  .filter((x) => x.startsWith("sharp@"))
  .sort()
  .at(-1)
if (!dependency) throw new Error("Run bun install first: sharp is required by the asset pipeline")
const sharp = createRequire(import.meta.url)(path.join(modules, dependency, "node_modules/sharp"))
const mark = await fs.readFile(path.join(root, "packages/ui/src/assets/brand/redspace-mark.svg"), "utf8")
const tile = mark
  .replace('viewBox="0 0 100 100"', 'viewBox="-20 -20 140 140"')
  .replace('color="#D9362B"', 'color="#FFF5EB"')
  .replace(/(<svg[^>]*>)/, '$1<rect x="-20" y="-20" width="140" height="140" rx="30" fill="#D9362B"/>')
const maskable = tile.replace('rx="30"', 'rx="0"')
const png = (svg, size) => sharp(Buffer.from(svg)).resize(size, size).png().toBuffer()
function ico(frames) {
  const header = Buffer.alloc(6 + frames.length * 16)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(frames.length, 4)
  let offset = header.length
  frames.forEach(({ size, data }, i) => {
    const at = 6 + i * 16
    header[at] = header[at + 1] = size === 256 ? 0 : size
    header.writeUInt16LE(1, at + 4)
    header.writeUInt16LE(32, at + 6)
    header.writeUInt32LE(data.length, at + 8)
    header.writeUInt32LE(offset, at + 12)
    offset += data.length
  })
  return Buffer.concat([header, ...frames.map((x) => x.data)])
}
const frames = await Promise.all(
  [16, 24, 32, 48, 64, 128, 256].map(async (size) => ({ size, data: await png(tile, size) })),
)
const icon = ico(frames)
const chunks = await Promise.all(
  [
    ["icp4", 16],
    ["icp5", 32],
    ["icp6", 64],
    ["ic07", 128],
    ["ic08", 256],
    ["ic09", 512],
    ["ic10", 1024],
  ].map(async ([type, size]) => {
    const data = await png(tile, size)
    const header = Buffer.alloc(8)
    header.write(type)
    header.writeUInt32BE(data.length + 8, 4)
    return Buffer.concat([header, data])
  }),
)
const icnsHeader = Buffer.alloc(8)
icnsHeader.write("icns")
icnsHeader.writeUInt32BE(8 + chunks.reduce((n, x) => n + x.length, 0), 4)
const icns = Buffer.concat([icnsHeader, ...chunks])
for (const channel of ["dev", "beta", "prod"]) {
  const dir = path.join(root, "packages/desktop/icons", channel)
  for (const name of await fs.readdir(dir)) {
    if (!name.endsWith(".png")) continue
    const file = path.join(dir, name)
    const meta = await sharp(file).metadata()
    await fs.writeFile(file, await sharp(Buffer.from(tile)).resize(meta.width, meta.height).png().toBuffer())
  }
  await fs.writeFile(path.join(dir, "icon.ico"), icon)
  await fs.writeFile(path.join(dir, "icon.icns"), icns)
}
const web = path.join(root, "packages/app/public")
await fs.writeFile(path.join(web, "favicon-redspace.ico"), icon)
for (const [name, size, svg] of [
  ["favicon-96x96-redspace.png", 96, mark],
  ["apple-touch-icon-redspace.png", 180, maskable],
  ["redspace-192x192.png", 192, maskable],
  ["redspace-512x512.png", 512, maskable],
]) {
  await fs.writeFile(path.join(web, name), await png(svg, size))
}
await fs.writeFile(path.join(root, "packages/ui/src/assets/brand/redspace-app.svg"), tile)
console.log("Generated RedSpace web and desktop icons (dev/beta/prod).")
