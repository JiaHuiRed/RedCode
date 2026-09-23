import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { platformFetch } from "./fetch"

let server: ReturnType<typeof Bun.serve>
let origin: string

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: async (req) => Response.json({ method: req.method, body: await req.text() }),
  })
  origin = `http://localhost:${server.port}`
})

afterAll(() => void server.stop(true))

describe("platformFetch", () => {
  test("Request 与 init 同时传入时 init 生效", async () => {
    const request = new Request(`${origin}/echo`, { method: "GET" })
    const response = await platformFetch(request, { method: "POST", body: "payload" })
    expect(await response.json()).toEqual({ method: "POST", body: "payload" })
  })

  test("仅传 Request 时按原请求发送", async () => {
    const request = new Request(`${origin}/echo`, { method: "PUT", body: "plain" })
    const response = await platformFetch(request)
    expect(await response.json()).toEqual({ method: "PUT", body: "plain" })
  })

  test("字符串 input 与 init 正常组合", async () => {
    const response = await platformFetch(`${origin}/echo`, { method: "PATCH", body: "direct" })
    expect(await response.json()).toEqual({ method: "PATCH", body: "direct" })
  })
})
