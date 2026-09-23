import { Button } from "@redcode-ai/ui/button"
import { CapsuleRow, type CapsuleTone } from "@redcode-ai/ui/capsule"
import { useDialog } from "@redcode-ai/ui/context/dialog"
import { Icon } from "@redcode-ai/ui/icon"
import { Switch } from "@redcode-ai/ui/switch"
import { useMutation, useQueryClient } from "@tanstack/solid-query"
import { showToast } from "@redcode-ai/ui/toast"
import { useNavigate } from "@solidjs/router"
import { type Accessor, createEffect, createMemo, createSignal, For, type JSXElement, onCleanup, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { ServerRow } from "@/components/server/server-row"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { normalizeServerUrl, ServerConnection, useServer } from "@/context/server"
import { useSync } from "@/context/sync"
import { useCheckServerHealth, type ServerHealth } from "@/utils/server-health"
import { formatServerError } from "@/utils/server-errors"
import { useQueryOptions } from "@/context/server-sync"
import { pathKey } from "@/utils/path-key"

const pollMs = 10_000

/** 服务器健康 → 状态点语义；未探到状态落在中性色。 */
const healthTone = (value: ServerHealth | undefined): CapsuleTone => {
  if (value?.healthy === true) return "success"
  if (value?.healthy === false) return "critical"
  return "idle"
}

/** 同步数据里的连接状态 → 状态点语义。 */
const connectionTone = (value: string | undefined): CapsuleTone => {
  if (value === "connected") return "success"
  if (value === "failed" || value === "error") return "critical"
  if (value === "needs_auth" || value === "needs_client_registration") return "warning"
  return "idle"
}

const pluginEmptyMessage = (value: string, file: string): JSXElement => {
  const parts = value.split(file)
  if (parts.length === 1) return value
  return (
    <>
      {parts[0]}
      <code class="bg-surface-raised-base px-1.5 py-0.5 rounded-sm text-text-base">{file}</code>
      {parts.slice(1).join(file)}
    </>
  )
}

const listServersByHealth = (
  list: ServerConnection.Any[],
  active: ServerConnection.Key | undefined,
  status: Record<ServerConnection.Key, ServerHealth | undefined>,
) => {
  if (!list.length) return list
  const order = new Map(list.map((url, index) => [url, index] as const))
  const rank = (value?: ServerHealth) => {
    if (value?.healthy === true) return 0
    if (value?.healthy === false) return 2
    return 1
  }

  return list.slice().sort((a, b) => {
    if (ServerConnection.key(a) === active) return -1
    if (ServerConnection.key(b) === active) return 1
    const diff = rank(status[ServerConnection.key(a)]) - rank(status[ServerConnection.key(b)])
    if (diff !== 0) return diff
    return (order.get(a) ?? 0) - (order.get(b) ?? 0)
  })
}

const useServerHealth = (servers: Accessor<ServerConnection.Any[]>, enabled: Accessor<boolean>) => {
  const checkServerHealth = useCheckServerHealth()
  const [status, setStatus] = createStore({} as Record<ServerConnection.Key, ServerHealth | undefined>)

  createEffect(() => {
    if (!enabled()) {
      setStatus(reconcile({}))
      return
    }
    const list = servers()
    let dead = false

    const refresh = async () => {
      const results: Record<string, ServerHealth> = {}
      await Promise.all(
        list.map(async (conn) => {
          results[ServerConnection.key(conn)] = await checkServerHealth(conn.http)
        }),
      )
      if (dead) return
      setStatus(reconcile(results))
    }

    void refresh()
    const id = setInterval(() => void refresh(), pollMs)
    onCleanup(() => {
      dead = true
      clearInterval(id)
    })
  })

  return status
}

const useDefaultServerKey = (
  get: (() => string | Promise<string | null | undefined> | null | undefined) | undefined,
) => {
  const [state, setState] = createStore({
    url: undefined as string | undefined,
    tick: 0,
  })

  createEffect(() => {
    state.tick
    let dead = false
    const result = get?.()
    if (!result) {
      setState("url", undefined)
      onCleanup(() => {
        dead = true
      })
      return
    }

    if (result instanceof Promise) {
      void result.then((next) => {
        if (dead) return
        setState("url", next ? normalizeServerUrl(next) : undefined)
      })
      onCleanup(() => {
        dead = true
      })
      return
    }

    setState("url", normalizeServerUrl(result))
    onCleanup(() => {
      dead = true
    })
  })

  return {
    key: () => {
      const u = state.url
      if (!u) return
      return ServerConnection.key({ type: "http", http: { url: u } })
    },
    refresh: () => setState("tick", (value) => value + 1),
  }
}

const useMcpToggleMutation = () => {
  const sync = useSync()
  const sdk = useSDK()
  const language = useLanguage()
  const queryClient = useQueryClient()
  const queryOptions = useQueryOptions()

  return useMutation(() => ({
    mutationFn: async (name: string) => {
      const status = sync.data.mcp[name]
      if (status?.status === "connected") {
        await sdk.client.mcp.disconnect({ name })
        return
      }
      if (status?.status === "needs_auth") {
        await sdk.client.mcp.auth.authenticate({ name })
        return
      }
      await sdk.client.mcp.connect({ name })
    },
    // 同 dialog-select-mcp：原始路径必须过 pathKey，与写入侧 queryKey 对齐
    onSuccess: () => queryClient.refetchQueries(queryOptions.mcp(pathKey(sync.directory))),
    onError: (err) => {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: formatServerError(err, language.t),
      })
    },
  }))
}

