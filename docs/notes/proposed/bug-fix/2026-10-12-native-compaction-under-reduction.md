# 原生压缩归约不足：`selectAutomatic` 静默降级 best-effort，长任务退化成压缩风暴

状态:proposed

## 问题

用户在排查 gpt-6.1-sol 缓存命中率（见 `proposed/bug-fix/2026-10-12-gpt-6.1-sol-cache-instability.md`）后追加两问：① **换掉 DCP `compress` 改用原生 compaction，是不是引入了回归？** ② 用缓存好的 GLM / DeepSeek 做对照，**两代差别是不是只有 GPT 有？**

用两代各自的真实压缩事件对账（`~/.redcode/data/redcode.db`：DCP 侧取 `part` 里 `tool=compress` 的调用时刻，原生侧取 `context_compaction_block.committed_at`；压缩代价统一用 `message.data.tokens.context` / `cache.read`，即 provider 实报口径），答案是：**① 是；② 机制是通用的，但账单只有 GPT 在付**——详见实证五。

### 时间边界

- **DCP `compress` 代**：2026-06-05 → 2026-10-10，`compress` 工具调用 1,200+ 次。
- **原生 compaction 代**：2026-10-10 起（`0a004738` 12:34 落地，`05dc6355` 19:58 播种配置切换），账本 `context_compaction_block` 仅 20 行。

### 实证一：每次压缩的归约率掉了一半

只看 GPT 家族、取「事件前最后一条非 compaction 请求」与「事件后第一条请求」：

| | DCP `compress` (n=411) | 原生 compaction (n=13) |
|---|---:|---:|
| 压前 ctx 中位 | 223,322 | 247,564 |
| 压后 ctx 中位 | 129,775 | **197,852** |
| **归约率中位** | **39.8%** | **20.5%** |
| 恢复轮 read 中位 | 35,328 | 34,304 |
| **恢复轮全价缺失中位** | **77,274** | **149,168** |

关键在最后两行：**GPT 两代的恢复轮都只命中约 34–35k token**（固定 system+tools 前缀），差别全在压后体积。原生压后留 197,852，于是同一次压缩要按全价重付 149k；DCP 压后 129,775，只付 77k。**命中率差不是"缓存策略"问题，是"压后历史没变小"问题。**（注意这条**只对 GPT 成立**——GLM/DeepSeek/Step 的恢复轮 read 是 84–103k，缓存能跨过历史改写，见实证五。）

### 实证二：归约率是双峰的，30%~50% 之间一个样本都没有

```
DCP compress (n=411, 中位 39.8%)          原生 compaction (n=13, 中位 20.5%)
 -100~0   45 (10.9%)                       -100~0    1 ( 7.7%)
    0~10   33 ( 8.0%)                          0~10   4 (30.8%)
   10~20   27 ( 6.6%)                         10~20   1 ( 7.7%)
   20~30   29 ( 7.1%)                         20~30   2 (15.4%)
   30~40   72 (17.5%)                         30~40   0
   40~50   84 (20.4%)                         40~50   0
   50~60   59 (14.4%)                         50~60   2 (15.4%)
   60~70   39 ( 9.5%)                         60~70   2 (15.4%)
   70~80   22 ( 5.4%)                         70~80   0
   90~101   1 ( 0.2%)                         90~101  1 ( 7.7%)
```

DCP 是平滑单峰；原生**要么压到 50–64%，要么只有 7–23%，中间是空的**。这种双峰是「有阈值判定 + 达不到就静默降级」的指纹——正好对上代码里的 `required` 与 fallback 分支。

### 实证三：压缩风暴——单会话 3 小时 10 次压缩，157 万 token 全价

`ses_ffe5ed25a2347ffez61We6cc4mxJ4O`（2026-10-12 09:31 → 12:44）：

```
 #  time      model           before     after   red%   recRead   recMiss   srcN protN protChars
 2  10:39:43  gpt-6-luna     244,030   194,086  20.5%         0   194,086     56    43    26,549
 3  11:00:20  gpt-6-luna     301,652   232,904  22.8%    34,304   198,600    117    45    26,638
 4  11:08:45  gpt-6-luna     246,617   227,790   7.6%    34,304   193,486    148    48    26,782
 5  11:29:39  gpt-6-luna-fast 315,364  136,469  56.7%    34,304   102,165    294    75    45,968
 6  11:54:54  gpt-6-luna     248,511   231,216   7.0%    34,304   196,912    303    76    45,984
 7  12:10:43  gpt-6-luna     341,964   123,409  63.9%    34,304    89,105    404    97    82,444
 8  12:30:38  gpt-6-luna     216,969   201,617   7.1%    34,304   167,313    412    99    82,450
 9  12:38:10  gpt-6-luna     215,274   181,317  15.8%    34,304   147,013    426   100    82,454
10  12:44:36  gpt-6-luna     229,881   209,881   8.7%    34,304   175,577    447   100    82,454
```

