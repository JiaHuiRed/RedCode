import { createHash } from "crypto"

export namespace Hash {
  export function fast(input: string | Buffer): string {
    return createHash("sha1").update(input).digest("hex")
  }

  // 260616 Red read/edit 的文件指纹 [path#TAG]，从 read.ts/edit.ts 各自的
  // Bun.hash.xxHash32 抽来此处统一：Bun.hash 在 GUI 的 Node sidecar 里 undefined
  // (ReferenceError: Bun is not defined)，改用 node:crypto 的 sha1 取前 16bit，
  // 跨运行时一致。read 产 tag、edit 校验 currentHash 必须用同一实现。
  export function fileTag(text: string): string {
    const normalized = text.replace(/[ \t\r]+(?=\n|$)/g, "")
    return createHash("sha1").update(normalized).digest("hex").slice(0, 4).toUpperCase()
  }
}
