# 全盘审计：五路并行读码结果、按杠杆排序的修复清单，以及一处必须避开已否决路线的修正

日期：2026-09-18 · 状态：proposed（尚无任何一条落地）· 来源：五路并行子审计（核心健壮性 / UI 渲染 / 架构腐化 / 性能与数据层 / 工程卫生），覆盖 `packages/opencode/src`(223k 行)、`app`(55k)、`ui`(35k)、`core`(23k)、`llm`(18k)、`desktop`(6k)

> 本文只收**读码确认过**的条目，每条带 `file:line`。标注 `inferred` 的是未能直接测量的推断。所有数字由主 agent 二次复核（见「附：复核记录」）。
>
> **回链义务**：本文各条目前**均无代码回链**——因为它记录的是缺陷而非决策，在缺陷位置加"见审计"注释会随修复过期。约定为：**每条被实际修掉时，该 fix 的 commit 必须回链本文对应小节**；未修条目的可见性靠 CHANGELOG 顶部说明区一次性挂本文路径（待办，见 §6-15）。

---

## 一、贯穿全仓的单一病灶（本文最重要的一条）

根 AGENTS.md 为 `edit.ts` replacer 家族立的规矩——*「改一个函数前先数它的同形状兄弟」*、「**"补齐了"这个说法本身要复核**」——在本次审计中独立复现 **7 次**。这不是七条独立缺陷，是**一种失效模式产生了七条缺陷**：

| 已修的那个 | 漏掉的同形状兄弟 | 证据 |
| --- | --- | --- |
| `core/src/process.ts:165-173` `AppProcess.run` 有真 `Effect.timeoutOrElse` | `opencode/src/util/process.ts:77-88` 的 `timeout` 是死参数 | §2.1 |
| 门检 `check-subprocess-timeout.ts` 扫 `AppProcess.Service` | 对 `Process.run/text/lines` 全盲 | §2.1 |
| `ui/src/components/message-part.tsx:170` `PacedMarkdown` 自适应节流+块缓存 | `cli/cmd/tui/routes/session/index.tsx` 零节流 | §3.2 |
| `tool/read.ts:21,42-45` 文本 50KB / 图片 32MB / PDF 3.75MB 三闸门 | `session/tools.ts:250-286` MCP 附件一个字节都不过 | §2.2 |
| `session/summary.ts:60-61` `MAX_TURN_PATCH_BYTES`/`MAX_SESSION_PATCH_BYTES` | `session/projectors.ts:187-196` `state.metadata` 无帽 | §4.2 |
| `script/generate.ts:7` 修掉一处 `packages/redcode` 死路径 | 还剩 5 处（`publish.ts:46`、`beta.ts:89,203`、`raw-changelog.ts:117,129,130`） | §5.2 |
| `message-timeline.data.ts:126-143` 注释宣告消灭了「每帧 2N 次模板串分配」 | `:144-155` 函数自身 2N 次 `key()` 一分未减 | §3.1 |

其中最后一行性质最重：**注释与结论声称已修，代码没有。** 前两行合起来说明更糟的一点——门检脚本自己的头注释记录了它曾产生过「9 处里只看到 8 处、全部合规」的假通过（`2026-08-21-subprocess-timeout-git.md:58`），当时补了「盲区断言」；但盲区断言位于 `if (!bound.size) continue` **之后**，对整文件跳过这种形态仍然无效。

**可执行的制度结论**：任何标 `fix(...)` 的 PR，验收动作应该是 `grep` 同形状函数/调用点并报数，而不是读 commit message 里的「补齐了」。本文 §6 每条都附了「兄弟数」字段。

---

## 二、健壮性（引擎侧）

### 2.1 🔴 子进程墙钟超时根本没生效 —— 32 处调用点无界

`packages/opencode/src/util/process.ts:77-88`：arm SIGKILL 的 `setTimeout` 在 `abort()` 内部，而 `abort()` 只在 `:111-114` 传了 `opts.abort` 时才挂监听。

```ts
const abort = () => { ...; const ms = opts.timeout ?? 5_000; timer = setTimeout(() => proc.kill("SIGKILL"), ms) }
if (opts.abort) { opts.abort.addEventListener("abort", abort, { once: true }) }
```

不传 signal ⇒ `opts.timeout` 永不使用 ⇒ `:136` `await Promise.all([proc.exited, buffer(stdout), buffer(stderr)])` 永挂。

最热落点：
- `cli/cmd/tui/util/clipboard.ts:110/123/139/143/166` —— 每次粘贴跑 powershell `GetImage()` / `xclip -o` / osascript，无 abort 无 timeout。**剪贴板被别的过程占住时输入路径死锁，日志零输出。**
- `lsp/server.ts:194-195`（`npm install` / `npm run compile`）、`:576-578`（`mix deps.get`）—— 网络卡住即 LSP 启动永挂。
- `util/archive.ts:10/14`、`cli/cmd/uninstall.ts:195`、`ide/index.ts:50`。

门检同样半瞎：`script/check-subprocess-timeout.ts:22` `BINDING = /const\s+(\w+)\s*=\s*yield\*\s*AppProcess\.Service/`。`clipboard.ts:14` 用的是 `AppProcess.Service.use((svc) => svc.run(ChildProcess.make(...), { stdin: text }))`——无 `const` 绑定 ⇒ `:76 if (!bound.size) continue` **整文件跳过**，连该文件 `:105` 的盲区断言都救不到（它排在 `continue` 之后）。

**⚠️ 修法必须避开一条已否决路线**（`2026-08-21-subprocess-timeout-git.md:48`）：

> **在 `AppProcess.run` 里给所有调用一个全局默认超时**：否决——默认值会静默套到未来所有新调用点上，包括那些合法长跑的。让每个调用点显式声明，才能在 review 时看见它选了什么。

因此这里的正确修法**不是**给 `spawn()` 加 5s 缺省值（那恰恰是否决掉的形态）。改成两件事：

1. **让参数变成真的**：`timeout` 存在就无条件 arm 墙钟定时器，不再寄生在 `abort()` 里；`timeout` 缺席且无 `abort` 时**显式报错或按调用点声明**，不静默变永挂。
2. **扩门检而不是加缺省**：`BINDING` 增认 `AppProcess.Service.use(` 与 `Process.run/text/lines`，并让 `.run(` 的归因不依赖 `bound.size` 早退——使每个 `util/process.ts` 调用点也必须像 `AppProcess` 那样显式声明或写豁免理由。

### 2.2 🔴 MCP 附件绕过截断与缩放，体积与条数双无界

`session/tools.ts:250-269` 把 MCP `image` / `resource.blob` 拼成 `data:` URL 放进 `attachments`，而 `truncate.output` 只作用于 `textParts`（`:270`）；`:286 content: result.content` 把含原始 base64 的 MCP 原始响应整体塞进 output 落库。`session/processor.ts:615-628` 的 5MB 缩放闸门条件是 `mime.startsWith("image/")`，**PDF / octet-stream 原样透传**，附件**条数**也无上限。

