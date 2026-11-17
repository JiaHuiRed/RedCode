import { Effect } from "effect"
import { Server } from "../../server/server"
import { effectCmd } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"

export const ServeCommand = effectCmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "starts a headless redcode server",
  // Server loads instances per-request via x-redcode-directory header — no
  // need for an ambient project InstanceContext at startup.
  instance: false,
  handler: Effect.fn("Cli.serve")(function* (args) {
    // 260824 cc 原来这里是"没密码就打印一行 warning 然后照常监听"。真正有风险的只有
    // 对局域网可见的那种绑定，已由 resolveNetworkOptions 的闸门硬拦（见 cli/network.ts）；
    // 只听回环时不设密码本来就没问题，每次都喊只是噪音。
    const opts = yield* resolveNetworkOptions(args)
    const server = yield* Effect.promise(() => Server.listen(opts))
    console.log(`redcode server listening on http://${server.hostname}:${server.port}`)

    yield* Effect.never
  }),
})
