import type { TuiPlugin, TuiPluginApi } from "@redcode-ai/plugin/tui"
import { USD_TO_CNY } from "@redcode-ai/core/currency"
import type { InternalTuiPlugin } from "../../plugin/internal"
import { createMemo, createResource, Match, onCleanup, Show, Switch } from "solid-js"
import { Global } from "@redcode-ai/core/global"
import { useEvent } from "@tui/context/event"
import { useSDK } from "@tui/context/sdk"
import { useSync } from "@tui/context/sync"
import { useDialog } from "@tui/ui/dialog"
import { DialogMcp } from "@tui/component/dialog-mcp"

const id = "internal:home-footer"

// 260701 Red DeepSeek/Xiaomi 报价本身是 CNY，其余按官方汇率折算成 ¥ 统一展示
// （与 GUI 侧 session-context-format.ts 的 USD_TO_CNY 保持一致）
//
// 260730 Karina 币种判定从"硬编码 providerID 名单"改成读 model.cost.currency。
// 原来这里维护了一份精确匹配的集合 `["deepseek","xiaomi","stepfun","zhipuai","opencode-go"]`，
// 而 provider.ts 的 CNY_PRICING 是另一份名单 —— 同一件事在两处各存一份，加 provider 必漏。
// 实测漏的就是 `stepfun-step-plan`：它的 cost 本来就是人民币（0.8.1 刚补的定价），
// 却因为不在这个集合里被当美元又乘了一次 6.76，¥7.50 显示成 ¥50.73。
// provider.ts:1267 落定价时已经写了 `currency: "CNY"`，直接读它就不会再漏。
// 260904 cc 汇率的四份拷贝已合并到 @redcode-ai/core/currency，改汇率只改那一处。
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
  const dialog = useDialog()
  const list = createMemo(() => props.api.state.mcp())
  const has = createMemo(() => list().length > 0)
  const err = createMemo(() => list().some((item) => item.status === "failed"))
  const count = createMemo(() => list().filter((item) => item.status === "connected").length)

  return (
    <Show when={has()}>
      <box gap={1} flexDirection="row" flexShrink={0}>
        <box onMouseUp={() => dialog.replace(() => <DialogMcp />)}>
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
        </box>
        <text fg={theme().textMuted}>/status</text>
      </box>
    </Show>
  )
}

// 261022 Red 会话列表只返回近期/有限条目，累计计费改读和 GUI 相同的全项目聚合
function Stats(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const sync = useSync()
  const sdk = useSDK()
  const event = useEvent()
  const [usage, { refetch }] = createResource(async () => {
    const result = await sdk.client.session.usage({ range: "all" })
    return result.data
  })
  onCleanup(event.on("session.updated", () => void refetch()))

  const stats = createMemo(() => {
    const data = usage()
    if (!data) return { costCNY: 0, hitPct: null, count: 0 }

    const costCNY = data.models.reduce((sum, model) => {
      const cost = sync.data.provider.find((p) => p.id === model.providerID)?.models[model.modelID]
        ?.cost as { currency?: string } | undefined
      return sum + (cost?.currency === "CNY" ? model.cost : model.cost * USD_TO_CNY)
    }, 0)
    const denominator = data.tokens.cacheRead + data.tokens.cacheWrite + data.tokens.input
    const hitPct = denominator > 0 ? Math.round((data.tokens.cacheRead / denominator) * 100) : null
    return { costCNY, hitPct, count: data.sessions }
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