同形状兄弟 `tool/read.ts:42-45` 已有图片 32MB / PDF 3.75MB 双闸门（`2026-08-28-image-pixel-budget-and-alpha-ladder.md` 立的 `attachment.image.max_pixels`/`max_dimension` 语义），MCP 这条一个都没有。

**这条的战略意义**：它是全仓**唯一一条第三方服务器可单方面把无界字节写进本地消息表并灌进模型上下文**的路径，与 `summary.diffs` 32MB / `read.ts` 图片 3.23MB 两次事故同量级。照搬 `read.ts` 闸门即可，成本最低收益最高。

### 2.3 🔴 slash 命令 `` !`cmd` `` 一条同时踩三条红线

`session/prompt.ts:1978-1997`：
1. 走 §2.1 的 `Process.text`，无墙钟上限；
2. 结果 `results[index++]` 直接 `template.replace` 进 prompt，**无任何字节上限**——`` !`git log` ``、`` !`cat big` `` 任意膨胀进模型上下文；且 `Process.text` 不像 `AppProcess.run` 那样收 `maxOutputBytes`，stdout 无限涨到 OOM；
3. `nothrow: true` 把 stderr 与 stdout 混成同一串正文，**模型分不清命令成没成**。

另：`Promise.all` 无并发上限。

### 2.4 🟠 其余（每条都是某次加固的漏网兄弟）

| 位置 | 缺陷 | 已立但没覆盖到它的加固 |
| --- | --- | --- |
| `tool/registry.ts:384` | 第三方 agent frontmatter 的 `item.description` 原样拼进 `task` 工具 description；`config/agent.ts:32` 只有 `Schema.optional(Schema.String)` 无长度校验 | `skill/index.ts:365` 已立 `MAX_DESCRIPTION_CHARS=1024`，`:392` 还把工具描述降成 names-only（`2026-09-11-skill-description-budget.md`）。工具 schema 属**固定前缀**，一条超长描述每轮全价付费并作废其后 KV cache |
| `session/prompt.ts:366-370` | `@path` 指向不存在文件且无同名 agent 时直接 `return`，不推 part、不报错、不提示 | 同函数 `:339-350` 对「配置化 reference 内的缺失路径」明确推 `problem:` 文本。**同函数内的不对称** |
| `mcp/index.ts:309-350` | 重试不分类：参数校验失败、tool 不存在同样重试 3 次，且 `:342-346` 每次重试前重启整个 server（最坏 3×timeout + 3s 退避 + 3 次进程重生）；`:347 } catch {}` 无说明吞掉 reconnect 失败 | 同文件另有 8 处空 catch（`:61/79/102/814/994/1092/1096`），其中 `:994` 是配置热重载 reconcile 失败——**静默失效后 watcher 从此不再响应** |
| `session/canary.ts:34-43` | 读失败（`:37`）与写失败（`:42`）双双静默。只读 FS 或 state 目录不可写时每次重启生成新 secret → 派生 token 每轮变 → **整段历史前缀缓存作废** | 正是 `:6-12` 注释点名要修的症状；且 TUI 与 sidecar 双进程会各持一份 secret |
| `session/prompt.ts:224` | `catch { return { approved: false } }` 把 `perm.ask` 的**基础设施故障一律译成「用户拒绝了」** | 权限系统的错误应响，不该伪装成用户意志 |

### 2.5 catch 统计与真实危险分布

作用域内 catch 共 199；按「既不处理也无注释」口径 87 处（AGENTS.md 记的「~97」同量级、略偏高但仍有效）；物理空块 28 处（`opencode/src` 26 + `core/src/account.ts:141` + `core/src/util/module.ts:8`）。**危险的集中在一处**：`mcp/index.ts`（8 处）与上表 `prompt.ts:224`。

### 2.6 ✅ 已核实健康（不必再花精力）

- `storage/storage.ts:257` 与全部 config 写入走 `writeFileStringRecursiveAtomic`——**持久状态写入这一面是干净的**（`2026-09-01-atomic-config-writes.md` 已落地）。
- `session/message-v2.ts` 读路径已 keyset 分页（`:1077` `limit+1`、`:658-682` `hydrate` 用 `inArray` 批量取 part），**无一处 OFFSET、无 N+1**。
- `tool/edit.ts:40-65` 引用计数锁用 `acquireUseRelease`，中断路径正确无泄漏；`snapshot/index.ts:89-98` 的 locks Map key 是 gitdir、实例上限 10，量级可控。
- 全仓 `as any` 19 处 / `@ts-ignore` 13 处（`opencode/src`，主 agent 复核口径），类型面相当紧。

---

## 三、UI 与渲染

**先说正面，因为这决定了下面几条的定位**：这个前端的响应式纪律**异常好**——全仓 grep 解构 props 破坏响应式的模式命中 **0**；`<Index>` 仅 6 处且都在只追加分组上；`DebugBar` 有 `import.meta.env.DEV` 门禁（`app/src/pages/layout.tsx:1190`）；`preload` 每条 `ipcRenderer.on` 都返回 remove 闭包；三个窗口全 `contextIsolation:true / nodeIntegration:false / sandbox:true` + `setWindowOpenHandler` deny + `resolveExternalURL` 协议白名单；sidecar 有 `taskkill /T` 整树与有界 timeout；`overflow`/`min-width:0`（222 处）与 `prefers-reduced-motion`（10+ 处）覆盖到位。**下面的问题是漏网点，不是系统性松懈。**

### 3.1 🔴 `TimelineRow.reuse` 每帧 O(全量行)，且注释宣告已修

`packages/app/src/pages/session/message-timeline.data.ts:144-155`：

```ts
const byKey = new Map(previous.map((row) => [key(row), row] as const))   // :146  N 次 key()
const result = rows.map((row, index) => { const existing = byKey.get(key(row)) ... })  // :149  再 N 次
```

`:138` 那段注释把「外加每帧约 2N 次模板串分配喂给 GC」列为本次改动要解决的问题——实际**只消灭了下游传播**（返回 `previous` 引用让 `===` 成立），`reuse` 自己那 2N 次一分没少。同文件自量的数：3601 行 3.96ms/次，按 `server-sdk.tsx` 的 `FLUSH_FRAME_MS = 16` 算即 **24% 帧预算**。

修（约 20 行）：行是不可变 `Data.TaggedClass` 且按引用复用 ⇒ `key()` 结果惰性写回 `row._key`；`byKey` 随 `previous` 引用一起缓存。**同时把 `:126-143` 那句不成立的结论改掉**——按本文 §1，留着它比没有注释更危险。

### 3.2 🔴 TUI 流式 markdown 全量重解析，无节流（web 已修的漏网兄弟）

`packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:1883-1901` `content={props.part.text.trim()}` 直读 signal；`context/sync.tsx:385-396` 每个 `message.part.updated` 事件一次 `reconcile` 写入，**无合帧/节流**（grep `throttle|debounce` 零命中）→ opentui `<markdown>` renderable 每次收到新 content 整块重解析重排，`.trim()` 每 tick 再分配一份全文。8KB 回答按 50–100 events/s 即 O(n²)。

