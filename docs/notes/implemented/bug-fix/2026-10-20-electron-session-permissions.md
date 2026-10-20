# Electron 共享 session 权限回调按 session 注册

状态：implemented

## 问题

主窗口和 loading 窗口使用默认共享 Electron session，但权限回调由每个窗口创建时分别注册。后创建窗口会覆盖 session 级 handler；闭包只认可自己的 `webContents.id`，因此旧窗口的剪贴板等权限请求被拒绝。

## 决策

按 `Session` 用 `WeakSet` 只注册一组 handler。Permission request 必须来自可信请求 URL，且 `webContents` 仍属于一个存活、当前 URL 可信的 `BrowserWindow`；permission check 在 Electron 提供 `webContents` 时执行同样的窗口校验，无 `webContents` 时保留可信来源校验。permission 仍限制在既有白名单。

## 验证

单测驱动真实 handler 注册函数，覆盖共享 session 下两个窗口均获准、handler 只注册一次，以及已销毁/未知窗口、外部 URL、非白名单权限被拒绝。没有启动 GUI；真实双窗口粘贴冒烟未运行。

## 后果

窗口集合在每次权限请求时读取，新增和关闭窗口无需维护额外注册表。新增自定义 session 时，它会各自拥有独立的一组 handler。
