// 261109 Karina UX-04：审查进度的纯函数。
//
// 「已审查」是用户看过，不是暂存、也不是测试通过。用 diff 指纹绑定标记：文件再次
// 变化后指纹不匹配，旧标记自动失效，不会把新 diff 当成已检查。
// 261110 Red 指纹升级：有 patch 时对内容做 FNV-1a 哈希（patch:长度:哈希），增删
// 行数相同但内容不同的 diff 不再共享指纹；patch 缺失时回退旧的 status+计数格式。
export type ReviewLike = {
  // SDK 的 diff 类型里 file 是可选字段，这里跟随它的形状，不额外收窄。
  file?: string
  additions?: number
  deletions?: number
  status?: string
  patch?: string
}

// FNV-1a 32 位：纯同步、跨端一致；指纹是非安全场景，长度 + 32 位哈希足够。
// 乘法必须走 Math.imul，普通乘法在 2^53 以上丢精度，哈希会退化。
const fnv1a = (text: string) => {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

export function diffFingerprint(diff: Omit<ReviewLike, "file">) {
  if (diff.patch) return `patch:${diff.patch.length}:${fnv1a(diff.patch).toString(16)}`
  return `${diff.status ?? "modified"}:${diff.additions ?? 0}:${diff.deletions ?? 0}`
}

export function reviewedFiles(diffs: readonly ReviewLike[], reviewed: Record<string, string>) {
  return diffs.flatMap((diff) =>
    diff.file && reviewed[diff.file] === diffFingerprint(diff) ? [diff.file] : [],
  )
}