web 侧 `PacedMarkdown`（`ui/src/components/message-part.tsx:170-215`，配套 `2026-09-07-markdown-block-dom.md`、`2026-09-07-markdown-highlight-worker.md`）已用「自适应 `max(120ms, renderMs×1.5)` 节流 + 块缓存 + 分块 DOM」解决。**修法是把 `PacedMarkdown` 抄成 TUI helper 包在 `<markdown>` 外，约 1 小时。**

### 3.3 🟠 其余

- **memo 体内做全局缓存删除**：`message-timeline.tsx:523` → `readTimelineCache`（`:99-111`）miss 时 `timelineCache.delete(id)`。memo 可被任意顺序/次数重算，**读不幂等**；一次非末尾变更（顶部翻历史、compaction、回滚）删条目后 `virtualCache()` 同帧再算即 `undefined` → `itemSize` 回落 `timelineFallbackItemSize = 60`（`:96`）→ 整列塌缩再逐行重测，就是注释里描述的「闪一下」。拆成纯读 + 在行键 effect 里显式 invalidate。
- **底部锚定 4 个写入者，一个绕过统一门禁**：`app/src/pages/session.tsx:126` `createAutoScroll({ working: () => true })` 恒真 ⇒ `ui/src/hooks/create-auto-scroll.tsx:169-183` 的 ResizeObserver 每帧都可能 `el.scrollTop = el.scrollHeight`（同步强制布局），它只看 `userScrolled`，**不看** `shouldAnchorBottom()`（`session.tsx:1746`，含 `location.hash / messageId / pendingMessage`）。目前靠每条跳转路径都记得 `autoScroll.pause()` 兜住（`use-session-hash-scroll.ts:112,123,169`、`session-message-nav.ts:78`）——**新增滚动功能漏一次就是「跳到某条消息被拽回底部」**。把 `shouldAnchorBottom` 当 `working` 传进去。
- **设置页整块英文裸漏，绕过 i18n**：`app/src/components/settings-general.tsx:739/780/1042/1046/1050/1058/1103`（`Chat Background` 及其 description、`Home Background`、`Display Name`、`placeholder="Your name"`、`Avatar`×2）。全站 JSX 英文字面量 grep **只出这一个文件**，所以是明显漏网而非风格问题。10 分钟。
- **`parse-markdown` 是死 IPC，且主进程藏着第二套不净化的 marked**：`desktop/src/main/ipc.ts:95` + `desktop/src/main/markdown.ts`。`app/src/app.tsx:193` 的 `<MarkedProvider>` **没传** `nativeParser`，`platform.parseMarkdown`（`context/platform.tsx:91`、`desktop/src/renderer/index.tsx:280`）全仓零调用。而它用的 `marked` 正是 `ui/src/context/marked.tsx:157` 注明「长文本 O(n²)，50KB 587ms」而被换掉的库，且**不 sanitize**。今天无害，谁接上就是主进程卡顿 + HTML 注入。**删整条链。**
- **无终止条件的 rAF 循环**：`ui/src/pierre/comment-hover.ts:40-46,54` 的 `loop` 只判 `button.isConnected`——按钮挂着就每帧跑（页面永不空闲）；被摘掉再插回则循环已永久退出、`line` 不再更新 → hover 定位失效。`mouseenter/mousemove` 已在调 `sync()`，这个 rAF 可直接删。

### 3.4 🟡 低（含一处「修对了但别以为修完了」）

`contain-intrinsic-size: auto 200px`（`ui/src/components/{message-part,basic-tool,file}.css`，`fd72538b` 补齐）方向正确、无遗漏点（`turn-outline.tsx:155` 自带）。**但 `auto` 只在元素渲染过一次后才记住真尺寸**，首进会话时视口外行统一按 200px 上报 virtua，长行持续低估总高 → 滚动条比例不准。且这套 200/40 与 `timelineFallbackItemSize = 60` 是**两套互不校验的估值**。

其余：TUI `context/sync.tsx:352-368` 内存有界（>100 时 `shift()` 最旧并删其 parts）但用户滚到顶部读历史时列表会从头顶抽走；消息流只有 `aria-live="off"`（`message-timeline.tsx:1439`），全仓无 polite 完成播报，读屏用户不知道回答结束；`message-timeline.tsx:192`、`titlebar.tsx:571` 硬编码印色（全仓仅 2 处）应抽 token；`app/src/components/session/session-context-format.ts:8` 造的 `usd` 从未使用。

---

## 四、性能与数据层

**前置事实（读码确认）**：`storage/db.bun.ts:4` 用 `bun:sqlite`、`db.node.ts:4` 用 `node:sqlite DatabaseSync` —— **全部查询同步阻塞事件循环**。所有 DB 延迟都是 evloop stall，不是异步等待。Pragma（`db.ts:99-105`）配置合理：WAL / `synchronous=NORMAL` / `busy_timeout=5000` / `cache_size=-64000` / 开库 `wal_checkpoint(PASSIVE)`。

### 4.1 🔴 `event` 表零索引 + 无界追加

`src/sync/event.sql.ts:9-16` 只有 `id` 主键；全 `migration/` grep `CREATE INDEX ... event` **零命中**。三条热查询裸扫：
- `sync/index.ts:176` `delete from event where aggregate_id=?` —— **删一个会话 = 全表扫**（SQLite 不为 FK 自动建索引）；
- `control-plane/workspace.ts:722-724` `where aggregate_id=? order by seq` —— 按会话回放全表扫 + 临时 B 树；
- `server/.../handlers/sync.ts:84-90` —— 每次同步轮询全表扫 + 排序。

且 `sync/index.ts:363-372` 每个 part 更新追加一行**全文 data**：流式 200 次更新 × 50KB = 单 part 10MB，O(n²)。

**⚠️ 与既有决策的关系（不重提）**：`2026-08-28-sync-write-path-invariants.md` 已明确**否决**「把持久化写入整个移出 flag」，理由「`event` 表存事件全文，等于把整个会话再存一遍；而它只有 workspace 同步要用」。**本文不重提该路线**，`experimentalWorkspaces` 门控（默认关）继续保留。要修的是正交的两件事：
1. `CREATE INDEX event_aggregate_seq_idx ON event(aggregate_id, seq)` —— 零行为变更，把「删一个会话全表扫」变成索引查找，并为 flag 打开后的追加风暴留出可读性；
2. 给 `event` 加保留窗口（按 aggregate 只留快照后增量）—— 这不改变「是否落库」的门控，只限制「落多少」。

**这里的不对称同样说明问题**：`session.sql.ts:57-154` 给 session/message/part/todo 建了 10 个索引，`event` 表一个没有。

### 4.2 🔴 tool part `state.metadata` 无字节帽，且 patch 写两遍

`session/projectors.ts:187-196` 把整个 part `data` 序列化落库，而 `Truncate.MAX_BYTES = 50KB`（`truncate.ts:17`）**只管 `output`**。`tool/edit.ts:318-324` + `:334-338` 把**同一份 patch 写两遍**（`metadata.diff` 与 `metadata.filediff.patch`），外加全项目 `diagnostics` map；`write.ts:86-88`、`apply_patch.ts:222-224` 同形。

10k 次编辑 × p90 158KB × 2 ≈ **3GB part blob**，而 §4.3 每 step 会把这些全部 `JSON.parse` 回来。

