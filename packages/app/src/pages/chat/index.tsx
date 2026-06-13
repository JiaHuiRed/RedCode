// 260613 Red chat room — "office" UI shell
import { createSignal, createResource, For, Show } from "solid-js"
import { useServer } from "@/context/server"

type ContactId = "tui" | "gui" | "group"

interface Contact {
  id: ContactId
  name: string
  subtitle: string
  avatar: string
  color: string
}

// TODO: 动态从 ~/.redcode/souls/{T,G}soul.md 标题读取名字（需 preload API）
const contacts: Contact[] = [
  { id: "tui", name: "TUI", subtitle: "Terminal Agent", avatar: "🐱", color: "#6ec6ff" },
  { id: "gui", name: "GUI", subtitle: "Desktop Agent", avatar: "🐹", color: "#ff8a80" },
  { id: "group", name: "Group", subtitle: "User + TUI + GUI", avatar: "🏠", color: "#b39ddb" },
]

interface SessionItem {
  id: string
  title: string
  time: { created: number; updated: number }
  agent?: string
  model?: { id: string; providerID: string }
  directory: string
}

async function fetchSessions(serverUrl: string, auth?: { username: string; password: string }): Promise<SessionItem[]> {
  if (!serverUrl) return []
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (auth) {
    headers["Authorization"] = "Basic " + btoa(`${auth.username}:${auth.password}`)
  }
  const res = await fetch(`${serverUrl}/session`, { headers })
  if (!res.ok) return []
  const data = await res.json()
  return (data ?? []) as SessionItem[]
}

// 260613 Red dist = TUI (敏敏从 dist/ 启动), 非 dist = GUI
function isTuiSession(s: SessionItem) {
  return s.directory?.includes("dist")
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return "刚刚"
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}分钟前`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}小时前`
  return `${Math.floor(diff / 86400_000)}天前`
}

export default function ChatRoom() {
  const server = useServer()
  const [active, setActive] = createSignal<ContactId | null>(null)
  const http = () => {
    const c = server.current
    return c && "http" in c ? c.http : undefined
  }
  const [sessions] = createResource(
    () => http()?.url,
    (url) => fetchSessions(url, http()?.username && http()?.password ? { username: http()!.username!, password: http()!.password! } : undefined),
  )

  const filteredSessions = () => {
    const all = sessions() ?? []
    const id = active()
    if (id === "tui") return all.filter((s) => isTuiSession(s))
    if (id === "gui") return all.filter((s) => !isTuiSession(s))
    if (id === "group") return all // group shows all
    return []
  }

  return (
    <div style={styles.container}>
      <div style={styles.titlebar}>
        <span style={styles.titleText}>RedCode Office</span>
      </div>

      <div style={styles.body}>
        {/* Left sidebar */}
        <div style={styles.sidebar}>
          <For each={contacts}>
            {(contact) => (
              <div
                style={{
                  ...styles.contactItem,
                  ...(active() === contact.id ? styles.contactActive : {}),
                }}
                onClick={() => setActive(contact.id)}
              >
                <div
                  style={{
                    ...styles.avatar,
                    "background-color": contact.color + "33",
                    "border-color": contact.color,
                  }}
                >
                  {contact.avatar}
                </div>
                <div style={styles.contactInfo}>
                  <div style={styles.contactName}>{contact.name}</div>
                  <div style={styles.contactSub}>{contact.subtitle}</div>
                </div>
              </div>
            )}
          </For>
        </div>

        {/* Right panel */}
        <div style={styles.main}>
          <Show
            when={active()}
            fallback={
              <div style={styles.empty}>
                <div style={styles.emptyIcon}>🏢</div>
                <div style={styles.emptyText}>RedCode Office</div>
                <div style={styles.emptyHint}>点击左侧头像开始对话</div>
              </div>
            }
          >
            {(contactId) => {
              const contact = () => contacts.find((c) => c.id === contactId())!
              return (
                <div style={styles.chatPanel}>
                  <div style={styles.chatHeader}>
                    <div
                      style={{
                        ...styles.avatarSmall,
                        "background-color": contact().color + "33",
                        "border-color": contact().color,
                      }}
                    >
                      {contact().avatar}
                    </div>
                    <span style={styles.chatTitle}>{contact().name}</span>
                    <span style={styles.chatSubtitle}>{contact().subtitle}</span>
                    <div style={{ "margin-left": "auto" }}>
                      <button
                        style={styles.newBtn}
                        onClick={() => {/* TODO: create new session */}}
                      >
                        + 新对话
                      </button>
                    </div>
                  </div>

                  {/* Session list */}
                  <div style={styles.chatBody}>
                    <Show when={!sessions.loading} fallback={<div style={styles.placeholder}>加载中...</div>}>
                      <Show
                        when={filteredSessions().length > 0}
                        fallback={<div style={styles.placeholder}>暂无对话</div>}
                      >
                        <For each={filteredSessions()}>
                          {(session) => (
                            <div
                              style={styles.sessionItem}
                              onClick={() => {/* TODO: open session chat view */}}
                            >
                              <div style={styles.sessionTitle}>
                                {session.title || "未命名对话"}
                              </div>
                              <div style={styles.sessionMeta}>
                                <span>{session.model?.id?.split("/").pop() ?? ""}</span>
                                <span>{timeAgo(session.time?.updated || session.time?.created || 0)}</span>
                              </div>
                            </div>
                          )}
                        </For>
                      </Show>
                    </Show>
                  </div>
                </div>
              )
            }}
          </Show>
        </div>
      </div>
    </div>
  )
}

