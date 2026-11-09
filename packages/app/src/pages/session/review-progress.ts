// 261109 Karina UX-04：审查进度的纯函数。
//
// 「已审查」是用户看过，不是暂存、也不是测试通过。用 diff 指纹（status + 增删行数）
// 绑定标记：文件再次变化后指纹不匹配，旧标记自动失效，不会把新 diff 当成已检查。
export type ReviewLike = {
  // SDK 的 diff 类型里 file 是可选字段，这里跟随它的形状，不额外收窄。
  file?: string
  additions?: number
  deletions?: number
  status?: string
}

export function diffFingerprint(diff: Omit<ReviewLike, "file">) {
  return `${diff.status ?? "modified"}:${diff.additions ?? 0}:${diff.deletions ?? 0}`
}

export function reviewedFiles(diffs: readonly ReviewLike[], reviewed: Record<string, string>) {
  return diffs.flatMap((diff) =>
    diff.file && reviewed[diff.file] === diffFingerprint(diff) ? [diff.file] : [],
  )
}
