# Effect 4.0.5 工具 schema 编码回归：空结构根节点兜底对象定义

状态:implemented

## 问题

261022 依赖批次把 Effect 从 beta 升到 4.0.5 稳定版后，`Schema.toJsonSchemaDocument` 对空 `Schema.Struct({})` 的编码从 `anyOf[{type:"object"},{type:"array"}]` 改成 `{not:{type:"null"}}`（语义「任意非 null 值」）。`json-schema.ts` 的 `normalize` 有一个 `isEmptyStructUnion` 分支专门兜旧编码，新编码绕过了它——无参工具的 wire schema 顶层不再有 `type`。

后果：`todoread` / `plan` / `goal` 的 done、clear 四个无参工具，发到 OpenAI 兼容网关直接拒整单请求：

```
Invalid schema for function 'todoread': schema must be a JSON Schema of
'type: "object"', got 'type: "None"'.
```

实证：ses_ffe5e999（redmind 首轮，gpt-6-luna-fast / openai 通道，09:32:39）；Step 5 同型网关。客户端把服务端错误事件当流事件解析失败，渲染成一片 zod 报错墙——那是连锁症状，拒单原因只有 schema 一条。261022 批次验证没跑 `test/tool/parameters.test.ts`，断裂带病过关。

## 决策

`fromSchema`（全部工具 wire schema 的唯一出口）在根节点没有任何 schema 意图键（type / properties / items / anyOf / oneOf / allOf / $ref / enum / const / prefixItems）时，兜底补 `type: "object", properties: {}` 并丢掉孤立的 `not`。工具参数在传输层永远是对象，这个不变式由出口保证，不依赖 Effect 的编码细节。MCP 动态工具此前已自行强制 object（mcp/index.ts），同族先例。

补空 Struct 回归测试（json-schema.test.ts）；`plan` 快照存的正是兜底产物形状，修复后直接复活。

## 备选与否决理由

- **等 Effect 上游改回**：不可控，且新编码本身语义没错（错在我们依赖根必须是 object），上游大概率不动。
- **逐工具加 `jsonSchema` override**：散，每个新无参工具都会再踩。
- **在 `ProviderTransform.schema` 按模型修**：出口不唯一，遗漏面大。

## 后果与移交（Effect 编码审计批，未修）

同一次升级还改变了其他编码，已用探针逐一实证（beta 与 4.0.5 各跑一遍对照）：

1. **`.check()` 约束静默丢弃**：双 pattern 约束的 wire schema 只剩 `{"type":"string"}`，约束对模型不可见（beta 编码为 `allOf:[{pattern},...]`）。守门测试 `keeps repeated allOf constraints` 挂因。
2. **`additionalProperties` 从 `false` 松成 `true`**：wire 不再声明严格性（执行层 `unknownArgumentKeys` 与 Effect 解码仍兜底，模型侧影响小）。
3. **`annotate` 套在 `optional` 内层的 description 丢失**：todos 的 id/parent_id 字段说明对模型不可见（外层构造的工具如 edit 完好）。改构造（annotate 移外层）可绕。
4. **bash 快照欠再生**：shell 字段加入后没重跑守门测试，快照缺该字段（与本升级无关的存量债）。

修复前 stash 对照实证：bash / plan / allOf 三处失败中，plan 由本修复复活，其余两处先前已存在。识别签名：网关报 `got 'type: "None"'`；无参工具调用整轮被拒；`parameters.test.ts` 是这类回归的守门栅栏，升级 Effect 后必须跑。