// -- Inline styles --

const styles = {
  container: {
    display: "flex",
    "flex-direction": "column",
    height: "100vh",
    "background-color": "var(--color-background, #1a1a2e)",
    color: "var(--color-foreground, #e0e0e0)",
    "font-family": "system-ui, -apple-system, sans-serif",
    overflow: "hidden",
  } as const,
  titlebar: {
    height: "40px",
    display: "flex",
    "align-items": "center",
    "justify-content": "center",
    "-webkit-app-region": "drag",
    "background-color": "var(--color-surface, #16213e)",
    "border-bottom": "1px solid var(--color-border, #2a2a4a)",
    "flex-shrink": "0",
  } as const,
  titleText: {
    "font-size": "13px",
    "font-weight": "600",
    opacity: "0.7",
    "user-select": "none",
  } as const,
  body: {
    display: "flex",
    flex: "1",
    overflow: "hidden",
  } as const,
  sidebar: {
    width: "220px",
    "min-width": "220px",
    "border-right": "1px solid var(--color-border, #2a2a4a)",
    "background-color": "var(--color-surface, #16213e)",
    display: "flex",
    "flex-direction": "column",
    "padding-top": "8px",
    overflow: "auto",
  } as const,
  contactItem: {
    display: "flex",
    "align-items": "center",
    gap: "10px",
    padding: "10px 14px",
    cursor: "pointer",
    transition: "background-color 0.15s",
    "border-radius": "8px",
    margin: "2px 6px",
    "-webkit-app-region": "no-drag",
  } as const,
  contactActive: {
    "background-color": "rgba(100, 100, 180, 0.25)",
  } as const,
  avatar: {
    width: "40px",
    height: "40px",
    "border-radius": "50%",
    display: "flex",
    "align-items": "center",
    "justify-content": "center",
    "font-size": "20px",
    border: "2px solid",
    "flex-shrink": "0",
  } as const,
  avatarSmall: {
    width: "28px",
    height: "28px",
    "border-radius": "50%",
    display: "flex",
    "align-items": "center",
    "justify-content": "center",
    "font-size": "14px",
    border: "2px solid",
    "flex-shrink": "0",
  } as const,
  contactInfo: {
    display: "flex",
    "flex-direction": "column",
    overflow: "hidden",
  } as const,
  contactName: {
    "font-size": "14px",
    "font-weight": "600",
  } as const,
  contactSub: {
    "font-size": "11px",
    opacity: "0.5",
    "white-space": "nowrap",
    overflow: "hidden",
    "text-overflow": "ellipsis",
  } as const,
  main: {
    flex: "1",
    display: "flex",
    "flex-direction": "column",
    overflow: "hidden",
  } as const,
  empty: {
    flex: "1",
    display: "flex",
    "flex-direction": "column",
    "align-items": "center",
    "justify-content": "center",
    gap: "8px",
    opacity: "0.5",
  } as const,
  emptyIcon: {
    "font-size": "48px",
  } as const,
  emptyText: {
    "font-size": "18px",
    "font-weight": "600",
  } as const,
  emptyHint: {
    "font-size": "13px",
  } as const,
  chatPanel: {
    flex: "1",
    display: "flex",
    "flex-direction": "column",
    overflow: "hidden",
  } as const,
  chatHeader: {
    display: "flex",
    "align-items": "center",
    gap: "8px",
    padding: "10px 16px",
    "border-bottom": "1px solid var(--color-border, #2a2a4a)",
    "background-color": "var(--color-surface, #16213e)",
    "flex-shrink": "0",
  } as const,
  chatTitle: {
    "font-size": "15px",
    "font-weight": "600",
  } as const,
  chatSubtitle: {
    "font-size": "12px",
    opacity: "0.5",
  } as const,
  chatBody: {
    flex: "1",
    display: "flex",
    "flex-direction": "column",
    overflow: "auto",
    padding: "8px",
  } as const,
  placeholder: {
    flex: "1",
    display: "flex",
    "align-items": "center",
    "justify-content": "center",
    opacity: "0.4",
    "font-size": "14px",
  } as const,
  newBtn: {
    background: "rgba(100, 100, 180, 0.3)",
    border: "1px solid rgba(100, 100, 180, 0.5)",
    color: "inherit",
    padding: "4px 12px",
    "border-radius": "6px",
    cursor: "pointer",
    "font-size": "12px",
    "-webkit-app-region": "no-drag",
  } as const,
  sessionItem: {
    padding: "10px 12px",
    "border-radius": "8px",
    cursor: "pointer",
    transition: "background-color 0.15s",
    "border-bottom": "1px solid rgba(255,255,255,0.05)",
  } as const,
  sessionTitle: {
    "font-size": "13px",
    "font-weight": "500",
    "margin-bottom": "4px",
    overflow: "hidden",
    "text-overflow": "ellipsis",
    "white-space": "nowrap",
  } as const,
  sessionMeta: {
    display: "flex",
    "justify-content": "space-between",
    "font-size": "11px",
    opacity: "0.45",
  } as const,
} as const
