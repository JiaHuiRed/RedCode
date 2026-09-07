import { createHighlighter, bundledLanguages, type BundledLanguage, type Highlighter } from "shiki"
import { redcodeShikiTheme } from "./shiki-theme"

// 260907 Red markdown 代码块高亮 worker。主线程此前用 getSharedHighlighter 同步
// codeToHtml，长会话滚动时缓存未命中的块逐个卡 UI 线程；这条 worker 只做一件事：
// 进 {id, code, lang}，出 {id, html}。主题/语言/选项与主线程兜底路径完全一致
// （同一份 shiki-theme.ts），输出逐字节相同，markdown.tsx 的块缓存两边通用。
// 语言按需懒加载，加载过的语言常驻本 worker。

type HighlightRequest = { id: number; code: string; lang: string }
type HighlightResponse = { id: number; html?: string; error?: string }

// DOM lib 下 self 的类型不齐，最小化声明而不是整文件切 webworker lib（会与 DOM 冲突）
const ctx = self as unknown as {
  postMessage(message: HighlightResponse): void
  addEventListener(type: "message", listener: (event: MessageEvent<HighlightRequest>) => void): void
}

let highlighter: Promise<Highlighter> | undefined

ctx.addEventListener("message", (event) => {
  const { id, code, lang } = event.data
  void (async () => {
    try {
      highlighter ??= createHighlighter({ themes: [redcodeShikiTheme()], langs: [] })
      const highlighter_ = await highlighter
      const language = lang in bundledLanguages ? (lang as BundledLanguage) : "text"
      if (language !== "text" && !highlighter_.getLoadedLanguages().includes(language)) {
        await highlighter_.loadLanguage(language)
      }
      ctx.postMessage({
        id,
        html: highlighter_.codeToHtml(code, { lang: language, theme: "RedCode", tabindex: false }),
      })
    } catch (error) {
      ctx.postMessage({ id, error: error instanceof Error ? error.message : String(error) })
    }
  })()
})
