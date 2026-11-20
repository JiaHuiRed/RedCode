# 0.18.7 体验路线图 v2 落地：引导投递、只读终端、引用与定位、结果阅读

状态：implemented

## 问题

`docs/experience/2026-11-16-experience-roadmap-v2.md`（原 HTML 导出）列出 15 个任务包、85 条交付子项和 13 条用户路径，基准是 `0.18.6 / dev / f3266…`。对照源码核实后，缺口集中在四类：

1. **后台看得见、动不了**：TUI 后台面板把「终止」当默认动作，任务跑完就没有入口回到对应会话；跑着的 PTY 能看到名字，看不到它在跑什么、输出是什么。
2. **子代理只能等**：`task_steer` 只允许**直接父代理**投递，用户想在运行中途补一句「先别看归档」没有正规入口，只能等结束或者打断重来。
3. **引用是假的**：对话框里的「引用」只把文本塞进输入框，没有来源、没有上限、回不去原处；搜索命中只能跳到轮次，落不到具体片段（工具输出折叠着，根本没挂载）。
4. **审完了不知道结论**：审查面板标记完全部文件后汇总消失，看不出这一批到底改了多少。

## 决策

### 冻结三个跨端契约，再分组实现

先定 schema 再写两端，避免 TUI / GUI / 服务各自发明字段：

| 契约 | 形状 |
| --- | --- |
| `POST /background/tasks/:sessionID/steer` | `{ message, requestID }` → `{ messageID, state: "queued" \| "delivered" }` |
| `GET /pty/:ptyID/output` | `{ output, startCursor, endCursor, truncated }` |
| `Platform.openHtmlPreview?(document: string)` | 桌面走独立回环来源；web 走 blob；未实现时显式报「不可用」 |

`requestID` 是幂等键：同 ID 同正文重放返回原消息，同 ID 不同正文拒绝。状态只有两个来源——子消息持久化后的 `delivery` 字段，以及父会话里那条 `task_steer_record`；不另造第二套状态源。

### A03：用户来源不伪装成父代理，父记录不阻塞子回合

三段时序是这次改动的核心，逐条都有回归用例：

1. 子消息以 `source: "user"` / `priority: "user_override"` 写入子会话，正文前缀明说「来自正在查看此子代理的用户，不是父代理」——模型必须知道这条不是它自己的规划。
2. 父记录在**子消息落库后立刻**写入，`noReply` + `synthetic`，在父真实实例（`InstanceRef`）下执行。`isolated` 子任务的 provider 属于子 worktree，父记录若在子实例写会落到错误的目录。
3. `promptFiber` 的 join 与父记录解耦：原来 queued→delivered 靠 `forkChild` 轮询，而 `send` 返回即关 scope，子回合在最后一步结束时那条 250ms 轮询还没跑到就被中断，父记录**永久停在 queued**。现在 join 之后同步读一次最终 `delivery` 再更新。

父记录失败不吞：HTTP 如实报错；如果子消息已经落库，同 `requestID` 重试只补父记录、不重复写子消息。任务结束后不接受引导，也不自动续跑。

### A02：PTY 只读快照，不借只读名义给写通道

`output()` 只切既有有界缓冲（末尾 32,000 字符），不 attach socket、不 resize、不写入。自然退出的终端保留最近 20 条尾部并进 `list`/`get`（`status: "exited"`），显式 `remove` 才删且只删自己——否则短命令一跑完就从列表消失，J04 没有入口。孤儿记录仍然只读、不可终止（PID 可能已被复用）。

### A04/B05/B06：引用带来源、有上限，命中落到真实片段

