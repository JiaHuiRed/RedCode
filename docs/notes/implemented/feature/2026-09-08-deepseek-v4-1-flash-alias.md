# 接入 DeepSeek V4.1 Flash 临时多模态别名

状态:implemented

## 问题

DeepSeek 官方助手公布了临时 beta 别名 `deepseek-v4.1-flash-expires-on-0910`。公开文档尚未列出这个别名，但它与现有 DeepSeek API 使用同一 base URL，账号限制为 20 请求/分钟，并明确支持原生多模态；不能把它误归为纯文本模型，也不能把峰值价格当成全天价格。

## 决策

在 live 配置对应的 `seed/redcode.home.jsonc` 中新增独立模型卡，声明 text+image 输入、text 输出、reasoning、tool call、attachment、1M context 和 384K output，保留到期日和账号限流说明。

在 `provider.ts` 与 `tiered-pricing.ts` 同时登记模型 ID，复用 `DS_V4_COST_FLASH` 和 `DS_V4_FLASH_SEGMENTS`。这样它与 Flash/Vision 一样按人民币工作日峰值、工作日非峰值和周末分段计费，而不是只复用峰值静态价。

## 备选与否决理由

- **覆盖现有 Flash 或 Vision 模型**：否决——新别名是临时 beta，且原 Flash 与 Vision 的能力边界仍需保留。
- **把峰值价格写进模型配置的 `cost`**：否决——会绕过已存在的峰谷分段解析。
- **等公开 `/models` 文档出现后再接入**：否决——用户已经提供了官方 beta 公告，且配置可在 0910 后移除。

## 后果

- V4.1 alias 是临时配置，0910 后应复核账号权限并移除。
- 模型可见内容新增一张模型卡；固定提示词 token 影响只来自模型目录条目，不新增系统提示词段落；KV cache 前缀结构不变。
- 输入能力硬上限为 1,000,000 context tokens，输出上限为 384,000 tokens；账号请求频率上限为 20 requests/minute。
- 公开文档未确认每个账号的 beta 权限，未进行付费 API 请求；首次真实调用仍以账号返回为准。
