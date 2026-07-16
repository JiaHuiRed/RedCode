import type { TuiPlugin, TuiPluginApi } from "@redcode-ai/plugin/tui"
import type { InternalTuiPlugin } from "../../plugin/internal"
import { createMemo, Match, Show, Switch } from "solid-js"
import { Global } from "@redcode-ai/core/global"
import { useSync } from "@tui/context/sync"

const id = "internal:home-footer"

// 260701 Red DeepSeek/Xiaomi 报价本身是 CNY，其余按官方汇率折算成 ¥ 统一展示
// （与 GUI 侧 session-context-format.ts 的 USD_TO_CNY 保持一致）
const USD_TO_CNY = 6.76
const CNY_PROVIDERS = new Set(["deepseek", "xiaomi", "stepfun", "zhipuai", "opencode-go"])
const money = new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY" })

function Directory(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const dir = createMemo(() => {
    const dir = props.api.state.path.directory || process.cwd()
    const out = dir.replace(Global.Path.home, "~")
    const branch = props.api.state.vcs?.branch
    if (branch) return out + ":" + branch
    return out
  })

  return <text fg={theme().textMuted}>{dir()}</text>
}

function Mcp(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const list = createMemo(() => props.api.state.mcp())
  const has = createMemo(() => list().length > 0)
  const err = createMemo(() => list().some((item) => item.status === "failed"))
  const count = createMemo(() => list().filter((item) => item.status === "connected").length)

  return (
    <Show when={has()}>
      <box gap={1} flexDirection="row" flexShrink={0}>
        <text fg={theme().text}>
          <Switch>
            <Match when={err()}>
              <span style={{ fg: theme().error }}>⊙ </span>
            </Match>
            <Match when={true}>
              <span style={{ fg: count() > 0 ? theme().success : theme().textMuted }}>⊙ </span>
            </Match>
          </Switch>
          {`${count()} MCP`}
        </text>
        <text fg={theme().textMuted}>/status</text>
      </box>
    </Show>
  )
}

// 260701 Red 跨 session 花费/缓存命中率统计条。session.cost/tokens 在落库时已经
// denormalize 好了（session.ts），这里直接对 sync.data.session 做本地 reduce，不产生新请求
function Stats(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const sync = useSync()
  const stats = createMemo(() => {
    let costCNY = 0
    let read = 0
    let miss = 0
    let write = 0
    for (const s of sync.data.session) {
      const cost = s.cost ?? 0
      const isCNY = s.model?.providerID ? CNY_PROVIDERS.has(s.model.providerID) : true
      costCNY += isCNY ? cost : cost * USD_TO_CNY
      const t = s.tokens
      if (!t) continue
      read += t.cache.read ?? 0
      write += t.cache.write ?? 0
      miss += t.cache.miss ?? t.input ?? 0
    }
    const denom = read + (miss || write)
    const hitPct = denom > 0 && read > 0 ? Math.round((read / denom) * 100) : null
    return { costCNY, hitPct, count: sync.data.session.length }
  })

  return (
    <Show when={stats().count > 0}>
      <box flexDirection="row" gap={1} flexShrink={0}>
        <text fg={theme().textMuted}>{money.format(stats().costCNY)}</text>
        <Show when={stats().hitPct !== null}>
          <text fg={theme().textMuted}>· cache hit {stats().hitPct}%</text>
        </Show>
      </box>
    </Show>
  )
}

function Version(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current

  return (
    <box flexShrink={0}>
      <text fg={theme().textMuted}>{props.api.app.version}</text>
    </box>
  )
}

function View(props: { api: TuiPluginApi }) {
  return (
    <box
      width="100%"
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
      flexDirection="row"
      flexShrink={0}
      gap={2}
    >
      <Directory api={props.api} />
      <Mcp api={props.api} />
      <Stats api={props.api} />
      <box flexGrow={1} />
      <Version api={props.api} />
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      home_footer() {
        return <View api={api} />
      },
    },
  })
}

const plugin: InternalTuiPlugin = {
  id,
  tui,
}

export default plugin
