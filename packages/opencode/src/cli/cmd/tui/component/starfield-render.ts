import { OptimizedBuffer, RGBA } from "@opentui/core"

// 260701 Red 首页背景点缀星空：稀疏光点 + 慢速呼吸闪烁，纯装饰。
// 手动低频 requestRender（见 starfield.tsx 的 setInterval）代替常驻 60fps live 循环——
// 呼应 Logo 组件默认不空闲动画、省 CPU/电量的既有设计取向（logo.tsx 的 idle 开关）。
const DENSITY = 0.03
const GLYPHS = [".", "\u00b7", "*"].map((c) => c.codePointAt(0)!)
const SPACE = " ".codePointAt(0)!
const TWINKLE_PERIOD = 3200

function hash(x: number, y: number, seed: number) {
  const n = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453
  return n - Math.floor(n)
}

type Star = {
  index: number
  glyph: number
  phase: number
  speed: number
  peak: number
}

export class StarfieldPainter {
  private baseRgb: [number, number, number] = [255, 255, 255]
  private width = 0
  private height = 0
  private stars: Star[] = []

  setBase(color: RGBA | undefined) {
    if (!color) return false
    const [r, g, b] = color.toInts()
    if (r === this.baseRgb[0] && g === this.baseRgb[1] && b === this.baseRgb[2]) return false
    this.baseRgb = [r, g, b]
    return true
  }

  private rebuild(width: number, height: number, buffer: OptimizedBuffer) {
    if (width === this.width && height === this.height) return
    this.width = width
    this.height = height
    const buffers = buffer.buffers
    buffers.char.fill(SPACE)
    buffers.fg.fill(0)
    buffers.bg.fill(0)
    buffers.attributes.fill(0)
    this.stars = []
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (hash(x, y, 0) > DENSITY) continue
        this.stars.push({
          index: y * width + x,
          glyph: GLYPHS[Math.floor(hash(x, y, 1) * GLYPHS.length) % GLYPHS.length]!,
          phase: hash(x, y, 2) * Math.PI * 2,
          speed: 0.6 + hash(x, y, 3) * 0.8,
          peak: 0.3 + hash(x, y, 4) * 0.45,
        })
      }
    }
  }

  render(buffer: OptimizedBuffer) {
    this.rebuild(buffer.width, buffer.height, buffer)
    if (this.stars.length === 0) return
    const fg = buffer.buffers.fg
    const char = buffer.buffers.char
    const [r, g, b] = this.baseRgb
    const t = performance.now() / TWINKLE_PERIOD
    for (const star of this.stars) {
      const wave = 0.5 + 0.5 * Math.sin((t + star.phase) * star.speed * Math.PI * 2)
      const brightness = wave * star.peak
      const offset = star.index * 4
      fg[offset] = r
      fg[offset + 1] = g
      fg[offset + 2] = b
      fg[offset + 3] = Math.round(Math.max(0, brightness) * 255)
      char[star.index] = star.glyph
    }
  }
}