- `buildReference` / `appendReference`（`packages/app/src/utils/reference.ts`）统一格式：头部字段每个最多 120 字符，正文上限 2,000 字符（超限只带末尾并标注），只追加文本部件，不动附件 / @ 文件 / Agent / 图片，不自动发送。
- 最近引用按会话保留 8 条、最多 4 个会话（`reference-links.ts`），点击回到来源；终端来源与时间线通过 `redcode:reference-added` / `redcode:reference-terminal` 两个 CustomEvent 协作。
- 搜索命中先 `locateTarget` 解析所属用户轮次（**优先 assistant 的 `parentID`，时间只做兜底**——同一毫秒的 steer 会让纯时间比对落到错误的轮），再 `loadThrough` 翻页、滚到轮次、`revealPart` 定位。
- `revealPart` 三段：滚到行 + 打开外层工具组 → 等 `data-timeline-part-id` 出现 → `revealWithinHost` 按需展开目标工具自身与内层折叠，**每轮重读 `aria-expanded` 与已挂载 `textContent`**，命中即停。不假设「等一帧 DOM 就好」，帧数/展开次数都有上限（40/12/90）；rAF 被遮挡不回调时用 120ms 兜底，不锁死跳转。命中词始终没挂出来就返回 false，由调用方明确提示「无法定位」，不静默假装成功。

### A05：HTML 必须真的在浏览器里跑，且不和工作区共享来源

文档明确「不再用下载冒充浏览器打开」。web 端 `window.open(blob:)`；桌面端没有可用的「文件 → 默认浏览器」路径（Blob URL 出不了渲染进程、`openPath` 不保证走浏览器），所以起一个**只监听 `127.0.0.1:0`** 的临时 HTTP 服务：随机 24 字节 token 路径、只允许 `GET/HEAD`、单项 5MB / 总量 16MB / 最多 8 项 / 10 分钟惰性回收，响应带 `no-store`、`nosniff`、`no-referrer` 和 `Content-Security-Policy: sandbox allow-scripts`（**无 `allow-same-origin`**，文档在不透明来源里执行）。写完即 `shell.openExternal`，不动 `open-link` 白名单、不托管工作区目录。相对本地资源不可用，界面直说。

### A06 / C01 / B01 / B03 / B07

- 结果阅读（TUI `/result`）只把「已完成、无错误、工具全 completed」的轮里连续过程段折叠成一行，点开原样渲染，**不生成摘要、不改模型上下文**；运行中 / 失败 / 待授权 / 待回答始终可见。
- 默认投递读 `config.busy_enter`，「写后读回」才算成功——读回不一致就报 warning，不冒充已生效。
- 输入框主操作栏独立成列（`shrink-0`），窄容器收窄次级控件而不是把发送按钮挤走。
- 新会话页「继续已有任务」按项目根 + sandbox 列最近 ≤5 条；看板卡片只给一条下一步动作（question > permission > error > unseen > draft），没有可靠状态就不渲染这一行，也不为每张卡加载 6.9MB 媒体。
- 审查面板收尾汇总移出筛选分支：筛到「未审阅」清空时仍显示整批合计；全部审完给「复查全部」。

## 模型可见四问

改动触达 `packages/opencode/src/tool/task.ts`（新增两条注入项，已登记 `docs/injection-registry.jsonc`）。

1. **模型看到什么变了**：子会话多一段 3 行前缀 `[User steering from the user reviewing this subagent, not from the parent agent. …]` + 用户原文；父会话多一条 synthetic 记录 `User steering sent to background task <id> (title). / state: … / request_id: …` + 用户原文。工具 schema 与 description 未改。
2. **token 影响**：固定文案约 260 / 210 字节，主体是用户原文；单条硬上限 `STEERING_MESSAGE_MAX_BYTES = 16,384` UTF-8 字节。请求级不新增任何固定前缀。
3. **KV cache 影响**：两条都只在用户真的补充要求时追加到**会话历史尾部**，固定前缀逐字节不变；父记录是 `noReply`，不触发新的模型轮次，只在父会话下一次请求时作为历史进入，缓存从追加点起作废一次。
4. **注入项硬上限**：单条 16,384 字节；累计随会话历史增长，与其它历史消息同受既有压缩处理——不另设第二套上限。

引用块（2,000 字符）与 PTY 输出（32,000 字符）都是工具/UI 侧文本，不进系统提示。

## 备选与否决理由

