import { createSimpleContext } from "./helper"

export interface Args {
  model?: string
  agent?: string
  prompt?: string
  continue?: boolean
  sessionID?: string
  fork?: boolean
}

// 261113 Red 导出 context 供测试喂假值（同 kv.tsx 260911、helper.tsx 260828 的理由）。
export const { use: useArgs, provider: ArgsProvider, context: argsContext } = createSimpleContext({
  name: "Args",
  init: (props: Args) => props,
})