`summary.diffs` 已有 `MAX_TURN_PATCH_BYTES`/`MAX_SESSION_PATCH_BYTES`（`summary.ts:60-61`，其 p50 14KB / p90 158KB / p99 1.0MB / 最大 30.7MB 的实测在 `:54-57`），**metadata 是唯一漏掉的那条分支** —— 与 `read.ts` 图片分支同一形状的缺陷。修法：写库前统一裁 `metadata`，`filediff.patch` 只留一份引用。

### 4.3 🔴 每 step 重新物化整个保留窗口

`session/prompt.ts:1113` 的 `filterCompactedEffect` 在 `while(true)` **内**，每 step 重跑 `stream() → page() → hydrate() → 逐行 JSON.parse`，再 `:1520` `toModelMessagesEffect` 全量重转。`msgPin`/`modelMsgs` 只稳定**内容**（前缀缓存），不减算力；`stabilizedMsgs` 仍要先建完整 `modelMsgs`。

本仓自己的实测（`message-v2.ts:1250`）：2612 条会话 44ms（压缩后）/ 213ms（未压缩）。**50 step 的一轮 = 2.2–10.7s 纯阻塞**，而 §4.2 的 blob 直接乘进这个数——**这两条互相放大，应合并处理**。修法：step 循环内维护增量窗口，只读新写 part。

### 4.4 🔴 压缩期把全会话加载 3 遍，只为一次主键点查

`session.ts:887-906` `messages()` 不带 `limit` 即整会话入内存。调用点：`compaction.ts:383`（prune）、`:701`、`:720`、`:734` —— **同一次压缩跑 3 遍全量**。最恶劣的是 `:701` 与 `:720`：

```ts
(yield* session.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)).find(
  (item) => item.info.id === msg.id,
)
```

这是主键点查，而 `MessageV2.get`（`message-v2.ts:1225`）已存在。`:734` 载全表只为算 `tokensAfter`。`lastUserAgent`（`message-v2.ts:1044`）和 `snapshotParts`（`:1175`）**已经修过两次同一缺陷**。

其余无界调用点：`revert.ts:43,117`、`tool/plan.ts:47`、`share/share-next.ts:282`、`server/.../handlers/session.ts:185`（HTTP 无 limit 全量响应）。

**这是全仓风险收益比最好的一条**：改约 10 行、零行为变更，且压缩恰好发生在会话最长的那一刻。

### 4.5 🔴 session 列表全列扫 + 无排序索引

`session.ts:1070-1085` `select()` 取全列（含最大 4MB 的 `summary_diffs`）、`orderBy desc(time_updated)`，而 `session.sql.ts:56-59` 只有 `project_id`/`workspace_id`/`parent_id` 三个索引 → **全表扫 + 临时 B 树排序在 LIMIT 之前**。1000 会话 × 200KB = 200MB 读 + parse。`like('%'+search+'%')`（`:1072`）永不走索引。修法：加 `(time_updated, id)` 与 `(project_id, time_updated)`；`list` 改投影列表，不取 `summary_diffs`。

### 4.6 🟠 中

- **每次 search 强制全仓重扫**：`file/index.ts:410-421` 扫完立刻重建 `Effect.cached`，`search()`（`:668`）先 `ensure()`；`isGlobalHome=false` 分支（`:386-389`）`rg --files` 结果 `Stream.runCollect` **无上限入内存**，再 `fuzzysort.go` 扫全表 + `[...files,...dirs]` 整表拷贝（`:683`）。10 万文件仓库＝每击键一趟完整磁盘遍历 + 10 万元素排序。`file/watcher.ts` 已接 `@parcel/watcher` 却**只发总线事件、不喂这个缓存**（仅 `server/routes/instance/httpapi/server.ts:236` 装了 layer）。注意 `:410` 注释声明这是刻意的、`test/file/index.test.ts` 钉住了该语义——改成 watcher 增量失效需**同步改该测试**。
- **edit/write 路径无文件大小帽**：`edit.ts:206` `Bom.readFile` 整文件读入，随后 `createTwoFilesPatch` + `diffLines`（`:294-310`、`:683-697`），jsdiff 是经典 O(N·M)。**50MB 单行 minified bundle 一次编辑即同步挂死**（无超时）。`read.ts:21` 有 50KB 帽，写路径一个都没有；`FUZZY_MAX_CONTENT_LINES=3000`（`edit.ts:800`）只保护 fuzzy，不保护 diff。修法：stat 超阈值直接拒 diff、退化成计数。
- **`msgPin` 是第二份全历史**：`prompt.ts:1483` 逐条 `structuredClone(msg.parts)`。`MAX_SESSIONS=32`/TTL 1h（`util/session-evictor.ts:71-72`）限的是**会话数不是字节**：32 × 33.7MB（H3 注释实测）≈ 1GB，再叠 `modelMsgs` 第三份。修法：pin 表加字节预算。
- **shell 每 chunk 一次串接 + 一次发布**：`tool/shell.ts:694` `last = preview(last + chunk)` 每次构造 ≤30KB 新串再切，`:722` 每个 stdout chunk 触发一次 `ctx.metadata`。10 万 chunk ≈ 3GB 瞬时字符串 churn。滚动缓冲本身有界（`keep = maxBytes*2`，`:687-692`），只是常数。
- **无保留/回收路径**：全仓 grep `vacuum` **零命中**，无 `auto_vacuum`；`compaction.ts:414-418` prune 只打 `state.time.compacted` 标记，**output 字节永不出库**；`session-diff-gc.ts` 只清孤儿 JSON 文件。6 个月重度使用 = 单调增长 + 空 freelist 永不归还（`inferred`：未能读 live DB 量化，据「无任何 reclaim 路径」推得）。

### 4.7 🟡 低

`src/index.ts:20-57` 顶部 40+ 个**串行** `await import()`：每个子命令（含 `--version`）加载整张模块图，且是串行 waterfall；短路只对 `REDCODE_WINDOWS_JOB_RUNNER` 生效（`:11`）。（`inferred`：`bun build --metafile` 量化启动图大小被权限拦，此条为阅读所得。）`session.ts:962-977` `latestCompactionCursor` 对整个会话每个 part 做 `json_extract`（§4.2 的 blob 越大越慢）。`session/prompt.ts:1503-1540` `system`/`modelMsgs` 按 `[sessionID][modelKey]` 二级分桶，`dropSession` 只按会话摘 ⇒ **单会话内换 20 次模型留 20 份全文 system 副本**，无 per-model 回收。`processor.ts:660` 每次 tool-result 都 `JSON.stringify(toolCall.part.state.input)` 做重复检测。

### 4.8 ✅ 已核实健康

Provider SDK 全动态 import（`provider.ts:105-129`）；models.dev 5 分钟文件缓存（`core/src/models-dev.ts:184`）；MCP 断线用磁盘缓存桩不阻塞首 token（`mcp/index.ts:360`）；glob/grep 结果已封顶（`glob.ts:53`、`grep.ts:16,116`）；`lsp/client.ts:671-677` diagnostics 是纯内存读。

### 4.9 现有 perf 资产的盲区（这条决定上面几条会不会复发）

