# 上游改动采摘清单 · opencode 1.15.10 → 1.18.18

> **落地记录（2026-08-14）**：§8 的第一批 16 项与第二批全部条目已在本分支落地
> （提交 `d29e99f2..f0750b4e`，共 10 个 fix 提交），全仓 typecheck 12/12、相关单测全绿。
> **明确跳过**：§3A-A1 compaction 行为修复（常量/tail_turns/提示词重写）——用户指示排除；
> 其中 `prune` 默认值只改了说反的文档与 schema 描述，未碰行为。
> **待做**：§8 第三批（需决策/验证的条目）+ §3A-A5 远程 skill 缓存（对照重写量较大，归入第三批节奏）。
> 两处既有环境问题记录在案：`session-composer-state.test.ts` 在 HEAD 单跑即因 router client-only 报错；
> `test/tool/task.test.ts` 的 description 类用例超时 flake（主仓同现）。

> 产出日期：2026-08-14 ｜ 上游镜像：`D:\AI\opencode`（HEAD = `d8bf79225`，`packages/opencode/package.json` 版本 1.18.18）
> 比对基准：上游 tag `v1.15.10` 的文件树 vs RedCode `dev` HEAD（`d36b8f3`）的文件树，按 git blob SHA 逐文件比对
> 本文只做甄别，不含任何代码改动。

## 定位

RedCode 不是跟随式 fork，是走自己的路子。本文的目的**不是**评估"该不该跟上游"，而是回答一个具体问题：

> 在我们还与上游同源的那部分代码里，上游修掉了哪些我们身上也还带着的毛病？

因此全文按三类组织：

1. **§3A / §3B 能直接吃** —— 落点文件我们没动过（或动过但区域不重叠），上游的修复对我们同样成立。这是本文主体。§3A 是跨包交叉的（落在 `packages/opencode`），§3B 是 GUI 四包里的。
2. **§3C 我们自己的 bug** —— 这次逐条比对时顺手挖出来的，与上游无关。按你的定位，这几条优先级其实最高。
3. **§4 已核实不必做** —— 看着该做、实测我们已经好了，甚至照搬会把能用的路径拆掉。
4. **§5 代码不要、思路可借鉴** —— 我们自己重写过，但那套还没覆盖到上游发现的问题。只记问题和思路，不搬代码。
5. **§6 我们自己的地盘** —— 已经各走各路，上游怎么改都与我们无关。只划边界、不逐条评估，让下次筛选能自动跳过。

§1 是分叉地形（决定上面几类的划分依据），§2 是一条容易漏掉整类修复的筛选陷阱，§7 是下次怎么复用这套筛法，§8 是落地顺序。

---

## 0. 一句话结论

范围内触及 `packages/app|core|ui|web` 的 996 个提交，逐条读过 diff 并回到 RedCode 侧核对落点之后：

- **约 40 条能吃**（§3A/§3B），其中十几条是一到三行、风险接近零；
- **7 条是我们自己的 bug**（§3C），是这次比对顺手挖出来的，按你的定位这几条优先级其实**高于**任何上游同步；
- **7 条思路可借鉴但代码别搬**（§5）——我们那套没覆盖到的问题；
- **13 条看着该做、实测不必做**（§4），其中 5 条是上游在修它自己重构引入的回归，我们从没经历过那次重构；照搬其中两条反而会**拆掉我们能用的路径**。

其余九成落在我们已重写的区域或上游独有的架构上，§6 划了边界、§7 给了可复用的排除规则，下次不必再逐条看。§8 是按风险和成本排好的落地顺序。

按落点自动分档的原始分布（供理解筛选口径，不是结论）：

| 落点 | 提交数 | 其中 fix/perf |
|---|---:|---:|
| 我们没改过的文件 | 38 | 16 |
| 我们改过但改动 < 40 行 | 160 | 56 |
| 我们重写过的文件 | 522 | 146 |
| 我们根本没有的文件（上游新增架构） | 264 | 121 |
| 我们已删掉的文件 | 12 | 1 |

**这张表本身有一个陷阱**，见 §2 —— 只按这四个包筛，会漏掉一整类真正该吃的修复。

---

## 1. 分叉地形（实测数据，非估计）

### 1.1 四包文件级对照

| 状态 | 文件数 | 占比 |
|---|---:|---:|
| 与上游 1.15.10 完全一致 | 1789 | 65% |
| RedCode 改过 | 487 | 18% |
| RedCode 删除 | 563 | — |
| RedCode 新增 | 34 | — |

RedCode 删掉的 563 个文件里，`packages/web/src` 独占 525 个——文档站被大幅裁剪。

### 1.2 core 已经不是同一个 core

这是本次甄别里最重要的一条结构事实：

- RedCode 的 `packages/core/src` = **115 个文件**，顶层结构与上游 v1.15.10（113 个）**完全一致**。
- 上游 HEAD 的 `packages/core/src` = **322 个文件**。fork 之后上游把整个 v2 会话引擎搬进了 core：`src/session/**`、`src/tool/**`、`src/v1/**`、`src/database/**`、`src/control-plane/**`、`config.ts`、`ripgrep.ts`、`project.ts`、`git.ts`、`snapshot.ts` 全是新增。
- 佐证：`packages/core/src/session.ts` 在 RedCode 里只有 **11 行**（barrel 转发），在上游已长成会话引擎主体（范围内被 33 个提交改过）。

**推论**：上游标 `fix(core)` 的提交，凡落在这些新增区域的，对 RedCode 的 core 一律无关——RedCode 的会话引擎在 `packages/opencode`，是 v1 血统，与上游 v2 引擎不同源。

### 1.3 未来同步的痛点排行

按「RedCode 改动行数 × 上游在此范围内改动它的提交数」排序，热度越高说明每次同步越难：

| 文件 | RedCode 改动行 | 上游提交数 | 热度 |
|---|---:|---:|---:|
| `packages/app/src/pages/layout.tsx` | 1585 | 32 | 50720 |
| `packages/app/src/pages/home.tsx` | 662 | 75 | 49650 |
| `packages/app/src/components/titlebar.tsx` | 783 | 59 | 46197 |
| `packages/app/src/components/prompt-input.tsx` | 717 | 46 | 32982 |
| `packages/app/src/pages/session.tsx` | 444 | 70 | 31080 |
| `packages/app/src/components/settings-general.tsx` | 315 | 19 | 5985 |
| `packages/app/src/i18n/en.ts` | 121 | 38 | 4598 |
| `packages/core/package.json` | 51 | 88 | 4488 |
| `packages/app/src/pages/session/session-side-panel.tsx` | 236 | 18 | 4248 |

反过来，**同步最省力的区域**（RedCode 未改 + 上游高频改动）：

| 文件 | 上游提交数 |
|---|---:|
| `packages/core/src/plugin/provider/*.ts`（openai / google-vertex / bedrock / azure / github-copilot 等） | 5–10 各 |
| `packages/ui/src/v2/components/*`（button-v2 / dialog-v2 / icon-button-v2 / toast-v2） | 5–10 各 |
| `packages/core/src/permission.ts` | 14 |
| `packages/core/src/model.ts` | 9 |
| `packages/ui/src/components/scroll-view.tsx`、`tabs.css` | 6–7 |

RedCode 完整保留了上游的 v2 设计体系（`packages/ui/src/v2/**`）且未做改动，这一片是干净的可 cherry-pick 区。

### 1.4 上游做过的目录重构（影响可移植性）

`packages/app/src/pages/session/message-timeline.tsx` → `packages/app/src/pages/session/timeline/message-timeline.tsx`，并拆成 `timeline/{model,projection,rows,measure,virtual-items,row-reconciliation,summary-diffs,observe-element-offset}.ts` 等十余个模块。RedCode 仍是老的单文件形态，因此这次重构**之后**的所有时间线修复都无法直接落地。

---

## 2. 范围陷阱：`fix(core)` 有一半的身子在 `packages/opencode` 里

上游在 2026-06-03（#30473）把 v1 的 schema/config 提到了 `packages/core/src/v1/**`。此后**修 v1 行为的提交同时改 `core/src/v1/*` 和 `packages/opencode/src/*`** —— 只按四包筛选，会把这批整体误判成"无关"。

实测：被判为「无关」的 fix/perf 里，有 **21 条同时触及 `packages/opencode`**（14 条落在 RedCode 改过的文件上，7 条只碰测试）。这 21 条里藏着本次甄别中价值最高的几条修复，详见 §3。

顺带量了 `packages/opencode` 的分叉面（RedCode 同样持有这个包）：

| 状态 | 文件数 |
|---|---:|
| 与上游 1.15.10 一致 | 328 |
| RedCode 改过 | 629 |
| RedCode 删除 | 45 |
| RedCode 新增 | 130 |

分叉率 66%，远深于四包的 21%。上游在同一范围内另有 **657 个提交（268 个 fix）**触及该包——这是本次任务范围之外的第二条战线，建议单独立项。

> **关键判断**：文件整体分叉大 ≠ 修复难落。这批 fix 的实际 hunk 都极小（+24/-17、+15/-1、+12/-0、+1/-0），逐条手工移植成本很低，只是不能用 `git cherry-pick`。

---

## 3A. 能直接吃 · 跨包交叉（落点在 `packages/opencode`，已逐条在 RedCode 侧验证问题仍存在）

### A1 · `dab263721` compaction 对小模型不友好 — #42045, 2026-08-12

> `fix(compaction): adjust instructions and structure to be more clear to smaller models like dsv4 flash`

**症状**：压缩提示词绕、保留的近期上下文预算过小、`tail_turns` 默认只留 2 轮。上游明确是冲着 DeepSeek v4 Flash 这类小模型去的。

