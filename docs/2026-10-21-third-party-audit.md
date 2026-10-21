# RedCode 第三方工程审计（2026-10-21）

## 审计基线与边界

- 基准提交：`a191033a7b86910511c042c7175b77e76c0aeef3`。
- 包版本：`0.12.17`；日期按 Asia/Hong_Kong。
- 范围：`packages/opencode` 核心服务与 TUI、`packages/app` Web UI、`packages/desktop` Electron 主进程，以及配置同步脚本。
- 方法：调用链审查、相关决策记录核对、定向测试、生产实现的内存隔离探针，以及本轮审计前实际启动故障的日志证据。
- 审计过程未修改产品代码，未访问真实会话正文或修改真实数据库；配置退役故障在审计前已通过备份并移除本机遗留字段恢复。
- 未进行 Windows GUI 视觉验收、实机长时间运行、大文件 OOM 压测或 WSL 挂起测试。静态风险不等同于已经复现的崩溃。

本文是审计与修复建议，不表示这些方案已经实施。代码行号对应上述基准提交；代码演进后应按符号重新定位。历史审计文档中的状态没有在本轮逐项重验，也不作为当前事实直接继承。

## 结论与优先级

当前更值得优先治理的是状态一致性、资源边界和升级可靠性。局部维护债务已有具体表现：双向分页上线后目标跳转仍只走一个方向；相邻分页分支对迟到请求的防护不一致；同一进程的退出与健康失败分别推动重启。判断依据是这些实际行为和调用关系，而不是文件行数。

本报告中，P1 表示优先安排的用户阻断问题或发布机制缺口，P2 表示应进入近期修复计划的正确性、性能或维护性问题。

| 编号 | 优先级 | 方向 | 事项 | 证据状态 |
| --- | --- | --- | --- | --- |
| RC21-01 | P1 | 升级可靠性、错误体验 | 退役配置缺少覆盖全部配置层的迁移 | 实际启动故障与源码交叉确认；本机已恢复，通用机制仍缺失 |
| RC21-02 | P2 | UI、长会话 | 轮次目录跳转只能向旧消息分页 | 生产函数隔离复现 |
| RC21-03 | P2 | UI、异步状态 | 旧会话迟到失败污染新会话的历史加载状态 | 生产函数与真实 Solid store 隔离复现 |
| RC21-04 | P2 | 统计正确性、缓存 | 用量缓存漏掉原地更新及日期变化 | 生产聚合模块与内存 SQLite 隔离复现 |
| RC21-05 | P2 | 性能、资源预算 | 文件预览先全量读取再限额，文本和完整 diff 无读取上限 | 调用链静态确认；未实测 OOM |
| RC21-06 | P2 | 桌面可靠性、维护性 | sidecar 退出与健康失败可重复触发恢复 | 静态控制流确认；并发启动后果待调度测试 |
| RC21-07 | P2 | 主进程响应性 | WSL 路径转换同步阻塞且无超时 | 静态确认；实机阻塞时长待测 |

## RC21-01：为退役配置建立完整迁移链路

### 证据与影响