- **让用户直接打开子会话聊天**：否决——普通聊天会启动新一轮模型回合，绕开「下一个安全点生效」与权限边界，也会让子任务把用户消息当成新目标重启。
- **PTY 走现有 WebSocket 回放**：否决——那条通道同时允许客户端写入进程，只读保证只能靠 UI 自觉，不是契约。
- **退出终端不留尾部**：否决——J04 的场景（短命令跑完再看输出）直接没有入口。
- **搜索结果直接锚到轮次**：否决——目标是工具输出里的具体片段，折叠未挂载时高亮不到，属于「看起来跳了但没到」。
- **桌面端用下载 / `openPath` 冒充浏览器**：否决——文档明确禁止，且不产生独立来源。
- **为看板每张卡创建 prompt store 读草稿**：否决——会为每卡加载 6.9MB 媒体，改只读单个持久化键，代价是最后 250ms 未落盘输入与纯图片草稿不计。

## 后果

- 子会话底部原本内联的大表单在真实布局里**被右侧浮动工作台挡住发送按钮**（浏览器实测：`session-side-panel__rail` 拦截 pointer events），改为底部紧凑入口打开上层对话框；这条只有真实浏览器能发现，typecheck 与单测都看不见。
- 桌面 HTML 预览未做 Electron 实机验收（按要求不启动壳），浏览器侧行为由回环端点的 HTTP 级测试间接证明；默认浏览器是否真的拉起仍需人工确认。
- B06 的「返回工具」只展开目标工具自身正文，内层折叠保持原状（返回不是搜索，不该替用户展开内容）。
- 引用跳转依赖 CSS Custom Highlight API；不支持时只定位不画高亮。最近引用是内存态，刷新即清空。
- 父记录「最终 delivered」更新若 `updatePart` 失败只记 warning，不把子任务判失败——子消息的 `delivery` 始终是权威状态。
- 已退出 PTY 尾部只在内存保留，重启不恢复。
- 识别签名：新增 steering 相关代码若只写子消息、父会话看不到记录，先查是不是又在 isolated 子实例里写了父记录；`queued` 永久不变则查 join 后的最终读是否还在。

## 验证

- 四包 typecheck 全绿（opencode / app / ui / desktop）。
- 定向测试：task-steering 4、prompt 集成 1（含真实的「父记录先于子回合结束」时序）、pty-output 6、pty-session/pty-orphans、task_status 14；app 侧 reference 9、reference-links 2、timeline-locate 7、history-loader 15、session-next-action 9、submit 17、terminal 9、file-preview 2、i18n parity；desktop 侧 browser-preview 9、updater + update-bridge 10；ui 侧 session-review 16、message-part 13。
- httpapi 覆盖对账 185 场景 0 缺失；`background.steer` / `pty.output` auth 模式各通过。
- SDK + OpenAPI 已生成，`check:openapi-drift` 与 `check:subprocess-timeout` 通过。
- 浏览器实测（vite 5173 + serve 4097）：看板 24 卡无 console error；中文 Markdown 阅读/源码切换（源码 711 行真实渲染）；HTML 工具栏 + 隔离提示 + `blob:` 打开；工具折叠展开显示真实输出；时间线选区 →「引用到草稿」→ 草稿收到带完整来源头的引用块 + chip `引用到草稿 · 1`，清理后草稿归零；终端面板自动创建并连上真实 PowerShell 7.6.7。
- Playwright 冒烟 `experience-steering.spec.ts`：失败重试沿用同 `requestID`、改正文换新 ID、只投递到目标子会话、回执 delivered、任务结束后按钮禁用且草稿可恢复、两个子会话草稿互不串。

## 未做

- Electron 壳内的更新安装流程与桌面浏览器预览的**实机**验收（不启动 Electron）。
- TUI 侧跨工作区 `switchTo`、exited PTY 输出的真机走查。
- A04 的两个已知缺口：终端输出详情里没有「引用这段输出到草稿」；草稿里的来源不能点击跳回。前者在 TUI 侧缺入口，后者受限于引用块是纯文本。
- A03 回执面板的重试/编辑只有鼠标入口（键盘可 Esc 关闭后从原入口重开，草稿与 `requestID` 仍在）。