**10 次压缩、恢复轮全价缺失合计 1,571,823 token**（另有 3 次 `step-5-preview` 摘要请求各 46–74k，当时摘要模型还没继承主模型）。

每次只压掉 7–23%，于是 200k 上下的上下文很快又顶回触发线，8–25 分钟后再压一次。**触发线被本地层遮蔽（`redcode.local.jsonc` 压着 `redcode.jsonc` 的同名键，当日实测 250k 照样触发）是放大器，不是根因**——根因是压不动，否则一次就该退到 target 附近。

### 实证四：账本显示块在「越长越大」，锚点从不前移

同一会话 10 个块（按提交序）：

| | #1 | #2 | #3 | #4 | #5 | #6 | #7 | #8 | #9 | #10 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `sourceMessageIDs` | 37 | 56 | 117 | 148 | 294 | 303 | 404 | 412 | 426 | 447 |
| `protectedRecords` | 41 | 43 | 45 | 48 | 75 | 76 | 97 | 99 | 100 | 100 |
| 保护正文（字符） | 25,932 | 26,549 | 26,638 | 26,782 | 45,968 | 45,984 | 82,444 | 82,450 | 82,454 | 82,454 |

- `sourceMessageIDs` **单调增长且恒以会话首条消息开头**：10 个块的 `anchorID` 全部等于 `msg_001a12da5dc9a001…`，即会话第一条消息。**锚点从不前移**，每个新块都要重新吞掉全部历史。
- `protectedRecords` 单调累积：41 → 100 条、25,932 → 82,454 字符（≈28k token）。

### 实证五：代价不对称——GLM/DeepSeek/Step 近乎免疫，GPT 承担全部伤害

上面四条都在说"压不动"。但**压不动的代价不是恒定的**：恢复轮要按全价重付多少，取决于该 provider 的缓存能不能跨过历史改写。用缓存最好的三家（GLM / DeepSeek / Step）做对照，结论是同一个 bug 在它们身上几乎不花钱。

**5a. 同会话对照（最强证据）**。`ses_ffe5f577ade1cffexwjEs1ufYf7Fd1`（09-16「RedCode-dcp 压缩过晚与预算不足排查」，650 请求，DCP 代）里 **deepseek-flash 和 gpt-5.6-luna-fast 交替跑，用的是同一个 `compress` 机制**：

| 恢复轮模型 | 压缩事件 | 压前 → 压后 | 恢复轮全价缺失（非零，中位） |
|---|---:|---|---:|
| deepseek-flash | 6 | 167k→52k / 241k→56k / 135k→86k / 224k→151k / 172k→113k | **21,765** |
| gpt-5.6-luna-fast / terra | 5 | 278k→137k / 274k→129k / 274k→99k / 282k→132k / 287k→125k | **96,090** |

同一会话、同一机制、同一时间窗，**DS 的压缩代价中位是 GPT 的 1/4.4**。

**5b. 全 DCP 代汇总（按恢复轮首个请求的模型归因）**：

| 家族 | 事件数 | 压前 ctx 中位 | 压后 ctx 中位 | 归约率中位 | 恢复轮缺失中位 | **缺失 / 压后 ctx** |
|---|---:|---:|---:|---:|---:|---:|
| deepseek | 252 | 158,200 | 112,406 | 19.4% | **9,112** | **8.1%** |
| zhipuai/glm | 98 | 178,306 | 99,494 | 36.6% | **15,734** | **15.8%** |
| stepfun/step | 107 | 182,983 | 84,760 | 47.0% | **15,109** | **17.8%** |
| openai/gpt | 411 | 223,322 | 129,775 | 39.8% | **77,274** | **59.5%** |
| openai/gpt（native 代） | 13 | 244,030 | 181,317 | 20.5% | **149,168** | **82.3%** |

压后上下文里"没被缓存到"的比例：国产三家 **8–18%**，GPT 在 DCP 代就已 **60%**，原生代涨到 **82%**。