`packages/opencode/script/bench-performance-budget.ts` 是**真门禁**（2612 msg / 50ms / 缩放比 6 / 16MiB，超阈值 exit≠0），`f15c08af` 才加。但它**只测 `filterCompactedEffect` 一条路，且种子数据每条 user 4KB 纯文本 —— 完全不含 §4.2 的 metadata blob，所以 metadata 膨胀永远撞不到这条门禁**。`perf/test-suite.md` 是测试套件提速，非生产路径。门禁只有 `check:subprocess-timeout`（pre-push）与 `check-migrations.ts`（仅 drizzle 漂移，**不查索引存在性**）。

**缺失的门禁**：`event`/`part` 行尺寸上限、`session` 表排序索引存在性、tool metadata 字节帽、让 budget 种子带真实 metadata blob。

---

## 五、架构腐化

### 5.1 🔴 fork 分歧内联进上游文件 —— 下次合并的冲突面

`packages/opencode/src` 内 `// YYMMDD Red` 标记 **559 处 / 137 个文件**（含 `.tsx`；子审计口径为 234/81，主 agent 复核后按更宽口径为 559/137）。集中在上游必改的大文件：

| 文件 | 标记数 |
| --- | --- |
| `session/prompt.ts` | **65** |
| `session/processor.ts` | 34 |
| `mcp/index.ts` | 33 |
| `provider/transform.ts` | 21 |
| `cli/cmd/tui/routes/session/index.tsx` | 21 |
| `provider/provider.ts` | 20 |
| `session/llm.ts` | 16 |
| `session/message-v2.ts` | 13 |

git log 显示上游走 merge 流（`44dda421 Merge upstream/main`）。**下次 upstream 合并的冲突面 ≈ 559 个热点，且全在最大的文件里。**

修法：沿**已存在的 seam** 把 RedCode 独有关注点（steering 策略、reminders、prefix-cache、MCP guide）推进 `session/system.ts`、`session/reminders.ts`、`instruction`，做成 RedCode 自有模块被薄 hook 调用。注意这与 §7-13 是同一次改动。

### 5.2 🔴 v1/v2 session 双活，两套 projector 写同一批表

（主 agent 已核实：`session/projectors.ts` 与 `session/projectors-next.ts` 并存，`server/routes/instance/httpapi/api.ts:49 .addHttpApi(V2Api)` 确实挂载。）

`session/projectors.ts:9` 用 v1 `MessageV2/MessageTable/PartTable`；`:12` import 的 `projectors-next.ts:3` 用 v2 `core/session-message`。两条流都从 `@/sync SyncEvent` 驱动。v2 侧还有 `v2/session.ts`(372) + `core/src/session*.ts` 五个文件。

**代价**：动一个 session/message 字段 = 2 套域模型 + 2 套 httpapi handler + 2 个 projector + 共享 SQL，**五处一起改**。修法：v1 handler 降级为只读适配器，写路径冻结到 v2 projector，一个概念一个 owner。

### 5.3 🔴 「跑会话 / 渲染消息」实现了三遍

- `cli/cmd/run/` **17,215 行**（已核实：`session-data.ts` 1145、`stream.transport.ts` 1259、`tool.ts` 1489、`footer.*.tsx`）
- `cli/cmd/tui/routes/session/index.tsx`(2736) + `tui/util/transcript.ts`
- web 侧 `ui/src/components/message-part.tsx`(2739) + `app/src/pages/session.tsx`(1806) + `message-timeline.tsx`(1969)

三者各自 switch `part.type`、各自折叠事件、各自画 permission/tool（`run/tool.ts:305` 与 tui 各有 ToolPart 分支）。**后果不是抽象不美，而是 §3.2 那类 bug 的确切来源**：新消息类型/权限流程只在一个面落地，另两个面静默漏配——UI bug 恰好全在这三处漂移。

修法：抽一个框架无关的「事件 → view-model」reducer，先让 `run` + `tui` 共用（`run/session-data.ts` 已是雏形），停止复制折叠逻辑。

### 5.4 🟠 中

- **Effect-TS 却以命令式报错为主**：`throw new` **248** vs `Effect.fail` **111**（均已核实），`TaggedError` 仅 4 处。DI 上 81 文件用 Layer/Context.Service，另有 23 处手写 `make/create` 工厂并存。边界处 throw↔fail 转换点会随代码增加而增多。
- **session ↔ tool 循环依赖**：`tool/{goal,plan,read}.ts` 引 `session/*`，`session/{processor,prompt}.ts` 引 `tool/*`。二者无法独立编译/测试；抽 tool 运行时前需先立 `ToolContext` 接口注入。
- **God module 继续长**：`prompt.ts`(2217) 已混 ≥6 职责（系统提示装配 / structured-output 工具 / 繁忙 steering / 前缀缓存 / skills·env·instructions 缓存 / 循环检测）。**seam 已存在**，只需把缓存+steering 抽进去。`provider.ts`(2071)、`lsp/server.ts`(2067)、`ui/message-part.tsx`(2739) 同理需按类型/语言拆。
- **i18n 偏科**：`app/src/i18n/{en,ja,zh}.ts` + `parity.test.ts` 齐备，而 **TUI/run 无任何 i18n 层**（英文硬编码）。旗舰是 GUI，终端会越来越不可本地化。
- **AGENTS.md 陈旧**：引用 `instruction.ts:120-138`/`:127` 讲 global+project 注入，实际逻辑在 `:80-107`（**行号已漂**）；根表让你「先读该 package 的 AGENTS.md」，但 `core`(22k)/`ui`(35k)/`sdk` **根本没有** package 级 AGENTS.md。行号引用应改符号名。
- **notes 回链半失效**：83 篇里仅 10 篇完全无回链（~88%），但**只有 30/83≈36% 从代码回链**，其余只挂 CHANGELOG。而根 AGENTS.md 定义的读取触发点恰恰是「① 读代码撞见回链时」——**六成的决策记录永远不会被撞见**，也就无法阻止重提已否决路线。

### 5.5 ✅ 三个「以为是风险、其实健康」的（别再花精力）

- **SDK 两步同步已被门禁挡住**：`check:openapi-drift` 在 `.husky/pre-push:27`，`packages/sdk/openapi.json` 不一致直接拦。根 AGENTS.md 里「只跑第一条会漏掉 openapi.json」那条警告可降级为历史信息（**但 `proposed/process/2026-08-28-generated-artifact-gates.md` 指出的 `types.gen.ts` 仍无人看守，那一半还没落地**）。
- **层向清晰**：`ui` **不依赖** `app`（无向上依赖）；`opencode → core` 409 次引用、`core → opencode` **0 次**。
- **持久写入面干净**：见 §2.6。

---

## 六、工程卫生与门禁

> 这一节决定上面五节能否守住。核心判断：**测试本身不是假绿，覆盖面和门禁才是问题。**

### 表 · 测试覆盖形状

