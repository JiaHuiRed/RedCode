# RedSpace Windows 性能审计 · TUI 与伙伴 Chat

基线为 GitHub [master@3027056](https://github.com/JiaHuiRed/RedSpace/commit/30270567f3f36b66dc720787e8e9b997fcea03d9)，已合入伙伴 Chat 轻量界面。对照以这份生产源码为准。检查覆盖 TUI 启动、打开与切换 Chat 会话、流式输出、消息时间线、后台请求和历史搜索。上次的 Solid 警告证明同进程加载了两份运行时；这次单独测量了实际的行构建调用、请求和文本处理时间。

**建议先合三项独立改动。** 第一项修复长对话被连带重算，已有浏览器 A/B。第二项关闭 Chat 隐藏面板的数据请求，改动小。第三项优化中文流式文本过滤，直接受益于 TUI 和桌面端。冷开会话重复下载的收益也很具体，单独实施，避免引入断线补消息的回归。

| 场景 | 最新基线的实际表现 | 建议的验收值 |
| --- | --- | --- |
| GUI 长对话追加一个 assistant 步骤 | 15 轮全部参与行构建，共 16 次 | 相同回放仅末轮参与，原型实测 2 次 |
| 已打开过 Code 文件树，再打开 Chat | 额外请求目录、Git diff 和会话 diff，各 1 次 | 3 个自动请求均为 0 |
| 显示过滤器处理含“说”的长中文流 | 10,800 字符、338 次更新，累计中位 874 ms | 增量原型 8 ms，同一输入逐次输出一致 |
| 首次打开已有会话 | 当前会话先请求最近 200 条，再请求最近 400 条 | 静止会话读取 1 页，重连和窗口缺口仍能恢复 |
| 打开伙伴列表中间的一条 Chat | 未点击的相邻 8 条会话各取 40 条历史 | 未表达切换意图时，相邻历史请求为 0 |
| TUI 启动后直接聊天 | 同时取已连接模型和完整供应商目录 | 未开相关弹窗时，完整目录请求为 0 |
| 手动搜伙伴对话正文 | 40 条会话、每条一页未命中，共 40 个串行请求 | 一次伙伴级查询开始搜索，按总扫描预算续页 |

## 1. 追加新回复时，只重算所属轮次

**复现。** 打开含 15 个用户轮次的真实 Chat 页面。页面稳定后，经同一条 SSE 连接给第 15 轮追加一个 assistant 步骤。在生产构建的 `constructMessageRows` 调用点计数，14 个旧轮次各跑 1 次，末轮跑 2 次。给每轮加上独立的分组比较后，重新回放同一事件，只剩末轮的 2 次。这里量的是行数据构建次数，屏幕绘制次数需另测。

**原因与改法。** 页面用一个 memo 构造全会话的 `Map<parentID, AssistantMessage[]>`。新消息插入会替换整张 Map，而每轮直接订阅这张 Map。在每轮行构建的上游按 `parentID` 取数组，按长度、顺序和消息对象身份比较。未变的组阻断传播；已变消息内部的响应式字段继续由原消费者跟踪。Linux/Bun 压测中，150 轮输入的一次末轮插入或移除，构建轮数从 150 降至 1，操作耗时中位约 2.24 → 0.35 ms。Windows 回归还需覆盖同轮多步工具、消息撤回、旧页前插、切分支和折叠思考。[分组 Map](https://github.com/JiaHuiRed/RedSpace/blob/30270567f3f36b66dc720787e8e9b997fcea03d9/packages/app/src/pages/session/message-timeline.tsx#L438-L449) · [每轮构建入口](https://github.com/JiaHuiRed/RedSpace/blob/30270567f3f36b66dc720787e8e9b997fcea03d9/packages/app/src/pages/session/message-timeline.tsx#L617-L643)

## 2. Chat 隐藏了文件树，数据请求仍受 Code 布局驱动

**复现。** 同一 Git 项目、同一伙伴会话、1500 px 宽窗口。将保存的文件树开关从关改为开，Chat 的外观相同，冷开后 `/file`、`/vcs/diff`、`/session/{id}/diff` 三项从各 0 次变为各 1 次。还观察到挂载输入区后，`/background` 和 `/pty` 各发一次，约十秒后再各发一次。这两项来自后台活动入口，有运行中任务时有交互用途。

**改法。** 把“会话已确认是 Code，且面板可见”作为自动加载文件树及审查数据的共同条件。冷开时会话身份还没返回，应等身份确定再决定。文件变更和任务结束触发的 VCS 刷新也用相同条件。Chat 主动打开附件仍按需读取。后台活动入口单独处理，若仍提供入口，可在打开时读取，并在有活动时刷新。验证 Chat → Code 后，原来的树、diff 和刷新能力恢复。[审查请求门槛](https://github.com/JiaHuiRed/RedSpace/blob/30270567f3f36b66dc720787e8e9b997fcea03d9/packages/app/src/pages/session.tsx#L432-L456) · [会话 diff 与文件树](https://github.com/JiaHuiRed/RedSpace/blob/30270567f3f36b66dc720787e8e9b997fcea03d9/packages/app/src/pages/session.tsx#L1215-L1264) · [后台活动计数](https://github.com/JiaHuiRed/RedSpace/blob/30270567f3f36b66dc720787e8e9b997fcea03d9/packages/app/src/components/background-activity.tsx#L582-L605)

## 3. 中文流式正文与思考反复扫描已经显示过的文本

**复现。** 用含“说起那天的晚饭”的普通中文构造 400 行文本，共 10,800 字符，每 32 字符增长一次。真实 `filterCannedAgreement` 对 338 个前缀累计耗时中位 **874 ms**。增量原型复用仓库的行过滤规则，保存已完成行、代码围栏和跨行引号状态，只重新解析当前未结束行，中位 **8 ms**。七组计时；逐个前缀核对输出，并另测分段、正文替换、代码围栏和引号。此数是该函数累计耗时，尚无 Windows 整轮延迟数据。

**原因与改法。** 一旦文本含单字“说”或“我认”，后续每次更新都会对整段重新分行、扫描和拼接；普通的“说明”“说起”也触发。按 part 保存解析进度，收到替换快照或切换 part 时重建。保留当前对引语、代码块和条件从句的处理。针对超长单行单独测量，它从“已完成行”缓存获得的收益较小。TUI 和 GUI 共用核心实现，正文、思考及最终复制文本应逐字回归。[过滤器](https://github.com/JiaHuiRed/RedSpace/blob/30270567f3f36b66dc720787e8e9b997fcea03d9/packages/core/src/util/canned-agreement.ts#L81-L103) · [TUI 消费点](https://github.com/JiaHuiRed/RedSpace/blob/30270567f3f36b66dc720787e8e9b997fcea03d9/packages/redspace/src/cli/cmd/tui/routes/session/index.tsx#L2597-L2605) · [GUI 消费点](https://github.com/JiaHuiRed/RedSpace/blob/30270567f3f36b66dc720787e8e9b997fcea03d9/packages/ui/src/components/message-part.tsx#L1663-L1671)

## 4. 首次打开会话，同一段历史会下载两遍

**复现。** 稳定 SSE、15 轮共 30 条消息、无新增事件。浏览器对同一会话先发 `GET /message?limit=200`，再发 `limit=400`，两次都无 `before/after`，这个样本的 30 条历史因而传了两遍。首次同步负责显示消息，首次挂载同时启动变更日志恢复。日志没有已确认游标时，需要一份权威快照；代码等待前一任务完成后，又自行请求快照。已挂载会话的窗口上限为 400。

**改法。** 将冷开的“首份权威快照”交给一个所有者，供页面展示和首次日志同步共用。必须保证先取得日志水位，再读取覆盖该水位的快照，成功应用后才确认游标；也可让服务端在一致读取中一并返回快照与水位。不能直接把一个更早的页面请求当作新水位的依据。Windows 验收要在两步之间插入新增、编辑和删除，核对每条都能恢复；窗口过期、旧服务端、用户正在看较早页时仍走原有回退。[页面首读](https://github.com/JiaHuiRed/RedSpace/blob/30270567f3f36b66dc720787e8e9b997fcea03d9/packages/app/src/pages/session.tsx#L579-L608) · [首次启动恢复](https://github.com/JiaHuiRed/RedSpace/blob/30270567f3f36b66dc720787e8e9b997fcea03d9/packages/app/src/pages/session.tsx#L738-L770) · [游标与快照顺序](https://github.com/JiaHuiRed/RedSpace/blob/30270567f3f36b66dc720787e8e9b997fcea03d9/packages/app/src/context/session-changes.ts#L184-L200) · [第二次历史读取](https://github.com/JiaHuiRed/RedSpace/blob/30270567f3f36b66dc720787e8e9b997fcea03d9/packages/app/src/context/directory-sync.ts#L673-L716)

## 5. 打开一条 Chat，顺带下载最多八条相邻对话

**复现。** 40 条伙伴会话，打开列表中部的一条，不悬停、不切换。实测 8 次相邻历史请求，各 `limit=40`。每条邻居消息使用 2 KiB 正文的合成夹具，8 个响应体合计 **745,936 字节**，含 320 条消息及其 parts。把入口换到列表首项，同样测试取到 4 个邻居。字节数取自浏览器读取的响应体，随真实历史变化。

**改法。** Chat 的历史栏只需标题和日期。保留当前会话的前台加载，把相邻会话预取改成明确意图触发，例如聚焦或停留在某条历史链接时只取该条。已有并发上限为 2，并会给前台请求让路，所以这里节约的是额外下载、解析和缓存占用；首屏能快多少需另测。验收分别看直接打开、快速划过多项和真正点击的请求数与点击后可读时间。[Chat 继承布局预取](https://github.com/JiaHuiRed/RedSpace/blob/30270567f3f36b66dc720787e8e9b997fcea03d9/packages/app/src/pages/layout.tsx#L459-L490) · [每页上限](https://github.com/JiaHuiRed/RedSpace/blob/30270567f3f36b66dc720787e8e9b997fcea03d9/packages/app/src/pages/layout/prefetch.ts#L33-L45) · [双向各四条](https://github.com/JiaHuiRed/RedSpace/blob/30270567f3f36b66dc720787e8e9b997fcea03d9/packages/app/src/pages/layout/prefetch.ts#L240-L264)

## 6. TUI 把连接供应商弹窗的全量目录提前到了启动阶段

**复现。** 挂载仓库真实的 TUI SyncProvider，未开弹窗，首次 bootstrap 已请求一次 `/provider`；再执行一轮 bootstrap 后累计为 2 次。已连接模型另走 `/config/providers`。用仓库转换函数生成 100 家、每家 30 个模型的合成目录，单次完整 JSON 为 **2,049,806 字节**。这是样本大小，生产目录随配置变化。该请求本来就在后台，节省的首先是序列化、传输和 store 写入。

**改法。** 启动保留已连接模型，目录按工作区或配置版本失效，首次进入需要目录的弹窗再加载，复用进行中的请求。**直接“连接 Provider”的入口必须一起改。** 它等状态变成 `ready` 才挂载列表，现有首次加载调用恰好在列表内部；只删启动预取会让首次直开一直等待。应由外层弹窗发起，保留重试。验收覆盖直接连接、新建自定义供应商、模型选择以及切工作区后的迟到响应。[启动预取](https://github.com/JiaHuiRed/RedSpace/blob/30270567f3f36b66dc720787e8e9b997fcea03d9/packages/redspace/src/cli/cmd/tui/context/sync.tsx#L798-L809) · [目录组装](https://github.com/JiaHuiRed/RedSpace/blob/30270567f3f36b66dc720787e8e9b997fcea03d9/packages/redspace/src/server/routes/instance/httpapi/handlers/provider.ts#L53-L82) · [弹窗等待条件](https://github.com/JiaHuiRed/RedSpace/blob/30270567f3f36b66dc720787e8e9b997fcea03d9/packages/redspace/src/cli/cmd/tui/component/dialog-provider.tsx#L227-L242)

## 7. 伙伴正文搜索按会话串行发请求

**复现。** 40 条会话，输入关键词时本地过滤标题；明确按 Enter 搜索正文后，每条会话第一页都无匹配且无后续页，浏览器实测发了 **40 次** `/session/{id}/query`。单会话扫描预算耗尽会返回游标，客户端还会继续翻页。此项只影响手动全文搜索。

**改法。** 提供按伙伴查询并返回命中会话 ID 的分页入口。复用已有 `SessionQuery` 的伙伴过滤能力，同时对齐界面当前可见会话、历史归档和可搜索内容的口径。每页设总扫描预算，客户端取消搜索时把取消信号传到正在扫描的后端任务。Windows 验收要覆盖第一页无命中、第二页命中、相同关键词命中多个会话、切伙伴，以及取消后停止继续发请求。[前端逐会话循环](https://github.com/JiaHuiRed/RedSpace/blob/30270567f3f36b66dc720787e8e9b997fcea03d9/packages/app/src/components/companion-chat-frame.tsx#L75-L102) · [现有单会话入口](https://github.com/JiaHuiRed/RedSpace/blob/30270567f3f36b66dc720787e8e9b997fcea03d9/packages/redspace/src/server/routes/instance/httpapi/handlers/session.ts#L296-L325) · [已有伙伴范围过滤](https://github.com/JiaHuiRed/RedSpace/blob/30270567f3f36b66dc720787e8e9b997fcea03d9/packages/redspace/src/tool/session-query.ts#L119-L139)

## 怎样在 Windows 判断修复是否值得合并

用同一份测试档案、同一提交配置、同一窗口尺寸比较改动前后。首开与热开分开记录，计时各跑至少 10 次并报告中位数与最慢值。优先复核上表中的次数，次数稳定再判断整机体感。

- **TUI** 用新构建的 Windows EXE 从终端冷开，记录启动到可输入、首次打开模型选择器到列表可用两个时间。分别测“只用已选模型”和“启动后立刻连接供应商”，以看清延迟转移。
- **桌面 Chat** 开、关 Code 文件树各跑一次。记录 Network 中历史页的目标会话、分页参数、响应体字节和 diff 请求数。用固定 SSE 回放追加一个 assistant 步骤，再用纯文本 delta 作对照。界面诊断 `timeline.group-build` 可用于计数。
- **正确性** 同一份 SSE 回放前后，正文、思考折叠、模型选择、附件读取和历史滚动锚点均应一致。冷开同步额外覆盖并发编辑、切分支、断线重连和快照失败后重试。

**证据范围。** 请求记录来自 Linux 无头 Chromium 运行的真实生产前端，服务端数据由仓库 smoke 夹具或明确标注的合成数据提供。TUI 使用 Bun 1.3.14 和仓库的挂载夹具。文本与时间线微基准均在 Linux 运行。尚未测量 Windows Electron/EXE 的首屏、整机 CPU、内存或帧率。以上为审计与临时原型，仓库没有生产代码改动。
