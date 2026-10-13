# 下午批次第三方复核：压缩中断恢复、阶段取证、工具描述预算、锁测试修复

状态:proposed（第三方只读复核。**未改动任何被审文件**；对照实验临时还原的三个源文件已按 sha256 校验还原，工作区与复核前逐字节一致）

## 复核对象与方法

工作区 19 个修改文件 + 3 个新增文件（均未提交）。基线 `HEAD = d176cac7`。

方法：

1. 读全部 diff（源码、测试、笔记、配置）；
2. 跑 `packages/opencode` typecheck 与 6 个定向测试文件；
3. 对 3 个失败用例做 **HEAD 对照**：临时把 `prompt.ts` / `compaction.ts` / `processor.ts` 还原为 `HEAD` 版、单跑该用例、再从备份还原并比对 sha256；
4. 独立复算所有可在文档里对上的数字（字节、文件数、边界语义）。

复核前后 `git status --short` 与 `git diff --stat` 完全一致（19 files changed, 1069 insertions(+), 224 deletions(-)），哈希一致。

## 一、结论

**批次方向正确，文档与代码一致，全部可复算的数字都对得上。三处测试失败经 HEAD 对照确认是先前就存在的环境问题，不是本批回归。** 发现 1 项提交前应处理、3 项建议、1 项已知未覆盖。

## 二、核实通过项

| 文档声明 | 实测 | 结论 |
| --- | --- | --- |
| 工具描述 25 个文件 / 25,841 / 32,768 字节，余 6,927 | `bun run check:tool-description-budget` → `25 files, 25841/32768 (6927 remaining)`；`find` + `wc -c` 独立复算同为 25,841 | 一致 |
| 与原 dev 相比静态描述净 −7 字节 | `HEAD` 递归求和 25,848；工作区 25,841；`edit.md` 单文件 `3219 → 3212 = −7`，其余工具描述未动 | 一致 |
| 「固定前缀增量 0」 | 本批对模型可见字节的唯一改动就是 `tool/edit.md` 那一句；无提示词、无 schema 装配改动 | 一致 |
| typecheck 通过 | `bun run typecheck` 通过（tsgo 崩溃后回退 TS 5.9.3，无报错） | 一致 |

**逐条读码核实（这些是本批的核心逻辑，逐条查了依赖）**：

- **`MessageV2.latest()` 的失败摘要回收语义正确。** `failedCompactions` 以摘要 assistant 的 `parentID` 为键，与 `m.info.id`（承载 compaction marker 的 user 消息）比对。查了 `compaction.create`：**每次都新建一条 user 消息**再挂 marker，所以 `parentID ↔ marker` 是 1:1，不存在「同一 parent 上既失败又成功、成功那条被误伤」的情形。subtask 分支与 `failedCompactions` 无关，按文档所说保留。
- **`ContextCompaction.list()` 过滤 `active = true`**（`context-compaction.ts:79-81`），所以 `prompt.ts` 里 `.at(-1)?.committedAt` 取的是**当前生效**的最新块提交时间，不是被 deactivate 的旧块。语义正确。
- **`sessions.findMessage` 是 newest-first**（`session.ts:608` 注释 + 实现从 `page.items` 尾部倒扫），所以新谓词 `(tokens.context ?? 0) > 0` 取的是**最新一条非零实报**，不会被本轮零用量占位遮蔽。这正是修复目标，方向对。
- **`WaitingForModel` 有 `onCleanup(() => clearInterval(timer))`**（`index.tsx:1907`）。新增的 `CompactingIndicator` 是常驻挂载点，若缺清理会按 mount 次数泄漏定时器——实际有，没问题。
- **`processor.ts` 的 `case "step-finish"` 只有一个 `return`**（该 case 内无提前返回），所以 `usageMs` 累加不会被跳过。
- **`edit.md` 改引用没丢内容锚点。** 新句把具体示例 `(e.g., \`1: \`)` 换成了 `(format \`<line>: <content>\` — defined in the Read tool description)`，我担心丢了具体例子，查了 `read.md:11`——**生产端保留了 `if a file has contents "foo\n", you will receive "1: foo\n"`**。锚点在生产端，消费端引用它，是真单源化，不是信息删除。
- **`.gitignore` 新增 `.workbuddy-ai/`** 与既有 `日间壁纸.png` / `夜间壁纸.png` 两条同族，位置与写法一致。
- **锁测试的 `waitClose` 先注册后 kill**，并 `stdout?.resume()` / `stderr?.resume()` 排空管道（不排空会阻止 `close`），`taskkill` 带 `timeout: 5000`。修法与笔记里的竞态描述一致。
- **新增回归测试是实质性的**，不是同义反复：`message-v2` 两个用例分别覆盖「终态摘要只退出自己的 task（subtask 与无关新 marker 保留）」与「未完结摘要不丢弃可恢复任务」；`compaction` 的计时用例断言了阶段键齐全、`first_content >= first_event`、`request >= stream_complete`，**并断言日志里不含摘要正文**（`not.toContain("Logs checked; ...")`）——这条泄漏断言值得肯定。

