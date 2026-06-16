// 260613 Red chat room — "office" UI shell
// 260615 Red group chat messaging UI
import { createSignal, createResource, createEffect, For, Show, on, onCleanup } from "solid-js"
import { useServer } from "@/context/server"

type ContactId = "tui" | "gui" | "group"

interface Contact {
  id: ContactId
  name: string
  subtitle: string
  avatar: string
  color: string
}

const contacts: Contact[] = [
  { id: "tui", name: "TUI", subtitle: "Terminal Agent", avatar: "\u{1F431}", color: "#6ec6ff" },
  { id: "gui", name: "GUI", subtitle: "Desktop Agent", avatar: "\u{1F439}", color: "#ff8a80" },
  { id: "group", name: "Group", subtitle: "User + TUI + GUI", avatar: "\u{1F3E0}", color: "#b39ddb" },
]

interface SessionItem {
  id: string
  title: string
  time: { created: number; updated: number }
  agent?: string
  model?: { id: string; providerID: string }
  directory: string
  client?: string
}

// 260615 Red group chat message from DB
interface ChatMessage {
  id: string
  room_id: string
  sender: "user" | "tui" | "gui"
  text: string | null
  content_type: string
  session_id: string | null
  time_created: number
}

function makeHeaders(http?: { url: string; username?: string; password?: string }) {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (http?.username && http?.password) {
    headers["Authorization"] = "Basic " + btoa(`${http.username}:${http.password}`)
  }
  return headers
}

async function fetchSessions(http: { url: string; username?: string; password?: string }): Promise<SessionItem[]> {
  if (!http.url) return []
  // 260615 Red scope=global to see sessions from all directories (TUI + GUI)
  const res = await fetch(`${http.url}/session?scope=global`, { headers: makeHeaders(http) })
  if (!res.ok) return []
  const data = await res.json()
  return (data ?? []) as SessionItem[]
}

// 260615 Red fetch group chat messages
async function fetchGroupMessages(http: { url: string; username?: string; password?: string }): Promise<ChatMessage[]> {
  const roomId = "office"
  // 260615 Red ensure room exists first
  await fetch(`${http.url}/chat/room/${roomId}`, {
    method: "POST",
    headers: makeHeaders(http),
    body: JSON.stringify({ type: "group" }),
  })
  const res = await fetch(`${http.url}/chat/room/${roomId}/message?limit=100`, {
    headers: makeHeaders(http),
  })
  if (!res.ok) return []
  const data = await res.json()
  return ((data ?? []) as ChatMessage[]).reverse()
}

// 260615 Red send message to group chat
async function sendGroupMessage(http: { url: string; username?: string; password?: string }, text: string) {
  const roomId = "office"
  const res = await fetch(`${http.url}/chat/room/${roomId}/message`, {
    method: "POST",
    headers: makeHeaders(http),
    body: JSON.stringify({ roomId, sender: "user", text }),
  })
  return res.ok
}

// 260616 Red 用 session.client 字段精确区分 TUI/GUI（B 方案根治）
// client="desktop" → GUI，client="cli"/其他 → TUI，老会话无 client 走标题前缀 fallback
function isTuiSession(s: SessionItem) {
  if (s.client) return s.client !== "desktop"
  // fallback: 标题前缀 [宋雨琦]/[GUI] = GUI，其余默认 TUI
  const m = s.title.match(/^\[(.+?)\]/)
  if (m) {
    const label = m[1]
    if (label === "GUI" || label === "\u5B8B\u96E8\u7426") return false
  }
  return true
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return "\u{521A}\u{521A}"
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}\u{5206}\u{949F}\u{524D}`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}\u{5C0F}\u{65F6}\u{524D}`
  return `${Math.floor(diff / 86400_000)}\u{5929}\u{524D}`
}

const senderMeta: Record<string, { avatar: string; name: string; color: string }> = {
  user: { avatar: "\u{1F464}", name: "You", color: "#a5d6a7" },
  tui: { avatar: "\u{1F431}", name: "TUI", color: "#6ec6ff" },
  gui: { avatar: "\u{1F439}", name: "GUI", color: "#ff8a80" },
}

