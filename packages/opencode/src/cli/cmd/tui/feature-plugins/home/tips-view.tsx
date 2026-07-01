import type { TuiPluginApi } from "@redcode-ai/plugin/tui"
import { createMemo, createSignal, For, onCleanup, onMount, type Accessor } from "solid-js"
import { DEFAULT_THEMES, tint, useTheme } from "@tui/context/theme"
import { useCommandShortcut } from "../../keymap"

// 260701 Red 提示语前的圆点加一点呼吸感点缀，低频定时器（不追求流畅度，省 CPU）
const BREATH_PERIOD = 1800
const BREATH_TICK_MS = 120

const themeCount = Object.keys(DEFAULT_THEMES).length

type TipPart = { text: string; highlight: boolean }
type TipShortcut = Accessor<string>
type Shortcuts = {
  agentCycle: TipShortcut
  childFirst: TipShortcut
  childNext: TipShortcut
  childPrevious: TipShortcut
  commandList: TipShortcut
  editorOpen: TipShortcut
  helpShow: TipShortcut
  inputClear: TipShortcut
  inputNewline: TipShortcut
  inputPaste: TipShortcut
  inputUndo: TipShortcut
  leader: TipShortcut
  messagesCopy: TipShortcut
  messagesFirst: TipShortcut
  messagesLast: TipShortcut
  messagesPageDown: TipShortcut
  messagesPageUp: TipShortcut
  messagesToggleConceal: TipShortcut
  modelCycle最近: TipShortcut
  modelList: TipShortcut
  sessionExport: TipShortcut
  sessionInterrupt: TipShortcut
  sessionList: TipShortcut
  sessionNew: TipShortcut
  sessionParent: TipShortcut
  sessionPinToggle: TipShortcut
  sessionQuickSwitch1: TipShortcut
  sessionQuickSwitch9: TipShortcut
  sessionSidebarToggle: TipShortcut
  sessionTimeline: TipShortcut
  statusView: TipShortcut
  terminalSuspend: TipShortcut
  themeList: TipShortcut
}
type Tip = string | ((shortcuts: Shortcuts) => string | undefined)

function parse(tip: string): TipPart[] {
  const parts: TipPart[] = []
  const regex = /\{highlight\}(.*?)\{\/highlight\}/g
  const found = Array.from(tip.matchAll(regex))
  const state = found.reduce(
    (acc, match) => {
      const start = match.index ?? 0
      if (start > acc.index) {
        acc.parts.push({ text: tip.slice(acc.index, start), highlight: false })
      }
      acc.parts.push({ text: match[1], highlight: true })
      acc.index = start + match[0].length
      return acc
    },
    { parts, index: 0 },
  )

  if (state.index < tip.length) {
    parts.push({ text: tip.slice(state.index), highlight: false })
  }

  return parts
}

const NO_MODELS_TIP = "运行 {highlight}/connect{/highlight} 添加 AI 服务商并开始编码"
const NO_MODELS_PARTS = parse(NO_MODELS_TIP)

function shortcutText(value: string) {
  return `{highlight}${value}{/highlight}`
}

function commandText(command: string, shortcut: string) {
  if (!shortcut) return shortcutText(command)
  return `${shortcutText(command)} 或 ${shortcutText(shortcut)}`
}

function press(shortcut: string, text: string) {
  if (!shortcut) return undefined
  return `按 ${shortcutText(shortcut)} ${text}`
}

function configShortcut(api: TuiPluginApi, command: string): TipShortcut {
  return () =>
    api.tuiConfig.keybinds
      .get(command)
      .map((binding) => api.keys.formatSequence(Array.from(api.keymap.parseKeySequence(binding.key))))
      .filter(Boolean)
      .join(", ")
}