| 包 | src 文件 | src LOC | 测试文件 | 测试 LOC | 比 | 进 CI |
| --- | --- | --- | --- | --- | --- | --- |
| opencode | 577 | 124,545 | 315 | 91,401 | 73% | ✅ |
| core | 115 | 12,737 | 49 | 9,722 | 76% | ✅ |
| **llm** | 55 | 8,793 | 27 | 7,006 | 80% | **❌ 一字未跑** |
| app | 262 | 54,538 | 68 | 8,252 | 15% | ✅ |
| **ui** | 235 | 35,217 | **10** | **675** | **1.9%** | ✅ |
| **desktop** | 43 | 4,875 | 8 | 356 | 7.3% | ✅ |
| web | 18 | 6,892 | 0 | — | 0% | ❌ 且无 typecheck |
| plugin | 6 | 1,270 | 0 | — | 0% | ❌ 无 test 脚本 |
| effect-drizzle-sqlite | 20 | 3,246 | 1 | 139 | 4.3% | ✅ |
| enterprise / sdk-js / storybook / function | — | — | 2/0/0/0 | — | ≤31% | ❌ 全部静默缺席 |

正面数据：断言密度 **6.2–16.6 expect/case**（opencode 7,887 expect / 299 文件）；`.only` **0 处**；空体用例 **0 处**；mock 使用 **29/481 = 6%** —— 包级 AGENTS.md 的「测试测实际实现，避免 mock」**被遵守了**。

### 表 · 类型安全面

| 包 | `as any`(src) | 非空断言 | `@ts-expect-error` | `noUncheckedIndexedAccess` |
| --- | --- | --- | --- | --- |
| opencode | 22 | 316 | 10 | **显式 false** |
| app | 9 | 117 | 2 | 未设（默认 off） |
| ui | 32 | 50 | 4 | 未设 |
| llm | 0 | 2 | **34** | 显式 false |
| core | 8 | 2 | 2 | 显式 false |
| effect-drizzle-sqlite | 25 | 2 | 0 | 显式 false |

### 6.1 🔴 `bun.lock` 未纳入版本控制，CI 每次解析当天版本集

`.gitignore:31` 排除 `bun.lock`，`git ls-files bun.lock` **为空**。`.github/actions/setup-bun/action.yml:55,57` 的 `bun install` **不带 `--frozen-lockfile`**；缓存键 `hashFiles('**/bun.lock')` 恒为空哈希 ⇒ **所有分支共用一个缓存桶**。

实测已并存：**6 个 typescript**（3.9.10 / 5.4.5 / 5.6.3 / 5.8.2 / 5.9.3 / 7.0.2）、**2 个 effect 大版本**（beta.66 与 beta.83 并存，`overrides` 只钉了 `@effect/platform-node-shared`）、**2 个 marked**（15.0.12 / 17.0.1，desktop 的 `^15` 撞 catalog 的 `17.0.1`）。另有 `"@solidjs/start": "https://pkg.pr.new/@solidjs/start@dfb2020"` 走**可撤销的 preview URL**，无 lock 即无字节证明。`bunfig.toml` 的 `minimumReleaseAge=259200` 只挡新发布投毒，**不挡既有版本漂移**。

**为什么这是第一优先级**：它削弱本仓所有其他证据的可解释力——CI 绿不代表这组依赖版本能过，本机绿灯与 CI 绿灯可能来自两套不同的 typescript/effect。多份 effect 并存还有 `InstanceOf` 判定跨副本失败的实害面。

### 6.2 🔴 发布链是断头路，且自身绕过全部门禁

`.github/workflows/` 只有 `audit.yml` / `test.yml` / `typecheck.yml` —— **无任何构建或发布 workflow**，出货二进制完全由本机 `build.bat` 产出、零门禁。

| 位置 | 状态 |
| --- | --- |
| `script/release` → `gh workflow run publish.yml` | 该文件**不存在** |
| `script/publish.ts:46` → `bun ./packages/redcode/script/publish.ts` | 路径**不存在**（实为 `packages/opencode`） |
| `script/beta.ts:89,203` → `cwd("packages/redcode")` | 同上 |
| `script/raw-changelog.ts:117,129,130` 用 `packages/redcode` 过滤 git log | **CHANGELOG 的 tui/core 分区一直静默错标** |
| `script/publish.ts:64,70` | 两处 `git push --no-verify`，发布路径绕过所有 pre-push 门禁 |

这正是根 AGENTS.md 红线「误配置要响 / 永远不要静默跳过一个解析不到的引用」的反例——而且它藏在**用来保证质量的那条链路上**。`script/generate.ts:7` 的注释证明这个死路径 08-19 曾被咬过一次并修了那一处，剩下 5 处留到今天（§1）。

### 6.3 🔴 CI 静默跳过：`llm` 的 7,006 行测试从未执行

`packages/llm/package.json:10` 只有 `"test": "bun test --timeout 30000"`，**无 `test:ci`**；`bun turbo test:ci` 对缺脚本的包**静默跳过不报错**；`test.yml` 的 junit glob `packages/*/.artifacts/unit/junit.xml` 只收跑过的包，**缺报告不响**。同样静默缺席：enterprise、plugin、sdk/js、web、function、storybook（合计约 3,900 LOC 逻辑 + llm 8,793）。

### 6.4 🔴 两道关键门禁只存在于本地，可被一次 `--no-verify` 永久绕过

`check:subprocess-timeout` 与 `check-version-consistency.ts` 只在 pre-push / `build.bat`（`git config core.hooksPath` = `.husky/_`，已确认）。**CI 上完全不存在** 7 步版本 checklist 里「README 徽章 / CHANGELOG / 14 个 package.json 同号」这条断言。`check-version-consistency.ts:33-48` 的清单本身也漏了 `packages/script`、`containers`、`extensions`。

### 6.5 🟠 中

- **lint 是装饰品**：workflows 里 grep 不到 oxlint/prettier；`.oxlintrc.json` `categories.suspicious="warn"`、`typescript/no-floating-promises="warn"`，**全 warn 且无 `--deny`**，`bun run lint` 恒退 0。且该文件有 **3 个重复的 `"options"` 键**（JSON 后者覆盖前者，**配置已被静默改坏**）。全仓无任何 coverage 工具（`--coverage`/codecov 0 命中）；`bench:budget` 无任何调用点。
- **`script/typecheck.ts` 的兜底只覆盖一个包**：只有 `packages/opencode` 走包装；app/ui/desktop/plugin/enterprise 用裸 `tsc` = tsgo 7.0.2，**tsgo OOM 崩溃时这几个包没有兜底**，CI typecheck 会因编译器自身崩溃长期飘红。回退用的 5.x 是 `readdirSync(node_modules/.bun)` 里**字典序挑出的任意一份**（未声明、随 lock 漂移），且不记录用了哪个编译器 ⇒ **同一份代码两次绿灯可能来自两个不同编译器**。
- **桌面/E2E 几乎裸奔**：整个 app 只有 **1 个** playwright spec（`packages/app/e2e/session-timeline.spec.ts`），CI `retries: 2` 掩盖抖动。3 个月 churn 榜上零测试的高危文件：`desktop/src/main/ipc.ts`(13 次)、`desktop/src/main/index.ts`(19 次)、`ui/src/components/message-part.tsx`(21 次 / ui 仅 10 个测试)、`app/src/pages/home.tsx`(27 次)、`desktop/src/main/windows.ts:160,430`。
- **测试隔离仍有旁路**：根因**确实已修**（`bunfig.toml [test] root = "./do-not-run-tests-from-root"`、`REDCODE_TEST_HOME` preload、`core/src/global.ts:14` 改为访问期派生）。但 `packages/opencode/src` 仍有 **19 处直接 `os.homedir()`** 绕过该变量，两处可达 live 数据：`session/prompt/shared.ts:22`（读真实 `~/.redcode/souls/Tsoul.md` 决定会话标题 → 测试非确定性）、`file/protected.ts:4`（**模块加载期**把 home 冻结成常量，与 `global.ts` 修掉的正是同一形状）。
- **无 trust/consent 门禁**：`mcp/index.ts`、`plugin/loader.ts`、`config/config.ts` grep `trust|consent|approve` **0 命中**。clone 来的仓库带 `.redcode/redcode.jsonc`（`test/config/config.test.ts:782` 实证会被自动加载）即可投递 local MCP 命令与插件代码执行。这与 0.10.0 修插件**加载失败静默**是同一片地，只是这次是**加载成功无需同意**。

