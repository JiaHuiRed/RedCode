import path from "node:path"
import { LANGUAGE_EXTENSIONS } from "@/lsp/language"

/**
 * 路径 → 语法高亮用的 filetype，喂给 `<code>` / `<diff>` / `<markdown>` 的 filetype 属性。
 *
 * 260831 cc 此前同一份实现在三个文件里各写了一遍（routes/session/index.tsx、
 * routes/session/permission.tsx、feature-plugins/system/diff-viewer.tsx），逻辑逐字相同，
 * 只有第三份写得略简。合并到这里。
 *
 * 三种 react/js 变体统一压成 typescript：opentui 的高亮器没有单独的 tsx/jsx 语法，
 * 而 typescript 那套规则覆盖它们不出错。这条不是随手写的，三份副本里都有，是有意的。
 */
export function filetype(input?: string) {
  if (!input) return "none"
  const language = LANGUAGE_EXTENSIONS[path.extname(input)]
  if (["typescriptreact", "javascriptreact", "javascript"].includes(language)) return "typescript"
  return language
}
