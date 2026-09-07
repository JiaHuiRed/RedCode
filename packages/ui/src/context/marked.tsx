/// <reference path="./markdown-it-task-lists.d.ts" />
import MarkdownIt from "markdown-it"
import taskLists from "markdown-it-task-lists"
import { bundledLanguages, type BundledLanguage } from "shiki"
import { createSimpleContext } from "./helper"
import { getSharedHighlighter, registerCustomTheme } from "@pierre/diffs"
import { redcodeShikiTheme } from "./shiki-theme"
import { highlightPoolAvailable, highlightViaWorker } from "./highlight-pool"

registerCustomTheme("RedCode", () => Promise.resolve(redcodeShikiTheme()))

// 260901 cc katex 改成用到才加载。
//
// 它是首屏 chunk 里最大的单个文件：从打包产物 sourcemap 归因，katex.mjs 594KB，
// 占 main-*.js（转译前 4.78MB）的 12.2%。而 MarkedProvider 在 app.tsx 是静态引入的，
// 于是每次启动都要把它解析编译一遍——哪怕整个会话里一条公式都没有。
//
// 三件事让这个改动是零视觉代价的：
//   ① parse() 本来就是 async（下面 provider 里两处都是），调用方已经在 await；
//   ② 同一个文件里的 highlightCodeBlocks 早就是这个套路（getSharedHighlighter 异步取），
//      照抄它的形状，不是新发明；
//   ③ katex 的**样式**走 CSS 层（ui/src/styles/index.css:7 的 @import），不受这里影响，
//      所以公式渲染出来时不会有一瞬间没样式的闪动。
// 绝大多数消息根本不含公式，MATH_PATTERN 先挡一道，连动态 import 都不会发起。
const MATH_PATTERN = /\$\$|\\\[|\\\(/
type Katex = typeof import("katex").default
let katexPromise: Promise<Katex> | undefined

function loadKatex(): Promise<Katex> {
  katexPromise ??= import("katex").then((m) => m.default)
  return katexPromise
}

function renderMathInText(text: string, katex: Katex): string {
  let result = text

  // Display math: $$...$$ and \[...\]
  const displayMathRegex = /\$\$([\s\S]*?)\$\$/g
  result = result.replace(displayMathRegex, (_, math) => {
    try {
      return katex.renderToString(math, {
        displayMode: true,
        throwOnError: false,
      })
    } catch {
      return `$$${math}$$`
    }
  })
  // 260802 Red: markdown-it 不处理数学，统一走后处理；补齐 marked-katex 的非标准括号语法
  const displayBracketRegex = /\\\[([\s\S]*?)\\\]/g
  result = result.replace(displayBracketRegex, (_, math) => {
    try {
      return katex.renderToString(math, {
        displayMode: true,
        throwOnError: false,
      })
    } catch {
      return `\\[${math}\\]`
    }
  })

  // Inline math: only \(...\) — $...$ 在编码场景歧义太大（$VAR、$5 到 $10、shell 片段
  // 全会被吃掉渲染成乱码公式），与上游 #34850 同口径砍掉；块级 $$...$$ 保留
  const inlineBracketRegex = /\\\(((?:[^\\]|\\.)+?)\\\)/g
  result = result.replace(inlineBracketRegex, (_, math) => {
    try {
      return katex.renderToString(math, {
        displayMode: false,
        throwOnError: false,
      })
    } catch {
      return `\\(${math}\\)`
    }
  })

  return result
}

async function renderMathExpressions(html: string): Promise<string> {
  // 没有任何公式定界符就直接走人——不加载 katex，也不做下面的 split/join。
  if (!MATH_PATTERN.test(html)) return html
  const katex = await loadKatex()

  // Split on code/pre/kbd tags to avoid processing their contents
  const codeBlockPattern = /(<(?:pre|code|kbd)[^>]*>[\s\S]*?<\/(?:pre|code|kbd)>)/gi
  const parts = html.split(codeBlockPattern)

  return parts
    .map((part, i) => {
      // Odd indices are the captured code blocks - leave them alone
      if (i % 2 === 1) return part
      // Process math only in non-code parts
      return renderMathInText(part, katex)
    })
    .join("")
}

const unescapeHtml = (escaped: string) =>
  escaped
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")

function normalizeLang(lang: string | undefined): BundledLanguage | "text" {
  const candidate = lang || "text"
  return candidate in bundledLanguages ? (candidate as BundledLanguage) : "text"
}

/** 主线程兜底：worker 池不可用/单块失败时走这条，行为与改动前完全一致。 */
async function highlightOnMainThread(code: string, language: BundledLanguage | "text"): Promise<string> {
  const highlighter = await getSharedHighlighter({
    themes: ["RedCode"],
    langs: [],
    preferredHighlighter: "shiki-wasm",
  })
  if (language !== "text" && !highlighter.getLoadedLanguages().includes(language)) {
    await highlighter.loadLanguage(language)
  }
  return highlighter.codeToHtml(code, {
    lang: language,
    theme: "RedCode",
    tabindex: false,
  })
}

// 260907 Red 代码块高亮迁 worker 池（见 highlight-pool.ts）：此前每块都在主线程同步
// codeToHtml，长会话滚动时缓存未命中的块逐个卡 UI 线程；worker 与主线程兜底共用
// 同一份主题（shiki-theme.ts），输出逐字节一致，markdown.tsx 的块缓存两边通用。
// 顺手消灭 O(块数 × 全文) 的 result.replace：matchAll 自带索引，按下标切片拼装。
// 决策记录：docs/notes/implemented/bug-fix/2026-09-07-markdown-highlight-worker.md
async function highlightCodeBlocks(html: string, skip: boolean): Promise<string> {
  if (skip) return html
  const codeBlockRegex = /<pre><code(?:\s+class="language-([^"]*)")?>([\s\S]*?)<\/code><\/pre>/g
  const matches = [...html.matchAll(codeBlockRegex)]
  if (matches.length === 0) return html

  const parts = await Promise.all(
    matches.map(async (match) => {
      const [, lang, escapedCode] = match
      const code = unescapeHtml(escapedCode)
      const language = normalizeLang(lang)
      if (highlightPoolAvailable()) {
        // worker 路径失败（超时/报错/熔断）只降级这一块，不拖累其余块
        try {
          return await highlightViaWorker(code, language)
        } catch {
          // 落到下面的主线程兜底
        }
      }
      return highlightOnMainThread(code, language)
    }),
  )

  let result = ""
  let last = 0
  matches.forEach((match, i) => {
    result += html.slice(last, match.index)
    result += parts[i]
    last = match.index + match[0].length
  })
  return result + html.slice(last)
}

export type NativeMarkdownParser = (markdown: string) => Promise<string>

export type MarkdownParseOptions = {
  // 260811 Red 流式期间跳过 Shiki 高亮（方案 1），结束后补全，避免每 300ms 全量 codeToHtml
  highlight?: boolean
}

export const { use: useMarked, provider: MarkedProvider } = createSimpleContext({
  name: "Marked",
  init: (props: { nativeParser?: NativeMarkdownParser }) => {
    if (props.nativeParser) {
      const nativeParser = props.nativeParser
      return {
        async parse(markdown: string, opts?: MarkdownParseOptions): Promise<string> {
          const html = await nativeParser(markdown)
          const withMath = await renderMathExpressions(html)
          return highlightCodeBlocks(withMath, opts?.highlight === false)
        },
      }
    }

    // 260802 Red: marked → markdown-it（marked 对长文本 O(n²)，50KB 纯文本 587ms → 1.2ms）
    const md = new MarkdownIt({
      html: true,
      linkify: true,
    })
    md.use(taskLists, { enabled: false, label: false })

    // 260812 Red: 剥离命名空间 XML 标签残留（如 </antml:thinking_mode>），
    // markdown-it 不识别带冒号的标签名，会当普通文本原文显示 → 界面上"思考标签泄露"。
    // 只处理含冒号的命名空间标签（不影响标准 HTML），反引号 code 内的引用保留。
    const NAMESPACED_TAG = /<\/?[a-zA-Z][a-zA-Z0-9]*:[a-zA-Z0-9_.-]+(?:\s+[^>]*)?\/?>/g
    const stripNamespacedTags = (text: string) =>
      text
        .split("`")
        .map((seg, i) => (i % 2 === 1 ? seg : seg.replace(NAMESPACED_TAG, "")))
        .join("`")

    // 与 marked 时代一致的链接样式：external-link + 新窗口打开
    const defaultLinkOpen =
      md.renderer.rules.link_open ??
      ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
    md.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
      const token = tokens[idx]
      token.attrJoin("class", "external-link")
      token.attrSet("target", "_blank")
      token.attrSet("rel", "noopener noreferrer")
      return defaultLinkOpen(tokens, idx, options, _env, self)
    }

      return {
        async parse(markdown: string, opts?: MarkdownParseOptions): Promise<string> {
          const html = md.render(stripNamespacedTags(markdown))
          const withMath = await renderMathExpressions(html)
          return highlightCodeBlocks(withMath, opts?.highlight === false)
        },
      }
  },
})
