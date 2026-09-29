# OpenAPI：单臂 optional 塌缩丢掉外层 description，Config 40 个字段丢了 37 个

状态:implemented

## 问题

`instruction_budget` 的四个内层字段（`max_source_bytes` / `max_total_bytes` /
`max_resolved_bytes` / `fetch_timeout_ms`）的 description 进不了
`packages/sdk/openapi.json`。最初把这记成「外层能进、内层不能」，**实际调查发现
这个描述是错的**：外层同样进不去，而且范围远大于一个字段。

`Config` 共 40 个 property，openapi 里只有 **3 条** description 活着
（`autoupdate` / `formatter` / `lsp`）。全仓 components 里 description 总数只有
42 条。

## 根因

`packages/opencode/src/server/routes/instance/httpapi/public.ts` 的
`stripOptionalNull()`。Effect 的 `Schema.optional(X)` 在 OpenAPI 里 emit 成
`{anyOf: [X, {type: "null"}], description: "..."}`——description 挂在**外层
optional 节点**上。而 `stripOptionalNull` 为了把 null 臂剔掉（legacy SDK 期望
optional 字段就是 plain `T`），写了：

```ts
const options = flattenOptions(schema.anyOf ?? schema.oneOf)
if (options) {
  const withoutNull = options.filter((item) => item.type !== "null")
  if (withoutNull.length === 1) return stripOptionalNull(withoutNull[0])   // ← 外层连同 description 一起丢
  ...
}
```

过滤掉 null 后只剩一个臂时直接 return 那个臂，外层 schema 自己的 metadata 被
一起丢掉。

于是**一个字段的描述能不能活，取决于它的 union 有几个非 null 臂**：

| 字段 | 声明形态 | 非 null 臂数 | 描述 |
|---|---|---|---|
| `autoupdate` / `formatter` / `lsp` | `optional(Union([Boolean, ...]))` | 2 | 活 |
| `instructions` | `optional(mutable(Array(String)))` | 1 | 丢 |
| `instruction_budget` | `optional(Struct({...}))` | 1 | 丢 |
| `enterprise` / `webfetch` / `tool_output` / `compaction` | `optional(Struct(...))` | 1 | 丢 |
| `attachment` | `optional(ConfigAttachment.Info)` → `$ref` | 1 | 丢 |
| `ProviderConfig.chunkTimeout` / `setCacheKey` | `optional(...)` | 1 | 丢 |
| `instruction_budget.*` 四个内层字段 | `optional(PositiveInt)` | 1 | 丢 |

`ProviderConfig.timeout` 是唯一有描述的同类字段，因为作者把同一句话**抄了两份**——
内层 `Schema.Union(...).annotate()` 一份、外层 `Schema.optional(...).annotate()`
一份（`src/config/provider.ts:99-107`）。那个重复抄写就是本 bug 的工号：它让
`timeout` 成了「看起来正常」的样板，后人照抄就会继承两份维护。

## 修法

单臂塌缩时把外层的 description 合并回唯一存活的臂，臂自己带描述时以臂为准
（更具体）：

```ts
if (withoutNull.length === 1) {
  const only = stripOptionalNull(withoutNull[0])
  return schema.description && !only.description ? { ...only, description: schema.description } : only
}
```

只动这一处，不改 null 剥离语义、不改任何 schema 声明。

## 影响面量化

| | 修复前 | 修复后 |
|---|---|---|
| 全仓 components description 条数 | 42 | 142 |
| `Config` 内 description 条数 | 3 | 59 |
| `instruction_budget` 五条描述 | 0 | 5 |

`packages/sdk/openapi.json` 702745 字符（原 689836），`types.gen.ts` +321 行
（JSDoc 注释）。**只增注释，不改任何类型形状**——`check:openapi-drift` 通过。

## 验证

- `bun run gen:openapi` 重生 + `bun run check:openapi-drift` ✅ 一致
- `bun ./packages/sdk/js/script/build.ts` 重生 `types.gen.ts`，五条描述全部到位
- `packages/opencode` 与 `packages/app` typecheck 均 EXIT 0
- `bun run test:httpapi`：pass=157 fail=0，missing=2 —— 两条缺失
  （`GET /session/usage`、`GET /session/{sessionID}/outline`）经 `git show HEAD:packages/sdk/openapi.json`
  确认在改动前就存在，与本次无关
- `bun test ./test/tool/parameters.test.ts`：56 pass / 2 fail，与 HEAD 基线一致
  （`edit > rejects missing filePath`、`JSON Schema (wire shape) > bash` 均为既有失败）
- oxlint `public.ts`：0 warning 0 error

## 已知残留（未修）

`flattenOptions()`（同文件 509 行）是第二处丢失点：它扁平化嵌套 union 时把
**中间节点**连同其 description 一起丢掉。表现是
`ProviderConfig.timeout` 那种「内层 union 上的 description」仍然活不了——
只是该作者恰好抄了外层一份所以看不出。本次不修：修它要改 emit 出来的 union
嵌套形状（会动生成类型），而现状已有工号式的双抄可绕开，收益不抵风险。

## 备选否决

- **在每个丢描述的字段上把 description 抄两份**（照抄 `timeout` 的工号）：
  能逐字段救回来，但把 bug 固化成正则模式，且每加一个字段都要记得抄。
- **改 schema 声明，把 `optional(X)` 换成 `optional(Union([X, Literal(undefined)]))`
  之类凑多臂**：用声明形态绕开后处理 bug，比抄描述更难看懂。
- **在 `normalizeComponentDescriptions` 里加白名单**：那函数已经在用白名单
  （`LegacyComponentDescriptions` 只有 3 条），且它删的是 component 顶层 description、
  不是 property 级的，治不了本。
- **丢掉 legacy 兼容、不剥 null**：`stripOptionalNull` 的存在是为了让 legacy SDK
  的 optional 字段保持 plain `T`，动它等于改 SDK 对外契约。
