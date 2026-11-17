import { TextAttributes } from "@opentui/core"
import { createResource, For, Match, Show, Switch } from "solid-js"
import { useDialog } from "@tui/ui/dialog"
import { useTheme } from "../context/theme"
import { useSDK } from "@tui/context/sdk"

// 261107 Red /instructions：注入清单只读视图。数据来自 GET /instructions
// （Instruction.describe() 与 system() 共用同一份预算管线，两边看到的一致）。
// 只显示「谁被注入、各占多少、谁被预算丢了」——内容本身不在这里，进上下文的是
// system() 的事，受注入四问约束；这个对话框是给人看的观测面。

const KIND_LABEL = { agents: "指令", memory: "记忆", config: "配置" } as const

function formatBytes(n: number) {
  if (n < 1024) return `${n}B`
  return `${(n / 1024).toFixed(1)}KiB`
}

export function DialogInstructions() {
  const { theme } = useTheme()
  const dialog = useDialog()
  const sdk = useSDK()

  const [inventory] = createResource(async () => {
    const result = await sdk.client.app.instructions()
    const inv = result.data
    // SDK 由 JSON schema 生成，Number 被放宽成 number | "Infinity" | ...；在边界收窄一次。
    if (!inv) return inv
    return {
      ...inv,
      totalBytes: Number(inv.totalBytes),
      budget: {
        maxSourceBytes: Number(inv.budget.maxSourceBytes),
        maxTotalBytes: Number(inv.budget.maxTotalBytes),
      },
      sources: inv.sources.map((s) => ({
        ...s,
        bytes: Number(s.bytes),
        effectiveBytes: s.effectiveBytes === undefined ? undefined : Number(s.effectiveBytes),
      })),
    }
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          注入清单
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <Switch
        fallback={
          <Show
            when={inventory()}
            fallback={<text fg={theme.textMuted}>⋯ 读取中</text>}
          >
            {(data) => {
              const inv = data()
              const trouble = inv.sources.some((s) => s.status !== "injected" && s.status !== "empty")
              return (
                <box gap={1}>
                  <text fg={theme.text}>
                    {`${inv.sources.length} 个来源 · 注入 ${formatBytes(inv.totalBytes)} / 总预算 ${formatBytes(inv.budget.maxTotalBytes)}`}
                  </text>
                  <For each={inv.sources}>
                    {(source) => (
                      <box flexDirection="row" gap={1}>
                        <text
                          flexShrink={0}
                          style={{
                            fg: (
                              {
                                injected: theme.success,
                                truncated: theme.warning,
                                dropped: theme.error,
                                skipped: theme.error,
                                missing: theme.warning,
                                empty: theme.textMuted,
                              } as Record<string, typeof theme.success>
                            )[source.status],
                          }}
                        >
                          {
                            {
                              injected: "•",
                              truncated: "△",
                              dropped: "✕",
                              skipped: "✕",
                              missing: "?",
                              empty: "○",
                            }[source.status]
                          }
                        </text>
                        <text fg={theme.text} wrapMode="word">
                          <b>{source.path}</b>{" "}
                          <span style={{ fg: theme.textMuted }}>
                            {`${KIND_LABEL[source.kind]} · `}
                            <Switch>
                              <Match when={source.status === "injected"}>
                                注入 {formatBytes(source.effectiveBytes!)}
                              </Match>
                              <Match when={source.status === "truncated"}>
                                截断至 {formatBytes(source.effectiveBytes!)}
                              </Match>
                              <Match when={source.status === "dropped"}>
                                超总预算丢弃（{formatBytes(source.effectiveBytes!)}）
                              </Match>
                              <Match when={source.status === "skipped"}>
                                {`${formatBytes(source.bytes)} 超单源上限 ${formatBytes(inv.budget.maxSourceBytes)}，未注入`}
                              </Match>
                              <Match when={source.status === "missing"}>读取失败</Match>
                              <Match when={source.status === "empty"}>空文件</Match>
                            </Switch>
                          </span>
                        </text>
                      </box>
                    )}
                  </For>
                  <Show when={trouble}>
                    <text fg={theme.textMuted} wrapMode="word">
                      有来源未进入注入面。需要时在 config 的 instruction_budget 里调高上限。
                    </text>
                  </Show>
                </box>
              )
            }}
          </Show>
        }
      >
        <Match when={inventory.error}>
          <text fg={theme.error}>注入清单读取失败</text>
        </Match>
      </Switch>
    </box>
  )
}
