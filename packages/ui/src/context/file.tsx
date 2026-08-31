import { createContext, useContext, type ParentProps, type ValidComponent } from "solid-js"
import { createSimpleContext } from "./helper"

const ctx = createSimpleContext<ValidComponent, { component: ValidComponent }>({
  name: "FileComponent",
  init: (props) => props.component,
})

export const FileComponentProvider = ctx.provider
export const useFileComponent = ctx.use

// 260831 cc 「在侧栏打开这个文件」的注入口。
//   message-part / basic-tool 在 packages/ui 里，拿不到 app 的 file/layout 上下文，而
//   「点工具行里的文件名 → 侧栏开标签页」需要 app 那边的能力。用一个可选回调注入。
//   刻意用 Solid 原生 context 而不是 createSimpleContext：后者的 provider 带 ready 门控，
//   而这里要的恰恰是**没有 provider 时安静返回 undefined**——storybook 与 playground 里
//   没人提供实现，不该因此报错或被门控挡住。
const openCtx = createContext<((path: string) => void) | undefined>()

export function FileOpenProvider(props: ParentProps<{ onOpen: (path: string) => void }>) {
  return <openCtx.Provider value={props.onOpen}>{props.children}</openCtx.Provider>
}

/** 未提供实现时返回 undefined —— 调用方一律 `open?.(path)`，不要断言。 */
export const useFileOpen = () => useContext(openCtx)
