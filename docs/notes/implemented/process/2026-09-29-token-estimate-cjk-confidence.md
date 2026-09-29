# token 估算：CJK 加权只进诊断侧，confidence 按分组标

状态:implemented

## 问题

`Token.estimate` 是 `Math.round(length / 4)` —— 纯字符数除法。本仓注入面以中文为主
（AGENTS.md / MEMORY.md / soul），而 CJK 字符在 BPE 下远不止一个 token，于是**诊断侧
数字系统性偏低**。实测本机五份注入全文（合计 57759 字节）：

| 来源 | 字符 | CJK | 朴素 | 加权 | 偏差 |
|---|---|---|---|---|---|
| 全局 AGENTS.md | 8569 | 4038 | 2142 | 3152 | 1.47× |
| 全局 MEMORY.md | 5959 | 2189 | 1490 | 2037 | 1.37× |
| 项目 AGENTS.md | 9599 | 2324 | 2400 | 2981 | 1.24× |
| 项目 MEMORY.md | 5509 | 1218 | 1377 | 1682 | 1.22× |
| soul | 1930 | 1445 | 483 | 844 | 1.75× |
| **合计** | | | **7892** | **10696** | **低估 36%** |

偏得最狠的是 soul（几乎纯中文，1.75×）。受影响的是 `context-snapshot` 的用量面板与
`prefix-shape` 的前缀诊断——两者都是**给人看的**，偏低会让「前缀才 8K，还有余量」
这类判断出错。

第二个问题：`ContextSnapshot.Info` 的 system/tools/messages 三组 token 没有任何置信度
标注，而三者的可靠程度差得很远——system 是纯文本，tools 是 JSON schema（键名、引号、
嵌套括号这些结构性 token 主导，CJK 加权对它们几乎无意义）。面板上三个数并排显示，
读者无法分辨哪个能信。

## 做法

### 1. 新增 `Token.estimateReporting`，不动 `estimate`

`estimateReporting` 把 CJK（中日假名 + 统一表意 + 扩展 A + 兼容表意 + 半角片假名）
按 2 倍权重计入后再除 `CHARS_PER_TOKEN`。权重是**借来的未校准启发式**——抄自 ZCode 的
`estimateTokens`（`apps/zcode-cli/packages/core/src/context/utils.ts:12-18`），它自己的
注释也只敢写 "for debugging and monitoring"。本仓没有真 tokenizer（tiktoken /
gpt-tokenizer / js-tiktoken 均未装，package.json 也无依赖），所以这个数只能进诊断侧。

**为什么不直接改 `estimate`**：它的调用面横跨行为与诊断两侧——

- 行为侧：`image-tokens.ts:178,181,204`（工具结果 token 硬限）+ `compaction.ts:403`
  （压缩判定）
- 诊断侧：`context-snapshot.ts:116,138,146` + `prefix-shape.ts:80,122`

更关键的是 `truncateToTokens` 拿 `CHARS_PER_TOKEN` 做 `estimate` 的**逆换算**
（`image-tokens.ts:132` 注释明说「token ↔ 字符用 CHARS_PER_TOKEN 换算，与 Token.estimate
同一口径……换成别的比例，『估算不超预算』这个承诺就不成立了」）。改 `estimate` = 让
逆换算与正向估算错口 = 改行为，得先独立测量压缩触发点的位移，不塞进一个「让 UI 数字
更准」的改动里。

两个估算器并存**不是漏了抽取，是故意不对称**：budget 估算器必须能和逆换算对齐，
reporting 估算器要近似真 tokenizer。这一点写进了 `token.ts` 的头注释——本仓有
「无法解释的不对称通常意味着漏了一次抽取」这条红线，不写清理由，后人迟早把两者
「统一」回去。

### 2. confidence 按分组标，不按 segment 标

`ContextSnapshot.Info` 的 system / tools / messages 各加一个 `confidence` 字段
（`Schema.Literals(["low", "medium"])`），取 medium / low / medium。定这个值的依据是
**数据形态、不是大小**：同一快照里每个 segment 用的是同一个估算器，逐段标注等于给每段
重复同一个常量。取自 ZCode 的 context-usage breakdown 思路
（`.../runtime/methods/context-usage.ts:119-253`，它按 system / tool schema / message
role 分别标置信度）。

### 3. SDK 生成物同改并重生

