// 把朱印（packages/ui/src/assets/brand/redcode-mark*.svg）的几何直接栅格化成 RGBA PNG / ICO。
//
// 260903 cc 仓里没有 SVG 栅格化依赖，而这个标志只有四种图元（闭合贝塞尔填充、多边形填充、
// 圆头折线描边、圆角矩形填充），自己画比引一个新依赖划算。做法：4 倍超采样画二值，
// 再 4x4 盒式下采样得到抗锯齿 alpha。几何坐标与 SVG 完全一致（100x100 坐标系）——
// 改标志先改 SVG，再把这里的数值同步过来，两边不一致以 SVG 为准。
//
// 尺寸档：≤32px 用「简化刻本」（去掉右上崩口与印边留白，印身改圆角方），与
// redcode-mark-simple.svg 一致——那两处细节在 16 像素下看不见，留着只会让边缘发毛。
//
// 用法：node script/brand/rasterize-mark.mjs [输出目录 ...]
//   不传目录时写到 script/brand/out/。每个目录都会得到同一套文件：
//     favicon-v4.ico               16(简) / 32(简) / 48(全)
//     favicon-96x96-v4.png         96
//     apple-touch-icon-v4.png      180
//     web-app-manifest-192x192.png 192（maskable：内容缩进 10% 留安全区）
//     web-app-manifest-512x512.png 512（同上）
//     redcode-mark-512.png         512（无缩进，给 GitHub 头像等外部场合）
import fs from "fs";
import path from "path";
import zlib from "zlib";

const SS = 4; // 超采样倍数

// ---------- 路径与图元（坐标系 100x100，与 SVG 一致） ----------
const SEAL = [
  ["M", 12, 9],
  ["C", 34, 6.5, 62, 7.5, 89, 9.5],
  ["C", 92, 11, 93.5, 13, 93.5, 16],
  ["C", 95, 40, 94, 66, 92.5, 90],
  ["C", 91, 92.5, 88.5, 93.5, 85, 93.5],
  ["C", 60, 95, 34, 94, 12.5, 92.5],
  ["C", 9, 92, 7, 90, 6.5, 86.5],
  ["C", 5, 62, 5.5, 36, 7, 13],
  ["C", 7.5, 10.5, 9, 9.2, 12, 9],
];
const BORDER = [
  ["M", 17, 17.5],
  ["C", 38, 15.8, 62, 16.3, 83, 17.5],
  ["C", 84.6, 32, 84.6, 68, 83, 82.5],
  ["C", 62, 83.8, 38, 83.8, 17, 82.5],
  ["C", 15.4, 68, 15.4, 32, 17, 17.5],
];
const CHIP = [[84, 6], [96, 7], [95, 19]];
const CHEVRON = [[30, 31], [49, 50], [30, 69]];
const CURSOR = { x: 56, y: 61, w: 20, h: 8.5, r: 2.5 };
const SIMPLE_BODY = { x: 7, y: 7, w: 86, h: 86, r: 7 };
const BORDER_W = 3.2;
const CHEVRON_W = 10.5;
const RGB = [0xc8, 0x32, 0x2b]; // #C8322B

function flatten(cmds, steps = 48) {
  const pts = [];
  let cur = [0, 0];
  for (const c of cmds) {
    if (c[0] === "M") { cur = [c[1], c[2]]; pts.push(cur); continue; }
    const [, x1, y1, x2, y2, x3, y3] = c;
    const [x0, y0] = cur;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps, u = 1 - t;
      pts.push([
        u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
        u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
      ]);
    }
    cur = [x3, y3];
  }
  return pts;
}