**5c. 恢复需要几个请求**（压缩后连续 `hit < 90%` 的请求数）：

| 家族 | 代 | 事件数 | 中位 | 均值 | >1 的比例 |
|---|---|---:|---:|---:|---:|
| deepseek | DCP | 252 | **0.0** | 0.54 | 7.1% |
| zhipuai/glm | DCP | 98 | 1.0 | 0.87 | 18.4% |
| stepfun/step | DCP | 107 | 1.0 | 0.82 | 8.4% |
| openai/gpt | DCP | 411 | 1.0 | 1.11 | 19.2% |
| **openai/gpt** | **native** | 13 | **2.0** | **1.62** | **53.8%** |
| zhipuai/glm | native | 2 | 1.0 | 1.00 | 0% |
| stepfun/step | native | 5 | 1.0 | 1.20 | 20% |

DeepSeek 中位 **0**——压缩后的**下一个请求就已经 ≥90%**，历史改写对它几乎零成本。GPT 在原生代中位 **2**，即连续两个请求全价（例：`12:30:38` 缺 167,313 → `12:30:52` 仍缺 168,067 → `12:31:19` 才回到 98.9%，单次压缩实付 **335,380**）。GLM 的对照：`09:31:14` 缺 107,566 → `09:31:32` 即 99.3%，只付一个请求。

**5d. 聚合命中率（`read/ctx`）**：

| 家族 | DCP 代 | native 代 | Δ |
|---|---|---|---|
| zhipuai/glm | 97.6%（7,994 请求 / 1.11B token） | **97.1%**（521 / 78.9M） | −0.5pt |
| stepfun/step | 96.3%（14,981 / 1.85B） | 94.2%（283 / 40.5M） | −2.1pt |
| openai/gpt | 95.1%（17,876 / 2.96B） | **91.5%**（641 / 126.9M） | **−3.6pt** |
| deepseek | 97.8%（8,122 / 1.17B） | 无 native 代数据 | — |

**5e. native 代 GLM/DeepSeek 几乎没有压缩事件**：GLM 2 次、Step 5 次、**DeepSeek 0 次**。所以回归的爆炸半径目前还没落到它们身上——**不是免疫，而是**(a) 它们的会话基本顶不到 250–400k 触发线，(b) 就算压了，恢复只要 1 个请求。唯一那次 native 代 GLM 压缩（`ses_ffe5edb2d573cffeY3rQYdzKYaRK6T`，10-12 08:14:38）落在双峰的**高簇**：249,514 → 116,549（**53.3%**），恢复 1 个请求，缺失 83,781。

**5f. 数据质量坑（必须记住）**：`message.data.tokens.cache.miss` 对 **DeepSeek 不可信**——8,122 条请求里 **2,726 条报 `miss=0` 而 `ctx-read > 1000`**；`sum(cache.miss)`=1,385,546 vs 真实 `sum(ctx-read)`=26,004,379，**低估 19 倍**（DeepSeek 的 usage 只回 `prompt_cache_hit_tokens`，适配层没映射 miss）。glm / gpt / step / other 四个家族两值**完全相等**。**命中率一律用 `read/ctx` 算，不要用 `read/(read+miss)`**。

具体踩坑实例（本次排查真实发生过，别重犯）：按 `read/(read+miss)` 统计出 `provider=deepseek / model=deepseek-flash` = **"3,556 请求 / 576,363,736 token / 命中率 100.0%"**，看着像某个超长会话的完美缓存。实际那 **576M 是 29 个会话的聚合**，真实命中率 **97.6%**（缺口 13.8M token 被 `miss=0` 吞掉）。同族修正后：`deepseek-v4-flash-vision-exp` 293.6M/98.2%、`opencode-go/deepseek-v4-flash-vision-exp` 202.3M/98.0%。单会话最好的几个是 98.9%（`ses_ffe5fc474240fffeR9F9bVYu7A1Qis`，48.6M）、98.8%（`ses_ffe5fc4236642ffeBLN1zNkTjCW7tJ`，51.3M）、98.6%（`ses_ffe5f38a0c846ffeL134serrZDzbRe`，44.6M）——**没有 100%，"100%" 是分母错了**。

## 决策

**已确认是回归，但暂不落地修复**（本次只出诊断）。根因链如下，修复需按此顺序决策：

