// 260613 Red chat room — "office" UI shell
import { createSignal, createResource, For, Show, type Component } from "solid-js"

type ContactId = "tui" | "gui" | "group"

interface Contact {
  id: ContactId
  name: string
  subtitle: string
  avatar: string
  color: string
}

const contacts: Contact[] = [
  { id: "tui", name: "敏敏", subtitle: "TUI / 柳智敏", avatar: "🐱", color: "#6ec6ff" },
  { id: "gui", name: "小宋", subtitle: "GUI / 宋雨琦", avatar: "🐹", color: "#ff8a80" },
  { id: "group", name: "群聊", subtitle: "哥哥 + 敏敏 + 小宋", avatar: "🏠", color: "#b39ddb" },
]

interface SessionItem {
  id: string
  title: string
  time_updated: number
  agent: string
  model: string
  directory: string
}

interface ChatRoomProps {
  serverUrl?: string
  username?: string | null
  password?: string | null
}

async function fetchSessions(props: ChatRoomProps): Promise<SessionItem[]> {
  if (!props.serverUrl) return []
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (props.username && props.password) {
    headers["Authorization"] = "Basic " + btoa(`${props.username}:${props.password}`)
  }
  const res = await fetch(`${props.serverUrl}/session`, { headers })
  if (!res.ok) return []
  const data = await res.json()
  return (data ?? []) as SessionItem[]
}

function isGuiSession(s: SessionItem) {
  return s.directory?.includes("dist")
}

function timeAgo(ts: number): string {
  const diff = Math.floor(Date.now() / 1000 - ts)
  if (diff < 60) return "刚刚"
  if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`
  return `${Math.floor(diff / 86400)}天前`
}

const ChatRoom: Component<ChatRoomProps> = (props) => {
  const [active, setActive] = createSignal<ContactId | null>(null)
  const [sessions, { refetch }] = createResource(() => props, fetchSessions)

  const filteredSessions = () => {
    const all = sessions() ?? []
    const id = active()
    if (id === "tui") return all.filter((s) => !isGuiSession(s) && !s.directory?.includes("chat"))
    if (id === "gui") return all.filter((s) => isGuiSession(s))
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
                                <span>{session.model?.split("/").pop() ?? ""}</span>
                                <span>{timeAgo(session.time_updated)}</span>
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

export default ChatRoom

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
