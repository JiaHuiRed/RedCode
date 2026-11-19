# TUI 与 GUI 共用桌面上的赤

状态：implemented（261119；实现记录见文末「实现记录」节）。

## 问题与目标

哥哥希望不打开 GUI、只用 TUI 时，赤也能出现在 Windows 桌面上，跟随实际会话状态，在两块屏幕之间自由拖动；同时打开 GUI 和 TUI 时不要出现多只赤。前一批已在工作树里实现 GUI 的独立透明桌宠窗，但它仍由 GUI 主窗口提供状态和控制生命周期，不等于 TUI 已经接通。

本方案的首选方向是**复用桌宠展示和原生窗口，让 GUI、TUI 作为不同来源接入同一个本机宿主**。不为桌宠再启动一份模型引擎，也不要求显示 GUI 主窗口。方案覆盖默认本地 TUI 和 `redcode attach`；首版只展示状态、拖动和关闭，不从赤身上批准权限或操纵会话。

本文基于 `9071b42e` 及其上的**未提交 GUI 桌宠工作树**调研。以下 GUI 独立窗口是工作树现状，不代表已经发布或提交；本方案须以其最终合入形态重新对账。

## 现状：能复用什么，缺什么

1. GUI 的 `PetLayer` 按当前会话/目录组合事件与状态快照，再经桌面桥发送展示快照；GUI 的 `pet-store` 是 renderer 内存单例，不是跨进程共享状态（`packages/app/src/pet/pet-layer.tsx`、`packages/app/src/pet/pet-store.ts`、`packages/app/src/context/server-sync.tsx`）。目前快照是 `{ kind, outfit, behavior }`：`outfit` 可能由 provider ID 推导，`behavior` 是偏好对象，并不都是单个标量；不传 session ID、工具详情和聊天正文（`packages/app/src/pet/desktop-pet.ts`）。
2. 工作树中的 `packages/desktop/src/main/pet-window.ts` 创建透明、置顶、不占任务栏的 Windows 窗，位置与多屏几何在 `pet-geometry.ts`。但当前 `updateDesktopPet` 要求 GUI `BrowserWindow` 作为 owner；owner 真正销毁时赤也会销毁。主窗隐藏或最小化不等于进程已经退出。
3. **默认本地 TUI 没有对外监听的 HTTP 端口。** `packages/redspace/src/cli/cmd/tui/thread.ts` 默认使用 `redcode.internal` 加 Worker fetch 和事件桥；`worker.ts` 内部调用 `Server.Default().app.fetch()`。显式网络选项才会启动监听。另一路 `attach.ts` 连接已有服务，可能是远端。不能假设桌宠宿主能直接连一个本地 SSE，也不能将 attach 的认证凭据交给桌宠。
4. TUI 当前会话是客户端路由，不是服务端自动知道的“活跃窗口”：`packages/redspace/src/cli/cmd/tui/context/route.tsx` 中路由可能为 home、session 或 plugin；项目/目录随 TUI 切换。会话 ID 单独使用不足以区分不同连接、目录和客户端。
5. 现有状态规则不是“最近一个事件 wins”：权限/提问优先，快照未就绪是 unknown 而非 idle，快照在途事件用 bootstrap journal 协调。见 [桌宠表现层与状态恢复](../../implemented/feature/2026-10-06-pet-v02-presentation.md) 和 [流式心跳与获胜会话](../../implemented/bug-fix/2026-10-01-pet-stream-heartbeat-winner.md)。不能为了 TUI 再复制一套口径。
6. Windows 桌面包已配置 Electron、pet renderer、preload 与资源的构建入口；CLI 的构建/分发独立（`packages/desktop/electron.vite.config.ts`、`packages/desktop/electron-builder.config.ts`、`packages/redspace/script/build.ts`）。不能假定只装 CLI 的用户机器上已经有 Electron 或可执行的 Desktop。

## 推荐设计

### 边界与数据流

```text
TUI 当前路由 + 当前连接/目录 + 现有事件与快照
    → 共享规则的本地状态投影 → 来源控制信封 + 有界展示快照
                                                    ↓
GUI 当前路由 + 状态投影 → 同一来源仲裁 → 本机桌宠宿主 → PetView
```

