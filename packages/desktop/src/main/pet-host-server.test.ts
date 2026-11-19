import { describe, expect, test } from "bun:test"
import type { DesktopPetSnapshot } from "@redcode-ai/ui/desktop-pet"
import type { PetHostFile } from "@redcode-ai/ui/pet-host"
import { createPetHostClient } from "@redcode-ai/ui/pet-host-client"
import { PET_HOST_FILE } from "@redcode-ai/ui/pet-host-files"
import { createPetHostRegistry } from "./pet-host-registry"
import { createPetHostServer } from "./pet-host-server"

// 261119 Red 宿主协议端到端：真 node:http 服务器 + 真客户端 fetch（fake 只替换文件读取），
// 照 mobile-gateway 的「真 server 当 fake upstream」模式。

const SNAPSHOT = { kind: "thinking", outfit: "openai", behavior: {
  activityChatterChance: 0, chatterCooldownMs: 1, chatterMs: 1, idleIntervalMs: 1,
  idleActionChance: 0, idleActionMs: 1, coffeeChance: 0, touchCooldownMs: 1, touchResponseMs: 1,
} } as const satisfies DesktopPetSnapshot

async function waitUntil(condition: () => boolean, what: string) {
  for (let waited = 0; waited < 2_000; waited += 20) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`timeout waiting for ${what}`)
}

async function setup() {
  const registry = createPetHostRegistry({ now: () => Date.now(), onChange: () => {} })
  const server = await createPetHostServer({ token: "tok-test-123", registry })
  const hostFile: PetHostFile = {
    protocol: 1,
    pid: 4242,
    port: server.port,
    token: "tok-test-123",
    version: "0.0.0-test",
    startedAt: 1,
  }
  return {
    registry,
    server,
    hostFile,
    baseURL: `http://127.0.0.1:${server.port}`,
    cleanup: async () => {
      await server.close()
    },
  }
}

describe("pet host server + client", () => {
  // 261119 Red 回归：kind 是 PetDisplay 的标量判别值，宿主曾只放行 6 种并要求
  // tool/coding/searching/waiting/permission 走嵌套对象，导致 TUI 一进工具状态就被
  // 400 拒绝且客户端不打日志（表现为赤在 GUI 关掉后再也回不来）。
  test("全部 PetDisplay kind 都能通过宿主校验", async () => {
    const { hostFile, cleanup } = await setup()
    try {
      const client = createPetHostClient({
        kind: "tui",
        log: () => {},
        readJson: (name) => (name === PET_HOST_FILE ? hostFile : undefined),
      })
      const kinds = [
        "idle",
        "unknown",
        "thinking",
        "coding",
        "searching",
        "tool",
        "waiting",
        "permission",
        "compacting",
        "success",
        "error",
      ] as const
      for (const kind of kinds) {
        expect({ kind, accepted: await client.push({ ...SNAPSHOT, kind }) }).toEqual({ kind, accepted: true })
      }
      client.dispose()
    } finally {
      await cleanup()
    }
  })

  test("客户端注册→推快照→激活→closed 事件→释放，全链路走真 HTTP", async () => {
    const { registry, server, hostFile, baseURL, cleanup } = await setup()
    try {
      const client = createPetHostClient({
        kind: "gui",
        log: () => {},
        readJson: (name) => (name === PET_HOST_FILE ? hostFile : undefined),
      })
      const closed = new Promise<void>((resolve) => client.onClosed(resolve))

      expect(await client.push(SNAPSHOT)).toBe(true)
      client.activate()
      await waitUntil(() => registry.active()?.sourceID !== undefined, "activation")
      expect(registry.active()?.snapshot?.kind).toBe("thinking")
      // 快照推到宿主但未激活前不显示——push 先于 activate 到达时 active 仍应最终落在 gui
      expect(registry.connectedCount()).toBe(1)

      const sourceID = registry.sources()[0].sourceID
      expect(server.send(sourceID, { type: "closed" })).toBe(true)
      await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error("closed event not delivered")), 2_000))])

      client.dispose()
      await waitUntil(() => registry.connectedCount() === 0, "release")
    } finally {
      await cleanup()
    }
  })

  test("错误 token 401、坏快照 400、过期序号 409", async () => {
    const { registry, server, hostFile, baseURL, cleanup } = await setup()
    try {
      const wrong = await fetch(`${baseURL}/v1/pet/health`, { headers: { authorization: "Bearer nope" } })
      expect(wrong.status).toBe(401)

      const auth = { authorization: `Bearer ${hostFile.token}`, "content-type": "application/json" }
      const badSnapshot = await fetch(`${baseURL}/v1/pet/update`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ sourceID: "s1", generation: 1, sequence: 1, snapshot: { kind: "hacked", outfit: "", behavior: {} } }),
      })
      expect(badSnapshot.status).toBe(400)

      const register = await fetch(`${baseURL}/v1/pet/register`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ type: "register", sourceID: "s1", kind: "gui", generation: 1 }),
      })
      expect(register.status).toBe(200)
      const stale = await fetch(`${baseURL}/v1/pet/update`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ sourceID: "s1", generation: 1, sequence: 0, snapshot: SNAPSHOT }),
      })
      expect(stale.status).toBe(409)
      expect(registry.sources()[0].sequence).toBe(0)
    } finally {
      await cleanup()
    }
  })
})
