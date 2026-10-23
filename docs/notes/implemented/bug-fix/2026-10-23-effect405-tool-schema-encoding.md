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

## 后果与审计结论（261023 同批收口）

同一次升级还改变了其他编码，已用探针逐一实证（beta 与 4.0.5 各跑一遍对照）：

1. **`.check()` 约束不再编入 wire schema**：beta 编为 `allOf:[{pattern},...]`，4.0.5 默认整个丢弃（官方出口 `generateDescriptions: true` 只产 prose 描述，机器约束不回来）。LLM 可见工具仅 `context.ts` 的 offset ≥ 0 一处受影响；运行时解码仍拒绝非法输入（InvalidArgumentsError → 模型自纠），代价是最多一轮重试。已在 parameters.test.ts 钉住现状（测试更名「4.0.5 check constraints are absent from wire」）。
2. **`additionalProperties` 从 `false` 松成 `true`**：normalize 删除 `true` 后 wire 不声明严格性，与现存快照一致，无行动；执行层 `unknownArgumentKeys` 与 Effect 解码兜底。
3. **bash 快照欠再生**：shell 字段加入后没重跑守门测试。已再生并逐行 review——仅 shell 字段补入 + timeout 的无效负下界（`minimum: -MAX_SAFE_INTEGER`，被 exclusiveMinimum: 0 覆盖）消失。

~~description 丢失~~ **勘误**：初版探针复刻 todo 构造时漏了 annotate，把「没有」误判成「丢失」；忠实复刻验证 raw 与输出均保留全部字段说明，无此问题。

识别签名：网关报 `got 'type: "None"'`；无参工具调用整轮被拒；`parameters.test.ts` 是这类回归的守门栅栏，升级 Effect 后必须跑。