- **客户端负责知道自己在看什么**：TUI 根据自身路由、目录和同步数据计算状态；GUI 继续使用自身的上下文。默认 TUI 的 Worker、网络模式、远端 attach 都在客户端一侧消费已有传输，不要求宿主读取远端账号、凭据或对话。
- **一份规则，多种适配器**：将现有纯状态归一化、优先级及快照重放规则放到 GUI 和 TUI 都能依赖的轻量位置，分别适配真实事件与快照；先检查依赖和 TUI bundle 边界，不把整个 GUI 包塞进 CLI。会话切换、重连和初始快照必须继续遵循现有 unknown / journal 语义。展示层 `PetView`、图片、拖动、多屏几何尽量复用。
- **宿主只展示，不控制会话**：首版展示快照沿用 `kind`、`outfit`、`behavior` 的最小思路；按实际需要裁减并规定上限。来源 ID、连接和会话映射只用于客户端与宿主协调，不进入宠物页面，不在日志写正文、路径、远端地址或凭据。点击关闭是桌宠显示控制，不是会话操作。
- **同一份宿主所有权**：建议无论由 GUI 还是 TUI 首次启用，都由独立的 pet-only Electron 进程持有桌宠窗；GUI/TUI 只持有来源连接。同一 Windows 用户桌面内只有一个宿主及一只赤，pet-only 不打开 GUI 主窗，也不启动 GUI sidecar。这样 GUI 进程退出时不用转移活窗口，只释放自身来源，宿主可继续服务 TUI。它与现有 GUI Electron 单实例、打包入口如何共存须先做原型，不能假设第二个 Electron 启动不会触发聚焦或退出。

### 来源与生命周期：建议契约

以下是建议，不是现有行为；进入实现前仍需验证终端焦点能力和关闭语义。

- 每次客户端运行生成随机 `sourceID`，一个连接对应一个来源；来源内部记录连接、目录、当前会话和视图代次。跨客户端即使 session ID 相同，也不能合并成同一来源。只有当前选择来源的快照可驱动赤。
- **显式激活接管（已定）**：GUI 窗口获得焦点或用户主动切换会话时报告；TUI 启动及用户明确切会话时报告。不要把收到事件、模型忙碌或后台心跳当“用户切换”。无法判断焦点时（多个 TUI 并存、终端无可靠焦点信号）保持当前来源，除非用户明确切换或当前来源退出，避免赤来回跳。
- 协议按连接建立代次和有序序号，切换视图后旧目录/旧会话的迟到结果不得覆盖新快照。正常退出显式释放；崩溃、终端关闭或连接中断由连接关闭释放；宿主按仍有效来源选取接替者，未选中来源断开不得关闭当前赤。最后一个来源释放后关闭桌宠宿主；GUI 退出不应终止仍在使用的 TUI 来源。
- TUI 不在 session 页面、状态尚未加载或连接中断时，明确展示对应的无会话/未知状态，不能沿用上一个会话伪装为当前状态。重连先建立新的来源代次，再恢复快照及事件，防止断线前回包复活。
- 复用拖放结束后保存位置、屏幕变化夹回的机制，不用无界轮询；非 Windows 首版不提供独立窗，不影响 TUI 正常使用。桌宠初始化或连接失败应可诊断、可恢复，不能阻断 TUI 或静默启动第二份引擎。

### 本机通道与分发

建议先验证 Windows named pipe 或同等本机 IPC，再选定具体实现；当前 Electron renderer IPC 不能直接跨进程复用。需要明确协议版本、单例发现、来源注册/更新/释放/关闭反馈和宿主重启后重新注册。消息仅在进程边界校验类型、状态枚举、长度和大小；管道权限、同用户隔离与身份认证在原型中实测，随机令牌不要通过命令行或日志泄露。不能只靠 PID 或 Windows 管道的“监听成功”判断单例，也不能靠删管道抢占在运行的宿主。

**运行时分发（已定）**：不要求纯 CLI 安装开箱出现赤。实际使用只跑 TUI 与 GUI，所以桌宠的 Electron 宿主随桌面版分发；TUI 侧只需发现并使用已安装的桌面版宿主，不另配一套运行时，也不写死本机路径。桌面版未安装或版本不匹配时明确提示，不自行下载或改动用户安装。