export function Tips(props: { api: TuiPluginApi; connected?: boolean }) {
  const theme = useTheme().theme
  const tipOffset = Math.random()
  const shortcuts: Shortcuts = {
    agentCycle: useCommandShortcut("agent.cycle"),
    childFirst: configShortcut(props.api, "session.child.first"),
    childNext: configShortcut(props.api, "session.child.next"),
    childPrevious: configShortcut(props.api, "session.child.previous"),
    commandList: useCommandShortcut("command.palette.show"),
    editorOpen: useCommandShortcut("prompt.editor"),
    helpShow: useCommandShortcut("help.show"),
    inputClear: useCommandShortcut("prompt.clear"),
    inputNewline: useCommandShortcut("input.newline"),
    inputPaste: useCommandShortcut("prompt.paste"),
    inputUndo: useCommandShortcut("input.undo"),
    leader: configShortcut(props.api, "leader"),
    messagesCopy: configShortcut(props.api, "messages.copy"),
    messagesFirst: configShortcut(props.api, "session.first"),
    messagesLast: configShortcut(props.api, "session.last"),
    messagesPageDown: configShortcut(props.api, "session.page.down"),
    messagesPageUp: configShortcut(props.api, "session.page.up"),
    messagesToggleConceal: configShortcut(props.api, "session.toggle.conceal"),
    modelCycle最近: useCommandShortcut("model.cycle_recent"),
    modelList: useCommandShortcut("model.list"),
    sessionExport: configShortcut(props.api, "session.export"),
    sessionInterrupt: configShortcut(props.api, "session.interrupt"),
    sessionList: useCommandShortcut("session.list"),
    sessionNew: useCommandShortcut("session.new"),
    sessionParent: configShortcut(props.api, "session.parent"),
    sessionPinToggle: configShortcut(props.api, "session.pin.toggle"),
    sessionQuickSwitch1: useCommandShortcut("session.quick_switch.1"),
    sessionQuickSwitch9: useCommandShortcut("session.quick_switch.9"),
    sessionSidebarToggle: configShortcut(props.api, "session.sidebar.toggle"),
    sessionTimeline: configShortcut(props.api, "session.timeline"),
    statusView: useCommandShortcut("redcode.status"),
    terminalSuspend: useCommandShortcut("terminal.suspend"),
    themeList: useCommandShortcut("theme.switch"),
  }
  const tip = createMemo(() => {
    if (props.connected === false) return NO_MODELS_TIP
    const tips = TIPS.flatMap((item) => {
      const value = typeof item === "string" ? item : item(shortcuts)
      return value ? [value] : []
    })
    return tips[Math.floor(tipOffset * tips.length)] ?? NO_MODELS_TIP
  }, NO_MODELS_TIP)
  // Solid can expose a memo's initial value while a pure computation is pending.
  const parts = createMemo(() => {
    const value = tip()
    if (typeof value === "string") return parse(value)
    return NO_MODELS_PARTS
  }, NO_MODELS_PARTS)

  const [breath, setBreath] = createSignal(0)
  let timer: ReturnType<typeof setInterval> | undefined
  onMount(() => {
    const start = performance.now()
    timer = setInterval(() => {
      const t = (performance.now() - start) / BREATH_PERIOD
      setBreath(0.5 + 0.5 * Math.sin(t * Math.PI * 2))
    }, BREATH_TICK_MS)
  })
  onCleanup(() => {
    if (timer) clearInterval(timer)
  })
  const dotColor = createMemo(() => tint(theme.background, theme.warning, 0.55 + breath() * 0.45))

  return (
    <box flexDirection="row" maxWidth="100%">
      <text flexShrink={0} style={{ fg: dotColor() }}>
        ● 提示{" "}
      </text>
      <text flexShrink={1} wrapMode="word">
        <For each={parts()}>
          {(part) => <span style={{ fg: part.highlight ? theme.text : theme.textMuted }}>{part.text}</span>}
        </For>
      </text>
    </box>
  )
}

