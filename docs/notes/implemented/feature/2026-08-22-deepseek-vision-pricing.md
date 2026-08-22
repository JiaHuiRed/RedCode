# DeepSeek V4 Flash Vision 计费补齐（opencode-go 键 + 峰谷分段）

状态:implemented

## 背景

8/21 补 `CNY_PRICING` 时只补了官方 `deepseek` 键缺 `deepseek-v4-flash-vision-exp` 的条目，**同名单遗漏了两处**：

1. **opencode-go 键**：`opencode-go/deepseek-v4-flash-vision-exp` 走到 `models.dev` 的 USD 价格（0.22/0.66），实际是官方人民币口径（与 flash 同价：高峰 3/9、空闲 1.5/4.5 元/M）。同一天上午 WebUI 接入了官方 vision 模型（0.9.4），下午哥哥看到 opencode-go 下该模型按美元计费才暴露。
2. **`tiered-pricing.ts` 峰谷分段表**：deepseek 与 opencode-go 两个键的段表都没有 vision 条目——新模型在带钟表定价的 provider 下直接走不了分段，回落无分段或恒 0。

## 根因

`provider.ts` 的 `CNY_PRICING` 和 `tiered-pricing.ts` 的 `TIERED_PRICING` 都是**按 provider 键手写条目**的映射表，键不一致就静默落空（漏键即不计费/按错币种），没有任何一致性校验在编译期或测试期兜住「新模型进了 models.dev 却没进这两个表」。

## 决策

- 两处「补键」与 8/21 的修复同属一条变更线，不动结构只补内容。
- vision 与 flash 同价沿用 76a15bfb 在官方定价页核实的口径，峰谷分段复用 `DS_V4_FLASH_SEGMENTS`。

## 后果

- `provider.ts` CNY_PRICING 的 opencode-go 键加 `"deepseek-v4-flash-vision-exp": DS_V4_COST_FLASH`；`tiered-pricing.ts` 的 deepseek 与 opencode-go 两个键都加 `"deepseek-v4-flash-vision-exp": DS_V4_FLASH_SEGMENTS`。
- 历史会话费用不回溯（与 8/21 修复同约定）。
- TUI footer 显示硬币仍是 `Intl.NumberFormat en-US currency USD` 硬编码（run/session-data.ts:32-34）——人民币显示由上层 `CNY_PROVIDERS` 转换，本次不动。
