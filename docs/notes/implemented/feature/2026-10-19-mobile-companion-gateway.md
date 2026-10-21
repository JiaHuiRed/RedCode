# Android 移动接力复用 GUI sidecar，并以设备和工作区双重收窄访问

状态:implemented

## 问题

RedCode 桌面会话需要在手机或 Pad 上继续查看与接力，但当前桌面 sidecar 只接受回环连接及其本机 Basic 凭据。直接把 sidecar 暴露到 LAN 会把桌面凭据交给网络；独立启动另一个服务则读不到 GUI 当前正在运行的那份会话状态。

## 决策

桌面进程在 GUI sidecar 生命周期内启动单独的 HTTPS Gateway。Gateway 只把请求转发到本机 loopback sidecar，并在服务端附加 Basic 凭据；Basic 不下发给 Android。监听地址由桌面显式选择，限 `127.0.0.1` 或 RFC1918 IPv4，不监听 `0.0.0.0`，也不修改防火墙。

配对通过 8 位、5 分钟有效的一次性代码完成；最多允许 8 台设备，单设备 token 只存 SHA-256 哈希，可单独撤销，停止 Gateway 会清除全部 token。Gateway 每次启动生成新的自签 TLS 身份。Android 手动输入完整 SHA-256 证书指纹，配对和 WebView 请求都必须通过精确证书 pin；同时保留 hostname 校验，并拒绝日期、主机名或证书格式错误。没有 HTTP、跳过证书错误或任意代理回退。

会话范围固定为桌面开启 Gateway 时的当前工作区：

- `/session` 强制 `scope=project`，返回前再按 `directory` 精确过滤；只把过滤后的会话 ID 纳入访问集合。状态表、问题列表同样按已授权会话过滤。
- 桌面启动前会校验 sidecar 返回的 session ID 与 `directory` 都精确匹配；只有该初始会话、过滤后的会话列表、或当前工作区 SSE 事件确认过的 session ID 能用于会话读取、prompt 和 abort。问题回复 ID 只能来自当前工作区问题列表或对应 SSE 事件。
- 拒绝所有 `workspace` 查询参数；sidecar 的 workspace-routing 参数不能覆盖 Gateway 固定的 `directory`。
- `/project` 被改写为 `/project/current`，仅返回当前项目；不暴露项目枚举和 sandboxes。`/config/providers` 仅返回界面选择模型所需的公开模型元数据，移除 provider key、env、options、model headers 和 variants。全局配置、provider 目录、文件路径、PTY、权限批准、删除及升级路由均不可用。
- JSON 列表投影最多读取 1 MiB；配对请求、问题回复/abort 分别最多 4 KiB，prompt 请求最多 1 MiB。
- Android 仅嵌入 APK 内的 app 静态资源；桌面配对二维码只包含 Gateway 地址、一次性配对码和证书指纹，Pad 扫码后仍执行完整 TLS pin 校验；相机权限只在主动扫码时由系统请求，手动输入保留为回退。session 与 token 不复制到 Android 数据库或工作区。token 用 Android Keystore 的 AES-GCM 密钥加密保存在本机；WebView 只接收 HttpOnly、Secure、SameSite=Strict 的会话 cookie。移动端权限弹窗不提供批准按钮，服务端也拒绝权限路由。

## 备选与否决理由

- **LAN 明文 HTTP 或把 sidecar Basic 暴露给手机**：否决——会把桌面服务的通用凭据暴露到 LAN。
- **要求预装 Tailscale/WireGuard**：否决——当前主机与 Pad 未配置这类隧道；首版采用手动核对的 TLS 证书指纹。
- **无约束的通用反向代理**：否决——任意 REST 路由会把其他项目、配置和执行能力一并暴露；只保留明确路由并对项目、会话、问题 ID 再次过滤。
- **复制会话数据库、Memory V4 或工作区到 Android**：否决——桌面 GUI sidecar 是唯一状态与执行端，Android 只负责展示和发起受限 API 请求。

## 后果

- Gateway 每次启动都会生成新证书；桌面重启后指纹变化，Android 必须重新配对。设备 token 在 Gateway 停止时全部失效。
- 当前 Windows 网络配置为 Public，Pad 验证使用 loopback + ADB USB reverse；未开放 LAN 监听或防火墙。
- Android 可读取当前工作区会话、发送常规文本 prompt、中止运行和回复当前会话问题；权限批准仍必须回到电脑处理。
- Debug APK 与桌面构建已通过；Gateway 集成测试覆盖目录过滤、凭据脱敏、会话/问题 ID 授权、SSE 工作区过滤和设备撤销。未对指定真实会话发送消息或触发模型调用。
- Pad 已安装 APK，但屏幕处于 Dozing/锁屏状态，不能完成视觉冒烟；当前运行中的桌面 GUI 也未重启加载新 Gateway，因此真实会话接力仍未端到端验收。

## 2026-10-21：SSE 背压恢复先消费缓存帧

`46fc22dd` 加入写背压后，`write(false)` 会暂停上游，但 `drain` 仅恢复上游，把同一 chunk 中尚未处理的完整帧留到下一个 `data`。如果之后只有 `end`，旧收尾路径会将多条 SSE 帧拼成一个事件交给目录过滤，JSON 解析失败时合法事件也被丢弃。

现在 `data`、`drain` 和 `end` 共用逐帧消费入口：恢复时先消费已有完整帧，再恢复上游；再次遇到背压则继续等待。上游结束只标记输入完成，完整帧及最后的未分隔尾帧仍逐个过滤、写出，直到背压解除才结束响应。结束、错误和响应关闭的跟踪清理幂等，避免正常结束后 `close` 再次退账。

不采用「仅在 end 时分帧」：它仍会让已缓存事件无故等待下一个上游事件；也不采用忽略背压强制写完，否则慢客户端的内存上界又失去约束。回归测试直接调用生产过滤函数，控制写入返回值与 `drain` / `end` 时序，不需要完整 TLS 网关才能重现。此次不改模型提示词、工具定义或请求前缀。
