# 推理强度控件按模型实际档位显示

日期：2026-09-28
状态：implemented
分区：feature

## 背景

不同模型提供的推理档位数量和名称不同。GUI 原先在档位列表前额外加入 `default`，
它代表未设置、由模型或 Agent 决定，并不是一个明确强度档位；把它放在滑条上既增加
了无效刻度，也无法告诉用户模型最终会采用哪档。

## 决策

- GUI 滑条只展示当前模型实际支持的档位，刻度数由档位列表决定；不额外加入 `default`。
- 未显式选择时不写入任何强度值，继续使用模型/Agent 自己的默认行为。UI 不把这个状态
  伪装成最低档：没有选中刻度、没有可见档位值，辅助技术读作“由模型或 Agent 决定”。
- 没有档位时隐藏控件；只有一档时以单个可选按钮呈现；两档及以上才使用滑条。
- 选中档位、刻度和单档按钮使用 V2 语义色 token（背景、文字、焦点/强调色），由主题映射
  适配日间、夜间及其它调色方案，不写死暗色值。英/中/日右侧提示统一表达“更深入”。
- 仅调整 GUI 控件；TUI 的档位轮转、模型变体数据与未设置的后端语义不变。

## 验证

- `bun test --conditions browser src/v2/components/effort-slider-v2.test.ts --timeout 30000`
  （`packages/ui`）：3 pass，覆盖三档、五档、过滤旧 `default` 值及未选择状态。
- `bun run typecheck`（`packages/ui`、`packages/app`）通过。

## 回链

- `packages/ui/src/v2/components/effort-slider-v2.tsx`
- `packages/ui/src/v2/components/effort-slider-v2.css`
- `packages/app/src/components/prompt-input.tsx`