**RedCode 现状（已验证）**：
- `packages/opencode/src/session/compaction.ts:39-41` 三个常量 = 上游修复前原值（`DEFAULT_TAIL_TURNS = 2`、`MAX_PRESERVE_RECENT_TOKENS = 8_000`）
- `select()` 函数 L321-346 与上游修复前**逐行一致**
- `packages/opencode/src/agent/prompt/compaction.md` 与上游修复前的 `compaction.txt` **字节一致**（RedCode 只改了扩展名）

**可直接落的部分**：
1. `MAX_PRESERVE_RECENT_TOKENS` 8_000 → 15_000
2. 去掉 `DEFAULT_TAIL_TURNS`，`tail_turns` 未配置时不再截断到最近 2 轮
3. token 预估改懒算（成本随保留的尾部走，不再按整会话算）
4. 压缩提示词整篇重写

**不适用的部分**：上游那段把 conversation 塞进 prompt 模板的重构。RedCode 走的是另一条路——`compaction.ts:502` 用 `MessageV2.toModelMessagesEffect` 把历史作为**结构化 model messages** 传入，`L549` 的 user 消息只放提示词本身。这比上游修复前的文本大块拼接更好，上游要修的问题 RedCode 本来就没有。

### A2 · 上下文溢出识别表落后 8 条 — #35671 / #37840

> `adf178a6b9 fix(llm): classify zai token limit overflow`、`2a097f3af7 fix(llm): expand context overflow patterns`

**症状**：provider 返回的溢出报错文案不在识别表里时，RedCode 认不出这是"上下文超了"，于是不触发自动压缩，直接把原始 API 错误抛给用户。

**RedCode 现状（已验证）**：`packages/opencode/src/provider/error.ts:9-27` 的 `OVERFLOW_PATTERNS` 有 19 条，与上游 v1.15.10 一致。上游把这张表挪进 `packages/llm/src/provider-error.ts` 后扩到 31 条。RedCode 有 `packages/llm` 但没有 `provider-error.ts`，落点就是 RedCode 本地这张表。

缺的 8 条：

```
/request_too_large/i
/exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i
/tokens in request more than max tokens allowed/i
/exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i
/input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i
/prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i
/too many tokens/i
/token limit exceeded/i
```

**落地**：纯数据追加，零冲突。

### A3 · `e2527db3c` 内容过滤中止导致会话静默死掉 — #31745, 2026-06-11

> `fix(opencode): surface content-filter finish reason as visible error`

**症状**：provider 因内容过滤中止（如 Anthropic `stop_reason: refusal`）时，`finish === "content-filter"` 没被当成错误——**会话直接静默转 idle，用户既看不到输出也看不到报错**。

**RedCode 现状（已验证）**：`packages/opencode/src/session/prompt.ts` 里 grep 不到 `content-filter` / `ContentFilterError`，问题存在。

**落地**：上游 hunk 仅 +12/-0，在 `finished && !handle.message.error` 分支里插一段；需配套一个 `ContentFilterError` 错误类型。

> 与已知问题的关系：这与「思考链有内容但正文为空、会话静默结束」是同一类表现，值得一并排查——但根因不一定相同，不要直接当成同一个 bug 结案。

### A4 · `285d315b4` 子代理可无限嵌套 — #37124, 2026-07-15

> `fix(core): limit subagent nesting depth`

**症状**：子代理能继续调子代理，没有深度上限，递归失控时会烧掉大量 token。

**RedCode 现状（已验证）**：`packages/opencode/src/tool/task.ts` 里 grep 不到任何 `depth` / `subagent_depth` 逻辑，问题存在。

**落地**：上游 hunk +15/-1，沿 `parentID` 链上溯计数，超过 `cfg.subagent_depth ?? 1` 就报错。RedCode 的 task.ts 相对上游修复前 +223/-164，但这段是独立插入，冲突面小。需同时在配置 schema 加 `subagent_depth` 键。

### A5 · `971518c6d` 远程 skill 缓存永不更新 — #34059, 2026-06-26

> `fix(core): refresh cached remote skills`

**症状**：远程 skill 一旦缓存就再也不更新；下载中断时缓存目录会停在半损坏状态。

**RedCode 现状（已验证）**：`packages/opencode/src/skill/discovery.ts`（116 行）grep 不到 `version` / `staging` / `.opencode-version`，问题存在。

**落地**：上游 hunk +48/-11——索引加 `version` 字段，版本变化时下到临时目录、校验 `SKILL.md` 存在后原子 rename 替换，失败回滚。RedCode 该文件相对上游修复前 +86/-79，需对照重写而非直接打补丁。

### A6 · 行内数学公式误判（`$...$`）— 见 §3B 的 ui 段

这条我最初按"RedCode 也用 marked"写过一版判断，后来核实我们已整体换成 `markdown-it`，**修法完全不同**（不是移植上游的 marked 扩展，而是删掉我们自己那段 `$...$` 正则）。完整结论见 §3B 的 packages/ui 小节末尾。同批的 `9a51765bd`（波浪号代码片段）经核实**不适用**，已撤回。

### A7 · `254a481e5` 配置目录不存在时写 .gitignore 失败 — #35632, 2026-07-06（低优先）

**RedCode 现状（已验证）**：`packages/opencode/src/config/config.ts:525-529` 的 `ensureGitignore` 确实没先 `ensureDir`，问题存在。补一行 `yield* fs.ensureDir(dir)` 即可。触发条件很窄。

---

## 3B. 能直接吃 · GUI 四包（逐条已回到 RedCode 侧核对落点）

### packages/app —— 落点与我们同源、可直接落

按性价比排序。「落点」列写的是 RedCode 侧的确切位置。