**关闭语义（已定）**：点关闭按钮只关这一次显示，不改持久开关；下次来源显式激活时赤会回来。GUI 原有设置继续作为显示开关的拥有方，不为 TUI 另造一套持久开关。窗口位置由桌宠宿主持久化，状态和来源是内存态；退出不更改用户数据或清理其他进程的资源。

## 备选与取舍

| 方案 | 优点 | 代价与结论 |
| --- | --- | --- |
| 仅保留 GUI 窗内/GUI 宿主 | 改动最少 | 不满足只开 TUI 的目标，不选为最终方案。 |
| 本机独立展示宿主 + 客户端投影（推荐验证） | 复用 Windows 窗与现有状态规则；TUI 无须暴露 HTTP 或转交凭据 | 要解决启动、分发、跨进程协议、多来源归属和额外进程成本。 |
| 把统一宠物投影搬到服务端 | 多客户端可共享后端投影 | 要新增服务端职责与 API，还要定义多个服务/客户端谁是当前会话；默认 TUI Worker 和独立宿主问题仍在。当前需求不足以证明这笔成本，暂不选。 |
| TUI 强制启动 HTTP 服务供宠物订阅 | 实现看似直接 | 改变默认本地传输与暴露面，attach 凭据/远端访问也变复杂；不选。 |

推荐方向仍要先跑原型，不预设 Electron 的启动耗时和内存“很小”，也不把窗口拆分等同于状态共享。

## 分阶段实施与验收

1. **原型与决策**：在隔离用户数据的 pet-only Electron 原型中，分别验证先开 GUI、先开 TUI、两者并发启动时的单例与交接；验证 pipe 访问权限、断连检测、失败反馈和进程退出，以及 TUI 发现已安装桌面版宿主的机制。实测宿主冷启动、额外工作集与空闲占用，记录机器、口径及与仅 TUI 基线的差值。分发、来源选择与关闭语义已按下方「已定决策」收敛，不再作为待确认项。
2. **事件与协议**：抽取共享状态规则与边界类型，接入 TUI 的路由、目录及默认 Worker/attach 的既有数据；加连接代次、快照顺序、生命周期测试，不新增模型调用。若后续选择新增 HTTP API，还须补 route exercise、SDK/OpenAPI 和对应门禁；本推荐方案不要求新增 HTTP API。
3. **接通现有窗**：主进程把 `BrowserWindow` owner 改为显式来源管理，GUI 与 TUI 走同一仲裁；保留 renderer 的可信窗口校验、最小 preload、现有动作和显示偏好，不让宿主无意成为 GUI 深链或菜单目标。
4. **验证与交付**：
   - 定向单测：初始 unknown、busy、权限/提问优先与回复、快照/事件交错、断连重连、旧来源/旧视图迟到更新、不同连接的同名 session、竞争启动、非 owner 退出、最后来源退出和异常恢复。
   - 端到端：默认 TUI（Worker，无监听端口）、网络 TUI、远端 attach；GUI-only、TUI-only、GUI+TUI、多个 TUI；改变当前目录与会话，验证赤与**实际选中来源**一致。分别检查 TUI 正常退出、终端异常关闭、GUI 隐藏/退出及宿主崩溃。
   - 真实 Windows 打包产物：不依赖开发目录，核对 pet 页面、preload、图片、启动/发现/升级；双屏负坐标、物理鼠标拖动与透明区穿透、混合 DPI、屏幕插拔、最小化/隐藏主窗后继续显示。注入坐标只能证明窗口路径，不能冒称物理拖拽验收。
   - 分别运行 App、Desktop 和 RedSpace 对应类型检查及完整路径过滤的定向测试；构建/打包范围按实际变更执行。不可为了验证重启或终止用户正在使用的 GUI/TUI。

## 已定决策（2026-11-18）

1. **分发**：不覆盖纯 CLI 安装；实际只跑 TUI 与 GUI，桌面版提供 Electron 宿主，TUI 侧负责发现与使用。
2. **来源**：显式激活接管；无法判断焦点时保持当前来源，不为抢焦点来回切换。
3. **关闭**：只关这一次显示，不改持久开关；下次显式激活恢复。

首版不改变模型提示词、工具或请求上下文，因此不增加模型可见注入；若以后让赤发消息或操作权限，必须另立身份、授权与确认边界。

