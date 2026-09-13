// 260913 Red home 同步的原子写与重命名重试。
// 构建前的同步脚本不能加载引擎依赖，这里只用 node 内置模块。
import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"

// 260913 Red Windows 上重命名会被杀软/索引器短暂占用；同目录重试后再放弃。
export async function renameWithRetry(from: string, to: string) {
  for (let attempt = 0; ; attempt++) {
    const error = await fs.rename(from, to).then(
      () => undefined,
      (error: NodeJS.ErrnoException) => error,
    )
    if (!error) return
    if (process.platform !== "win32" || !["EACCES", "EBUSY", "EPERM"].includes(error.code ?? "") || attempt === 8)
      throw error
    await new Promise((resolve) => setTimeout(resolve, Math.min(20 * 2 ** attempt, 200)))
  }
}

// 260913 Red 同目录临时文件 + rename：中途失败原文件一个字节都没动过，
// 不会像 writeFileSync 那样在截断后留下半截配置。
export async function writeAtomic(file: string, content: string) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  const previous = await fs.stat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error
    return undefined
  })
  try {
    await fs.writeFile(temporary, content, { flag: "wx", mode: previous?.mode ?? 0o600 })
    await renameWithRetry(temporary, file)
  } catch (error) {
    // 260913 Red 清理失败不改变主错误：临时文件名带 uuid，留着也不会覆盖任何东西。
    await fs.rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}
