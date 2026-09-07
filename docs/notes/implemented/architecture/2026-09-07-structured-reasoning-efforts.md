# 结构化模型推理档位能力

状态:implemented

## 问题

`models.dev` 的 `reasoning_options` 是开放形态的原始外部数据。运行时的推理档位生成此前直接在 `ProviderTransform` 中重复解析它；其他来源（自定义 provider、plugin）只能保留 raw 字段。官方 Codex 的模型契约说明模型能力应先被收窄为运行时可消费的数据，而不是让请求变换层读取目录原文。

## 决策

`Provider.Model.capabilities.reasoningEfforts` 现在保存经过收窄的 effort 标签。仅处理 `type: "effort"` 的选项：有效非空字符串原样保留，`null` 规范为 `none`，重复值去重；未知结构不生成能力。models.dev 与自定义 provider 都走同一规范化路径。

`ProviderTransform.dataEffortVariants` 优先消费结构化能力，但保留 `reasoningOptions` 的 raw 兼容回退，避免外部 plugin 仍直接构造旧运行时模型时失去档位。

## 备选与否决理由

- **把 Codex 的完整 ModelInfo 静态搬入 RedCode**:否决——多数 OpenAI 账户、Responses Lite、review 专属字段没有本仓可信数据源。
- **让目录数据覆盖既有模型特判**:否决——已有特判来自官方文档或实际请求，目录数据错误时不能改变已验证的请求形状。
- **删除 raw `reasoningOptions`**:否决——plugin SDK 与既有配置仍可能提供旧形态，需要平滑过渡。

## 后果

新模型可通过目录数据获得已知的 effort 变体，消费端不再重复解析原始 JSON；模型族的实测 hard rules 继续优先。新增 capability 不改变 system prompt、工具 schema 或固定前缀，KV cache 不受影响。