### 6.6 🔴 安全边界回退 + 静默注入公开凭据

`cli/network.ts:48` `LAN_DEFAULT_PASSWORD = "RedCode0429"`；`resolveLanDefaultPassword`（`:79-83`）在非回环绑定且 env 未设时把它写进 `process.env`，**不打任何日志**。时间线值得单独记：

- **260824** 立闸门，理由写在 `:53-55`：「此前 `serve`/`web` 两条命令在没有 `REDCODE_SERVER_PASSWORD` 时只打印一行 warning 然后照常监听——而 `redcode web` 的整个用途就是把机器开给局域网，于是同一 Wi-Fi 下的任何设备都能拿到 shell 与全部源码，**一行灰字提示挡不住任何人**」。
- **260908**（`:57-60`）把「拒绝启动」放宽为「自动落到内置默认密码」，理由是「每次开 0.0.0.0 都要手工设环境变量太劝退，而内置一个默认密码比裸奔强」。

现状：`assertPasswordForExposure`（`:62-75`）仍在，但只在**显式置空串**时触发。**净效果是用户被给出虚假的保护感**——不提示就以为密码是自己设的，而凭据是公开仓库里的字面量。`:45-47` 注释诚实承认「源码是公开的，这个值挡的是同网段顺手蹭」，问题不在选了这个默认值，**在于注入过程完全静默**（违反本仓「误配置要响」）。

两个最小方案，任选：① 注入时 `UI.warn` 明示「正在使用公开默认密码 `RedCode0429`，同网段任何读本仓的人均可登录」；② 保留劝退性但把默认值改成**随机生成 + 打印一次**（不牺牲「比裸奔强」，且不再公开可猜）。

### 6.7 ✅ 正面（观测面这条尤其值得肯定）

`core/src/util/log.ts` 有 DEBUG/INFO/WARN/ERROR 分级 + 文件落盘 + keep=10 轮转；`desktop/src/main/unresponsive.ts` 用 `collectJavaScriptCallStack()` 每 1s 采样、15s 窗口聚合去重后写日志 —— **渲染进程挂起可事后诊断**，这条在同类项目里通常是没有的。`src` 内空 `catch{}` 共 43 处（opencode 32），**但无任何门禁阻止继续新增**。

### 6.8 🟡 低（品牌与配置残留）

`nix/flake.nix` 全指 `opencode`/`nix/opencode.{nix,desktop.nix}`（品牌未改、CI 不建）；`sdks/vscode` 不在 `workspaces` 里 ⇒ 永不 typecheck/测试；`.github/publish-python-sdk.yml` 误放在 `workflows/` 之外 ⇒ **永不触发**；`sst.config.ts` 注释自陈 `packages/console` 已删、任何 `sst deploy` 必崩（CI 不跑 sst 故无人踩）；`markitdown-temp/` 是 28MB 的微软 markitdown 游离 clone，已 gitignore、**不随包发布**（本文档生成工具误落入工作区，非供应链风险）。

---

## 七、修复排序（按 影响 ÷ 工时，跨维度合并）

### 第一梯队 —— 十行级、零行为风险、当下正在损失

| # | 动作 | 条目 | 兄弟数（改完须复查） |
| --- | --- | --- | --- |
| 1 | `bun.lock` 纳管 + CI `--frozen-lockfile` + 缓存键改真实哈希 | §6.1 | 所有 `bun install` 点 |
| 2 | LAN 默认密码注入改为可见（warn 或随机+打印） | §6.6 | 其余「静默兜底成公开常量」的配置项 |
| 3 | `compaction.ts:701/720` 换 `MessageV2.get`、`:734` 复用已有 `history` | §4.4 | `session.messages()` 无 limit 的 8 个调用点 |
| 4 | 两条索引：`event(aggregate_id, seq)`、`session(project_id, time_updated)` | §4.1 / §4.5 | 全表 `where`/`orderBy` 逐表复查 |
| 5 | 修 `publish.ts:46` / `beta.ts:89,203` / `raw-changelog.ts:117,129,130` 五处 `packages/redcode` 死路径 | §6.2 | 全仓 `grep -rn packages/redcode` 复查为 0 |
| 6 | TUI 抄 `PacedMarkdown` 节流；设置页 i18n；删 `parse-markdown` 死 IPC 链 | §3.2 / §3.3 | run / tui / web 三个面对齐 |

### 第二梯队 —— 无界增长（本仓已因此出过两次事故）

7. MCP 附件体积+条数双闸门，照搬 `read.ts:42-45` 纪律（§2.2）。
8. `projectors.ts` 写库前统一裁 `metadata`，`filediff.patch` 只留一份引用（§4.2）。
9. `` !`cmd` `` 套截断 + 传 timeout + 带 exit code 标记（§2.3）。
10. `util/process.ts` 让 `timeout` 生效 + 扩门检扫描面，**不加隐式缺省**（§2.1）。
11. step 循环内增量窗口，替代每 step 重物化（§4.3，与 8 合并做）。
12. 补门禁：`event`/`part` 行尺寸上限、排序索引存在性、metadata 字节帽；让 `bench-performance-budget.ts` 种子带真实 metadata blob（§4.9）。

### 第三梯队 —— 结构性，需排期

13. 抽框架无关「事件 → view-model」reducer，`run`+`tui` 先共用（§5.3）。
14. 沿已有 seam 拆 `prompt.ts` 并把 RedCode 关注点外移（§5.1，**与 13 同批做**，一次干掉最大 god module 与最大合并冲突面）。
15. v1 handler 降级只读适配器，写路径冻结到 v2 projector（§5.2）。
16. CI 新增 `gates` job：断言**每个含 `src/` 的包都产出 junit**（缺失即红）+ 收编 subprocess-timeout / version-consistency / `oxlint --deny-warnings` / `prettier --check`；发布前静态引用完整性闸（解析 `publish.ts` 每条 `bun ./…` 路径并断言存在）。
17. workspace trust 门禁（§6.5）+ `os.homedir()` 19 处收编进 `REDCODE_TEST_HOME`。
18. AGENTS.md 行号引用改符号名，并补齐 `core`/`ui`/`sdk` 的 package 级 AGENTS.md（§5.4）。