| # | 上游提交 | 症状（用户看得到的） | 落点与改动量 |
|---|---|---|---|
| 1 | `237e694df` fix(app): expand Windows file tree folders (#39249) | **Windows 专属**：从搜索/跳转打开文件时，文件树不自动展开所在目录——目录 key 带反斜杠（`frontend\src`）而树里存的是 `frontend/src`，比对不上 | `context/file/path.ts` 的 `normalizeDir` 是逐字 pre-image，纯函数 7 行。`path.test.ts` 不要整文件覆盖（我们自己加过一个混合分隔符用例），把上游 4 个新 test 追加进去 |
| 2 | `09afffeea` fix(app): preserve shadowed command owners (#39044) | 两个组件用同一 key 注册命令时，后注册的会把先注册的**从数组里删掉**；等后者卸载（关掉对话框/面板），先注册那份再也回不来——表现为某些快捷键和命令面板条目在某次交互后静默失效，直到刷新 | `context/command.tsx` 完全是 pre-image：`upsertCommandRegistration` 在 L105、遍历在 L261、注册处在 L399。函数改名后 `command.test.ts` 的 import 会断，需一并换上游新版测试 |
| 3 | `db4dbaa28` fix(app): prevent stale session tab reads (#39767) | 非 keyed 的 `<Show>` 只在真假翻转时重建子树，而 `<Portal mount={…}>` 的 mount 只在创建时读一次——挂载点元素被替换（布局重挂/路由切换）后 Portal 仍往已脱离文档的旧节点渲染，**会话顶栏的搜索按钮和右侧控件区整块消失** | `components/session/session-header.tsx` 的 L280/282/299/302/310/312 六处改动行逐字存在。只落这一份，commit 里另两个文件我们没有。文件 churn 33，手改 6 行比 cherry-pick 快 |
| 4 | `3016830e2` fix(app): search every known project in the open project dialog (#40202) | "打开项目"对话框的最近项目被硬砍到 5 条，**而且是在搜索之前砍的**——输入一个排在第 6 名之后的项目名，明明在册却搜不出来。项目一多必踩 | `dialog-select-directory.tsx:304` 的 `.slice(0,5)` 和 L318 都是逐字 pre-image。把 slice 从 memo 挪到 `items()` 且只在搜索词为空时生效。注意别误删 L304 附近我们自己的 260707 peek 注释块 |
| 5 | `e34822db6` fix(desktop): preserve selected model during session promotion (#34466) | 草稿里选好模型后，若新会话落到另一个目录/worktree，promote 的一瞬间 scope 既读不到 draft 也读不到 handoff，**模型被打回默认值** | `context/local.tsx` 四个 hunk 都对得上（L80 区、L127-129、L133-147、L386-402）。我们的 `handoffKey` 签名是 `(dir, session)` 而上游多一个 scope 参数，且我们用 `sdk.directory` 不是 `sdk().directory`，三处照我们现有写法改 |
| 6 | `a19b52e85` fix(app): omit empty prompt text parts (#37577) | 只拖附件/图片、正文为空就发送时，请求里带一个空 text part——模型侧看到空文本块，消息气泡也渲染出一条空行 | `prompt-input/build-request-parts.ts` 开头逐字一致，改动是一个三元，3 行。落完顺手在 `build-request-parts.test.ts` 加个空文本用例 |
| 7 | `9ae4a5139` fix(app): expand terminal resize gutter hitbox (#32169) | 终端面板顶边的拖拽把手被父容器 `overflow-hidden` 裁掉，鼠标必须精确压在 1px 边线上才拖得动 | `pages/session/terminal-panel.tsx` 结构与 pre-image 一致，把手上移到外层、`overflow-hidden` 下移到内层。**必须删掉上游新增的 `useSettings` import 和 `newLayoutDesigns` 判断**——我们没有这个设置项 |
| 8 | `43e472bba` 的 pty 片段 feat(app): sync embedded terminal theme (#37931) | Windows 上用系统自带 ConPTY，Win10 老版本有换行/重绘/resize 缺陷 | 一行：`packages/opencode/src/pty/pty.node.ts` 加 `...(process.platform === "win32" ? { useConptyDll: true } : {})`。已实测我们装的 `@lydell/node-pty@1.2.0-beta.10` 的 d.ts 有该选项、`prebuilds/win32-x64/conpty/{conpty.dll,OpenConsole.exe}` 随包发出。**本机是 Win10 Pro 19045，内置 ConPTY 正是老版本** |
| 9 | `d46c02ba7` feat(desktop): papercut fixes (#34939) | 输入框失焦再回来光标跳位——`restoreFocus()` 读的是异步落库的 `prompt.cursor()`，失焦瞬间的真实光标位置没人存 | 3 行。`prompt-input.tsx:546`(restoreFocus)/`:573`(handleBlur) 与 pre-image 逐字相同（只多一行 `clearGhost()`），`currentCursor()` 现成。**该文件 churn 717 但这块区域零重叠** |
| 10 | `ea982c383` fix(app): wrap session creation state updates in startTransition (#36182) | 从首页发出第一条消息、会话刚创建的那一瞬间，promote + handoff + navigate 同步连打，界面明显卡一下 | `prompt-input/submit.ts:395-402` 是上游同一块的子集。上游 hunk 里 `tabs.promoteDraft(...)` 和 `submission.retarget(...)` 两行要删（我们都没有），`navigate` 从 else 分支提回无条件调用 |
| 11 | `d3f30df18` fix(app): open legacy picker at home (#39804) | 服务端只报了 directory 没报 home 时，"打开项目"对话框不去补拉 home，起始位置落在项目目录、路径也不显示成 `~/…` | 两行。`dialog-select-directory.tsx:258-260` 逐字 pre-image |
| 12 | `45badf716` fix(app): suspend hidden terminal renderer (#33990) | 终端面板收起后渲染器仍挂着，隐藏状态下继续吃 CPU、窗口尺寸变化时被重排 | 一行。`terminal-panel.tsx:289` 改成 `when={opened() && terminal.active()}`，`opened()` 同文件 L105 已在用 |
| 13 | `2ec20e576` fix(app): slow tooltip display for models (#30745) | 模型列表悬停要等默认延迟才出信息 tooltip，翻列表手感迟钝 | 一行。`dialog-select-model.tsx` 的 Tooltip 块逐字一致，`ui/src/components/tooltip.tsx` 用 `{...others}` 透传，`openDelay` 会生效 |
| 14 | `33762292f` fix(app): wrap model.set in startTransition (#34351) | 切模型/变体时同步写 store 触发大范围重渲染，界面顿一下 | `context/local.tsx:307` 起两块是逐字 pre-image。只落 local.tsx，commit 里的 tabs.tsx hunk 丢弃 |
| 15 | `4f88cab20` fix(app): suspend while recent models load (#33921) | 模型选择器首次打开时"最近使用"是空的，localStorage 水合完才突然刷出来，闪一下 | 9 行。`context/models.tsx` 就是 pre-image，`persisted()` 的 ready 带 `.promise`，依赖齐全。补 `createResource` import |
| 16 | `17166b271` fix(app): simplify question prompt (#33968) | 只有一个问题时也渲染一条"1/1"进度分段条；问题正文不能选中复制 | `session-question-dock.tsx` 的 `total()` 在 L66、`question-progress` 块在 L431，位置一致。CSS 半边上游在 `packages/session-ui/`，**我们对应的是 `packages/ui/src/components/message-part.css:943-950`，内容逐字相同，换路径即可** |
| 17 | `49707c211` fix(app): deduplicate and merge server connections (#29313) | 同一服务器同时来自"已存列表"和"URL 注入"时两条互相顶掉，`displayName`/`username`/`authToken` 只能活一个——表现为自定义显示名突然变回裸 URL | `resolveServerList` 与 v1.15.10 逐字一致、25 行自包含。**不能直接 cherry-pick**（上游 pre-image 是 props-first，我们是 stored-first），整段函数体照抄新版即可——新版的 `{...existing, ...conn}` 恰好保留我们 stored 优先的意图 |
| 18 | `077deb9d8` fix(app): bump ghostty-web to prevent terminal resize hangs (#34020) | 拖动终端尺寸时偶发卡死 | `packages/app/package.json:70` 正是 `"ghostty-web": "github:anomalyco/ghostty-web#main"`，漂浮依赖。**先看 lockfile 当前解析到哪个 commit**：若已比上游钉的那个新，钉死就是回退 |

### packages/app（续）—— 落在我们改过的文件里，但改动区不重叠

这几条的落点文件 churn 很高，但上游要改的那几行在我们这边**逐字未动**，所以照样能落，只是手改比 cherry-pick 快。

| # | 上游提交 | 症状 | 落点与改动量 |
|---|---|---|---|
| 29 | `f8c9bfd45` fix(app): mount shortcuts per titlebar tab (#33567) | 见 §3C-L1——这条上游修的正是我们身上那个 bug | 一行。见 §3C |
| 30 | `f62ba5eb8` 的后半 fix(app): hide unavailable titlebar update (#30642) | 见 §3C-L2 | 一行。前半（无更新时不渲染按钮）我们已经有了 |
| 31 | `449c64928` 的 event-reducer 那段 fix(app): 78x faster Home cold loading (#36214) | **真崩溃**：归档事件命中不到本地会话列表时，`store.session[result.index]!.time.archived` 对 `undefined` 取属性抛 TypeError，抛在 SSE 事件流里 | 我实读 `global-sync/event-reducer.ts:176-178` 确认：解引用写在 `if (result.found)` **之前**。`Binary.search` 未命中时返回插入位，可能等于数组长度。**两行调序**：把 `if (!result.found) break` 提到解引用之前。<br>注：该提交的性能主体不用管——我们 260706 已独立做过且更激进（四个 query 都按当前项目 gate，上游只 gate 了一个且是"激活一次后永久开启"） |
| 32 | `2039c90c0` 的 desktop 那 20 行 fix(desktop): open external links in system browser (#39820) | **既是 UX 缺陷也是导航安全缺口**：点消息里的链接会弹一个没有地址栏的裸 Electron 窗口，而不是走系统浏览器 | 我完整验过这条链路：`ui/src/context/marked.tsx:535-536` 给每个 markdown 链接强制 `target="_blank"` + `rel="noopener noreferrer"`，而 `packages/desktop/src/main/` 全目录**没有 `setWindowOpenHandler` 也没有 `will-navigate`**（只有 `ipc.ts` 的 `open-link` 通道）。Electron 默认行为就是新开 BrowserWindow。<br>只取 desktop 侧：新建 `external-url.ts`（`resolveExternalURL` 只放行 http/https/mailto，`resolveLocalFilePath` 只放行无 host 的 file:）+ `wireNavigationPolicy(win)`（`setWindowOpenHandler` 一律 deny 并转 `shell.openExternal`，`will-navigate` 非本应用 URL 一律 preventDefault）。约 40 行，不碰 app 层。<br>**上游 app 侧那一大片改名（`openLink`→`openExternal`、`Link`→`ExternalLink`、删 `utils/notification-click.ts`）不要跟** |
| 33 | `28bcc0e4f` fix(app): sort sessions by persisted time (#41000) | 会话列表自己在跳：1 分钟内活动过的会话被单独归一档、按 id **升序**（最老在前）顶到列表顶部，过了 1 分钟又整批重排 | `pages/layout/helpers.ts:10-22` 的 `sortSessions(now)` 与上游修复前**逐字节相同**。换成 `compareSessionTime`（先按 `updated ?? created` 降序，相等按 id 升序），`now` 参数保留成 `_now` 不改签名。现有 `helpers.test.ts` 的两个用例传的 now 是 120_000、数据时间戳是 1/2/10，全落在非最近分支，改完不会红 |
| 34 | `65fd2e5c9` fix(app): prioritize shortcuts in terminal (#35668) | 焦点在终端里时应用级快捷键被 xterm 吃掉，按了没反应 | **`context/command.tsx` 与上游 v1.15.10 逐字节相同，只差两行 `@opencode-ai/ui` → `@redcode-ai/ui` 的 import 改名**。改动：keydown 监听改 `{capture:true}`、触发时补 `stopPropagation()`、keymap 从 `Map<string, CommandOption>` 改成 `Map<string, CommandOption[]>` 并加 `when(event)` 谓词。第二半（`terminal.close` / mod+w）也能落——我们已有 `terminal.close(id)` API 和 `terminal.close` 文案键 |
| 35 | `7ea343cab` fix(app): prevent file tree tab clipping (#39770) | 文件树面板在默认宽度下标签条被裁掉一截 | **我们默认就是坏的**：`context/layout.tsx:18` 的 `DEFAULT_FILE_TREE_WIDTH = 200` 正好压在裁切线上。落点换文件——上游改 `session-side-panel.tsx`，我们对应逻辑在自有的 `pages/session/file-tree-panel.tsx:169-173`。常量提到 240 + 渲染期钳制 `Math.max(240, width)`（不覆写已持久化的值）。注：200 是我们自己定的，抬到 240 属产品决定 |
| 36 | `bdfea046d` fix(desktop): recognize normal auth metadata input prompts (#33024) | 类型为 api-key 但同时声明了 prompts（额外 metadata，如 base_url / region / 部署名）的 provider，连接对话框**永远不弹这些输入框**——上游只在 oauth 分支走 prompts，api 分支直接跳过，字段静默丢失 | `dialog-connect-provider.tsx` churn 6.9%，仍是修复前形态。27/4 行自包含。**对我们尤其相关**——国内 provider（sensenova / deepseek / step 等自定义端点）正是最容易需要 api-key + 额外 metadata 组合的一类 |
| 37 | `3aa286005` fix(app): restore prompt cursor on focus (#34175) | 光标离开输入框再点回来，插入点跳到开头/乱位 | `prompt-input.tsx:1554-1573`。加 `restoreEndOnFocus` 一次性标志 + `handleFocus` 里 rAF 内 `setCursorPosition(...)`，挂 `onFocus`。三个 API（editor-dom.ts / history.ts）都现成，约 15 行。<br>**与 `d46c02ba7`（§3B #9）和 `a625d35f7` 功能重叠，三条只做一条**——这条最通用（覆盖鼠标点击聚焦） |
| 38 | `c35267776` 的 session-review.tsx 半边 fix(app,ui): session review reactivity (#30660) | 评审面板不跟随实时改动——`<For each={items()}>` 每次 diff 变化整行重建，行闭包捕获的是旧 diff 对象 | `ui/src/components/session-review.tsx` churn 仅 1%，几乎原版可直接照搬（改成 `itemsMap` + `<For each={files()}>` + `diff()` 访问器）。**⚠️ 上游这次顺手带进了一行 `console.log({ file })`，移植时必须删掉**。`session.tsx` 那半边（删 `staleTime: Infinity`）与我们自己的 `refreshVcs` debounce 重叠，建议先只做 session-review.tsx |
| 39 | `d13779b1d` 的三处 fix(app): preserve todo dock across sessions (#33778) | 切会话时 todo dock 的开合/动画状态跟着旧会话走——新会话没 todo 却挂着展开的 dock；dock 高度用 `getBoundingClientRect` 测折叠中的元素，测出来是错的，展开动画从错误高度弹起 | 落点 churn 都低：`session-composer-state.ts` 4.9%、`session-todo-dock.tsx` 14.2%、`ui/motion-spring.tsx` **未改动**。给 composer state 加 `sessionID` 守卫 + 高度改 `Math.max(height, el.scrollHeight)` + useSpring 加 `snapKey`。上游同 commit 的 composer-region 大重构整块跳过 |
| 40 | `b1a6c40ad` 的 UI 半边 fix: speed up fff file search (#31366) | 文件搜索双重过滤——后端已按查询排过序，前端 `useFilteredList` 又拿 fuzzysort 筛一遍，**会把后端已判为命中的结果丢掉**（表现为"明明有这个文件，@ 提及里搜不到"） | `ui/src/hooks/use-filtered-list.tsx` 我们**完全未改动**，加一个 `skipFilter` 分流即可；三个调用点各加一行。<br>⚠️ 两个 agent 对这条判断不一：一个认为我们的 `file.searchFiles(query)` 就是服务端带 query 搜索、同属双重过滤；另一个认为我们没有 fff、"服务端已排序"前提未必成立。**落手前先确认我们的文件搜索到底有没有服务端排序** |
| 41 | `003c22b4a` 的第一步 fix(desktop): context menu button / tab intermittent issue (#34420) | 上下文用量按钮被 `<Tooltip>` 包住整个 `<Switch>`，Tooltip 的 ref 锚定跟着 Switch 分支切换而失效，**按钮间歇性点不动** | `session-context-usage.tsx` 完全是修复前形态。第一步只把 Tooltip 挪进每个 `<Match>` 内部——纯结构调整、无依赖。第二步（给 layout 的 reviewPanel 加 `source` 追踪，解决"点一次强开面板、再点只关标签不关面板"）要动公共 API，可之后再评估 |
| 42 | `e04c5e72f` 的 `createPromptReady` fix(app): prompt persistence and draft sessions (#33528) | 见 §3C-L3 | `prompt.tsx` churn 仅 1.9%，约 15 行。上游同 commit 的 draft/tabs 部分整块丢弃 |

### packages/ui —— 这批性价比最高，而且大多能干净落

**先记四条前提，它们决定了这一片哪些能吃哪些不能：**

1. **我们桌面端只真正渲染 5 个 v2 组件**：`IconV2`、`icon-button-v2`、`avatar-v2`、`button-v2`、`wordmark-v2`。其余 22 个 v2 组件（select / toast / tooltip / dialog / menu / tabs / switch / checkbox / …）**只出现在 Storybook**。所以上游那一大批 v2 组件 CSS 打磨对我们零可见收益——但落在这 5 个上的就是真的。
2. **我们已经把 `marked` 整体换成了 `markdown-it` 14.3.0**（`marked.tsx:2` 就是 `import MarkdownIt`，`ui/package.json` 里 marked 三件套已删）。理由记在提交注释里："marked 对长文本 O(n²)，50KB 纯文本 587ms → 1.2ms"。**上游所有 marked 相关修复一律不适用。**
3. **`@pierre/diffs` 版本卡死**：我们 `1.1.0-beta.18`，上游 HEAD 已到 `1.2.10`。凡依赖新 pierre API（`areFilesEqual` / `areOptionsEqual` / `enableGutterUtility`）的都被挡住。
4. 我们的 `6cf8a1af`（v2 组件 CSS 补齐 262 处 `--v2-` token 前缀）与上游 `8aff7b8c7` 是**同一件事、我们做得更全**（22 个文件 vs 上游 16 个，还加了 `token-refs.test` 钉死）。divergence.csv 里那一整片"v2 CSS 改动"就是这个，不是自有设计。

| # | 上游提交 | 症状 | 落点 |
|---|---|---|---|
| 19 | `3a90639cb` fix(ui): correct OC-2 weak icon color (#41504) | **改一个字符，修的是默认主题**：`oc-2` 亮色下 `icon-weak-base` 写成 `"C7C7C7"` 少了 `#`，是非法颜色值，弱化图标（次级图标）颜色解析失败、回落到继承色 | 我实测：`ui/src/theme/themes/oc-2.json:26` 就是这个错值，而且是**整份文件里唯一一个缺 `#` 的**；`theme/context.tsx` 里 `oc-1` 也映射到 `oc-2`。1 个字符 |
| 20 | `707166ae4` fix(ui): render whole-file patches as complete diffs (#30516) | 工具产生的整文件补丁（snapshot / VCS 全上下文 patch）被当成"局部补丁"渲染，diff 视图只显示片段而不是完整文件 | `git apply --check` 对我们的 `session-diff.ts` **干净通过**——因为那个文件恰好就是这条提交的父版本。唯一手工活是测试：我们的 `session-diff.test.ts` 还停在 v1.15.10，上游的测试补丁打不上 |
| 21 | `fced9c5a2` 的 `components/tooltip.tsx` 两行 | **v1 Tooltip 没有打开延迟，鼠标扫过工具栏时提示框一路乱闪** | 加 `openDelay: 400` / `skipDelayDuration: 300`，实测干净应用。v1 Tooltip 在 debug-bar / dialog-select-model / prompt-input 等六七处在用，**本批体感提升最直接的一条**。<br>（注：另一条关于 `TooltipV2` 的 `openDelay={0}` 我先前也验过属实，但 TooltipV2 我们不渲染，优先级低；`tooltip-v2.css` 缺 `prefers-reduced-motion` 同理） |
| 22 | `c35267776` **＋** `5426478e4`（必须成对） | 前者：review 面板里文件 diff 数据更新后 UI 不刷新（`<For>` 按对象身份而非文件名做 key）。后者：**删掉前者留下的一行 `console.log({ file })`**——不然每次渲染 review 列表都往控制台刷文件名 | 两条成链实测干净应用。**别只拿第一条** |
| 23 | `e3a55db5b` 的 `ui/src/context/dialog.tsx` | **对话框不能叠加**——在一个对话框里再开一个，父对话框被直接 dispose，返回时上一层没了 | 该文件我们零改动，实测干净应用；改成 stack + 每层 z-index。我们有十几个 `dialog-*` 组件都吃这个 context |
| 24 | `3cf71808c` 的 `scroll-view.tsx` | 键盘滚动三个真实缺陷：空格 / Shift+空格不能翻页；焦点在按钮或链接上时 PageUp/PageDown 被外层容器抢走；嵌套滚动容器里内层滚不动时不会把滚动交回外层（表现为"按了没反应"） | 我们该文件与 v1.15.10 逐字符一致。直接 apply 会失败（上游中间有次拖拽重构不在名单内），要手抄约 30 行：4 个纯函数（`canScrollKey` / `scrollKeyOwner` / `isScrollKeyTarget` + `scrollKey` 的空格分支）+ onKeyDown 里 2 行守卫 + viewport 上 1 个 `data-scrollable`。无外部依赖 |
| 25 | `1bcb9d7cb` 的 `scroll-view.css` + `dialog.css` | ScrollView 用 `height:100%` 撑高度，在 flex 父容器里不收缩 → 内容溢出 / 滚动条位置错；x-large 对话框高度顶到屏幕边缘 | 改成 flex column + `min-height:0`，实测干净应用。**ScrollView 是我们用得最多的 v1 组件**。同提交的 v2 CSS / oc-2.json / theme mapping 部分全部不要 |
| 26 | 从 `3b811bd01` 拆出：scroll-view 拇指拖拽 + pointercancel | 拖自定义滚动条时按下瞬间视图跳一下（旧算法用 `startY`/`startScrollTop` 增量推算，忽略抓取点在拇指内的偏移）；且只监听 `pointerup`，触发 `pointercancel`（触控板手势中断、窗口失焦）时 `isDragging` 永久卡 true、`pointermove` 监听器泄漏 | 我实测该文件与上游 v1.15.10 **完全一致**（diff 无输出），L106-138 仍是旧版。上游新增纯函数 `scrollTopFromThumbPointer` 连测试一起拿，零冲突。**与 #24 同文件，建议一起做** |
| 27 | `5a55135d8` + `ae7d63272` + `003c22b4a`（打包做，合计不到 15 行） | ① 下拉选项 hover 高亮有 0.2s 过渡，快速划过时反馈明显滞后、感觉"粘"；② `ButtonV2` 的 `line-height:1` 把 g/j/p/y 的下伸尾巴裁掉；③ 环形进度条底色写死在组件里，放不同底色面板上时环的背景对不上、看起来像"缺一块" | 三条全部实测干净应用。①落 `components/select.css`（v1 Select 在 settings-general / prompt-input / session.tsx 都在用）；②落 `button-v2.css`（ButtonV2 是我们真渲染的 5 个之一）；③落 `progress-circle.{tsx,css}`（`session-context-usage.tsx` 在用） |
| 28 | `52eae83ae` + `c76938077` 合并成一次改动 | 带下拉的按钮在下拉**展开**时仍显示 hover 底色，展开态与悬停态视觉不分——下拉开着的时候按钮看起来"没被按住" | ⚠️ 上游在这个选择器上来回改了三次（`52eae83ae` 加 → `1bcb9d7cb` 撤 → `c76938077` 再加）。**别按提交序列逐条 cherry-pick**，直接照 `c76938077` 的最终形态一次改到位 |
| 29 | `9535a8f92` fix(ui): update OpenRouter logo (#40313) | OpenRouter 图标还是旧的多路径线条版，与官方新 logo 不一致 | 只改 `assets/icons/provider/openrouter.svg` + `provider-icons/sprite.svg`，实测干净应用 |
| 30 | `d13779b1d` 的 `motion-spring.tsx` 半边 | 切会话时 todo dock 从上一个会话的高度"动画滑"到新会话的高度，视觉上像 dock 在乱跳 | 加一个 `snapKey` 参数，跨状态边界直接 jump 不做动画；`createEffect` → `createComputed` 顺带修了一帧延迟。实测干净应用，`useSpring` 在 prompt-input / session-composer-region / session-todo-dock 三处在用。**与 §3B #39 是同一条提交的两半，一起做** |

**⚠️ 这里要纠正我前面的两处判断**（读上游 subject 得出的，读完我们自己的代码才发现错了）：

- `5fecf7ae9`（行内 LaTeX `$...$` 误判）：**bug 确实在**——我们 `marked.tsx:408` 还留着 `/(?<!\$)\$(?!\$)…/g`，聊天里出现 `$VAR`、`$5 到 $10`、shell 片段会被 KaTeX 吃掉渲染成乱码。但**修法不是搬上游的 marked 扩展**（我们已换 markdown-it，且自己另加了 `\(...\)` 和 `\[...\]` 的后处理）。实际动作只有一个：**删掉我们那段 `$...$` 正则，约 14 行**。
- `9a51765bd`（紧邻波浪号的代码片段被破坏）：**不适用，撤回**。这是 marked 的缺陷（markedjs/marked#4011），我们用的 markdown-it 是 CommonMark 合规的，没有这个问题。我先前依据"我们没有 `marked-code-span.ts`"判它适用，那个依据本身是对的但推论错了。

| # | 上游提交 | 症状 | 落点 |
|---|---|---|---|
| 31 | `fa9ba2938` feat(desktop): make error view draggable (#34627) | 崩到错误页时整个窗口没有任何拖拽区域（错误页不渲染 titlebar），既不能移动窗口也不能拖到另一块屏幕，只能强杀进程 | 一行：`pages/error.tsx` 根 div 加 `data-tauri-drag-region`。我实测 `index.css:74-81` 已把该属性映射成 `-webkit-app-region: drag`（Electron 也吃），error.tsx 根 div 与上游逐字一致 |

### packages/web —— 文档站，代码侧几乎零分叉

我们删掉的 528 个 web 文件里 **527 个是 content/**（15 语种 mdx），**代码只删了 1 个**：`src/components/LanguageSelect.astro`。构建/组件/页面全留，`Share.tsx` churn 仅 1.7%、`middleware.ts` 0%。所以上游 web 的代码类改动基本都吃得下。

| # | 上游提交 | 症状 | 落点 |
|---|---|---|---|
| 24 | `bd84c3286` fix(web): persist docs language selection (#32551) | **这是我们自己裁剪时误伤造成的，现在就坏着**：文档站切语言不被记住 | 我复核过整条链路：`middleware.ts` 读 `oc_locale` cookie（L44-45、L89），但全仓写这个 cookie 的只剩 `packages/app/src/context/language.tsx:18`（桌面应用，不同源）；web 侧唯一的写入者 `LanguageSelect.astro` 正是我们删掉的那个代码文件，`Footer.astro:3` 现在 import 官方 starlight 版（不写 cookie）。middleware 另一条写 cookie 的 `docsAlias` 路径只在别名 URL 触发，下拉框跳的是规范路径 → `next === pathname` 直接 return。**cookie 永远写不进去。** 落地=新增 1 文件 + `astro.config.mjs` 的 `components:` 块加 1 行 + Footer 改 1 行 import；组件内 `Object.keys(config.locales)` 动态读取，自动适配 3 语种 |
| 25 | `20750c332` fix(web): order shared messages by creation time (#40995) | 分享页 `/s/[id]` 的消息不按时间排序，对话错乱 | 纯 drop-in。`Share.tsx` 与上游 HEAD 全文只差 3 处（2 处品牌改名 + 这个没打的补丁），现状 `toSorted((a,b) => a.id?.localeCompare(b.id))`，改成 `a.time.created - b.time.created \|\| a.id.localeCompare(b.id)`。**触发条件是导入/迁移进来的消息 ID 不单调**——自生 ID 排序没问题，但分享页正是最易遇到导入消息的场景 |
| 26 | `9251e5d8c` docs: correct compaction prune default (#30670) | 文档和 JSON schema 都说 `compaction.prune` 默认 `true`，**实际是 false** | 我复核过：`compaction.ts:376` 是 `if (!cfg.compaction?.prune) return {tokens:0,parts:0}`（未设置即关闭）；`config.ts:282` 描述写 `"(default: true)"`；`config.mdx:709/:716` 同样写 true。**schema 描述会出现在编辑 redcode.jsonc 时的编辑器提示里**，直接误导对 token 消耗的判断。改 3 份 mdx + 1 行 schema |
| 27 | `92f1a17b6` + `7e7ad3773` 两条"有功能没文档" | provider 的 `whitelist`/`blacklist` 过滤、本地 MCP 的 `cwd` —— 我们都实现了，文档一个字没写 | `config/provider.ts:81-82` 有 whitelist/blacklist，三份 `providers.mdx` grep 零命中；`config/mcp.ts` 有 cwd 且描述比上游详细（支持 `~/` 展开），三份 `mcp-servers.mdx` grep 零命中。**cwd 那条应照抄我们自己的 schema 描述，不要用上游的** |
| 28 | `86dc66eae` + `959c8bd49` 两条琐碎但照抄即错 | ① `custom-tools.mdx` 的入门示例返回 `number`，而 `plugin/src/tool.ts` 的契约是 `ToolResult = string \| {output:string,…}`，照抄即 TS 报错；② 三份 `providers.mdx` 各有 2 处 `"My AI ProviderDisplay Name"` 粘连 | 合计不到 10 行。考虑到在 `~/.redcode/tool/*.ts` 里写原生工具是常规用法，①最容易被踩 |

---

## 3C. 顺手挖到的 RedCode 自身缺陷（与上游无关，但都是这次逐条比对时暴露出来的）

这一节不是"同步项"，是我们自己代码里的问题。按你"走自己的路子"的定位，这些的优先级其实高于任何上游同步。**下面每一条我都亲自 grep 或读过源码确认过。**

| # | 位置 | 问题 | 证据 | 修法 |
|---|---|---|---|---|
| L1 | `components/titlebar.tsx:424` | **`mod+1`..`mod+9` 切标签的可用性判据写错了对象**——用的是"项目数量"，而 `onSelect` 里取的是 `tabsStore[i]`（标签数组）。开着 1 个项目但有 5 个会话标签时，`mod+2`..`mod+5` 全部失效 | 实读该文件：`disabled: layout.projects.list().length <= i`，紧接着的 `onSelect` 是 `const tab = tabsStore[i]` | 一行：`layout.projects.list().length` → `tabsStore.length` |
| L2 | `pages/layout.tsx` `installUpdate` | **点了"安装更新"后按钮可能永久转圈**——`updateAndRestart()` 正常 resolve 但进程没退出时，`installing` 状态永远不清（只有 `.catch` 分支会清） | 实读：`setUpdate("installing", true); void platform.updateAndRestart().catch(() => setUpdate("installing", false))`，无 `.finally` | 一行：补 `.finally(() => setUpdate("installing", false))` |
| L3 | `context/prompt.tsx:281` | **"等草稿水合完再渲染 composer"这个门禁是空操作**。`ready` 来自 `persisted()` 的第四个返回值（L168），对外暴露成 `ready: () => session().ready` —— 调用 `prompt.ready()` 拿到的是 ready **函数对象本身**，恒为 truthy | 同一个仓里两种用法自相矛盾：`prompt-input.tsx:1308` 写的是 `prompt.ready().promise`（当对象用，对的）；而 `session-composer-region.tsx:83`、`:192` 和 `session.tsx:104` 写的是 `if (!prompt.ready()) return` / `<Show when={prompt.ready()}>`（当 boolean 用，永远为真） | 参考上游 `e04c5e72f` 的 `createPromptReady()`：做成"可调用返回 boolean、同时带 `.promise`"的对象，两种调用点就都对了 |
| L4 | `context/settings.tsx` + `components/settings-general.tsx` | **`showFileTree` 这个设置项完全空转**——有开关 UI、有三语 i18n、有读写实现，但全 app 没有任何消费方，打开关闭对界面毫无影响 | `grep -rn showFileTree packages/app/src` 只命中 settings-general.tsx（UI）、settings.tsx（存取）、i18n 三份。零消费点 | 要么接上 `file-tree-panel.tsx` / `session-side-panel.tsx` 的显示逻辑，要么把这个开关删掉。别留着骗自己 |
| L5 | `components/dialog-select-mcp.tsx:44,46`、`components/status-popover-body.tsx:158` | **MCP 开关点完后状态可能不刷新**。这三处用 `queryOptions.mcp(sync.directory as PathKey)` 去 refetch，而 `sync.directory` 是原始目录串、没归一化；写入侧 `server-sync.tsx:168` 用的是 `directoryKey(active)`（= `pathKey`，Windows 下会把 `\` 转成 `/`）。**两边 queryKey 对不上，refetch 打空** | `pathKey` 实现在 `utils/path-key.ts`：`isWindowsPath` 时 `replaceAll("\\","/")`。`global-sync/utils.ts:3` 确认 `directoryKey` 就是 `pathKey` 的再导出。三处 `as PathKey` 是**强制类型断言，绕过了 PathKey 这个 brand 的全部保护** | 三处换成 `pathKey(sync.directory)`。**注意**：代码层面的不一致是确定的，但是否真的复现取决于运行时 `sdk.directory` 拿到的是不是反斜杠形态——落手前在 GUI 里开一个 MCP 开关，看 devtools 里那个 query 有没有真的重发请求 |

另有一条**系统性隐患**值得单独排一轮：`persisted()` 返回的第四个值 `ready` 在 RedCode 有多处消费，L3 是已经确认踩中的一处，上游 `36f901588` 修的"没等水合就读 collapsed"是同一类。建议把 `settings` / `layout` / `prompt` / home 相关用到 `persisted(...)` 的地方统一过一遍，凡是把 `ready` 当 boolean 用的都要确认拿到的到底是 `ready()` 还是 `ready` 本身。

---

## 4. 已核实**不必做**的几条（避免白干）

这几条从 subject 看很像该做，实测 RedCode 侧已无问题：

| 上游提交 | 为什么不必做 |
|---|---|
| `246d40db7` skill base directory 用 `file://` URL (#33580) | RedCode `tool/skill.ts:41` 已经是 `const base = dir`，本来就没这个 bug |
| `4f1a9d7ae` honor configured agent step limits (#33142) | opencode 侧那一半只是把 `max-steps.txt` 换成从 core 引常量（纯模块搬家）；真正的行为修复在 v2 引擎里。RedCode `session/prompt.ts:1310` 已经是 `agent.steps ?? DEFAULT_MAX_STEPS` |
| `7ad68f815` apply plugin pty environment (#32296) | RedCode 无 `plugin/pty-environment.ts`，但 `pty/index.ts:195` 已直接 `plugin.trigger("shell.env", ...)`，用另一条路径达成了同样效果 |

### 特别提醒：`f092bafe88` 不要跟进

> `tweak: remove steering wrapper that can bust cache` (#33039)

上游的做法是**整块删掉** step>1 时把新到 user 消息包进 `<system-reminder>` 的逻辑，理由是它改写已发出的消息、会打断前缀缓存。

**RedCode 已经独立修过，而且修得更细**（`session/prompt.ts:1428-1459`，注释日期 260623 / 260729）：
- 不再原地改写 `p.text`（注释明确记录了旧做法"mutated p.text before msgPin, which silently restored the un-wrapped cached version"）——缓存打断问题已消除
- 修了边界 bug：原来用 `lastFinished.id` 做界，导致开启本轮的那条用户消息每一步都被重复提醒（20 步的回合会提醒 19 次）
- 加了去重（`remindedUserIDs`）

**结论：RedCode 保留功能 + 修好副作用，优于上游的直接删除。不要按上游做法回退。**

### 其余已核实不必做的

| 上游提交 | 为什么不必做 |
|---|---|
| `246d40db7` skill base directory 用 `file://` URL | 我们 `tool/skill.ts:41` 已经是 `const base = dir` |
| `4f1a9d7ae` honor configured agent step limits | opencode 侧那一半只是模块搬家；我们 `session/prompt.ts:1310` 已经是 `agent.steps ?? DEFAULT_MAX_STEPS` |
| `7ad68f815` apply plugin pty environment | 我们 `pty/index.ts:195` 已直接 `plugin.trigger("shell.env", …)`，另一条路径达成同样效果 |
| `c71fe7897` disable health check for web deployments | 我们 `entry.tsx:174` 早就有 `disableHealthCheck`——这条修的是上游自己重构时删掉造成的回归 |
| `d11181238` restore review line comments | 修的是上游 `enableHoverUtility`→`enableGutterUtility` 改名引入的回归。我们全仓仍是旧命名，行为本来就是好的，**搬过去反而会拆掉能用的路径** |
| `4aaed4264` preserve macos titlebar inset | 我们 `titlebar.tsx:211` 已经是修复后的形态 |
| `e16bfd745` start MCP servers only for open directories | 我们 260609/260706 已自己解决且**更彻底**——`child-store.ts:22-27` 把 mcp/path/lsp/provider 四个 query 一起 gate，上游只 gate 了 mcp。不要回退成上游版本 |
| `4e70eabbc` / `2725eed99` / `ab69f4106` MCP 状态与 path 同步三条 | 我们已独立落地等价改动（`child-store.ts:210-218` 的注释描述的失效现象和上游一字不差） |
| `b94e55c7c` align context tokens with usage | 我们已独立修过且更彻底（`session-context-metrics.ts` 重写，`getSessionTokenTotal` 早已不存在） |
| `b5e09024d` clarify status indicator severity | **这是上游多服务器重构自己引入的回归**——上游错在 `serverHealthy() \|\| …`，我们用的是正确的 `server.healthy() === false \|\| …` |
| `9e8b2171a` refresh V1 providers after auth | 上游的 bug 是 `if (directory)` 判的是函数引用而非取值；我们的 `use-providers.ts` 是完全另一份实现，这个 bug 形状不存在 |
| `b05a0d1fb` + `550d1ffd2` 中文 token 用词两条 | 上游三天内自我推翻（令牌→词元→token），**最终落点恰好就是我们早就在用的写法** |
| 8 条纯 `@ai-sdk/*` 版本 bump | 我们 2026-08-07 的 AI SDK v6→v7 迁移（`4f1ce2af`）已把所有 `@ai-sdk/*` 推到上游 HEAD **之上一个大版本线**。"上游 bump 了所以我们也该 bump"这个直觉在这批全错 |

⚠️ 唯一的依赖缺口是非 `@ai-sdk/*` 的 `@openrouter/ai-sdk-provider`（我们 2.8.1 / 上游 2.9.0，`e45e0e112`）。**动之前先验它与我们现在的 `@ai-sdk/provider 4.0.5` peer 是否兼容**——不排除 2.8.1 是被 v7 迁移刻意钉住的。

---

## 5. 代码不要、思路可借鉴

这几条落在我们已经重写的区域，**上游代码别搬**，但它们指出的问题我们那套确实没覆盖到。

### 5.1 输入框贴图后打字卡顿 —— 我们的方案只解决了一半

上游 `6ff0adef2`。症状是图片以 base64 dataUrl 存在草稿状态里，而整个 prompt store 每次变更都要 `JSON.stringify` 写 localStorage，**每敲一个字都在重新序列化整张图**。

我们确实中招：`context/prompt.tsx:35` 仍是 `dataUrl: string`，`:168` 用 `persisted(Persist.scoped(dir, id, "prompt"))` 把含图片 part 的整个 store 落盘，没有任何过滤。

我们在 `prompt-input/attachments.ts:63` 有自己的方案（注释 `260629 Red: 落盘到 .attachments/，让 build-request-parts 走 file:// URL 而非 base64 dataUrl`）——但那只解决了**请求侧**，草稿侧照旧。

**建议**：不要照搬上游的 IndexedDB 方案，复用我们已有的 `.attachments/` 落盘路径，草稿里只存路径而非 dataUrl。成本远低于引入一层新存储。

### 5.2 长回复时 markdown 渲染占死主线程

上游 `3b811bd01` 把 Shiki 高亮搬进 Web Worker，并把 markdown 按 block 投影后增量渲染。

我们的 `message-part.tsx` 里 `PacedMarkdown` 的注释原话就是"full parse + Shiki highlight + morphdom，随文本增长退化成 O(n²)，实测症状 UI 冻结 + 憋一大段后一次蹦出"——**上游这条正是那个病的根治法，我们现在的自适应节流只是降频缓解**。

配套还有一条更便宜的：`context/server-sdk.tsx` 目前只合并 `message.part.updated`/`session.status`/`lsp.updated`，**delta 是逐条 emit 的**，而 event-reducer 对每条 delta 做一次 `part[field] = existing + delta` 字符串拼接 → 长回复 O(n²)。上游的 `coalesceServerEvents`（同一 part+field 在一帧 16ms 内合并）是纯增量、自带测试，结构同源可直接照搬。

### 5.3 拒绝权限后模型继续往下跑

上游 `709af5861`。用户拒绝一次权限请求后，拒绝被当成工具输出喂回模型，模型继续执行。上游的落点是 v2 权限服务（我们没有），但**"拒绝应当中止本轮"是真实体感问题**，值得在 `packages/opencode/src/permission` 自己实现。

### 5.4 分层定价没被计算

上游 `d71454c70` 的一小段。我们的 `ModelsDev.Cost` schema **已经声明了** `tiers: Schema.optional(Schema.Array(CostTier))`，但 `plugin/models-dev.ts` 的 `cost()` 只处理 `context_over_200k`，完全忽略 `tiers` ⇒ **声明了分层定价的模型全部按基础价计**。约 10 行。与用量面板的口径准确性直接相关。

### 5.5 推理档位硬编码表可以改成数据驱动

上游 `a8062ea31` + `a1ab489e6` 给 models.dev 的 Model schema 加了 `reasoning_options`（effort/toggle/budget_tokens 的声明式描述）。我们的 `provider/transform.ts:656-740` 躺着 `WIDELY_SUPPORTED_EFFORTS` / `GLM_EFFORTS` / `KIMI_K3_EFFORTS` / `OPENAI_GPT5_*` 一大片硬编码表，正是这条想替掉的东西。

schema 部分零风险可以先落（约 20 行），但**单独落地不产生任何行为变化**——真正的收益要等 transform 侧改造。

### 5.6 二进制文件被当文本喂给模型

上游 `83dca45dd`。逻辑可手工移植到 `packages/opencode/src/tool/read.ts`：BINARY_EXTENSIONS 名单、前 4KB 采样判二进制、20MB 媒体摄入上限。**不要沿 core 的 filesystem 重构链往前补**（见 §6）。

### 5.7 上游的 i18n 纪律值得抄，译文不值得抄

上游 `8d65dbdd0` 的 AGENTS.md 里那几条 i18n 纪律（禁止在业务代码里拼语法片段、禁止判断 locale、禁止手搓复数键）值得抄进我们的 `packages/app/AGENTS.md`。译文本身完全不用跟——我们是自有中文化，且上游中文用词三天内自我推翻过。

---

## 6. 我们自己的地盘（不跟，划边界用）

下面这些是上游有、我们明确不走的路。**列出来是为了让下次筛选能直接跳过，不必再逐条读 diff。**

| 上游体系 | 上游落点（可作为排除规则） | 我们走的路 |
|---|---|---|
| 浏览器式标签页 | `context/tabs.tsx`、`titlebar-tab-{nav,strip,drag}.*`、`utils/session-route.ts`、`utils/session-placement.ts` | 标签写在 `titlebar.tsx` 内部的 603 行自研实现（带 status 圆点、MCP 目录激活、`titlebar-history`） |
| v2 布局与设计系统 | `pages/layout-new.tsx`、`pages/new-session*`、`pages/session/v2/**`、`components/settings-v2/**`、`settings.general.newLayoutDesigns()`、`settings.visibility.*` | 自有 5 套主题（redcode/yuqi/cream/deep-blue/eye-green）+ 中文化 + `index.css`（churn 207）。**v2 组件库在 `packages/ui/src/v2/` 里存在但 app 侧零调用** |
| 多服务器并存 | `app/src/wsl/**`、`components/settings-v2/servers.tsx`、`ServerScope`、`requireServerKey`、`global.servers.health` | 单本地 sidecar。数据结构上支持多 server（`ServerConnection`/`resolveServerList`），但 `useServerSDK` 是应用级单例、Tab 无 server 维度 |
| v1/v2 服务端协议兼容层 | `utils/server-compat.ts`(496行)、`utils/server-protocol.ts`、`utils/session.ts`、`context/server-session.ts`、`context/mcp.ts`、`hooks/provider-catalog.ts`、任何 `(await sdk().protocol) === "v1" ? …` | 只有 v1 一种服务端 |
| 时间线拆分 + 虚拟化换库 | `pages/session/timeline/**`、`@tanstack/solid-virtual` | 老的单文件 `message-timeline.tsx` + virtua |
| core 的 v2 会话引擎 | `core/src/session/**`、`core/src/tool/**`、`core/src/database/**`、`core/src/control-plane/**`、`core/src/config.ts`、`core/src/project.ts`、`core/src/git.ts`、`core/src/snapshot.ts`、`core/src/ripgrep.ts` | 会话引擎在 `packages/opencode`，v1 血统 |
| core 的 filesystem 重构链 | `604a5f781` 起共 9 条，`AppFileSystem` → `FileSystem`+`FSUtil` | 全仓 import `AppFileSystem`。**这是不可拆的连锁，别沿链往前补** |
| Effect logging 替换 | `c06ad7c88`（删 `core/src/util/log.ts`） | 全仓靠 `Log.create({service})`。**明确不碰**——纯内部重构、零用户可见收益、爆炸半径覆盖整个日志文件体系 |
| provider 插件新宿主 | `c780d7cee`(v2 effect host) + `909a1a6d7`(namespaced hook API)，另加 `1520b0de2`、`11dbd1581` | 自有 HookSpec（tool.use.pre / session.start / notification / permission.denied / compact.post / subagent.*），`plugin.ts` churn 65.7% |
| RTL 与 80 语种 i18n | `i18n/desktop-native.ts`、`Intl.PluralRules` 复数键、`dir=rtl` | en/zh/ja 三语，`parity.test.ts` 已重写成全键集 diff（比上游那版强） |
| marked 生态 | `marked` / `marked-katex-extension` / `marked-shiki`、`marked-code-span.ts`、`markdown-worker*.ts`、`@shikijs/stream` | 已整体换成 `markdown-it` 14.3.0（"marked 对长文本 O(n²)，50KB 纯文本 587ms → 1.2ms"），流式期间 `highlight: false` 跳过 Shiki |
| v2 主题映射层 | `ui/src/theme/v2/{mapping,resolve,foreground,default-primitives,avatar}.ts`、`script/build-oc2-v2-overrides.ts` | 完全没有这一层（`oc-2.json` 88 行 vs 上游 476 行），自有 5 套主题另有实现 |
| 22 个不渲染的 v2 组件 | `ui/src/v2/components/` 里除 icon / icon-button / avatar / button / wordmark 之外的全部 | 只在 Storybook 出现，桌面端走 v1 组件 |
| `body[data-new-layout]` 门控的 CSS | `78a5a030c` 之后大量新规则挂在这个属性下 | 全仓不设该属性。搬进来不报错、只是永远不生效，还会让 `tabs.css`/`accordion.css` 持续膨胀 |
| 上游文档站内容 | `web/src/content/docs/**` 的 15 个语种、Zen/Go 自营模型目录与定价 | 三语自主维护。**这个边界现在很干净，建议保持，不要为减少 diff 把 15 语种加回来** |
| 上游品牌与商务 | opencode.ai 链接、enterprise 联系页、生态插件目录、Snowflake Cortex 等第三方 provider | 自有 |

---

## 7. 下次怎么筛（这套方法可复用）

甄别脚本在 `%TEMP%\claude\…\scratchpad\`（本次会话的临时目录，非仓内）。核心思路四步，下次换个 tag 重跑即可：

1. **建分叉底图**：用 `git ls-tree -r <上游fork点tag>` 和 `git ls-tree -r HEAD` 各出一份 `blobSHA + path`，按 path 比对 → 得到四类文件（一致 / 我们改过 / 我们删了 / 我们新增）。
2. **量每文件分叉深度**：对"我们改过"的文件，逐个 `git diff --no-index --numstat` 拿改动行数。这决定后面 SOFT/HARD 的分界。
3. **给每个上游提交打分**：`git log <range> --name-only` 拿到每条提交的文件列表，与第 1 步的四类求交集 → 自动分档。
4. **人工只看有交集的那部分**：本次 996 条里，只有 720 条与我们的文件有交集，其中 fix/perf 只有 217 条——**筛掉了 78%**。

三条从这次踩出来的经验：

- **别按"fork 自 v1.15.10"去推我们的现状。** 至少 8 条如果只看 fork 点会判成"缺失、该移植"，实测我们已经有了、甚至比上游更彻底（`e16bfd745` `4e70eabbc` `2725eed99` `ab69f4106` `4aaed4264` `b94e55c7c` `b5e09024d` `c71fe7897`）。每条都必须 `git show HEAD:<path>` 实看。
- **`rc_only` ≠ 我们原创，`未在 rc_modified 里` ≠ 与上游 HEAD 同源。** `context/server-sdk.tsx`/`server-sync.tsx` 是我们**手工回移**的上游产物，只因对比基准是 v1.15.10 才被标成"我们独有"。
- **上游有连环自伤，别照单全收。** `943135671` 把 `[...tabsStore, ...tabsStore, ...tabsStore]` 调试残留和被注释掉的 `data-tauri-drag-region` 提交进了主干，三天后由 `c613c3378` 回滚；`c35267776` 带进了一行 `console.log({ file })`（要靠 `5426478e4` 才删掉）；`b05a0d1fb` 把 token 译成"词元"、三天后 `550d1ffd2` 又改回 token；`f06e9491e` 加 Gemini 3.7 Flash、同日 `244958154` 删掉。凡是上游改 titlebar/tabs/i18n 用词/自营模型目录的提交，先看它有没有在几天内被改回去。
- **同一选择器反复横跳的，别走提交序列。** `[data-expanded]` 那条上游改了三次（`52eae83ae` 加 → `1bcb9d7cb` 撤 → `c76938077` 再加）。这类正确做法是取上游 HEAD 的最终形态直接覆盖。
- **"标题小、附带删除大"的提交要先看 `--stat`。** `a9afed051` 标题只说修 macOS 全屏标题栏内衬，实际顺手删光了 `titlebar.tsx` 里整套 `__TAURI__` 探测与窗口拖拽/最大化/主题回退——**照搬会把我们已完成的 Tauri 迁移 #1–#5 拆掉**。同类还有 `51b9c726c`、`638788f8d`。

### 快速排除规则（下次可直接跳过，不必读 diff）

只要提交**仅**触及下列路径，一律判无关：

```
packages/app/src/context/tabs.tsx
packages/app/src/components/titlebar-tab-*
packages/app/src/pages/{layout-new,new-session}*
packages/app/src/pages/session/v2/**
packages/app/src/pages/session/timeline/**
packages/app/src/components/settings-v2/**
packages/app/src/wsl/**
packages/app/src/utils/{server-compat,server-protocol,session}.ts
packages/core/src/{session,tool,v1,database,control-plane,migration}/**
packages/session-ui/**          ← 上游 2026-06-24 从 packages/ui 拆出去的新包
packages/web/src/content/docs/**（除非改的是 flag / 默认值 / 配置键的描述）
packages/*/src/i18n/**
packages/ui/src/theme/v2/**     ← 我们没有这一层
packages/ui/src/v2/components/  ← 除 icon / icon-button / avatar / button / wordmark 这 5 个
任何只改 marked / marked-katex-extension / marked-shiki / markdown-worker* 的
任何新规则只挂在 body[data-new-layout] 下的 CSS
```

另外三类"改动本身没问题、但对我们零收益"的，也可以直接跳：只往 `v2/icon.tsx` 加图标的、只改我们不渲染的 v2 组件 CSS 的、纯上游发布基建的（LICENSE / publish 脚本 / 内嵌字体）。

另外三条时间分界线，之后的同类提交默认按"需重写"而非"可移植"评估：

| 日期 | 事件 | 影响 |
|---|---|---|
| 2026-06-21/22 | provider 插件两次全量换形（`c780d7cee` + `909a1a6d7`） | 之后所有 provider 修复不能直接 apply |
| 2026-06-24 | `packages/ui` → `packages/session-ui` 拆包（`04c1730c9`，约 60 个文件） | 之后 `message-part` `markdown*` `file` `session-diff` `basic-tool` `line-comment*` 的修复 diff 路径全变，cherry-pick 会变成"新增文件" |
| 2026-07-17 / 2026-07-23 | composer 双轨化（`c0a258b22`，新修复只进 v2 轨）、v1→v2 双协议七连击（一周内落完） | composer 类修复的可移植窗口已关闭；app 层网络/事件/PTY/会话读写的修复都被包在协议分叉里 |

---

## 8. 建议的落地顺序

分三批，每批可独立收工。

**第一批 · 一行到十几行，风险接近零（建议打成一个提交批次）**

| 项 | 出处 | 量 |
|---|---|---|
| `oc-2.json:26` 的 `"C7C7C7"` 补 `#`（**默认主题**弱化图标颜色失效） | §3B #19 | 1 字符 |
| `titlebar.tsx` 的 `mod+1..9` gate 写错对象 | §3C-L1 | 1 行 |
| `layout.tsx` `installUpdate` 缺 `.finally` | §3C-L2 | 1 行 |
| `event-reducer.ts` 归档分支解引用顺序（**真崩溃**） | §3B #31 | 2 行 |
| `Share.tsx` 消息排序 | §3B #25 | 1 行 |
| v1 Tooltip 加 openDelay（工具栏扫过时提示乱闪） | §3B #21 | 2 行 |
| 下拉 hover 滞后 + ButtonV2 下伸字母被裁 + 进度环底色 | §3B #27 | <15 行 |
| 终端渲染器隐藏时挂起 | §3B #12 | 1 行 |
| 模型列表 tooltip 延迟 | §3B #13 | 1 行 |
| `dialog-select-directory` 补拉 home | §3B #11 | 2 行 |
| 空 prompt text part | §3B #6 | 3 行 |
| 删掉 `marked.tsx:408` 的 `$...$` 正则 | §3B ui 段的纠正 | ~14 行 |
| 上下文溢出模式表补 8 条 | §3A-A2 | 纯数据 |
| `compaction.prune` 文档与 schema 说反 | §3B #26 | 4 处 |
| `zh.ts:400` 残留的"令牌" + 两处硬编码英文 | §3C 末 | 3 处 |
| 三处 `sync.directory as PathKey`（**先做一次现场验证**） | §3C-L5 | 3 行 |

**第二批 · 十到六十行，落点已逐条核对**

| 项 | 出处 |
|---|---|
| compaction 三处常量 + 提示词重写（**对 DeepSeek v4 Flash 直接相关**） | §3A-A1 |
| Windows 文件树目录展开（**Windows 专属，你就在 Windows**） | §3B #1 |
| 命令注册被同名覆盖后不恢复（静默失效类，最难自查） | §3B #2 |
| 会话顶栏控件整块消失（Portal mount 陈旧） | §3B #3 |
| 打开项目对话框搜不到第 6 名之后的项目 | §3B #4 |
| 会话列表自己在跳 | §3B #33 |
| 终端里应用级快捷键失灵 | §3B #34 |
| 对话框不能叠加（弹窗里开弹窗会吃掉父层） | §3B #23 |
| 整文件补丁被当片段渲染 | §3B #20 |
| review 面板 diff 不刷新（**必须带上删 `console.log` 那条**） | §3B #22 |
| ScrollView 键盘滚动三缺陷 + 拖拽跳位/pointercancel（同文件，一起做） | §3B #24 + #26 |
| ScrollView flex 收缩 + 对话框高度 | §3B #25 |
| 内容过滤中止导致会话静默死掉 | §3A-A3 |
| 子代理无限嵌套 | §3A-A4 |
| api-key + 额外 metadata 的 provider 连不上 | §3B #36 |
| desktop 外链导航策略（**既是 UX 也是安全缺口**） | §3B #32 |
| 文件树默认宽度压在裁切线上 | §3B #35 |
| 按钮展开态视觉（**照 `c76938077` 最终形态一次改到位**） | §3B #28 |
| todo dock 跨会话串台（app 侧 + motion-spring 两半一起） | §3B #39 + #30 |
| OpenRouter 图标 | §3B #29 |

**第三批 · 需要先做决策或先验证**

| 项 | 要先定什么 |
|---|---|
| `prompt.ready()` 恒真 + `persisted()` ready 用法专项排查 | §3C-L3；排查面比单点修复大 |
| `showFileTree` 空转设置项 | §3C-L4；接上还是删掉，是产品决定 |
| 草稿别再存 base64（用我们自己的 `.attachments/` 路径） | §5.1；改动面最大的一条 |
| markdown 渲染 worker 化 + server-sdk delta 逐帧合并 | §5.2；worker 化是独立工程，delta 合并可以先单做 |
| 补回 `LanguageSelect.astro` | §3B #24；顺带核 `i18n/locales.ts` 与 `astro.config.mjs` 的 locales 键是否仍一一对应 |
| 分层定价 + 推理档位数据驱动 | §5.4/§5.5 |
| `@openrouter/ai-sdk-provider` 2.8.1 → 2.9.0 | 先验与 `@ai-sdk/provider 4.0.5` 的 peer 兼容 |
| `session-diff.test.ts` 与实现对齐 | 实现已是上游重写版，测试还停在 v1.15.10 |
| `@pierre/diffs` 升版 | 卡住三条 ui 提交；**`d11181238` 在旧 pierre 上硬搬会让行内评论彻底失灵且不报错** |
| v2 主题映射层：整体引入还是宣布永久分叉 | 目前是"既没引入也没宣布"的模糊状态，每次同步都要重判一遍 |
| `packages/opencode` 那条战线 | 657 个提交、268 个 fix、66% 分叉率，单独立项 |

---

## 9. 第三批决策与落地记录（08-14 拍板）

| 项 | 决策 | 状态 |
|---|---|---|
| `prompt.ready()` 恒真 | **真修**（启用门禁；根因=少一对括号，`persisted()` 第四返回值本就是正确形状） | ✅ b6ecf5ab；**盯首屏**：门禁生效后 composer 会真等草稿水合 |
| `showFileTree` 空转设置项 | **删**（空转至今无人发现=无人需要） | ✅ 9a0248d6（UI+store+三语 key） |
| 草稿 base64 | **B：落盘滤图**（重开丢图、文字保留）；顺带查清双路径：`.attachments/`=GUI 发送侧、`%TEMP%\redcode-vision-*`=不识图模型的 vision 子进程落盘（内容哈希路径**不能动**，08-04 缓存事故防线） | ✅ b6ecf5ab + vision 临时文件 7 天 TTL 惰性清扫 8d405808 |
| 推理档位数据驱动（§5.5） | **做，覆盖层方案**：数据打底、校准表覆盖；schema 按 Json 透传不收紧 | ✅ f31ddd84；接线只动两个"通用猜测"兜底 |
| markdown worker 化（§5.2） | **先量化**：实测回复完成后那次 Shiki 高亮的主线程阻塞，>100ms 才立项 | ⏸ 待单独测 |
| 分层定价 tiers（§5.4） | **挂起**：USD 显示基本不用；CNY 侧目前疑似只有 DeepSeek 有阶梯且 8.17 要换新定价，等落地后连 CNY 表结构一起定 | ⏸ 8.17 后重看 |
| v2 主题映射层 | **宣布永久分叉**：以后 `theme/**` 上游提交一律跳过，不再逐条判 | ✅ 定调（本体系一个多月前已独立） |
| `@pierre/diffs` 升版 | **不动**：无用户可见坏处在逼；行内评论真出问题再升 | ✅ 定调 |
| `packages/opencode` 战线 | **排期**：方法论复用本次（分叉底图→按落点筛→逐条验证→分批落地） | 📅 待排 |
| delta 逐帧合并（§5.2 半条） | 重归类为"可直接做"（无决策点） | ⏳ 下轮顺手 |
| `@openrouter/ai-sdk-provider` 2.9.0 | 验证型：peer 兼容即升 | ⏳ 下轮顺手 |
| `LanguageSelect.astro` | 前置问题：文档站有无真实访客；无则降级不做 | ⏸ 待答 |
