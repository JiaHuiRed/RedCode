/**
 * 从双联原图（左 TUI / 右 GUI）生成两个 exe 图标。
 *
 * 260901 cc 换角色图时跑这个，别手搓 ICO。三件事是这个脚本存在的理由：
 *
 * ① **边界按 alpha 扫，不目测。** 原图是透明底的两个圆角徽章，扫出的框是
 *    左 x[36,850] y[0,836]、右 x[925,1737] y[1,839]，两个都略高于宽。
 *    **补透明边而不是裁切** —— 徽章四角本就透明，补边看不出来，裁切会切掉内容。
 *
 * ② **小尺寸用放大到头部的裁剪，大尺寸用完整徽章。** 任务栏在 100% DPI 下只取 32x32，
 *    给它 256 也没用 —— 分辨率不是可调的变量，可调的是这 32 个像素里放什么。
 *    满幅细节图缩到 32 没有剪影可言；裁到头部之后只剩一张脸，认得出来。
 *    ICO 本来就允许每帧不同的图。分界在 48/64 之间：≤48 是「只能认剪影」的档
 *    （任务栏 32 / 标题栏 16 / alt-tab 48），≥64 装得下完整构图。
 *
 * ③ **必须多尺寸。** 旧的 icon.ico 只有一帧 249x256（还不是正方形），Windows 取不到
 *    32 那一档时整个回退成默认 Electron 图标。
 *
 * 用法：bun run scripts/build-icons.ts [原图.png]
 */
import fs from "node:fs"
import path from "node:path"

// sharp 是间接依赖（没被提升到 node_modules/sharp），裸 import 解析不到。
// 为一个偶尔跑一次的图标脚本去改 lockfile 不值当，这里自己找一次。
async function loadSharp() {
  try {
    return (await import("sharp")).default
  } catch {
    const bun = path.resolve(import.meta.dir, "../../../node_modules/.bun")
    const hit = fs
      .readdirSync(bun)
      .filter((name) => name.startsWith("sharp@"))
      .sort()
      .pop()
    if (!hit) throw new Error("找不到 sharp，请先 bun install")
    return (await import(path.join(bun, hit, "node_modules/sharp/lib/index.js"))).default
  }
}
const sharp = (await loadSharp()) as typeof import("sharp").default

const SRC = process.argv[2] ?? "赤ico.png"
const SMALL = [16, 24, 32, 48]
const LARGE = [64, 128, 256]
const CHANNELS = ["dev", "beta", "prod"]
const ALPHA_MIN = 16 // 低于此视作透明，避开抗锯齿羽化边

type Box = { left: number; top: number; width: number; height: number }

/** 按 alpha 扫出画面里彼此分离的内容块（本图是左右两个徽章）。 */
async function findBadges(file: string): Promise<Box[]> {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const { width: W, height: H, channels: C } = info
  const colHas = new Array<boolean>(W).fill(false)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) if (data[(y * W + x) * C + 3]! > ALPHA_MIN) colHas[x] = true

  const runs: [number, number][] = []
  let start = -1
  for (let x = 0; x <= W; x++) {
    const on = x < W && colHas[x]
    if (on && start === -1) start = x
    if (!on && start !== -1) {
      if (x - start > W * 0.05) runs.push([start, x - 1])
      start = -1
    }
  }

  return runs.map(([x0, x1]) => {
    let y0 = -1
    let y1 = -1
    for (let y = 0; y < H; y++) {
      let any = false
      for (let x = x0; x <= x1; x++)
        if (data[(y * W + x) * C + 3]! > ALPHA_MIN) {
          any = true
          break
        }
      if (any) {
        if (y0 === -1) y0 = y
        y1 = y
      }
    }
    return { left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 }
  })
}

function buildIco(frames: { size: number; data: Buffer }[]) {
  const sorted = frames.slice().sort((a, b) => a.size - b.size)
  const header = Buffer.alloc(6)
  header.writeUInt16LE(1, 2) // type = icon
  header.writeUInt16LE(sorted.length, 4)
  const dir = Buffer.alloc(16 * sorted.length)
  let offset = header.length + dir.length
  sorted.forEach((f, i) => {
    const o = i * 16
    dir[o] = f.size === 256 ? 0 : f.size // 256 在 ICO 里用 0 表示
    dir[o + 1] = f.size === 256 ? 0 : f.size
    dir.writeUInt16LE(1, o + 4) // color planes
    dir.writeUInt16LE(32, o + 6) // bpp
    dir.writeUInt32LE(f.data.length, o + 8)
    dir.writeUInt32LE(offset, o + 12)
    offset += f.data.length
  })
  return Buffer.concat([header, dir, ...sorted.map((f) => f.data)])
}

const render = (src: Buffer, size: number, sharpenIt: boolean) =>
  sharp(src)
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 }, kernel: "lanczos3" })
    .sharpen(sharpenIt ? { sigma: 0.6 } : undefined)
    .png({ compressionLevel: 9 })
    .toBuffer()

const badges = await findBadges(SRC)
if (badges.length !== 2) throw new Error(`原图里找到 ${badges.length} 个徽章，预期 2 个（左 TUI / 右 GUI）`)

// 头部在徽章里的相对位置。换构图的话调这里，改完看 32px 认不认得出来。
const ZOOM = [
  { name: "tui", cx: 0.5, cy: 0.36, span: 0.62 },
  { name: "gui", cx: 0.42, cy: 0.34, span: 0.58 },
]

for (const [i, box] of badges.entries()) {
  const z = ZOOM[i]!
  const side = Math.max(box.width, box.height)
  const full = await sharp(SRC)
    .extract(box)
    .extend({
      left: Math.floor((side - box.width) / 2),
      right: Math.ceil((side - box.width) / 2),
      top: Math.floor((side - box.height) / 2),
      bottom: Math.ceil((side - box.height) / 2),
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer()

  const zside = Math.round(side * z.span)
  const zleft = Math.max(0, Math.round(side * z.cx - zside / 2))
  const ztop = Math.max(0, Math.round(side * z.cy - zside / 2))
  const zoom = await sharp(full)
    .extract({ left: zleft, top: ztop, width: Math.min(zside, side - zleft), height: Math.min(zside, side - ztop) })
    .png()
    .toBuffer()

  const frames = [
    ...(await Promise.all(SMALL.map(async (s) => ({ size: s, data: await render(zoom, s, true) })))),
    ...(await Promise.all(LARGE.map(async (s) => ({ size: s, data: await render(full, s, false) })))),
  ]
  const ico = buildIco(frames)

  if (z.name === "tui") {
    // TUI 的 exe 图标由 packages/opencode/script/build.ts 直接按路径引用
    fs.writeFileSync("赤.ico", ico)
    console.log(`tui → 赤.ico  ${frames.length} 帧  ${(ico.length / 1024).toFixed(0)}KB`)
  } else {
    // GUI 三个 channel 同图；copy-icons.ts 会把整个目录拷进 resources/icons
    for (const ch of CHANNELS) {
      const dir = path.join("icons", ch)
      fs.writeFileSync(path.join(dir, "icon.ico"), ico)
      for (const s of [32, 64, 128]) {
        fs.writeFileSync(path.join(dir, `${s}x${s}.png`), await render(s <= 48 ? zoom : full, s, s <= 48))
      }
      fs.writeFileSync(path.join(dir, "128x128@2x.png"), await render(full, 256, false))
    }
    console.log(`gui → icons/{${CHANNELS.join(",")}}/icon.ico  ${frames.length} 帧  ${(ico.length / 1024).toFixed(0)}KB`)
  }
}