---

## 附：复核记录

主 agent 对子审计的关键数字独立复核。结论：**方向全部成立，两处修正**。

| 子审计声称 | 复核结果 |
| --- | --- |
| `util/process.ts` timeout 空参数 | ✅ 读 `:77-88`、`:111-114`、`:136` 原文确认 |
| `check-subprocess-timeout.ts` BINDING 盲区 | ✅ 读 `:22`、`:76` 确认 |
| `// YYMMDD Red` 234 处 / 81 文件 | ⚠️ 实为 **559 / 137**（子审计漏算 `.tsx` 与更宽前缀匹配）。修正后写本文 |
| fork 内联进上游 | ✅ 但 `prompt.ts` 标记数为 **65**（非 38） |
| `run/` 17,215 行 | ✅ `find … \| wc -l` 一致 |
| `throw new` 188 vs `Effect.fail` 103 | ⚠️ 实测 **248 vs 111**（口径含 `throw` 非 `new` 的部分）。不对称程度更大，结论不变 |
| v1/v2 双 projector 且 v2 已挂载 | ✅ `projectors.ts` + `projectors-next.ts` 并存；`httpapi/api.ts:49` 确认 |
| `bun.lock` 未纳管 | ✅ `git ls-files bun.lock` 为空；`.gitignore:31` 确认 |
| 无 publish workflow | ✅ `ls .github/workflows/` = audit / test / typecheck |
| `packages/redcode` 死路径 | ✅ 6 处引用（含 `check-openapi-drift.ts:5` 的历史说明），`packages/redcode` 目录不存在 |
| LAN 默认密码静默注入 | ✅ 读 `network.ts:44-88` 全文确认，含 260824→260908 政策回退的原始注释 |
| `event` 表零索引 | ✅ 读 `sync/event.sql.ts:9-16`；`migration/` grep 0 命中；对照 `session.sql.ts:57-154` 有 10 个索引 |
| `compaction.ts` 三遍全量 + `.find` 点查 | ✅ 读 `:698-738` 原文确认 |
| `edit.ts` patch 双写 | ✅ 读 `:316-340`，`metadata` 同时含 `diff` 与 `filediff` |
| `reuse()` 注释声称已修但没修 | ✅ 读 `message-timeline.data.ts:126-155` 原文确认 |
| TUI 无节流 / web 有 | ✅ `PacedMarkdown` 只在 `packages/ui`；TUI `index.tsx` grep `throttle\|debounce` 0 命中 |
| 设置页 7 处硬编码英文 | ✅ 逐行确认 `:739/780/1042/1046/1050/1058/1103` |
| `usd` 造了未用 | ✅ `session-context-format.ts:8` |
| 真空 catch 27 处 | ⚠️ 主 agent 单行/多行口径 25–27，子审计 28，§2.5 的「87 处无处理无注释」口径更宽。**量级一致，取 §2.5 表述** |
| live DB 行尺寸数字 | ❗ 未能独立验证（工作区权限拦截读 `~/.local/share/redcode/redcode.db`，169MB）。本文所有行尺寸/缩放数字引自**本仓代码内注释的实测记录**（`message-v2.ts:1180`、`:1250`、`summary.ts:54-57`），非本次直接测量 |
| §4.6 无 reclaim、§4.7 启动 import | ❗ `inferred`（阅读所得，`bun build --metafile` 被拦） |

---

## 助手核验批注（Karina，260918）

本节只记录**落到代码上核验过**的差异，正文保持原样以便追溯原始审计意见。总判据：报告的**事实陈述多数成立**，但**判词（结论与修法）常过头**，照抄会误导修改方向。

### 已落地

| 项 | 结果 |
| --- | --- |
| §2.1 `util/process.ts` timeout 是死参数 | ✅ 已修 `73fdfeae`。单个 timer 拆成 `timeoutTimer` + `killTimer`，`timeout` 存在即无条件 arm 墙钟，仍走既有 abort→SIGTERM→宽限→SIGKILL 路径；**未加任何缺省值**（note `2026-08-21-subprocess-timeout-git.md:48` 否决过）。回归用例只给 timeout、不给 abort。**第 10 条后半的门检扩面仍未做** |
| §2.2 MCP 附件无闸门 | ✅ 已修 `210adf1d`。单条 5MB（对齐 `read.ts` 的 `MAX_PDF_BASE64_BYTES`——非图片不过缩放器，线必须画在源头）+ 总数 32 条，超限不报错、只在 output 说明。**该路径无测试接缝**（无 `test/session/tools.test.ts`，`read.ts` 同款闸门本身也无测试），边界记录在案 |

### 判词需作废（事实对、结论错）

1. **§2.2「`:289 content: result.content` 把含原始 base64 的响应整体塞进 output 落库」——不成立。** 两处消费者都不读 `content`：`processor.ts:381-390` 的 `toolResultOutput()` 只取 `{title, metadata, output, attachments}`，`message-v2.ts:728-762` 的 `toModelOutput()` 只读 `output.text` 与 `output.attachments`。它是死字段，既不落 part 也不进模型请求。真实缺口只有"非 image mime 绕过缩放分支"与"条数无上限"两条。
2. **§5.2「v1/v2 双 projector 写同一批表」——不成立。** 写的是不同表：旧 `MessageTable`/`PartTable` vs 新 `SessionMessageTable`，仅 `SessionTable` 有交集。这是并行版本债务，**不是**可以十行迁移的双写冲突，按原判词改会出事故。
3. **§2.3 第 3 条「`nothrow` 把 stderr 与 stdout 混成同一串正文」——不成立。** `util/process.ts` 的 `run()` 在 nothrow 下仍分开返回两者。真实缺陷是 slash 代码**只取 `.text`（stdout），忽略 exit code 与 stderr**。
4. **§2.4 表「`session/prompt.ts:224` 的 approval catch」——引用错位。** 实际在 `session/llm.ts:184-229`（catch 在 224-225）。关切成立，位置错。
5. **§3.1 Timeline「24%」——数字不成立。** 同一份报告所引源码注释写的是 3.96ms / 11%，自相矛盾，且无 benchmark 支撑。`reuse()` 的 2N 次 `key()` 是事实，但它正是复用旧数组所需的比较，**性能等级未经测量**，不宜按此优先级动手。
6. **§4.6「msgPin 无 per-session eviction」——已过时。** `session/prompt-caches.ts` + `util/session-evictor.ts` 已实现 TTL 1h / max 32 的会话级回收（`dropSession` / `touchSession`），源码注释显示该审计项此前已修。

### 范围调整（260918 定）

- **§4.4 compaction 三遍全量 + `.find` 点查：不投入。** 压缩路径绝大部分已由 DCP 插件接管，`session.messages()` 的重复调用在真实负载里占比可忽略。相应地 §7 第一梯队第 3 条撤下。
- **优化重心转向 DCP**（`E:\AI\RedCode-dcp`）——它才是压缩与上下文预算的实际执行者。
