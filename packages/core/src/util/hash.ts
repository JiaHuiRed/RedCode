import { createHash } from "crypto"

export namespace Hash {
  export function fast(input: string | Buffer): string {
    return createHash("sha1").update(input).digest("hex")
  }

  // 260616 Red read/edit 的文件指纹 [path#TAG]，从 read.ts/edit.ts 各自的
  // Bun.hash.xxHash32 抽来此处统一：Bun.hash 在 GUI 的 Node sidecar 里 undefined
  // (ReferenceError: Bun is not defined)，改用 node:crypto 的 sha1 取前 16bit，
  // 跨运行时一致。read 产 tag、edit 校验 currentHash 必须用同一实现。
  const TRAILING = /[ \t\r]+(?=\n|$)/g

  export function fileTag(text: string): string {
    const normalized = text.replace(TRAILING, "")
    return createHash("sha1").update(normalized).digest("hex").slice(0, 4).toUpperCase()
  }

  // 260728 Karina fileTag 的流式版本，摘要与 fileTag(全文) 必须逐字节一致 ——
  // read 产 tag、edit 用全文算 currentHash 校验陈旧度，两边对不上就会次次 hash mismatch。
  // 存在的理由：read 此前为了这 4 个字符要把整个文件再全量读进内存一次，
  // 把上面刚做完的 50KB/2000 行流式截断整个抵消掉。
  export function fileTagStream() {
    const hash = createHash("sha1")
    // 块尾的 [ \t\r] 连续段要等下一块才能定夺：后面跟 \n 或文件末尾才删，跟别的字符则保留。
    // 把它切走后本块结尾必定不是 [ \t\r]，正则的 $ 分支就不会在块边界上误命中。
    let pending = ""
    return {
      update(chunk: string) {
        if (!chunk) return
        const text = pending + chunk
        const match = /[ \t\r]+$/.exec(text)
        const boundary = match ? match.index : text.length
        pending = text.slice(boundary)
        if (boundary > 0) hash.update(text.slice(0, boundary).replace(TRAILING, ""))
      },
      digest(): string {
        // 残留的 pending 正好落在输入末尾，对应正则的 $ 分支，整段丢弃
        return hash.digest("hex").slice(0, 4).toUpperCase()
      },
    }
  }
}
