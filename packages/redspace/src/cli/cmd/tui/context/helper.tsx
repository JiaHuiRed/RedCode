import { createContext, Show, useContext, type ParentProps } from "solid-js"

export function createSimpleContext<T, Props extends Record<string, any>>(input: {
  name: string
  init: ((input: Props) => T) | (() => T)
}) {
  const ctx = createContext<T>()

  return {
    // 260828 cc 暴露原始 context，供测试直接喂假值。
    //
    // 这些 context 的 provider 之间是链式依赖的（Theme 要 KV + TuiConfig，Local 要
    // Sync + SDK + Toast），要渲染一条会话消息就得先把 7 层真 provider 全立起来，
    // 其中 SDK/Toast 还带副作用。而 `use()` 本身只是 `useContext(ctx)` —— 拿到 ctx
    // 就能绕过整条 init 链。**只在测试里用**：生产代码一律走 provider。
    context: ctx,
    provider: (props: ParentProps<Props>) => {
      const init = input.init(props)
      return (
        // @ts-expect-error
        <Show when={init.ready === undefined || init.ready === true}>
          <ctx.Provider value={init}>{props.children}</ctx.Provider>
        </Show>
      )
    },
    use() {
      const value = useContext(ctx)
      if (!value) throw new Error(`${input.name} context must be used within a context provider`)
      return value
    },
  }
}