function StatusSection(props: { id: string; label: string; summary: string; children: JSXElement }) {
  const [expanded, setExpanded] = createSignal(false)

  return (
    <section data-slot="capsule-section">
      <CapsuleRow
        label={props.label}
        description={<span class="truncate">{props.summary}</span>}
        trailing={
          <Icon name="chevron-down" class={expanded() ? "rotate-180 transition-transform" : "transition-transform"} />
        }
        selected={expanded()}
        aria-expanded={expanded()}
        aria-controls={`session-status-${props.id}`}
        onClick={() => setExpanded((value) => !value)}
      />
      <Show when={expanded()}>
        <div id={`session-status-${props.id}`} class="flex flex-col gap-2 px-2 pb-2 pt-1">
          {props.children}
        </div>
      </Show>
    </section>
  )
}

// 260924 Red Status 的四段详情改为可折叠 section，复用原有数据和操作。
export function SessionStatusTab(props: { shown: Accessor<boolean> }) {
  const sync = useSync()
  const server = useServer()
  const platform = usePlatform()
  const dialog = useDialog()
  const language = useLanguage()
  const navigate = useNavigate()

  const fail = (err: unknown) => {
    showToast({
      variant: "error",
      title: language.t("common.requestFailed"),
      description: formatServerError(err, language.t),
    })
  }

  let dialogRun = 0
  let dialogDead = false
  onCleanup(() => {
    dialogDead = true
    dialogRun += 1
  })
  const servers = createMemo(() => {
    const current = server.current
    const list = server.list
    if (!current) return list
    if (list.every((item) => ServerConnection.key(item) !== ServerConnection.key(current))) return [current, ...list]
    return [current, ...list.filter((item) => ServerConnection.key(item) !== ServerConnection.key(current))]
  })
  const health = useServerHealth(servers, props.shown)
  const sortedServers = createMemo(() => listServersByHealth(servers(), server.key, health))
  const healthyServers = createMemo(
    () => sortedServers().filter((conn) => health[ServerConnection.key(conn)]?.healthy === true).length,
  )
  const toggleMcp = useMcpToggleMutation()
  const defaultServer = useDefaultServerKey(platform.getDefaultServer)
  const mcpNames = createMemo(() => Object.keys(sync.data.mcp ?? {}).sort((a, b) => a.localeCompare(b)))
  const mcpStatus = (name: string) => sync.data.mcp?.[name]?.status
  const mcpConnected = createMemo(() => mcpNames().filter((name) => mcpStatus(name) === "connected").length)
  const lspItems = createMemo(() => sync.data.lsp ?? [])
  const lspCount = createMemo(() => lspItems().length)
  const plugins = createMemo(() =>
    (sync.data.config.plugin ?? []).map((item) => (typeof item === "string" ? item : item[0])),
  )
  const pluginCount = createMemo(() => plugins().length)
  const pluginEmpty = createMemo(() => pluginEmptyMessage(language.t("dialog.plugins.empty"), "redcode.json"))

  return (
    <div class="h-full min-w-0 overflow-y-auto px-2 py-2" aria-label={language.t("session.tab.status")}>
      <div class="flex flex-col gap-1">
        <StatusSection
          id="servers"
          label={language.t("status.popover.tab.servers")}
          summary={`${healthyServers()} / ${sortedServers().length}`}
        >
          <For each={sortedServers()}>
            {(s) => {
              const key = ServerConnection.key(s)
              const blocked = () => health[key]?.healthy === false
              return (
                <CapsuleRow
                  status={healthTone(health[key])}
                  disabled={blocked()}
                  onClick={() => {
                    if (blocked()) return
                    navigate("/")
                    queueMicrotask(() => server.setActive(key))
                  }}
                >
                  <ServerRow
                    conn={s}
                    dimmed={blocked()}
                    status={health[key]}
                    class="flex items-center gap-2 w-full min-w-0"
                    nameClass="text-14-regular text-text-base truncate"
                    versionClass="text-12-regular text-text-weak truncate"
                    badge={
                      <Show when={key === defaultServer.key()}>
                        <span class="text-11-regular text-text-base bg-surface-base px-1.5 py-0.5 rounded-md">
                          {language.t("common.default")}
                        </span>
                      </Show>
                    }
                  >
                    <div class="flex-1" />
                    <Show when={server.current && key === ServerConnection.key(server.current)}>
                      <Icon name="check" size="small" class="text-icon-weak shrink-0" />
                    </Show>
                  </ServerRow>
                </CapsuleRow>
              )
            }}
          </For>
          <Button
            variant="secondary"
            class="mt-2 self-start h-8 px-3 py-1.5"
            onClick={() => {
              const run = ++dialogRun
              void import("../dialog-select-server").then((x) => {
                if (dialogDead || dialogRun !== run) return
                dialog.show(() => <x.DialogSelectServer />, defaultServer.refresh)
              })
            }}
          >
            {language.t("status.popover.action.manageServers")}
          </Button>
        </StatusSection>

        <StatusSection
          id="mcp"
          label={language.t("status.popover.tab.mcp")}
          summary={`${mcpConnected()} / ${mcpNames().length}`}
        >
          <Show
            when={mcpNames().length > 0}
            fallback={
              <div class="text-14-regular text-text-base text-center py-2">{language.t("dialog.mcp.empty")}</div>
            }
          >
            <For each={mcpNames()}>
              {(name) => {
                const status = () => mcpStatus(name)
                const enabled = () => status() === "connected"
                const pending = () => toggleMcp.isPending && toggleMcp.variables === name
                return (
                  <CapsuleRow
                    status={connectionTone(status())}
                    label={name}
                    description={status() === "needs_auth" ? language.t("mcp.auth.clickToAuthenticate") : undefined}
                    disabled={pending()}
                    onClick={() => {
                      if (toggleMcp.isPending) return
                      toggleMcp.mutate(name)
                    }}
                    trailing={
                      <div onClick={(event) => event.stopPropagation()}>
                        <Switch
                          checked={enabled()}
                          disabled={pending()}
                          onChange={() => {
                            if (toggleMcp.isPending) return
                            toggleMcp.mutate(name)
                          }}
                        />
                      </div>
                    }
                  />
                )
              }}
            </For>
          </Show>
        </StatusSection>

        <StatusSection
          id="lsp"
          label={language.t("status.popover.tab.lsp")}
          summary={lspCount().toLocaleString(language.intl())}
        >
          <Show
            when={lspItems().length > 0}
            fallback={
              <div class="text-14-regular text-text-base text-center py-2">{language.t("dialog.lsp.empty")}</div>
            }
          >
            <For each={lspItems()}>
              {(item) => <CapsuleRow status={connectionTone(item.status)} label={item.name || item.id} />}
            </For>
          </Show>
        </StatusSection>

        <StatusSection
          id="plugins"
          label={language.t("status.popover.tab.plugins")}
          summary={pluginCount().toLocaleString(language.intl())}
        >
          <Show
            when={plugins().length > 0}
            fallback={<div class="text-14-regular text-text-base text-center py-2">{pluginEmpty()}</div>}
          >
            <For each={plugins()}>{(plugin) => <CapsuleRow status="success" label={plugin} />}</For>
          </Show>
        </StatusSection>
      </div>
    </div>
  )
}