// 260615 Red Group chat view component
function GroupChatView(props: { http: { url: string; username?: string; password?: string } }) {
  const [input, setInput] = createSignal("")
  const [sending, setSending] = createSignal(false)
  const [waiting, setWaiting] = createSignal(false)
  const [pollTick, setPollTick] = createSignal(0)
  let messagesEnd: HTMLDivElement | undefined
  let inputRef: HTMLTextAreaElement | undefined
  let lastUserMsgTime = 0

  const [messages, { refetch }] = createResource(
    () => [props.http, pollTick()] as const,
    () => fetchGroupMessages(props.http),
  )

  // 260615 Red auto-poll every 3s
  const timer = setInterval(() => setPollTick((n) => n + 1), 3000)
  onCleanup(() => clearInterval(timer))

  // 260615 Red auto-scroll to bottom on new messages
  createEffect(
    on(
      () => messages(),
      () => {
        setTimeout(() => messagesEnd?.scrollIntoView({ behavior: "smooth" }), 50)
      },
    ),
  )

  // 260615 Red detect when agents have responded (stop waiting indicator)
  createEffect(
    on(
      () => messages(),
      () => {
        if (!waiting()) return
        const msgs = messages() ?? []
        const hasAgentReply = msgs.some((m) => m.sender !== "user" && m.time_created > lastUserMsgTime)
        if (hasAgentReply) setWaiting(false)
      },
    ),
  )

  async function handleSend() {
    const text = input().trim()
    if (!text || sending()) return
    setSending(true)
    const ok = await sendGroupMessage(props.http, text)
    setSending(false)
    if (ok) {
      setInput("")
      lastUserMsgTime = Date.now()
      setWaiting(true)
      refetch()
      inputRef?.focus()
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <>
      <div style={styles.chatBody}>
        <Show when={!messages.loading || (messages() && messages()!.length > 0)} fallback={<div style={styles.placeholder}>Loading...</div>}>
          <Show when={(messages() ?? []).length > 0} fallback={<div style={styles.placeholder}>Group chat is empty. Send a message to start coordinating!</div>}>
            <For each={messages()}>
              {(msg) => {
                const meta = () => senderMeta[msg.sender] ?? senderMeta.user
                const isUser = () => msg.sender === "user"
                return (
                  <div
                    style={{
                      display: "flex",
                      "flex-direction": isUser() ? "row-reverse" : "row",
                      "align-items": "flex-start",
                      gap: "8px",
                      padding: "6px 12px",
                      "margin-bottom": "2px",
                    }}
                  >
                    <div
                      style={{
                        width: "30px",
                        height: "30px",
                        "border-radius": "50%",
                        "background-color": meta().color + "33",
                        border: `2px solid ${meta().color}`,
                        display: "flex",
                        "align-items": "center",
                        "justify-content": "center",
                        "font-size": "14px",
                        "flex-shrink": "0",
                      }}
                    >
                      {meta().avatar}
                    </div>
                    <div style={{ "max-width": "70%", "min-width": "0" }}>
                      <div
                        style={{
                          "font-size": "11px",
                          opacity: "0.5",
                          "margin-bottom": "2px",
                          "text-align": isUser() ? "right" : "left",
                        }}
                      >
                        {meta().name}
                        <span style={{ "margin-left": "6px" }}>
                          {new Date(msg.time_created).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        </span>
                      </div>
                      <div
                        style={{
                          "background-color": isUser() ? "rgba(100, 100, 200, 0.25)" : "rgba(255, 255, 255, 0.08)",
                          padding: "8px 12px",
                          "border-radius": isUser() ? "14px 4px 14px 14px" : "4px 14px 14px 14px",
                          "font-size": "13px",
                          "line-height": "1.5",
                          "white-space": "pre-wrap",
                          "word-break": "break-word",
                        }}
                      >
                        {msg.text ?? ""}
                      </div>
                    </div>
                  </div>
                )
              }}
            </For>
          </Show>
        </Show>
        {/* 260615 Red typing indicator while agents are processing */}
        <Show when={waiting()}>
          <div style={{ padding: "8px 12px", opacity: "0.5", "font-size": "12px", "font-style": "italic" }}>
            {"\u{1F431}"} TUI & {"\u{1F439}"} GUI are thinking...
          </div>
        </Show>
        <div ref={messagesEnd} />
      </div>

      {/* 260615 Red input bar */}
      <div style={styles.inputBar}>
        <textarea
          ref={inputRef}
          value={input()}
          onInput={(e) => setInput(e.currentTarget.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a message... (Enter to send, Shift+Enter for newline)"
          rows={1}
          style={styles.inputField}
          disabled={sending()}
        />
        <button style={styles.sendBtn} onClick={handleSend} disabled={sending() || !input().trim()}>
          {sending() ? "..." : "Send"}
        </button>
      </div>
    </>
  )
}

export default function ChatRoom() {
  const server = useServer()
  const [active, setActive] = createSignal<ContactId | null>(null)
  const http = () => {
    const c = server.current
    return c && "http" in c ? c.http : undefined
  }
  const [sessions] = createResource(
    () => http(),
    (h) => fetchSessions(h),
  )

  const filteredSessions = () => {
    const all = sessions() ?? []
    const id = active()
    if (id === "tui") return all.filter((s) => isTuiSession(s))
    if (id === "gui") return all.filter((s) => !isTuiSession(s))
    return []
  }

  // 260615 Red determine if showing group chat vs session list
  const isGroup = () => active() === "group"

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
                <div style={styles.emptyIcon}>{"\u{1F3E2}"}</div>
                <div style={styles.emptyText}>RedCode Office</div>
                <div style={styles.emptyHint}>{"\u{70B9}\u{51FB}\u{5DE6}\u{4FA7}\u{5934}\u{50CF}\u{5F00}\u{59CB}\u{5BF9}\u{8BDD}"}</div>
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
                    <Show when={!isGroup()}>
                      <div style={{ "margin-left": "auto" }}>
                        <button
                          style={styles.newBtn}
                          onClick={() => {/* TODO: create new session */}}
                        >
                          + {"\u{65B0}\u{5BF9}\u{8BDD}"}
                        </button>
                      </div>
                    </Show>
                  </div>

                  {/* 260615 Red group = chat view, others = session list */}
                  <Show
                    when={isGroup() && http()}
                    fallback={
                      <div style={styles.chatBody}>
                        <Show when={!sessions.loading} fallback={<div style={styles.placeholder}>{"\u{52A0}\u{8F7D}\u{4E2D}"}...</div>}>
                          <Show
                            when={filteredSessions().length > 0}
                            fallback={<div style={styles.placeholder}>{"\u{6682}\u{65E0}\u{5BF9}\u{8BDD}"}</div>}
                          >
                            <For each={filteredSessions()}>
                              {(session) => (
                                <div
                                  style={styles.sessionItem}
                                  onClick={() => {/* TODO: open session chat view */}}
                                >
                                  <div style={styles.sessionTitle}>
                                    {session.title || "\u{672A}\u{547D}\u{540D}\u{5BF9}\u{8BDD}"}
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
                    }
                  >
                    <GroupChatView http={http()!} />
                  </Show>
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
  // 260615 Red group chat input styles
  inputBar: {
    display: "flex",
    "align-items": "flex-end",
    gap: "8px",
    padding: "10px 12px",
    "border-top": "1px solid var(--color-border, #2a2a4a)",
    "background-color": "var(--color-surface, #16213e)",
    "flex-shrink": "0",
  } as const,
  inputField: {
    flex: "1",
    background: "rgba(255, 255, 255, 0.06)",
    border: "1px solid rgba(255, 255, 255, 0.12)",
    "border-radius": "10px",
    color: "inherit",
    padding: "8px 12px",
    "font-size": "13px",
    "font-family": "inherit",
    resize: "none",
    "min-height": "20px",
    "max-height": "120px",
    outline: "none",
  } as const,
  sendBtn: {
    background: "rgba(100, 100, 200, 0.4)",
    border: "1px solid rgba(100, 100, 200, 0.6)",
    color: "inherit",
    padding: "8px 16px",
    "border-radius": "10px",
    cursor: "pointer",
    "font-size": "13px",
    "font-weight": "600",
    "flex-shrink": "0",
    transition: "opacity 0.15s",
  } as const,
} as const
