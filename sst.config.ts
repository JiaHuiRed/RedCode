/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: "redcode",
      removal: input?.stage === "production" ? "retain" : "remove",
      protect: ["production"].includes(input?.stage),
      home: "cloudflare",
      providers: {
        stripe: {
          version: "0.0.28",
          apiKey: process.env.STRIPE_SECRET_KEY!,
        },
        random: "4.19.2",
        planetscale: "0.4.1",
        honeycomb: "0.49.0",
      },
    }
  },
  // 260904 cc 这里原本还有一行 `const { stat } = await import("./infra/console.js")`，
  // 返回值里带一个 `StatWorkerUrl: stat.url`。`infra/console.ts` 是 SaaS 控制台那套的基础设施
  // 定义，而它引用的 `packages/console/` 早在 `78e86454 chore: remove unused SaaS console package`
  // 就被有意删掉了——五个 handler / directory 全部指向不存在的路径，**任何 `sst deploy` 都必崩**，
  // 而 CI 不跑 sst，所以这条死链一直没人踩到。console.ts 已随本次一并删除（要恢复就从
  // 78e86454 之前取，连同 packages/console 一起）。
  async run() {
    await import("./infra/app.js")
    await import("./infra/enterprise.js")
    if ($app.stage === "production" || $app.stage === "vimtor") {
      await import("./infra/monitoring.js")
    }
  },
})
