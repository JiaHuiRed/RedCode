import { useTerminalDimensions } from "@opentui/solid"
import { createMemo } from "solid-js"
import { useTuiConfig } from "@tui/context/tui-config"

// 260731 Red 首页输入框与其下方提示行共用的宽度上限。
//
// 此前两处各算各的：routes/home.tsx 读 tui.prompt.max_width（默认 75），
// feature-plugins/home/tips.tsx 直接写死 75 —— 一旦用户配了 max_width，提示行就和
// 输入框对不齐了。抽出来共用，配置改一处两边一起动。
//
// 默认 75 → 98：配合大号 logo（logoLarge）把首页中间那块整体放大约 30%。宽屏终端下
// 原来 41 列的 logo 加 75 列的输入框，在一片留白里显得很小。
// 终端比这窄时外层的 width="100%" 会自然收窄，不会溢出。
export const PROMPT_MAX_WIDTH_DEFAULT = 98

export function usePromptMaxWidth() {
  const dimensions = useTerminalDimensions()
  const tuiConfig = useTuiConfig()
  return createMemo(() => {
    const configured = tuiConfig.prompt?.max_width
    if (configured === "auto") return Math.max(PROMPT_MAX_WIDTH_DEFAULT, Math.floor(dimensions().width * 0.7))
    return configured ?? PROMPT_MAX_WIDTH_DEFAULT
  })
}
