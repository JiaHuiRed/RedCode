import { OptimizedBuffer, RGBA } from "@opentui/core"

// 260701 Red 首页背景点缀星空：稀疏光点 + 慢速呼吸闪烁，纯装饰。
// 手动低频 requestRender（见 starfield.tsx 的 setInterval）代替常驻 60fps live 循环——
// 呼应 Logo 组件默认不空闲动画、省 CPU/电量的既有设计取向（logo.tsx 的 idle 开关）。
// 260731 Red \u539f\u6765\u5168\u5c4f\u4e00\u5f8b DENSITY = 0.03\uff1a\u5bbd\u5c4f\u4e0b\u603b\u91cf\u504f\u5c11\uff0c\u800c\u4e14 logo \u80cc\u540e\u548c\u56db\u89d2\u4e00\u6837\u5bc6\uff0c
// \u7b49\u4e8e\u5728\u4e3b\u4f53\u540e\u9762\u6492\u566a\u70b9\u3002\u6539\u6210\u300c\u6574\u4f53\u52a0\u5bc6 + \u6309\u5230\u4e2d\u5fc3\u7684\u8ddd\u79bb\u8870\u51cf\u300d\u2014\u2014
// \u4e2d\u5fc3\u4fdd\u6301 0.025\uff08\u2248 \u539f\u6765\u7684\u6c34\u5e73\uff0clogo \u5468\u56f4\u4ecd\u662f\u5e72\u51c0\u7684\u547c\u5438\u533a\uff09\uff0c\u8d8a\u5f80\u5916\u8d8a\u5bc6\u5230 0.085\uff0c
// \u6309\u9762\u79ef\u52a0\u6743\u540e\u603b\u91cf\u7ea6\u4e3a\u539f\u6765\u7684\u4e24\u500d\u3002
//
// \u5f52\u4e00\u5316\u7528\u7684\u662f\u300c\u76f8\u5bf9\u534a\u5bbd/\u534a\u9ad8\u300d\u800c\u4e0d\u662f\u7edd\u5bf9\u683c\u8ddd\uff0c\u6240\u4ee5\u5e72\u51c0\u533a\u662f\u4e00\u4e2a\u8ddf\u7ec8\u7aef\u540c\u6bd4\u4f8b\u7684\u692d\u5706\u2014\u2014
// \u5bbd\u5c4f\u4e0b\u81ea\u7136\u662f\u6241\u7684\uff0c\u6b63\u597d\u8d34\u5408 logo + \u8f93\u5165\u6846\u90a3\u4e00\u5757\u5bbd\u800c\u6241\u7684\u5f62\u72b6\u3002
const DENSITY_CENTER = 0.025
const DENSITY_EDGE = 0.085
// \u8fd9\u4e2a\u534a\u5f84\uff08\u5360\u534a\u5bbd/\u534a\u9ad8\u7684\u6bd4\u4f8b\uff09\u4e4b\u5185\u4e0d\u52a0\u5bc6\uff0c\u4e4b\u5916\u624d\u5f00\u59cb smoothstep \u722c\u5347
const CLEAR_RADIUS = 0.35
const GLYPHS = [".", "\u00b7", "*"].map((c) => c.codePointAt(0)!)
const SPACE = " ".codePointAt(0)!
const TWINKLE_PERIOD = 3200

function hash(x: number, y: number, seed: number) {
  const n = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453
  return n - Math.floor(n)
}

/** 某格出现星星的概率：中心稀、边缘密，中间用 smoothstep 过渡而不是硬边 */
function densityAt(x: number, y: number, width: number, height: number) {
  const halfW = Math.max(1, (width - 1) / 2)
  const halfH = Math.max(1, (height - 1) / 2)
  const nx = (x - halfW) / halfW
  const ny = (y - halfH) / halfH
  const dist = Math.min(1, Math.hypot(nx, ny))
  const ramp = Math.max(0, Math.min(1, (dist - CLEAR_RADIUS) / (1 - CLEAR_RADIUS)))
  const eased = ramp * ramp * (3 - 2 * ramp)
  return DENSITY_CENTER + (DENSITY_EDGE - DENSITY_CENTER) * eased
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
        if (hash(x, y, 0) > densityAt(x, y, width, height)) continue
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
