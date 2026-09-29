# 指令注入面：保留优先级显式化 + 声明行硬上限

状态:implemented

## 问题

第三方审计（`E:\dwonload\REDCODE_AUDIT_2026-09-29_ROUND2.md`，范围 dev 3b1fb50e..1ae505a1）
对 `1ae505a1`（指令注入面总量上限改为执行）提了两条，两条都坐实，且第二条**推翻了我自己
在 commit 里写的话**。

### A1（P1）声明行没有硬上限

```ts
parts.push(`[instruction budget] ${dropped.length} instruction source(s) dropped ...: ${dropped.join(", ")}. ...`)
```

`dropped` 的来源名来自 `config.instructions`，而那是 `Schema.Array(String)`、**没有长度
上限**——一条足够长的 glob 就能让声明行本身突破 `max_total_bytes`。我当时在 commit 与
note 里写「输出 ≤ maxTotalBytes + **有界**标记行」，那句是过度乐观：标记行当时一个字节
的上界都没有。

### A2（P1/P2）保留优先级与注入顺序混在一起

```ts
while (sources.length > 1 && total > maxTotalBytes) {
  const removed = sources.pop()!   // 从尾部丢
```

`sources` 的次序就是注入顺序（全局 AGENTS → 项目 AGENTS → 全局 MEMORY → 项目 MEMORY →
soul → config instructions），于是**丢的顺序也成了那个次序**：config instructions 与 soul
最先被丢。这个后果没有任何人设计过——它只是数组尾部的偶然。而 soul 是人格与声线、
config instructions 是用户显式配置的额外指令，把它们排在 MEMORY 和 AGENTS 前面丢，
说不过去。

### A5（P2）schema 文案漂移

`config/config.ts` 的 `max_total_bytes` description 还写着旧行为：「Warning threshold ...
Sources are still injected in full; crossing it logs which sources are largest」。实现早已
改成整份丢弃 + 单来源截断。

## 做法

### 1. 保留优先级成为显式维度

`RETENTION = { agents: 0, memory: 1, config: 2, soul: 3 }`，丢弃时每轮挑当前**最该丢的
那一份**（priority 大的先丢，并列时丢 order 大的——让靠前的已缓存前缀尽量不动）。
`splice` 保序，所以循环结束后 `sources` 仍是注入顺序，输出与缓存断点完全不变。

排序依据写进了代码注释：**「模型要正确干活，最不能少的是什么」**。AGENTS.md 是硬规则
（漏一条可能直接违反映该不该做某件事）→ MEMORY.md 是教训索引（丢了少一些触发提醒，
规则本身还在别处）→ config instructions 是用户自己选过的内容 → soul 只影响说话方式。

### 2. 发现逻辑与投影分离

原来只有一个 `systemPaths()` 返回 `Set<string>`，优先级无处安放；按路径字符串反推类别
又脆又会和发现逻辑漂移。改成内层 `discover()` 返回 `{path, kind}[]`，`systemPaths()` 与
`system()` 各取所需：

- `systemPaths()` = `new Set(found.map(i => i.path))`，**签名与行为不变**（`resolve()`
  与 10 处测试断言都靠它， blast radius 太大）
- `system()` 拿 `kind` 查 `RETENTION`

`Set` 的去重语义由 `add()` 里的 `found.some(...)` 等价保留。

### 3. 声明行上界由列举阶段保证

`budgetList(items, maxBytes)`：列满 `MARKER_ITEMS`(8) 条**或**吃满字节额度就停，其余
折叠成 `, and K more`。

上界之所以放在列举阶段而不是最后截断整串：截断会把一条长路径切成**看似合法的前缀**，
比明确的「这里被切了」更难发现问题。列举阶段收住之后，结尾永远是完整句子。
`truncateToBytes(marker, MAX - CUT_MARKER.length) + CUT_MARKER` 只作兜底——防有人把
前缀/后缀写长，那时宁可带省略标记也不能突破上界。

前缀/后缀只随 `maxTotalBytes` 的数字变长，`MARKER_RESERVE = 512` 对它们是 2.5 倍余量。

## 模型可见四问

1. **模型看到什么变了**：无新增段落。超预算时声明行内容可能变短（列举收上限），
   以及**丢弃顺序可能不同**——同样的预算下，现在先丢 soul 再丢 config instructions，
   过去正好相反。这是行为变更，但是被审计指出后才显式化的那个语义。
2. **token 影响**：预算内会话零增量；超预算会话声明行从「可能无限长」变为
   ≤ 2048 字节，是**减少**。
3. **KV cache 影响**：不动段落结构，不新增固定前缀。超预算会话的内容变化本来就会
   让该轮前缀作废，与本次改动无关。
4. **注入项有没有硬上限**：有，且这次是真的。输出 ≤ maxTotalBytes（保留部分）
   + ≤ 2048 字节（声明行）+ 一行 ≤ 14 token 的 OVERRIDE 声明。

## 验证

- `bun test ./test/session/instruction.test.ts` → 22 pass 0 fail（新增 2 条）
- oxlint 两文件 → 0 warning 0 error
- typecheck → EXIT 0
- `check:openapi-drift` → ✅ 一致（内层字段 description 不进 openapi，见下）

新增两条回归：
- `drops soul before AGENTS.md and MEMORY.md when the budget is tight`
- `caps the dropped-source notice so the marker itself cannot blow the budget`

第一条刻意用 `rules.filter(r => r.startsWith("Instructions from:"))` 而不是
`rules.some(...)`——声明行里也含被丢来源的路径，混在一起断言会因错误的原因通过
（我第一版正是这么写的，它确实因错误原因挂了）。

## 顺带发现（未修）

`instruction_budget` 的**外层** description（"Instruction prefix budget and remote fetch
timeout"）能进 `packages/sdk/openapi.json`，但**内层四个字段**的 description 全部丢失
（`max_source_bytes` / `max_total_bytes` / `max_resolved_bytes` / `fetch_timeout_ms`）。
`instructions` 与 `formatter` 的 description 同样丢失，而 `lsp` 的没有。

即：这些内层注释对 SDK 消费者不可见。不影响行为，是文档生成面的既有缺口，
不属于本次改动范围，记在这里备查。

## 回链

- `packages/opencode/src/session/instruction.ts` — `RETENTION` / `discover` / `budgetList`
- `packages/opencode/src/config/config.ts` — `instruction_budget.max_total_bytes`
