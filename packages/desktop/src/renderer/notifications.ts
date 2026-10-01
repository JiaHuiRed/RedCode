type DesktopNotification = Pick<Notification, "close" | "onclick">

type DesktopNotificationConstructor = new (title: string, options: NotificationOptions) => DesktopNotification

type NotificationApi = {
  getWindowFocused: () => Promise<boolean>
  flashFrame: (flash?: boolean) => void
  showWindow: () => Promise<void>
  setWindowFocus: () => Promise<void>
}

export const notifyDesktop = async ({
  title,
  description,
  href,
  api,
  document,
  Notification,
  handleNotificationClick,
  warn = console.warn,
}: {
  title: string
  description?: string
  href?: string
  api: NotificationApi
  document: Pick<Document, "baseURI" | "hasFocus">
  Notification: DesktopNotificationConstructor
  handleNotificationClick: (href?: string) => void | Promise<void>
  warn?: (message: string, error: unknown) => void
}): Promise<boolean> => {
  const focused = await api.getWindowFocused().catch(() => document.hasFocus())
  if (focused) return false

  // 260801 Red 任务栏闪烁：所有通知（turn-complete/error/permission/question）汇聚于此一处生效
  api.flashFrame(true)

  let notification: DesktopNotification
  try {
    notification = new Notification(title, {
      body: description ?? "",
      // 本地打包图标，避免请求未注册的 redcode.dev（DNS 解析失败 → 控制台 ERR_NAME_NOT_RESOLVED）
      icon: new URL("favicon-96x96-v3.png", document.baseURI).href,
    })
  } catch (error) {
    warn("Failed to create desktop notification", error)
    return false
  }

  notification.onclick = () => {
    void (async () => {
      try {
        // 260930 Red 保证恢复/聚焦 IPC 失败时仍路由到会话。
        await Promise.resolve()
          .then(() => api.showWindow())
          .catch(() => undefined)
        await Promise.resolve()
          .then(() => api.setWindowFocus())
          .catch(() => undefined)
        if (href !== undefined) await handleNotificationClick(href)
      } finally {
        notification.close()
      }
    })().catch((error) => warn("Failed to handle desktop notification click", error))
  }

  return true
}
