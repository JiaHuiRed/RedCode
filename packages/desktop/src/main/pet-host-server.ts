import { timingSafeEqual } from "node:crypto"
import type { IncomingMessage, Server, ServerResponse } from "node:http"
import * as http from "node:http"
import type { DesktopPetSnapshot } from "@redcode-ai/ui/desktop-pet"
import {
  PET_HOST_PROTOCOL,
  validateGeneration,
  validatePetSnapshot,
  validateSourceID,
  type PetHostEvent,
  type PetSourceKind,
} from "@redcode-ai/ui/pet-host"
import type { PetHostRegistry } from "./pet-host-registry"

// 261119 Red 桌宠宿主的来源协议端点（node:http，Electron 无关）。
// 传输选型：仓库没有 named pipe 先例，sidecar/mobile-gateway 的既定套路是
// loopback HTTP + 随机 token（同用户威胁模型），桌宠宿主沿用该套路。
// 消息仅在进程边界做形状/枚举/长度校验（validatePetSnapshot 等），语义规则仍在来源侧。

const BODY_MAX = 64 * 1024
const KINDS: PetSourceKind[] = ["gui", "tui"]

export type PetHostServer = {
  port: number
  /** 宿主→来源单播（目前只有 closed：用户点了赤的关闭按钮）。 */
  send(sourceID: string, event: PetHostEvent): boolean
  close(): Promise<void>
}

export function createPetHostServer(deps: { token: string; registry: PetHostRegistry }): Promise<PetHostServer> {
  const sseBySource = new Map<string, ServerResponse>()

  function authorized(req: IncomingMessage): boolean {
    const header = req.headers.authorization ?? ""
    const expected = `Bearer ${deps.token}`
    const given = Buffer.from(header)
    const want = Buffer.from(expected)
    // 长度不等时 timingSafeEqual 会抛错——先补齐再比，比较结果恒 false
    if (given.length !== want.length) return false
    return timingSafeEqual(given, want)
  }

  function readBody(req: IncomingMessage): Promise<string | undefined> {
    return new Promise((resolve) => {
      let body = ""
      let overflow = false
      req.on("data", (chunk: Buffer) => {
        body += chunk
        if (body.length > BODY_MAX) overflow = true
      })
      req.on("end", () => resolve(overflow ? undefined : body))
      req.on("error", () => resolve(undefined))
    })
  }

  function reply(res: ServerResponse, status: number, payload?: unknown) {
    res.statusCode = status
    if (payload !== undefined) res.setHeader("content-type", "application/json")
    res.end(payload === undefined ? undefined : JSON.stringify(payload))
  }

  function parseBody<T extends Record<string, unknown>>(raw: string | undefined): (T & { sourceID: string }) | undefined {
    if (raw === undefined) return undefined
    try {
      const parsed = JSON.parse(raw)
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined
      const record = parsed as Record<string, unknown>
      if (!validateSourceID(record.sourceID)) return undefined
      return record as T & { sourceID: string }
    } catch (error) {
      // 吞掉的只有 JSON.parse 的 SyntaxError：请求体损坏按 400 处理，不影响宿主存活
      void error
      return undefined
    }
  }

  const server: Server = http.createServer((req, res) => {
    if (!authorized(req)) return void reply(res, 401)
    const url = new URL(req.url ?? "/", "http://127.0.0.1")

    if (req.method === "GET" && url.pathname === "/v1/pet/health") {
      return void reply(res, 200, { ok: true, protocol: PET_HOST_PROTOCOL })
    }

    if (req.method === "GET" && url.pathname === "/v1/pet/events") {
      const sourceID = url.searchParams.get("sourceID") ?? ""
      if (!validateSourceID(sourceID)) return void reply(res, 400)
      if (!sseBySource.has(sourceID) && !deps.registry.attach(sourceID)) return void reply(res, 404)
      sseBySource.get(sourceID)?.destroy()
      sseBySource.set(sourceID, res)
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
      res.write(`data: ${JSON.stringify({ type: "attached" })}\n\n`)
      req.on("close", () => {
        if (sseBySource.get(sourceID) === res) sseBySource.delete(sourceID)
        deps.registry.detach(sourceID)
      })
      return
    }

    if (req.method !== "POST") return void reply(res, 405)
    void (async () => {
      const body = parseBody(await readBody(req))
      if (!body) return void reply(res, 400)

      if (url.pathname === "/v1/pet/register") {
        const kind = body.kind
        if ((typeof kind !== "string" || !KINDS.includes(kind as PetSourceKind)) || !validateGeneration(body.generation)) {
          return void reply(res, 400)
        }
        const result = deps.registry.register(body.sourceID, kind as PetSourceKind, body.generation)
        return void reply(res, result === "ok" ? 200 : 409)
      }

      if (url.pathname === "/v1/pet/update") {
        const snapshot = validatePetSnapshot(body.snapshot)
        if (snapshot === undefined || !validateGeneration(body.generation) || !validateGeneration(body.sequence)) {
          return void reply(res, 400)
        }
        const accepted = deps.registry.snapshot(
          body.sourceID,
          body.generation,
          body.sequence,
          snapshot as DesktopPetSnapshot | null,
        )
        return void reply(res, accepted ? 200 : 409)
      }

      if (url.pathname === "/v1/pet/activate") {
        if (!validateGeneration(body.generation)) return void reply(res, 400)
        const accepted = deps.registry.activate(body.sourceID, body.generation)
        return void reply(res, accepted ? 200 : 409)
      }

      if (url.pathname === "/v1/pet/release") {
        deps.registry.release(body.sourceID)
        const stream = sseBySource.get(body.sourceID)
        if (stream) {
          sseBySource.delete(body.sourceID)
          stream.destroy()
        }
        return void reply(res, 200)
      }

      void reply(res, 404)
    })()
  })

  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        server.close()
        reject(new Error("pet host server failed to bind loopback"))
        return
      }
      resolve({
        port: address.port,
        send(sourceID, event) {
          const stream = sseBySource.get(sourceID)
          if (!stream) return false
          stream.write(`data: ${JSON.stringify(event)}\n\n`)
          return true
        },
        close() {
          for (const stream of sseBySource.values()) stream.destroy()
          sseBySource.clear()
          return new Promise((resolveClose) => server.close(() => resolveClose()))
        },
      })
    })
  })
}
