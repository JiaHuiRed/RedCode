# 上下文进度条按引擎档位上色（而不是按百分比）

状态:implemented

## 问题

`9b45c01` 给 TUI 侧边栏加上下文进度条时，颜色阈值是拍的：绿 <60% / 黄 60–85% / 红 ≥85%。哥哥提出要"按颜色决定要不要主动 compress"之后，这个拍脑袋的阈值就不够了——**它和引擎真正动手的时机对不上**。

档位（`session/overflow.ts`）是相对 `ceiling() = min(硬顶, usable)` 算的，而进度条的分母是模型标称的 `limit.context`，两者不是一个数：

| | step-3.7-flash |
| --- | --- |
| context | 256k |
| usable ≈ | 224k |
| `soft` 0.6 | 134.4k = 进度条的 **52%** |
| `prune` 0.8 | 179.2k = 进度条的 **70%** |
| `compact` | 224k = 进度条的 **88%** |

按 60/85 上色，等于**颜色比引擎实际动手慢半拍**：看到黄色时 `soft` 早在 52% 就过了，85% 变红时 `prune` 在 70% 就已经在裁陈旧工具输出。拿它当决策依据会误判。

## 决策

**颜色由服务端算好的档位驱动，不由客户端按百分比推。**

`assistant` 消息加可选字段 `contextLevel: "ok" | "soft" | "prune" | "compact"`，侧边栏只做 level → 颜色的映射。颜色的含义因此从"用了多少"变成**"引擎下一步会做什么"**，正是要的那个信号。

**为什么不在 TUI 侧复刻这套计算**：`ceiling()` 依赖 `usable()`，`usable()` 依赖 `maxOutputTokens(model)`——那是一张按模型家族字符串匹配的表（MiMo 100k / DeepSeek-V4-Flash 50k / 其余 32k）。在客户端复刻等于同一张表两处维护，**加一个模型漏一处，颜色就悄悄偏，而且偏了没人会发现**（本仓刚在 08-18 加过 qwen3.8）。这与仓里 `gpt-` 字符串猜测那类坑同形。

**档位改为无条件计算并落库。** 原来只在 `result !== "compact"` 时算——那样恰恰在最该变红的那一轮拿不到值。现在无条件算、变化时才写库（避免每步一次无谓写入）；`soft`/`prune` 两档**动作**的门槛原样保留（仍只在非 compact 轮次执行），只是判定与动作解耦了。

**分母保持标称 context window（256k）不变。** 换成对 `ceiling` 显示能让百分比与档位线 1:1 对应，但数字会与模型标称值对不上——数字要诚实，信号交给颜色。

## 已知的、本次刻意没动的

`level()` 里的 `tokenCount` 用的是 `tokens.total`，那是**跨 step 累加**的值（`processor.ts`），长工具链的轮次上会让档位偏早触发。本次不动它，两个理由：

1. 改它等于改**真实压缩时机**，`overflow.ts` 的注释明确写着 compact 档"触发点与改造前完全一致，不动它"；
2. 颜色的目的就是忠实反映引擎行为——引擎用哪个数判定，颜色就该跟着哪个数，两者一致才不会骗人。

实测哥哥当前会话 `tokens.total / tokens.context = 1.00~1.02x`（轮次多为单 step），所以现阶段影响可忽略。这是同一个口径问题的第三处，记在这里等有痛点再动。

## 后果

- 测试：`sidebar-context.test.ts` 的颜色用例按新语义重写（四档颜色互不相同 / 档位缺失或不认识时回落 ok 且不报错），替换掉原来断言 60/85 门槛的那条。`overflow.ts` 本身没动，其 11 个档位边界用例照旧。
- 历史消息没有 `contextLevel` → 回落到 `ok` 的绿色，发一轮新消息即校正。
- 顺带记一笔：同批讨论过把 DCP 的三档提醒砍到只留紧急档（`inject.ts` 里 `overMaxLimit` / `else if (overMinLimit)` 本就是互斥两支，砍法干净），哥哥决定**保留三档不动**。

## GUI 侧（同日追加）

哥哥明确了这个颜色是**锦上添花**——"我可能不一定严格按照颜色区间 compress，纯粹是前端好看"。所以 GUI 侧按最小改动做，不为它引入任何新机制：

- **共享组件一行没改**。`progress-circle.css` 本来就是 `stroke: var(--progress-circle-progress, var(--border-active))` 的可覆盖写法，调用方传 `style` 即可。
- `session-context-metrics.ts` 只做透传（`level: message.contextLevel`），计算仍在服务端。
- **GUI 收成三档，TUI 是四档。** 原因：v2 的语义色只有 `success/warning/danger/info`，**没有橙色的 state token**。有 `--v2-orange-*` 调色板，但那是原始色阶、不分亮暗（`state-fg-*` 是亮色用 `-800`、暗色用 `-500` 两套），直接用会在暗色主题下发错。为一个装饰功能新增一对设计 token 不划算，于是 `soft` 与 `prune` 合并为 warning：**黄 = 廉价手段已在生效，红 = 正在全量压缩**。
- `ok` 档**不覆盖**变量，保持组件默认的 `--border-active` —— 没事发生时圈就该是平时的样子。

如果哪天真要四档对齐，正确做法是补一对 `--v2-state-fg-caution`（亮 `orange-800` / 暗 `orange-500`），而不是在调用点写死颜色。
