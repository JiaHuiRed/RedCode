// 261109 Karina UX-01：工作台布局预设。
//
// 预设只决定「哪些面板出现、工作台用哪种模式、默认打开哪个标签」，**不写死宽度**：
// 用户手动拖过的面板宽度、滚动位置、文件标签都必须原样保留（任务书明确禁止自动布局
// 反复覆盖用户操作）。所以这里输出的是声明式的 plan，由 layout.applyPreset 逐项执行。
export type LayoutPreset = "focus" | "build" | "review"

export const LAYOUT_PRESETS: readonly LayoutPreset[] = ["focus", "build", "review"] as const

export type LayoutPresetPlan = {
  fileTree: boolean
  reviewPanel: boolean
  workbench?: "capsule" | "docked" | "floating"
  tab?: "context" | "review"
}

export function presetPlan(preset: LayoutPreset): LayoutPresetPlan {
  switch (preset) {
    // 专注：聊天是唯一主角，左右面板都收起，输入框保持原位。
    case "focus":
      return { fileTree: false, reviewPanel: false }
    // 开发：文件树 + 对话 + 文件工作台并排，工作台停靠。
    case "build":
      return { fileTree: true, reviewPanel: true, workbench: "docked", tab: "context" }
    // 审查：收起文件树把宽度让给 Diff，工作台停靠并直接落在 review 标签。
    case "review":
      return { fileTree: false, reviewPanel: true, workbench: "docked", tab: "review" }
  }
}