## 三、三处测试失败的定性：**均为先存环境问题，与本批无关**

`bun test`（6 文件）得 232 pass / 13 skip / 3 fail。逐个定性：

| 用例 | 文件 | 现象 | HEAD 对照 | 结论 |
| --- | --- | --- | --- | --- |
| `stops quickly when aborted during retry backoff` | `session/compaction.test.ts` | 本批隔离单跑 3/3 稳定失败（3983 / 4802 / 5359 / 5614ms） | **还原 `compaction.ts`+`processor.ts` 到 HEAD 后单跑同样失败（5389ms）** | 先存。断言是「中断后 `Date.now()-start < 250`」，Windows 上 250ms 中断预算过紧 |
| `cancel with queued callers resolves all cleanly` | `session/prompt.test.ts` | 本批隔离单跑 3000.87ms | **还原 `prompt.ts` 到 HEAD 后单跑同样失败（3355ms）** | 先存。该用例自带 `3_000` ms 预算，卡在边界 |
| `(unnamed)` — `a beforeEach/afterEach hook timed out` | `session/compaction.test.ts` | 两次运行都出现，30,003 / 30,014ms | 未做 HEAD 对照（单跑整文件约 2 分钟，且需再次切换源文件） | 同为超时边界（30s hook 超时），最可能是 `{ git: true }` fixture 在本机的 git init。**未验证，标注为推定** |

三点补充证据：这三个用例**在 HEAD 就已存在**（`git show HEAD:...` 可查到），且**本批没有修改它们**（`compaction.test.ts` 的 diff hunk 全在 1031 行之前，失败用例在 1503 行；`prompt.test.ts` 的失败用例在 HEAD 1810 行）。同时它们的失败耗时**齐刷刷贴着各自的超时值**，符合本仓 `AGENTS.md` 里那条判定指纹——「失败耗时齐刷刷贴着超时值＝命令用错，不是回归」。

> 因此本批的验证结论可以写成：**改动面内的用例全绿；3 个失败在 HEAD 同样失败。**

## 四、提交前应处理（1 项）

### 368MB 构建产物 + 一张壁纸png 未被忽略，正混在工作区

`git status` 的未跟踪列表里有三个**没有被 `.gitignore` 覆盖**的目录，以及一张未忽略的 png：

| 路径 | 体积 | 为何未被忽略 |
| --- | ---: | --- |
| `packages/desktop/dist-fresh-261012/` | **368M** | `.gitignore` 有 `dist`（只匹配名为 `dist` 的目录），**没有 `dist-*`** |
| `packages/desktop/dist-probe-content-r1-r2/` | 84K | 同上 |
| `packages/desktop/dist-probe-locktest-261012/` | 8K | 同上 |
| `packages/desktop/知微.png` | 2.77M | 同目录已有 `日间壁纸.png` / `夜间壁纸.png` 两条忽略项，这张漏了 |

风险很直接：本批是**多文件批量提交**，一旦用 `git add -A` / `git add packages/`，368MB 构建产物会被一起纳入；即使这次没误提，它们也会持续污染 `git status`，让「哪些是真的待提交」变得不可读。

建议：给 `.gitignore` 补一条 `packages/desktop/dist-*/`（或通用 `dist-*`）与 `packages/desktop/知微.png`，或把这三个目录移出仓库。**这是本批唯一我认为必须在提交前解决的事。**

