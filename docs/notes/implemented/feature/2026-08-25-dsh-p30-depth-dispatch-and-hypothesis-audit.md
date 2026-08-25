# flash 锚 ① 改复杂度分派 + 验证失败先审假设

日期：2026-08-25 · 状态：implemented · 来源：dsh-routing-suite（`E:\AI\dsh-routing-suite`，本轮从 `c442950` 拉到 `21a7260`）

> 注意来源与 `docs/dsh-adoption-plan.md` 不同：那份的底本是官方 harness（deepseek-harness）；本条来自 **harness 的一个插件**——注入器 × 思维模式路由预设（`dsh-router-standard`）。0.8.x 的 flash/step 三锚就是从它的 WEAK_FLASH 实测（P10/P14/P19/P20/P22/P23）搬来的，本条是同一条线的续。

## 问题

上游预设从我们上次看的 v1.9/v1.10 走到了 v1.27，中间新增两类东西，**证据档次差别很大，必须分开对待**：

- **P 系列（P1–P30）**：`n=2/n=3` 对照实验，有实测差值。三锚当初就建在这上面。
- **v1.22–v1.27（"注意力工程五大支柱"）**：验证口径只有 `selftest PASS + router.test 26/26`——那是**预设自己的单元测试**，不是模型对照实验。

从 P 系列里筛出两条与 RedCode 现状直接相关的：

1. **P30「深度效率」**量化了两件事：① 胡思乱想率已被反跑题锚压到 0.0–0.3%（我们的锚 ③ 已覆盖，无需动）；② **决策闭环**（"每块思考以决策或信息缺口收尾"）在复杂任务上**深度 +12% 且收敛更快（8.0 vs 8.3 步）**。而促成上游 v19 改动的实战反馈是「**硬收敛锚催停了复杂任务的探索**」，其改法是**复杂度分派**：简单任务快速收敛（1 步零浪费），复杂任务才给深度引导。
   对照我们 `session/prompt.ts` 的 flash 锚 ①：`Think deeply first, then commit and act. Each reasoning block ends with a decision or an information need — no open-ended rumination.` ——**后半句正是被 P30 单独认可的决策闭环，我们已经有了且是对的**；缺的是前半句「Think deeply first」**无条件施加**，简单任务上就是纯浪费。

2. **验证失败后的行为**在 `prompt/deepseek.md` 里是空白。该文件有 "Verify after you edit"，但没有一条讲**验证失败之后该干什么**。上游 v1.25 的规则是：动实现之前先一句话点名 (a) 现在在重新检查哪个假设、(b) 这次失败给了什么新证据；并补一句 **"If the code is actually correct, say so and move on (do not manufacture a bug to justify rework)"**。
   这条的说服力不在上游，**在我们自己的账上**：0.9.4→0.9.5 那条闪烁，第一次「只是把滚动节流了，方向不对」，连修两轮才找到真根因；0.7.30 项目选择器冷启动那次，基于「能力协商随机失败」这个错误猜测加的三个强制开关，经对照测试证明**不是中性兜底而是有害**。两次都是同一种病——验证不过就把同一条流水线再跑一遍更用力，而不是回头质疑最初的假设。

## 决策

1. **锚 ① 改为复杂度分派，决策闭环那半句原样保留**（`session/prompt.ts`）。改后：`Match reasoning depth to the task. A simple, well-specified task converges in one pass — do not manufacture deliberation for it. A complex or ambiguous one earns real depth before you commit. Either way each reasoning block ends with a decision or an information need — no open-ended rumination.` 保留后半句是刻意的：P30 单独量化过它有正收益，动它是退步。
2. **`deepseek.md` 的 Doing tasks 段加一条验证失败规则**，紧跟 "Verify after you edit"。措辞按本仓风格重写而非照抄，"别为了给已经开始的返工找理由而编造缺陷"那半句保留——它是原规则里最锋利的部分，也正是我们栽过的那两次的直接对症。
3. **P27 的修正记进代码注释**：上游发现 Pro 档的「67% 完成率」是 8 步上限造成的假象，16 步下天然 100%，「**Pro 的慢是深度思考的代价，不是缺陷**」。我们的锚按 `model.id` 含 flash / step 分档，Pro 本就不受影响；写进注释是防止以后有人"顺手给 Pro 也加个收敛锚"。

## 备选与否决理由

- **搬 v1.20–v1.27 的「五大支柱」**（阶段化工具解锁 `windowFor`、`delivery_check` 门禁、阶段出口机）：**否决**。那是 harness 的形态——状态机 + 工具可见性控制，搬进 RedCode 是结构性改造；而它们只有预设单元测试背书，**没有对照实验**，与三锚不是一个证据档次。为没有实测支撑的设计做结构性改动，代价与把握不匹配。
- **搬 v1.22 防局部最优**（同一细节多轮不收敛就退一步、保住整体交付）：**暂不做**。`deepseek.md:42` 已有「blocked 就先完成其余、明说留下什么」，覆盖了大半；新的部分是**触发条件不同**（同一细节反复多轮 vs 被阻塞），但同样没有实测，且我手上没有 RedCode 侧"一个顽固细节拖住整个交付"的实例。等真撞上再说。
- **加预算锚（"最多 N 次工具调用"）**：**否决**，跟上游同一个理由。它实测能把完成率推到 100%，但上游明确评估后不放进 persona——"值是任务相关的"。我们同样不做。
- **把 P30 做成运行时的复杂度判定**（按任务打分选锚文本）：**否决**。要先有一个可靠的复杂度分类器，那本身就是 P3/P5/P8 证明过的难题（模型自路由不可行）；而把判断交还模型、由它自己按任务调节深度，正是这条规则的写法。零机制、零 token 增量。

## 验证

- `turbo typecheck` 12/12；裸控制字节闸门 3973 文件；`prettier --check` 通过。
- `test/session/prompt.test.ts` + `test/session/instruction-echo.test.ts` 56 pass / 0 fail。核过全仓：没有测试钉这两段文本，改动不会撞既有断言。
- 未做行为对照：这两条是提示词层改动，真实效果要在日常使用里看。上游的数字（+12% 深度、8.0 vs 8.3 步）是**他们在自己 harness 上**测的，不构成我们这边的实测证据。
- 副作用一句：改提示词会让固定前缀变一次，前缀缓存需重建一轮，之后恢复。