1. **`selectAutomatic` 达不到 `required` 时静默降级。** `native-context.ts:80` 算出
   `required = max(summaryMaxTokens, total - targetTokens + summaryMaxTokens)`；`:100` 命中即返回；但循环走完仍不够时，`:102-103` 直接 `return messages.slice(bestStart, bestEnd + 1)`——**best-effort，不报错、不告警、不回执**。这就是双峰的来源。同文件 `commit` 侧只有 `context-compaction.ts:199` 的 `if (Token.estimate(render(block)) >= before) throw "no positive savings"` 兜底——**它只要求「有一点点收益」，不要求「达到 target」**，所以压掉 15k 也算成功提交。
2. **`required` 够不到，是因为可回收量被保护记录吃掉了。** `context-compaction.ts:164` 新块 `protectedRecords.push(...old.protectedRecords)` 机械继承旧块，`:84` 的 `render()` 把保护记录**全文重新物化**进投影。于是锚点消息的 `retained`（`context-compaction.ts:346-349`，锚点直接取整块的 `protectedRecords`）逐轮变大，同一份内容既算进 `total` 又不算进 `released`，`required` 越来越够不到。
3. **锚点不前移放大了 2。** 块链是「新块消费旧块」（`consumedBlockIDs` 恒为 1），但 `anchorID` 不跟着前移，导致保护记录只能越攒越多、永远没有收敛出口。
4. **保护记录只有上界没有收敛。** 只受 `active_max_tokens` 80,000 / `active_max_bytes` 524,288 约束（`config/native-compaction.ts:68-73`），实测已到 82,454 字符且单调增长；`protected_tools` 默认 `[task, task_status, skill, todowrite, todoread]`，长任务里 `task` 输出是主要来源。
5. **代价被 provider 缓存存活率放大（实证五）。** 同一份"压不动"的结果，DeepSeek 只赔一个请求的 8%，GPT 赔两个请求的 82%。所以**这个 bug 的紧急度和修复收益按 provider 分层**：GPT 最高，Step/GLM 次之，DeepSeek 最低。反过来说，任何"用一个全局阈值/全局预算治理压缩成本"的方案都会算错账。

**拟修（按性价比排序）**：

- **A. 让降级可见。** `selectAutomatic` 在 best-effort 返回时把 `released < required` 带出来，由 `compaction.ts:475-490` 走既有的失败记录路径（`Native compaction was not committed`），或至少在回执里标注。当前「压了等于没压」伪装成成功，是这个问题潜伏两天没被发现的直接原因。**已落地**：`4d1234c1`（`planAutomatic` 返回 required/released + `native compaction shortfall` 日志）。
- **B. 锚点前移。** 新块 `anchorID` 取「上一个被消费块的 `sourceMessageIDs` 末尾之后的第一条被选消息」，让块链有界；否则保护记录与 `sourceMessageIDs` 都是无界的。
- **C. 保护记录参与收敛。** 已继承的保护记录在下一轮要么按 `condensedSummaries` 的既有机制收束，要么在算 `required` 时从 `total` 里扣除（它们本来就不产生回收量）。**部分落地**：`context-compaction.ts` `carryProtected()`——继承记录按 `retained_max_tokens`（默认 20k，对齐 codex `COMPACT_USER_MESSAGE_MAX_TOKENS`）预算携带，用户原文优先、最新优先、整条保留或丢弃，超限退账本读回（对照笔记借鉴项 #1/#2 的账本保留版）；`required` 口径的扣除仍未做。
- **D. 兜底触发线不要低于「一次压缩能退回的量」。** 压不动 + 低触发线 = 风暴；两者的乘积才是伤害。当前 400k 触发 / 120k 目标是安全的，但**不要为了省 token 把触发线调低**——在 A/B/C 落地前，调低触发线会直接把 GLM/Step 也拖进风暴。
- **E. 恢复代价按 provider 记账（实证五）。** 若将来要做"压缩值不值"的判定（例如自动 vs 手动、触发线自适应），判据必须带 provider 维度：DeepSeek 的压缩几乎免费，GPT 的压缩每次两轮全价。用统一的"压缩成本 ≈ 若干 token"参数会系统性低估 GPT、高估 DeepSeek。

## 备选与否决理由