## 实现记录（261119）

按本文四阶段落地，全部代码已进树、定向测试与四包 typecheck 绿；真机验证矩阵待执行（见文末）。

### 结构

- **共享规则层下沉 `packages/ui/src/pet/`**：`pet-state.ts` / `pet-lines.ts` / `pet-store.ts` / `desktop-pet.ts` 从 app 移入（pet-state 本就零 Solid 依赖）；app 保留 `pet-layer.tsx` 并经 `@redcode-ai/app/desktop-pet` 子路径 re-export。宿主协议契约（消息类型、快照/登记文件校验器）在 `pet-host-protocol.ts`，desktop（宿主）与 redspace（来源）共用一份，来源客户端与登记文件读写也下沉到 ui（`pet-host-client.ts` / `pet-host-files.ts`，均 Electron 无关）。
- **宿主**（`packages/desktop/src/main/pet-host.ts` + `pet-host-server.ts` + `pet-host-registry.ts`）：同一可执行文件 `--pet-host` 启动，独立 userData（`<appId>-pet`）与独立单实例锁（与 GUI 锁互不干扰——原型的第一验证点，实现即在 `runFork(main)` 前分支）；loopback `127.0.0.1:0` HTTP + Bearer token（仓库无 named pipe 先例，沿用 sidecar/mobile-gateway 的既定套路）；来源注册表 FSM（连接代次 + 有序序号、显式激活仲裁、断连交接）；rendezvous 落 `~/.redcode/state/pet-host.json`（运行中，宿主写、退出删）与 `pet-host-install.json`（spawn 命令登记，归 GUI 所有——GUI 启动即写，宿主不覆写，dev 下宿主的 argv[1] 不是可靠 app 路径）；最后一个来源断连 15s 后自退；赤窗位置一次性从 GUI 旧 store 迁移。
- **GUI 来源**（`pet-host-client.ts` kind=gui）：渲染层 `desktop-pet:update` 改走宿主客户端；焦点与渲染层 `desktop-pet:activate`（PetLayer 在会话/目录变化时发）为显式激活；宿主不可用返回 false → 渲染层保持 inline 兜底（桥契约不变）；点 × 只关本次显示（closed 事件经 SSE 回源，PetLayer 用 closed latch 压住内联 DOM，`petEnabled` 不再被自动置 false）。
- **TUI 来源**（`packages/redspace/src/cli/cmd/tui/pet-source.tsx` kind=tui）：消费本 scope 的 `sdk.event` 流喂共享 pet-state，1s tick + sync 状态/路由变化合并驱动，快照键比对后才推；挂载/会话切换显式激活；桌面版未登记时按快照变化留一条日志即降级；正常退出靠 SSE 断连由宿主兜底释放。

### 与原方案的偏差

- 传输选 loopback HTTP + token 而非 named pipe（方案原文「named pipe 或同等本机 IPC」；同用户威胁模型与 sidecar 一致，token 只落用户 profile 下的登记文件）。
- 方案原文假设的「pet-only 宿主与 GUI 单实例共存」验证结果：两把锁分别落在 `<appId>` 与 `<appId>-pet` 两个 userData，互不触发 second-instance——无需转移活窗口。

### 验证现状与待办

- 已绿：desktop 宿主协议端到端（真 node:http + 真客户端 fetch，2 用例：注册→激活→closed→释放全链路、401/400/409 边界）+ 注册表 FSM 9 用例（含 onActivate 先于 onChange 的 close-latch 时序） + ui 规则层 67 用例（pet-state/lines）+ app journal×child-reducer 集成 1 用例，合计 78；desktop/app/ui/redspace 四包 typecheck；`check:subprocess-timeout` 门禁；`check-version-consistency`。
- **模型可见四问全部为零**：不碰提示词、工具 schema、注入段与工具输出格式；`session/prefix-shape.ts` 无变化；无新增引擎 HTTP 端点（OpenAPI 不动）。
- 待真机：GUI-only / TUI-only / GUI+TUI 同开（一只赤）、焦点与切会话接管、关闭→下次激活恢复、拖动跨屏、宿主崩溃与终端强杀恢复、GUI 退出赤不跟随；宿主冷启动与空闲工作集数字待实测回填本节。