function roundRectPoly(o, steps = 12) {
  const { x, y, w, h, r } = o;
  const pts = [];
  const arc = (cx, cy, a0, a1) => {
    for (let i = 0; i <= steps; i++) {
      const a = a0 + (a1 - a0) * (i / steps);
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  };
  arc(x + w - r, y + r, -Math.PI / 2, 0);
  arc(x + w - r, y + h - r, 0, Math.PI / 2);
  arc(x + r, y + h - r, Math.PI / 2, Math.PI);
  arc(x + r, y + r, Math.PI, Math.PI * 1.5);
  return pts;
}

/** 扫描线填充（even-odd），写入 size×size 的二值缓冲 */
function fillPoly(buf, size, poly, scale, offset) {
  const n = poly.length;
  const ys = poly.map((p) => p[1] * scale + offset);
  const minY = Math.max(0, Math.floor(Math.min(...ys)));
  const maxY = Math.min(size - 1, Math.ceil(Math.max(...ys)));
  for (let y = minY; y <= maxY; y++) {
    const cy = y + 0.5;
    const xs = [];
    for (let i = 0; i < n; i++) {
      const a = poly[i], b = poly[(i + 1) % n];
      const ay = a[1] * scale + offset, by = b[1] * scale + offset;
      if (ay === by) continue;
      if (cy >= Math.min(ay, by) && cy < Math.max(ay, by)) {
        const t = (cy - ay) / (by - ay);
        xs.push(a[0] * scale + offset + t * (b[0] * scale - a[0] * scale));
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.max(0, Math.ceil(xs[k] - 0.5));
      const x1 = Math.min(size - 1, Math.floor(xs[k + 1] - 0.5));
      for (let x = x0; x <= x1; x++) buf[y * size + x] = 1;
    }
  }
}

/** 圆头描边：沿路径密集采样后逐点盖圆盘（等价于 round cap + round join） */
function strokePath(buf, size, pts, width, scale, offset, closed) {
  const r = (width / 2) * scale;
  const stamp = (px, py) => {
    const x0 = Math.max(0, Math.floor(px - r)), x1 = Math.min(size - 1, Math.ceil(px + r));
    const y0 = Math.max(0, Math.floor(py - r)), y1 = Math.min(size - 1, Math.ceil(py + r));
    for (let y = y0; y <= y1; y++) {
      const dy = y + 0.5 - py;
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - px;
        if (dx * dx + dy * dy <= r * r) buf[y * size + x] = 1;
      }
    }
  };
  const list = closed ? [...pts, pts[0]] : pts;
  for (let i = 0; i + 1 < list.length; i++) {
    const [ax, ay] = list[i], [bx, by] = list[i + 1];
    const px0 = ax * scale + offset, py0 = ay * scale + offset;
    const px1 = bx * scale + offset, py1 = by * scale + offset;
    const d = Math.hypot(px1 - px0, py1 - py0);
    const n = Math.max(1, Math.ceil(d / 0.5));
    for (let k = 0; k <= n; k++) stamp(px0 + (px1 - px0) * (k / n), py0 + (py1 - py0) * (k / n));
  }
}

/**
 * 渲染成 size×size 的 alpha（0..255）。
 * simple：简化刻本（≤32px）。inset：四周留白比例（maskable 图标用 0.1）。
 */
function renderAlpha(size, { simple = size <= 32, inset = 0 } = {}) {
  const big = size * SS;
  const pad = big * inset;
  const scale = (big - pad * 2) / 100;
  const shape = new Uint8Array(big * big);
  const cut = new Uint8Array(big * big);

  if (simple) {
    fillPoly(shape, big, roundRectPoly(SIMPLE_BODY), scale, pad);
  } else {
    fillPoly(shape, big, flatten(SEAL), scale, pad);
    fillPoly(cut, big, CHIP, scale, pad);
    strokePath(cut, big, flatten(BORDER), BORDER_W, scale, pad, true);
  }
  strokePath(cut, big, CHEVRON, CHEVRON_W, scale, pad, false);
  fillPoly(cut, big, roundRectPoly(CURSOR), scale, pad);

  const alpha = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hit = 0;
      for (let dy = 0; dy < SS; dy++) {
        for (let dx = 0; dx < SS; dx++) {
          const i = (y * SS + dy) * big + (x * SS + dx);
          if (shape[i] && !cut[i]) hit++;
        }
      }
      alpha[y * size + x] = Math.round((hit / (SS * SS)) * 255);
    }
  }
  return alpha;
}

// ---------- PNG (RGBA) ----------
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
const crc32 = (b) => { let c = -1; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
function pngRGBA(size, alpha, rgb) {
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const off = y * (size * 4 + 1);
    rows[off] = 0;
    for (let x = 0; x < size; x++) {
      const a = alpha[y * size + x];
      const o = off + 1 + x * 4;
      rows[o] = rgb[0]; rows[o + 1] = rgb[1]; rows[o + 2] = rgb[2]; rows[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- ICO（内嵌 PNG，Vista+ 与全部现代浏览器均支持） ----------
function ico(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach((e, i) => {
    const o = i * 16;
    dir[o] = e.size >= 256 ? 0 : e.size;
    dir[o + 1] = e.size >= 256 ? 0 : e.size;
    dir[o + 2] = 0; dir[o + 3] = 0;
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(e.data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.data.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.data)]);
}

// ---------- 输出 ----------
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const outs = process.argv.slice(2);
if (outs.length === 0) outs.push(path.join(here, "out"));

const png = (size, opts) => pngRGBA(size, renderAlpha(size, opts), RGB);
const files = {
  "favicon-v4.ico": ico([16, 32, 48].map((s) => ({ size: s, data: png(s) }))),
  "favicon-96x96-v4.png": png(96),
  "apple-touch-icon-v4.png": png(180),
  "web-app-manifest-192x192.png": png(192, { inset: 0.1 }),
  "web-app-manifest-512x512.png": png(512, { inset: 0.1 }),
  "redcode-mark-512.png": png(512),
};
for (const dir of outs) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, buf] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), buf);
  console.log(`${Object.keys(files).length} 个文件 -> ${dir}`);
}