- **"这是供应商/网关问题"**：否决——同会话、同 endpoint、同 account 下 glm-5.3-flash 命中率 97.5%、gpt-6-luna-fast 96.9%，只有压缩边界后的那一轮全灭；`request-evidence` 的 `system`/`tools`/`parameters` sha 在风暴期间全程 `unchanged`。**但要说清边界**：根因（压不动）在客户端，**账单大小**确实由 provider 缓存存活率决定（实证五）——这两件事不矛盾，不能拿后者否定前者。
- **"GLM/DeepSeek 看着没事，所以不是回归"**：否决——它们没事是因为 (a) 会话顶不到触发线、(b) 恢复只要 1 个请求，不是因为 `selectAutomatic` 对它们特殊对待。同一个 `view` 交给同一个选择器，静默降级的条件是模型无关的。判据：把触发线调低到它们会触发的区间，它们会立刻复现同样的低簇归约率（实证五 5e 那唯一一次 native GLM 压缩就落在高簇，纯属运气好凑够了 `required`）。
- **"触发线抬高就没问题了"**：否决——触发线从 250k 抬到 400k 只是把风暴周期拉长，单次压缩仍然压不动，代价仍在（本次实测恢复轮中位全价缺失 149k，是 DCP 代的 1.9 倍）。且 400k 对 500k 甜点位的 gpt-6.1-sol 余量本就只有 100k。
- **"原生整体比 DCP 更省，不用修"**：**部分成立但危险**。全 era GPT 流量口径：原生 0.10 次压缩/1M token（DCP 0.53），压缩恢复缺失占流量 1.3%（DCP 1.0%）——总量确实没恶化。但这个"没恶化"完全靠触发线从 220k 抬到 250–400k 换来；一旦触发线下调（小窗口模型按比例夹取、或本地层遮蔽回退），压不动的单次代价立刻按 2.2 倍放大。
- **回退到 DCP**：否决——`2026-10-10-native-compaction.md` 已定整合方向（消插件维护、账本/投影/提交/预算边界），且 DCP 的 39.8% 归约是模型选段的结果、不可复现也不可审计；要修的是原生选段算术，不是换回插件。

## 后果

- **识别签名**（防复发）：`context_compaction_block` 里 `sourceMessageIDs` 单调增长且各块 `anchorID` 相同；`protectedRecords` 条数与字符数单调增长；同会话连续多次压缩的归约率落在 {≤23%} 与 {≥50%} 两个簇、中间为空。出现任一条即命中本问题。
- **代价分层（实证五的结论）**：`selectAutomatic` 的静默降级是**通用**的（与模型无关，任何家族只要顶到触发线都会遇到），但**账单是按 provider 分的**——恢复轮缺失 / 压后 ctx：DeepSeek 8.1%、GLM 15.8%、Step 17.8%、GPT 60%（DCP）/ 82%（native）。**排查压缩成本时必须先看 provider 再下结论**；同理，`implemented/feature/2026-08-17-compaction-cache-miss-cost.md` 里「每次压缩固定全灭 ≈22.6 万 token」的常数只对 GPT 类严格缓存成立，对 DeepSeek 高估了一个数量级。
- **数据质量规则**：`tokens.cache.miss` 对 DeepSeek 恒为 0（8,122 条里 2,726 条 `miss=0` 而 `ctx-read>1000`，总量低估 19 倍）。**命中率统一用 `read/ctx`**；`cache.miss` 只在 glm/gpt/step 上等于 `ctx-read`。这条对以后所有缓存分析生效。
- **样本量限制**：原生代只有 13 次 GPT 压缩事件 / 2 天（DCP 代 411 次 / 127 天）；GLM native 代 2 次、DeepSeek native 代 0 次。**聚合口径不可比，单次代价口径与分布形状可比**——结论以后者为准。原生代聚合还混入了 `0dc25392`（10-12 11:15）之前的 variant 抖动 bug，见 `2026-10-12-gpt-6.1-sol-cache-instability.md`。
- **配置层牵连**：`redcode.local.jsonc` 会遮蔽 `redcode.jsonc` 同名键，当日 `250k` 照样触发才暴露（本地层注释已记）。压缩类配置改完必须核对**生效值**而非源文件值。
- **与既有 note 的关系**：`implemented/feature/2026-08-17-compaction-cache-miss-cost.md` 记录的是 legacy compaction 的「2 次全灭 ≈22.6 万 → 优化到 ~10 万」；本次实测原生恢复轮中位全价缺失 149k，**原生当前不在那个优化水平上**，该 note 的结论不能直接套用到原生路径。
- 回链：`native-context.ts:80/100/102-103`、`context-compaction.ts:84/164/186/199/346-349`、`compaction.ts:471-490`、`config/native-compaction.ts:68-73/174`。
