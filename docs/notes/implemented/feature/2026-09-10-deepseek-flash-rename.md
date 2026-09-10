# DeepSeek 正式模型名 deepseek-flash 替换 0910 到期的临时内测别名

状态:implemented

## 问题

260908 接入的 `deepseek-v4.1-flash-expires-on-0910` 是官方助手给的临时内测别名，名字自带 0910 到期。0910 官方公告给出正式 wire model ID `deepseek-flash`（模型版本 DeepSeek-V4.1-Flash）：旧名 `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 对应的模型已下线，服务端仍接受这两个名字但一律由 V4.1 Flash 提供服务并按 Flash 计价。models.dev 目录尚未收录 `deepseek-flash`（实测 API 的 deepseek provider 只返回旧三个名），不手工注册就在 RedCode 里选不到。

同时官方宣布有序下线 V4 Pro：北京时间 2026-09-14 12:00 之后、V4.1 Pro 上线之前，`deepseek-v4-pro` 的请求全部路由到 V4.1 Flash 并按 Flash 计价。

## 决策

- 配置层（`seed/redcode.home.jsonc` 与 live `~/.redcode/redcode.jsonc`）把临时别名替换成 `deepseek-flash`，显示名去掉「内测 / 0910 到期」；原生多模态、1M 上下文 / 384K 输出的声明不变。
- `tiered-pricing.ts` 增加 `deepseek-flash` 键（复用 0910 新价段），并为 `deepseek-v4-pro` 追加 `effectiveFrom = 2026-09-14T04:00:00Z`（北京 12:00）的 Flash 价段——记账端只看到 modelID、看不到服务端的路由结果，路由等价的价格变化必须在表里显式表达。
- `provider.ts` 的静态兜底价 `DS_V4_COST_FLASH` 从 0817 高峰价 3/9/0.1 跟到 0910 高峰价 2/8/0.04。tiered 记账表在 `7d4e9e02`（flash 系列 0910 新价）已更新，静态表当时漏动；它是 tiered 未命中时的回落值，也是 UI 展示口径，不跟就一直显示旧价。
- 旧别名键在新旧两张表里保留，供仍绑定 `deepseek-v4.1-flash-expires-on-0910` 的既有会话继续正确记账；配置目录不再暴露该名。

## 备选与否决理由

- **两个名字并存注册**：否决——models.dev 未收录正式名，配置里两条指向同一模型会让选择器出现重复项，而旧名本来就是临时的。
- **连旧别名的计价键一起删**：否决——历史会话绑定的就是旧 modelID，删键后新请求会回落到静态表或 models.dev（目录里没有这个模型）导致查价失败。
- **等 models.dev 收录正式名再动**：否决——官方文档已给出正式名且实测请求返回 200，等待只会让 0910 到期的临时别名继续被使用。

## 后果

- 需要重启 RedCode 生效（配置缓存在进程内是永久的）。重启前已绑定旧 modelID 的会话要重新选择 `DeepSeek V4.1 Flash (多模态)`。
- pro 的价格切换依赖记账端按请求时刻查 tiered 表。若 V4.1 Pro 上线，应为 `deepseek-v4-pro` **追加**新段而不是修改现有段——分段表只增不改，历史时刻查价靠 `effectiveFrom` 回退。
- 识别签名：选择器里重新出现两条指向 V4.1 Flash 的模型，说明临时别名又被补回（模板与 live 未同改时会复现）。