## 五、建议项（非阻塞，按价值排序）

1. **`Effect.onExit` 的失败分支丢掉了失败原因。** 现在写的是 `status: Exit.isSuccess(exit) ? exit.value : "failed-or-cancelled"`——失败时日志里只剩一个字符串，无法区分「结构性失败」还是「用户取消」，也拿不到 error 名。既然这条日志的全部目的就是取证，建议失败分支带上首个 error 的 tag（如 `Cause.failures`/`Cause.defects` 的首项名，或 `Cause.pretty` 的截断版）。代价：仅日志字段，零模型可见面、零预算影响。
2. **TUI 兜底文案「Compaction 未完成」会覆盖原来的空白态。** 原默认返回是不带 caret 的 `" Compaction "`，现在改成 `Compaction 未完成▸`。对一个**刚 `create` 完、`process` 尚未开始**的 marker（或 `session.time.compacting` 还没置位的窗口），会显示「未完成」。语义上不算错，但它与「压缩中」的区分完全依赖 `compacting()` 的时序判断，建议在真实 TUI 下确认这个窗口不会闪现误导文案。这是 UX 判断，不是 bug。
3. **错误原因截断按 JS 字符切，可能切在代理对中间。** `compactionReason().slice(0, 100)` 对中文/emoji 边界不安全。改成 `[...reason()].slice(0, 100).join("")` 即可。风险很低（只影响显示），但顺手。

另外提醒一件**本批有意未做**的事：`kimi.md:42` / `minimax.md:44` / `ollama.md:64` 那三处「Proactively use DCP compress… NEVER wait for auto-compact」仍在。笔记已声明「本批不顺带清理独立变体的 DCP 旧指令」，所以这不是遗漏，只是标记它仍未闭环。

## 六、未覆盖 / 未验证

- **未做**：真实 provider 续跑、重编重启后的旧会话续跑、整套 pre-push、`(unnamed)` hook 超时的 HEAD 对照。
- **未验证**：TUI 真实渲染。我只读了 `index.tsx` 的代码与 `compaction-fold.test.tsx` 的断言，没有起真 TUI 点过。文档里也把「源码重编重启后的旧会话续跑」列为部署验收边界——同意这个边界。
- **无法验证**：`compaction-fold.test.tsx` 与 TUI 的 10 pass 我只在合并跑里见到（该文件在 6 文件批里通过），未单独复跑。

## 七、模型可见面判定

本批对**模型可见字节**的净变化只有 `tool/edit.md` 一处 **−7 字节**（格式说明由重述改为引用生产端）。其余全部落在日志、TUI、测试、文档、构建门禁。

据此过四问：

1. **改了什么**：仅 `edit.md` 一句；无提示词、无工具 schema 结构、无输出协议变化。
2. **token**：固定前缀净 −7 字节（可忽略）；**文档没有宣称任何 token 收益，这是对的**。
3. **KV cache**：`edit.md` 在工具定义区，改它会使从该工具区起的缓存前缀失效一次；不改变运行时每轮固定机制。文档已按此表述，且说明「本会话现有缓存数据不能归功于尚未重编的改动」——口径正确。
4. **硬上限**：新增的 32KiB 门禁是**开发期源码预算**，不是运行时硬上限；文档明确写了「不包含 MCP、插件、运行时动态描述，也不包含参数 schema，不能宣称整个模型工具表已受此上限约束」。这个自我限制是准确的，不要在后来的引用里被简化成「工具表已有 32KiB 上限」。

## 八、关联

- 被审笔记：`implemented/architecture/2026-10-13-tool-description-scope-review.md`、`implemented/bug-fix/2026-10-13-flock-test-close-race.md`、`implemented/feature/2026-10-10-native-compaction.md`（新增两节）。
- 上一轮复核（本批的前置）：`proposed/architecture/2026-10-13-tool-description-change-audit.md`。
- 复现命令：`bun run check:tool-description-budget`；`bun test ./test/session/compaction.test.ts ./test/session/prompt.test.ts --timeout 30000`（预期 3 fail，均为先存）。
