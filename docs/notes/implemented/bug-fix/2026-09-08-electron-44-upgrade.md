# Electron 42.4.1 → 44.2.0 升级：clipboard W3C 化迁移与签名适配

状态:implemented

## 问题

electron devDep 落后两个 major（42 → 44）。43/44 的破坏清单里与我们相关且**实际命中**的只有一项：**44 把 clipboard 模块按 W3C Clipboard API 重构**——`readText/writeText/read/write` 全部 Promise 化、`readImage` 移除、clipboard 不再暴露给 renderer 进程。仓库唯一命中点是 `read-clipboard-image` IPC handler（粘贴图片附件）。

其余破坏项逐一对照后与本仓无冲突：Linux frameless 圆角 / Unity / macOS 12 / win32-ia32 / ANGLE 静态链接（electron-builder extraResources 只拷自有资源，不引用 libEGL/libGLESv2）/ `net.request` Sec-Fetch 限制（未用 net 发请求）/ client-certificate（未用）。**Electron 44 内嵌 Node 24.18.1，仍是 24 线**——sidecar 编译缓存（目录名带 Node 版本，自动失效重建）与 `@types/node` 24 的对齐都不受影响。

## 决策

- `readClipboardImage` 从「IPC → 主进程 clipboard.readImage」改为**渲染层 `navigator.clipboard.read()` 直读**（Chromium 152 支持），返回形状 `File | null` 不变，调用方（prompt-input attachments）零改动。配套：windows.ts 的 renderer 权限集加 `clipboard-read`（此前只有 sanitize-write）；删除主进程 handler 与 preload/types 的死线。
- `console-message` 监听器迁到 Electron 44 的 Event 对象签名（旧位置参数签名已废弃）。
- dev toast 快捷方式（同日另一修复）在 44 下验证正常。

## 备选与否决理由

- **主进程用新 `clipboard.read()` 读图**：否决——44 的 `Electron.ClipboardItem` 类型未在 d.ts 中导出（引用了但无定义），类型不可用；且 IPC 往返的序列化成本本来就该省。
- **留在 42 等上游生态**：否决——Chromium/Node 安全补丁与「faster boot + 更高性能 IPC」（43 头条改进）拿不到；冒烟实测 sidecar import 热启动 791ms（42 时代 1019-1227ms）。

## 后果

冒烟（dev，60 秒+）：启动正常、sidecar ready 1074ms / ready→healthy 13ms、flushCompileCache 0ms、无崩溃、无重启；toast 快捷方式写入正常。已知残留：`console-message` 废弃警告仍会出现，来源是 **electron-log 5.4.4 内部**（spyRendererConsole 用旧签名，`^5` 已是最新，等上游适配）；electron-log 自身功能不受影响。打包版（electron-builder）无配置改动需求。