const TIPS: Tip[] = [
  "输入 {highlight}@{/highlight} 加文件名可模糊搜索并附加文件",
  "消息开头输入 {highlight}!{/highlight} 可直接运行 shell 命令（如 {highlight}!ls -la{/highlight}）",
  (shortcuts) => press(shortcuts.agentCycle(), "切换 Build 和 Plan 代理"),
  "使用 {highlight}/undo{/highlight} 撤销上一条消息和文件修改",
  "使用 {highlight}/redo{/highlight} 恢复已撤销的消息和文件修改",
  "运行 {highlight}/share{/highlight} 生成对话的公开分享链接",
  "拖拽图片或 PDF 到终端即可作为上下文附件",
  (shortcuts) => press(shortcuts.inputPaste(), "从剪贴板粘贴图片到输入框"),
  (shortcuts) => `使用 ${commandText("/editor", shortcuts.editorOpen())} 在外部编辑器中编写消息`,
  "运行 {highlight}/init{/highlight} 根据代码库自动生成项目规则",
  (shortcuts) => `使用 ${commandText("/models", shortcuts.modelList())} 查看和切换可用的 AI 模型`,
  (shortcuts) => `使用 ${commandText("/themes", shortcuts.themeList())} 在 ${themeCount} 个内置主题间切换`,
  (shortcuts) => `使用 ${commandText("/new", shortcuts.sessionNew())} 开始新的对话`,
  (shortcuts) => `使用 ${commandText("/sessions", shortcuts.sessionList())} 查看、置顶和继续对话`,
  (shortcuts) => press(shortcuts.sessionPinToggle(), "在会话列表中置顶对话"),
  (shortcuts) =>
    shortcuts.sessionQuickSwitch1() && shortcuts.sessionQuickSwitch9()
      ? `置顶的会话会分配快捷槽位；按 ${shortcutText(shortcuts.sessionQuickSwitch1())} 到 ${shortcutText(shortcuts.sessionQuickSwitch9())} 快速切换`
      : undefined,
  "运行 {highlight}/compact{/highlight} 压缩过长的对话以释放上下文窗口",
  (shortcuts) => `使用 ${commandText("/export", shortcuts.sessionExport())} 将对话导出为 Markdown`,
  (shortcuts) => press(shortcuts.messagesCopy(), "复制助手的最近一条消息到剪贴板"),
  (shortcuts) => press(shortcuts.commandList(), "查看所有可用的操作和命令"),
  "运行 {highlight}/connect{/highlight} 添加 API 密钥，支持 75+ LLM 服务商",
  (shortcuts) => `Leader 键是 ${shortcutText(shortcuts.leader())}，可组合其他键执行快捷操作`,
  (shortcuts) => press(shortcuts.modelCycle最近(), "快速切换最近使用的模型"),
  (shortcuts) => press(shortcuts.sessionSidebarToggle(), "在对话中显示或隐藏侧边栏"),
  (shortcuts) =>
    shortcuts.messagesPageUp() && shortcuts.messagesPageDown()
      ? `按 ${shortcutText(shortcuts.messagesPageUp())}/${shortcutText(shortcuts.messagesPageDown())} 翻页浏览对话历史`
      : undefined,
  (shortcuts) => press(shortcuts.messagesFirst(), "跳转到对话开头"),
  (shortcuts) => press(shortcuts.messagesLast(), "跳转到最新消息"),
  (shortcuts) => press(shortcuts.inputNewline(), "在输入框中换行"),
  (shortcuts) => press(shortcuts.inputClear(), "清空输入框"),
  (shortcuts) => press(shortcuts.sessionInterrupt(), "中止 AI 的当前响应"),
  "切换到 {highlight}Plan{/highlight} 代理获取建议，不实际修改文件",
  "在消息中使用 {highlight}@agent-name{/highlight} 调用专门的子代理",
  (shortcuts) => {
    const items = [
      shortcuts.sessionParent(),
      shortcuts.childFirst(),
      shortcuts.childPrevious(),
      shortcuts.childNext(),
    ].filter(Boolean)
    if (!items.length) return undefined
    return `按 ${items.map(shortcutText).join(" / ")} 在父子会话间导航`
  },
  "创建 {highlight}redcode.json{/highlight} 配置服务端，{highlight}tui.json{/highlight} 配置 TUI 界面",
  "将 TUI 配置放在 {highlight}~/.config/opencode/tui.json{/highlight} 可作为全局配置",
  "在配置文件中添加 {highlight}$schema{/highlight} 可在编辑器中获得自动补全",
  "在配置中设置 {highlight}model{/highlight} 指定默认模型",
  "在 {highlight}tui.json{/highlight} 的 {highlight}keybinds{/highlight} 段可覆盖任意快捷键",
  "将快捷键设为 {highlight}none{/highlight} 可完全禁用它",
  "在 {highlight}mcp{/highlight} 配置段中添加本地或远程 MCP 服务器",
  "在 {highlight}.opencode/commands/{/highlight} 中添加 {highlight}.md{/highlight} 文件可定义可复用的自定义指令",
  "在自定义命令中使用 {highlight}$ARGUMENTS{/highlight}、{highlight}$1{/highlight}、{highlight}$2{/highlight} 接收动态输入",
  "在命令中用反引号注入 shell 输出（如 {highlight}`git status`{/highlight}）",
  "在 {highlight}.opencode/agents/{/highlight} 中添加 {highlight}.md{/highlight} 文件可定义专门的 AI 人格",
  "可为每个代理单独配置 {highlight}edit{/highlight}、{highlight}bash{/highlight}、{highlight}webfetch{/highlight} 工具权限",
  '使用类似 {highlight}"git *": "allow"{/highlight} 的模式精细控制 bash 权限',
  '设置 {highlight}"rm -rf *": "deny"{/highlight} 可阻止危险命令',
  '设置 {highlight}"git push": "ask"{/highlight} 可在推送前要求确认',
  '设置 {highlight}"formatter": true{/highlight} 启用内置格式化器（prettier、gofmt、ruff 等）',
  '设置 {highlight}"formatter": false{/highlight} 可禁用其他配置层启用的格式化器',
  "可在配置中按文件扩展名自定义格式化命令",
  '设置 {highlight}"lsp": true{/highlight} 启用内置 LSP 服务器进行代码分析',
  "在 {highlight}.opencode/tools/{/highlight} 中创建 {highlight}.ts{/highlight} 文件可定义新的 LLM 工具",
  "工具定义可调用 Python、Go 等语言编写的脚本",
  "在 {highlight}.opencode/plugins/{/highlight} 中添加 {highlight}.ts{/highlight} 文件可创建事件钩子",
  "可用插件在会话完成时发送系统通知",
  "可创建插件阻止 RedCode 读取敏感文件",
  "使用 {highlight}redcode run{/highlight} 进行非交互式脚本调用",
  "使用 {highlight}redcode --continue{/highlight} 恢复上次对话",
  "使用 {highlight}redcode run -f file.ts{/highlight} 通过命令行附加文件",
  "使用 {highlight}--format json{/highlight} 输出机器可读的 JSON 格式",
  "运行 {highlight}redcode serve{/highlight} 以无头 API 方式访问 RedCode",
  "使用 {highlight}redcode run --attach{/highlight} 连接到运行中的服务器",
  "运行 {highlight}redcode upgrade{/highlight} 更新到最新版本",
  "运行 {highlight}redcode auth list{/highlight} 查看已配置的服务商",
  "运行 {highlight}redcode agent create{/highlight} 引导式创建代理",
  '使用 {highlight}"theme": "system"{/highlight} 自动匹配终端配色',
  "在 {highlight}.opencode/themes/{/highlight} 目录下创建 JSON 主题文件",
  "主题支持暗色/亮色两种模式变体",
  "自定义主题 JSON 中可使用 0-255 的 xterm 颜色码",
  "在配置中使用 {highlight}{env:VAR_NAME}{/highlight} 引用环境变量",
  "使用 {highlight}{file:path}{/highlight} 将文件内容注入配置值",
  "在配置中使用 {highlight}instructions{/highlight} 加载额外的规则文件",
  "设置代理 {highlight}temperature{/highlight}，0.0（精确）到 1.0（创意）",
  "配置 {highlight}steps{/highlight} 限制每次请求的代理迭代次数",
  '设置 {highlight}"tools": {"bash": false}{/highlight} 可禁用特定工具',
  '设置 {highlight}"mcp_*": false{/highlight} 可禁用某个 MCP 服务器的所有工具',
  "可为每个代理单独覆盖全局工具设置",
  '设置 {highlight}"share": "auto"{/highlight} 自动分享所有对话',
  '设置 {highlight}"share": "disabled"{/highlight} 禁止分享对话',
  "运行 {highlight}/unshare{/highlight} 取消对话的公开访问",
  "权限 {highlight}doom_loop{/highlight} 防止工具调用无限循环",
  "权限 {highlight}external_directory{/highlight} 保护项目外的文件",
  "运行 {highlight}redcode debug config{/highlight} 排查配置问题",
  "使用 {highlight}--print-logs{/highlight} 在 stderr 查看详细日志",
  (shortcuts) => `使用 ${commandText("/timeline", shortcuts.sessionTimeline())} 跳转到特定消息`,
  (shortcuts) => press(shortcuts.messagesToggleConceal(), "折叠/展开消息中的代码块"),
  (shortcuts) => `使用 ${commandText("/status", shortcuts.statusView())} 查看系统状态`,
  "在 {highlight}tui.json{/highlight} 中启用 {highlight}scroll_acceleration{/highlight} 获得平滑滚动体验",
  (shortcuts) =>
    shortcuts.commandList()
      ? `通过命令面板（${shortcutText(shortcuts.commandList())}）切换聊天中的用户名显示`
      : "通过命令面板切换聊天中的用户名显示",
  "使用 {highlight}/connect{/highlight} 连接 RedCode Zen 获取精选测试过的模型",
  "将项目的 {highlight}AGENTS.md{/highlight} 提交到 Git 方便团队共享",
  "使用 {highlight}/review{/highlight} 审查未提交的更改、分支或 PR",
  (shortcuts) => `使用 ${commandText("/help", shortcuts.helpShow())} 打开帮助对话框`,
  "使用 {highlight}/rename{/highlight} 重命名当前对话",
  ...(process.platform === "win32"
    ? ([(shortcuts) => press(shortcuts.inputUndo(), "撤销输入框中的修改")] satisfies Tip[])
    : ([
        (shortcuts) => press(shortcuts.terminalSuspend(), "挂起终端并返回 shell"),
      ] satisfies Tip[])),
]