- [mergeUserWins](../script/merge-home-config.ts#L55) 以用户配置为基底，只补模板缺失键；本地覆盖层用于遮蔽模板，并不执行配置退役迁移。
- [ConfigParse.schema](../packages/opencode/src/config/parse.ts#L38) 拒绝 schema 不认识的顶层键。
- 实际故障中，新版移除 `image` 工具及配置字段，本机 `redcode.local.jsonc` 仍含 `image`。服务端抛出 `ConfigInvalidError: Unrecognized key: image`，`config.providers`、`provider.list`、`app.agents`、`config.get` 同时失败，TUI 退出。
- [错误中间件](../packages/opencode/src/server/routes/instance/httpapi/middleware/error.ts#L9) 将未声明的缺陷转成带诊断编号的通用 500；[TUI 启动链](../packages/opencode/src/cli/cmd/tui/context/sync.tsx#L510) 在阻塞请求失败后走致命退出。用户看到的汇总信息不能直接指出遗留字段。

审计前已完整备份本机配置，仅移除该遗留块，并核对其余设置不变。随后源码 doctor 的配置状态为 `ok`，安装版在 RedCode 与 RedMon 两个工作区的上述四个请求均返回 200。这证明本次故障的具体根因；不代表通用升级迁移已经补齐。

### 建议

1. 为已知退役字段定义显式、可重复执行的迁移，覆盖引擎实际读取的全局、本机覆盖及项目配置层，保留来源信息与备份。
2. 迁移只处理已经登记的兼容变化；未知键仍需明确报错，不能泛化为静默丢弃。
3. 在受信任的本机诊断入口展示脱敏后的字段、配置来源及修复动作。保留通用错误中间件的屏蔽边界，不直接向所有 HTTP 客户端返回原始配置或异常正文。
4. 发布验证加入“上一版配置启动新版”的场景，而不只验证新模板可以解析。

### 验收

- 含已知退役字段的旧配置可以完成升级启动；重复执行迁移结果不再变化。
- 用户其他设置、注释与配置层优先级保持原意，迁移失败不破坏原文件。
- 未登记的字段给出可操作诊断，敏感值不进入公开错误响应。

## RC21-02：让长会话目录支持双向目标定位

### 证据与复现

[loadThrough](../packages/app/src/pages/session/session-history-loader.ts#L170) 只检查 `historyMore()` 并调用 `loadMore(id)`。向新消息的生产分页能力已经存在于 [directory-sync.ts](../packages/app/src/context/directory-sync.ts#L1007)，但目标跳转没有使用。

长会话向前翻页后，400 条固定窗口会裁掉较新消息。此时点击目录中的较新轮次，目标确实存在，跳转逻辑却不能把它加载回来；仍有旧页时，还会向错误方向继续请求。

隔离探针直接导入生产 `createSessionHistoryLoader`，构造窗口 `m1..m400`，设置 `historyMore=false`、`historyNewer=true`，向新加载器可以提供目标 `m900`。调用 `loadThrough("m900")` 的实际结果：

```json
{"reached":false,"olderCalls":0,"newerCalls":0}
```

### 建议与验收

- 统一目标定位入口，依据目标轮次和现有窗口的顺序选择 `before` 或 `after`；也可评估直接加载目标所在窗口，避免多页串行远跳。
- 保留 400 条上限、连续窗口、跳转期间冻结投影及切换会话后的取消约束。
- 用 1000 条合成消息验收第 1 条→第 900 条→第 500 条的连续定位；内存窗口不超过上限，旧会话跳转不能改变新会话视口。

相关现行约束：[固定窗口与双向分页](notes/implemented/bug-fix/2026-10-09-gui-memory-unbounded.md)、[多页跳转的原子投影](notes/implemented/feature/2026-09-26-atomic-turn-history-projection.md)。

## RC21-03：统一分页请求的会话归属检查

### 证据与复现

[fetchOlderMessages 的 catch](../packages/app/src/pages/session/session-history-loader.ts#L83) 无条件写入 `stalled=true` 和 `shift=false`。虽然会话切换会清状态，但旧请求稍后失败仍能重新污染它。相邻 [fetchNewerMessages 的失败分支](../packages/app/src/pages/session/session-history-loader.ts#L120) 已检查会话归属，存在明确不对称。

真实函数与真实 Solid store 的隔离探针按以下顺序执行：

1. A 会话开始加载历史，请求保持等待。
2. 切换到 B，等待切换 effect 清理停滞状态。
3. A 的旧请求失败。
4. B 调用 `loadAndReveal()`。

实际请求记录为 `["A"]`，期望为 `["A", "B"]`。旧 A 的错误把 B 的自动历史加载挡住；显式滚动或再次切换才可能恢复。同一 catch 未调用 `onLoadError`，探针中的错误反馈调用次数为 0。

### 建议与验收

- 每次分页捕获会话及请求代次，成功、失败、收尾写状态前统一校验归属。仅比较会话 ID 不足以完整覆盖 A→B→A。
- 向旧、向新分页共用这一约束，避免兄弟分支各自维护不同的保护逻辑。
- 测试覆盖 A→B、A→B→A，以及旧请求迟到成功和失败；旧请求不得改变新请求的停滞、位移、错误提示和视口状态。
- 当前会话真正加载失败时，应给出可重试的反馈，同时保留防止请求风暴的停滞机制。

## RC21-04：补齐用量缓存的失效维度

### 证据与复现

- [fingerprint](../packages/opencode/src/session/usage.ts#L156) 只包含消息行数及最大 `time_created`；[缓存命中](../packages/opencode/src/session/usage.ts#L190) 没有检查内容更新或日期。
- [processor](../packages/opencode/src/session/processor.ts#L925) 会原地累计 assistant 消息的费用、token；[projector](../packages/opencode/src/session/projectors.ts#L147) 更新同一消息的数据，不必产生新行或新的创建时间。
- 本轮检索未发现生产代码调用 `SessionUsage.invalidate`。
- `range="all"` 的结果还包含依赖当前日期的 `currentStreak`，因此没有新增消息也不意味着缓存永远有效。

隔离探针执行真实 `src/session/usage.ts`，仅把存储适配器接到内存 SQLite，不触碰真实数据库：

| 操作 | 应有结果 | 实际结果 |
| --- | --- | --- |
| 首次统计，output=100、cost=1 | 100 / 1 | 100 / 1 |
| 同一消息 ID 原地更新为 output=500、cost=5，再统计 | 500 / 5 | 100 / 1，且复用同一结果对象 |
| 手动作废缓存后再统计 | 500 / 5 | 500 / 5 |
| 没有新消息，仅把时钟推进 3 天 | 连续天数按新日期计算 | 缓存为 1，失效重算为 0 |

用户在后台生成期间打开首页，可能先缓存中间值，完成后再次请求仍得到旧账，直到项目出现下一条新消息。

### 建议与验收

- 把消息新增、更新、删除关联到项目级统计版本或明确的缓存失效入口。
- 日期相关派生值独立计算，或将本地日期纳入相应缓存键。
- 保留聚合缓存的性能收益，避免直接关闭缓存而恢复频繁全项目扫描。
- 在现有测试补“同一消息更新 cost/tokens”“消息删除”“无新消息跨天”；同时验证未变化时仍能命中缓存。

## RC21-05：在读取之前落实文件预览预算

### 证据与影响

- 图片、PDF 和通过 MIME 识别的图片，分别在 [527 行](../packages/opencode/src/file/index.ts#L527)、[557 行](../packages/opencode/src/file/index.ts#L557)、[583 行](../packages/opencode/src/file/index.ts#L583) 先完整 `readFile`，再比较 20 MiB 内联限额。该限额不能限制读取峰值。
- [文本分支](../packages/opencode/src/file/index.ts#L596) 没有单文件读取上限。
- 有 Git 改动时还读取原文件，并以 [context: Infinity](../packages/opencode/src/file/index.ts#L608) 生成 patch，可能同时持有正文、原文、patch 和格式化 diff。
- [HTTP 处理器](../packages/opencode/src/server/routes/instance/httpapi/handlers/file.ts#L39) 直接调用 `svc.read(path)`；[GUI 文件加载](../packages/app/src/context/file.tsx#L175) 没有读取前大小检查。响应到达后才计量的前端 LRU 不能约束单次服务端读取、传输和解析峰值。

大型 JSON、日志、生成文件或 PDF 会进入这条路径，修改过的大文本成本更高。这是源码确认的资源边界缺口；本轮没有大文件压测，不能据此声称已复现 OOM 或实机闪退。

### 建议与验收

- 读取前检查文件大小，读取中仍按 `limit + 1` 有界读取，处理检查后文件继续增长的情况。
- 文本提供明确的截断或分页契约；大 diff 限制上下文、按需请求，前端展示超限原因和后续操作。
- 三条媒体读取分支统一预算执行方式，避免只修其中一条。
- [AppFileSystem.Interface](../packages/core/src/filesystem.ts#L24) 已继承 Effect FileSystem，已有 `stat`；相关旧注释应随修复校正，无需先为此扩大接口。
- 验证超限媒体不会被全量读入，大文本响应有界，文件增长仍不能绕过上限；记录代表性大文件的响应字节、峰值内存和事件循环延迟。

## RC21-06：统一 sidecar 恢复的状态所有权

### 证据与触发条件

触发条件是：重启的 sidecar 已发出 `ready`，但尚未通过健康检查就退出。

1. [server.ts 的退出回调](../packages/desktop/src/main/server.ts#L107) 调用 `onExit`。
2. [handleSidecarExit](../packages/desktop/src/main/index.ts#L345) 清引用并调用 `respawnSidecar`。
3. 同一次退出又使 [健康检查的 getFailure](../packages/desktop/src/main/server.ts#L195) 产生失败，原重启流程走到 [健康失败恢复](../packages/desktop/src/main/index.ts#L453)，再次请求重启。
4. 每次调用都在延时与现有 server 检查之前 [计入恢复预算](../packages/desktop/src/main/index.ts#L408)，因此同一次失败可消耗两个名额。

上述重复计数由控制流确认。多个计时器进一步导致并发启动的后果尚未做调度复现，不作为已发生事故报告。

预算耗尽时，主进程只记 `giving up`；界面缺少“自动恢复已停止”的明确终态，这是同一生命周期契约中的恢复体验缺口。

### 建议与验收

- 抽出单一 supervisor，以子进程代次去重退出和健康失败，持有唯一恢复任务。
- 延时、启动及等待健康都可取消；退出应用后，迟到回调不能重新拉起服务。
- 向界面发布 `starting / running / recovering / failed`、最后错误及诊断入口，失败后允许用户显式重试。
- 调度测试覆盖“ready→健康检查等待→退出”，断言一次失败只记一次预算，最多存在一个恢复计时器和一个启动任务；重试按钮不能产生第二个并行恢复任务。

相关决策：[sidecar 健康契约](notes/implemented/bug-fix/2026-09-16-sidecar-health-contract.md)。现有健康检查测试通过，不等于 supervisor 的组合时序已被覆盖。

## RC21-07：移除 Electron 主进程中的同步 WSL 等待

### 证据与影响

[wslPath](../packages/desktop/src/main/apps.ts#L24) 的两个分支均使用无超时的 `execFileSync("wsl", ...)`。它由 [主进程 IPC 入口](../packages/desktop/src/main/index.ts#L700) 调用，外层 `async` 不会让同步子进程等待异步化。

启用 WSL 后，[目录选择器出现前](../packages/desktop/src/renderer/index.tsx#L157) 会先转换 WSL home；选择文件或在外部程序打开路径也可能走转换。WSL 冷启动或挂起期间，主进程事件循环被阻塞，其他窗口操作与 IPC 受影响。本轮未测具体延迟，不把静态路径等同于已发生的用户卡死。

### 建议与验收

- 改用异步 `execFile`，设置显式超时、隐藏子进程窗口和可操作的失败提示。
- 多选转换限制并发，必要时合并为一次 WSL 调用，避免反复启动。
- 用可控执行器模拟 5 秒延迟及超时，验证其他 IPC 和主进程事件循环持续响应，超时后操作能恢复并保留失败原因。

## 验证记录

上一轮审计共运行 7 个定向测试文件，86 项通过、0 项断言失败：

| 包 | 测试文件 | 通过数 |
| --- | --- | ---: |
| opencode | `test/script/merge-home-config.test.ts`、`test/server/httpapi-error-middleware.test.ts`、`test/cli/cmd/tui/aggregate-failures.test.ts` | 17 |
| opencode | `test/session/usage-cache.test.ts`、`test/file/index.test.ts` | 57 |
| app | `src/pages/session/session-history-loader.test.ts` | 9 |
| desktop | `src/main/server-health.test.ts` | 3 |
| 合计 | 7 个文件 | 86 |

核心的两个测试文件最初在受限执行环境中因读取模板文件 `EPERM` 无法加载，随后通过原生命令通道重跑，得到表中的 57 pass / 0 fail；没有把环境加载错误算成断言回归。

此外，生产实现的内存隔离探针复现了 RC21-02、RC21-03 和 RC21-04。它们没有改动产品源码；目前尚未成为仓库内可重复运行的回归测试，修复时应把上述场景纳入现有测试文件。现有测试通过只说明已有断言成立，不能证明这些组合场景正确。

以下为定向复验命令，均从对应 package 目录执行，不运行全量套件：

```powershell
# packages/opencode
bun test --timeout 30000 ./test/script/merge-home-config.test.ts ./test/server/httpapi-error-middleware.test.ts ./test/cli/cmd/tui/aggregate-failures.test.ts
$env:REDCODE_TEST_TMP_TTL_HOURS='0'
bun test --timeout 30000 ./test/session/usage-cache.test.ts ./test/file/index.test.ts

# packages/app
bun run test:one ./src/pages/session/session-history-loader.test.ts --timeout 30000

# packages/desktop
bun test --timeout 30000 --preload ./bun-preload.ts ./src/main/server-health.test.ts
```

此次仅归档报告，没有修改产品代码，不据此要求重新跑全量测试、构建或发布。

## 建议实施顺序与维护边界

1. 优先补 RC21-01 的升级保护，并处理 RC21-02、RC21-03、RC21-04 这些已经复现的局部正确性问题。
2. RC21-05、RC21-07 先建立有界资源/延迟验证，再改读取和执行方式，补足具体性能数据。
3. RC21-06 按进程代次统一恢复状态，先用调度测试固定预算、取消和唯一任务约束，再接界面终态。
4. 重构范围围绕这些明确的状态所有者和调用契约收敛。验收应覆盖状态组合与时序，避免只测试各分支单独成功；保留既有消息窗口、缓存和恢复预算，避免为了修正确性退回无界加载或频繁全量扫描。

上述建议不涉及数据库 schema、模型提示词或工具定义的既定变更。实际实现若扩展到这些边界，需按仓库对应规则另行评估和验证。