`Segment.tokens` 的 description 原本写死 `"Estimated tokens (chars / 4)"`——改估算器后
这句变成假话，必须同改。`ContextSnapshot.Info` 经
`server/routes/instance/httpapi/groups/session.ts:228` 暴露，加字段触发
`script/check-openapi-drift.ts`（CI 门禁，`.github/workflows/test.yml:93`）。重生是两条
命令，只跑第一条会漏掉 `packages/sdk/openapi.json`：

```
bun ./packages/sdk/js/script/build.ts
bun run --cwd packages/opencode --conditions=browser src/index.ts generate > packages/sdk/openapi.json
```

跑完 `check:openapi-drift` 报 ✅ 一致（689836 字符）。

### 4. 文案补上「这是估算」

`context.inspect.note` 三语言原文都说「实测值」。那说的是**范围**（确实取自发出去的
那一个请求，不是客户端估算），但 token 数本身是估算——原话把两件事混成一句，读者会以
为数字精确。zh/en/ja 三份都补一句。

## 模型可见四问

这一改动**不进模型上下文**（context-snapshot 是服务端观测数据，只经 HTTP 给 UI）：

1. **模型看到什么变了**：无。
2. **token 影响**：固定前缀 0 增量。
3. **KV cache 影响**：完全不动。
4. **注入项有没有硬上限**：不适用——没有新增注入项。

（`Segment.tokens` 与三个 `confidence` 的 description 变化只影响 SDK 生成物与 UI 文案。）

## 备选与否决

- **直接改 `Token.estimate`**：否决。会同时改掉工具结果硬限与压缩触发线的判定，
  且破坏 `truncateToTokens` 的同口径逆换算。那是行为变更，需要独立测量，不属于
  「让诊断数字更准」这个改动的范围。
- **装真 tokenizer（tiktoken / gpt-tokenizer）**：否决。新增依赖 + 每次估算一次
  编码，而 context-snapshot 是每轮请求都要跑的路径；`messageFacts` 靠 WeakMap 按
  对象引用记忆才把稳态成本压到「只算新增几条」，换成真 tokenizer 那个优化就废了。
  真要用，先证明 CJK 加权不够。
- **confidence 加在 Segment 上**：否决。同一快照内所有段同一个估算器，逐段标注是
  常数噪音。
- **confidence 只加一个顶层字段**：否决。三组的数据形态差异正是这个字段要表达的
  信息，压成一个值就丢了。
- **UI 新增一个置信度徽章/图例**：否决。改 `context.inspect.note` 一句话就够，
  新增控件要过 frontend-design 的字阶与 token 约束，为一句说明付那个代价不划算。

## 后果（未做）

- 韩文音节（`\uac00-\ud7af`）与其余脚本同理但本仓用不到，刻意不收进加权范围——
  加权范围写多大就得为多大范围负责。真有韩文注入需求时再扩。
- 2 倍权重是借来的常数，没有针对本仓实际模型做过校准。校准需要一样本：拿真实请求
  的 messages 与 provider 返回的 usage 对账。这是后续可做项，不是本改动的阻塞。
- 盘上的旧快照文件没有 `confidence` 字段。`load()` 是 `JSON.parse(...) as Info` 的裸
  转换、不做校验，所以旧文件读回来该字段为 `undefined`；快照本质是缓存，下一轮
  `record()` 就覆盖，UI 侧当前也没有读它，故不处理。

## 验证

- `bun test ./test/util/token.test.ts ./test/session/context-snapshot.test.ts
  ./test/session/prefix-shape.test.ts` → 44 pass 0 fail（新增 8 + 4 条）
- `packages/opencode` typecheck → EXIT 0（tsgo 崩后退回 TS 5.9.3，零 `error TS`）
- `packages/app` typecheck → EXIT 0
- oxlint 五个文件 → 0 error，10 warning 全在既有行（`prefix-shape.ts:66,96`、
  `context-snapshot.ts:114,241`、`context-snapshot.test.ts:67,88,165,183`）
- `check:openapi-drift` → ✅ 一致
- httpapi exerciser coverage mode → `context-inspect` PASS（157 pass 0 fail；
  2 个 MISS 是 `/session/usage` 与 `/session/{sessionID}/outline` 缺场景，
  与本改动无关的路由树/场景清单既有状态）

## 回链

- `packages/opencode/src/util/token.ts` — `estimateReporting`
- `packages/opencode/src/session/context-snapshot.ts` — `Info` 的 confidence 字段
- `packages/opencode/src/session/prefix-shape.ts` — `schemaCosts` / `capture`
