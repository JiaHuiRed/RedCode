import { beforeAll, describe, expect, test } from "bun:test"
import { createServer, type IncomingMessage } from "node:http"
import { request as httpsRequest } from "node:https"
import {
  createMobileGateway,
  createMobileGatewayAuth,
  createMobileGatewayTlsIdentity,
  isSafeMobileGatewayHost,
  mobileGatewayRoute,
  mobileGatewaySessionInScope,
  type MobileGatewayTlsIdentity,
} from "./mobile-gateway"

describe("mobile gateway authentication", () => {
  test("pairs one device per code and never lists issued tokens", () => {
    const now = 10_000
    const auth = createMobileGatewayAuth({
      pairingCode: "48291537",
      expiresAt: now + 120_000,
      now: () => now,
    })

    const pad = auth.pair("48291537", "Pad")!
    expect(auth.pair("48291537", "Phone")).toBeUndefined()
    auth.rotate("12345678", now + 120_000)
    const phone = auth.pair("12345678", "Phone")!

    expect(auth.authenticate(pad.token)?.id).toBe(pad.device.id)
    expect(auth.authenticate(phone.token)?.id).toBe(phone.device.id)
    expect(pad.token).not.toBe(phone.token)
    expect(auth.devices()).toEqual([pad.device, phone.device])
    expect(JSON.stringify(auth.devices())).not.toContain(pad.token)
    expect(JSON.stringify(auth.devices())).not.toContain(phone.token)
  })

  test("rejects expired codes and stops after five invalid attempts", () => {
    let now = 10_000
    const auth = createMobileGatewayAuth({
      pairingCode: "48291537",
      expiresAt: now + 1,
      now: () => now,
    })

    now += 2
    expect(auth.pair("48291537", "late")).toBeUndefined()

    const retry = createMobileGatewayAuth({
      pairingCode: "48291537",
      expiresAt: now + 120_000,
      now: () => now,
    })
    for (let attempt = 0; attempt < 5; attempt++) expect(retry.pair("00000000", "unknown")).toBeUndefined()
    expect(retry.pair("48291537", "Pad")).toBeUndefined()
    retry.rotate("12345678", now + 120_000)
    expect(retry.pair("12345678", "Pad")).toBeDefined()
  })

  test("revocation invalidates the token and closes that device's streams", () => {
    const auth = createMobileGatewayAuth({
      pairingCode: "48291537",
      expiresAt: 120_000,
      now: () => 10_000,
    })
    const paired = auth.pair("48291537", "Pad")!
    let closed = false

    auth.track(paired.device.id, () => {
      closed = true
    })

    expect(auth.revoke(paired.device.id)).toBe(true)
    expect(auth.authenticate(paired.token)).toBeUndefined()
    expect(closed).toBe(true)
    expect(auth.devices()).toEqual([])
  })
})

describe("mobile gateway boundary", () => {
  test("only seeds the initial session when its ID and directory both match", () => {
    const session = { id: "ses_123", directory: "C:\\work" }

    expect(mobileGatewaySessionInScope(session, "ses_123", "C:\\work")).toBe(true)
    expect(mobileGatewaySessionInScope(session, "ses_other", "C:\\work")).toBe(false)
    expect(mobileGatewaySessionInScope(session, "ses_123", "C:\\other")).toBe(false)
    expect(mobileGatewaySessionInScope(null, "ses_123", "C:\\work")).toBe(false)
  })

  test("binds only to loopback or private IPv4 addresses", () => {
    expect(isSafeMobileGatewayHost("127.0.0.1")).toBe(true)
    expect(isSafeMobileGatewayHost("10.20.30.40")).toBe(true)
    expect(isSafeMobileGatewayHost("172.16.1.2")).toBe(true)
    expect(isSafeMobileGatewayHost("192.168.1.2")).toBe(true)
    expect(isSafeMobileGatewayHost("0.0.0.0")).toBe(false)
    expect(isSafeMobileGatewayHost("::")).toBe(false)
    expect(isSafeMobileGatewayHost("8.8.8.8")).toBe(false)
  })

  test("allows only the mobile session API and denies execution or destructive routes", () => {
    expect(mobileGatewayRoute("GET", "/global/health")?.kind).toBe("read")
    expect(mobileGatewayRoute("GET", "/global/event")?.kind).toBe("event")
    expect(mobileGatewayRoute("GET", "/event")).toBeUndefined()
    expect(mobileGatewayRoute("GET", "/project")?.kind).toBe("projects")
    expect(mobileGatewayRoute("GET", "/project/current")?.kind).toBe("read")
    expect(mobileGatewayRoute("GET", "/session")?.kind).toBe("sessions")
    expect(mobileGatewayRoute("GET", "/session/status")?.kind).toBe("session-status")
    expect(mobileGatewayRoute("GET", "/question")?.kind).toBe("questions")
    expect(mobileGatewayRoute("GET", "/config/providers")?.kind).toBe("providers")
    expect(mobileGatewayRoute("GET", "/session/ses_123/message")?.kind).toBe("read")
    expect(mobileGatewayRoute("GET", "/session/ses_123/children")).toBeUndefined()
    expect(mobileGatewayRoute("POST", "/session/ses_123/prompt_async")?.kind).toBe("prompt")
    expect(mobileGatewayRoute("POST", "/session/ses_123/abort")?.kind).toBe("abort")

    expect(mobileGatewayRoute("POST", "/global/upgrade")).toBeUndefined()
    expect(mobileGatewayRoute("DELETE", "/session/ses_123")).toBeUndefined()
    expect(mobileGatewayRoute("POST", "/pty")).toBeUndefined()
    expect(mobileGatewayRoute("POST", "/permission/perm_123/reply")).toBeUndefined()
  })
})

describe("mobile gateway proxy", () => {
  // 261021 Red CI 上 MSYS2 openssl 冷启动可超 5s（261020 CI 两次 test timed out，openssl
  // 被 SIGTERM 时 stdout 为空），而每个用例各起一次进程会把首次成本付两遍。这里共享一次
  // 预生成身份；30s 预算与 createMobileGatewayTlsIdentity 的外部进程超时一致。证书生成
  // 本身的正确性仍由生产路径的指纹 pin 与配对码断言覆盖。
  let tls: MobileGatewayTlsIdentity
  beforeAll(async () => {
    tls = await createMobileGatewayTlsIdentity("127.0.0.1")
  }, 30_000)

  test("pairs a device and proxies only scoped session calls with sidecar credentials", async () => {
    let captured:
      | {
          method: string
          path: string
          authorization: string | undefined
          cookie: string | undefined
          directory: string | undefined
          body: string
        }
      | undefined
    const sidecar = createServer((request, response) => {
      void collect(request).then((body) => {
        captured = {
          method: request.method ?? "",
          path: request.url ?? "",
          authorization: request.headers.authorization,
          cookie: request.headers.cookie,
          directory: request.headers["x-redcode-directory"],
          body,
        }
        response.writeHead(200, { "content-type": "application/json" })
        if (request.url === "/project/current") {
          response.end(JSON.stringify({ id: "project", worktree: "C:\\work" }))
          return
        }
        if (request.url === "/config/providers") {
          response.end(
            JSON.stringify({
              providers: [
                {
                  id: "custom",
                  name: "Custom",
                  source: "config",
                  env: ["REDCODE_API_KEY"],
                  key: "provider-secret",
                  options: { apiKey: "option-secret" },
                  models: {
                    "model-1": {
                      id: "model-1",
                      providerID: "custom",
                      name: "Model One",
                      options: { token: "model-secret" },
                      headers: { Authorization: "header-secret" },
                    },
                  },
                },
              ],
              default: { build: "custom/model-1" },
            }),
          )
          return
        }
        if (request.url?.startsWith("/session?")) {
          response.end(
            JSON.stringify([
              { id: "ses_123", directory: "C:\\work", title: "current" },
              { id: "ses_other", directory: "C:\\other", title: "private" },
            ]),
          )
          return
        }
        if (request.url === "/session/status") {
          response.end(JSON.stringify({ ses_123: { type: "idle" }, ses_other: { type: "busy" } }))
          return
        }
        if (request.url === "/question") {
          response.end(
            JSON.stringify([
              { id: "que_123", sessionID: "ses_123", questions: [] },
              { id: "que_other", sessionID: "ses_other", questions: [] },
            ]),
          )
          return
        }
        response.end(JSON.stringify({ ok: true }))
      })
    })
    await listen(sidecar)

    const gateway = createMobileGateway({
      host: "127.0.0.1",
      sidecar: {
        url: `http://127.0.0.1:${(sidecar.address() as { port: number }).port}`,
        username: "redcode",
        password: "sidecar-secret",
      },
      scope: { directory: "C:\\work", initialSessionID: "ses_123" },
      tls,
    })

    try {
      const started = await gateway.start()
      const paired = await httpsCall(started.port, tls.cert, {
        path: "/__mobile/pair",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: started.pairingCode, name: "Pad" }),
      })
      expect(paired.status).toBe(200)
      const credentials = JSON.parse(paired.body) as { token: string; deviceID: string }
      const cookie = `rc_device=${credentials.token}`

      const denied = await httpsCall(started.port, tls.cert, {
        path: "/global/upgrade",
        method: "POST",
        headers: { cookie, origin: `https://127.0.0.1:${started.port}` },
        body: "{}",
      })
      expect(denied.status).toBe(403)
      expect(captured).toBeUndefined()

      const wrongWorkspace = await httpsCall(started.port, tls.cert, {
        path: "/session/ses_123",
        method: "GET",
        headers: { cookie, "x-redcode-directory": "C:\\other" },
      })
      expect(wrongWorkspace.status).toBe(403)
      expect(captured).toBeUndefined()

      const unknownSession = await httpsCall(started.port, tls.cert, {
        path: "/session/ses_other",
        method: "GET",
        headers: { cookie },
      })
      expect(unknownSession.status).toBe(403)
      expect(captured).toBeUndefined()

      const routedWorkspace = await httpsCall(started.port, tls.cert, {
        path: "/project/current?workspace=wrk_other",
        method: "GET",
        headers: { cookie },
      })
      expect(routedWorkspace.status).toBe(403)
      expect(captured).toBeUndefined()

      const projectList = await httpsCall(started.port, tls.cert, {
        path: "/project",
        method: "GET",
        headers: { cookie },
      })
      expect(projectList.status).toBe(200)
      expect(captured?.path).toBe("/project/current")
      expect(JSON.parse(projectList.body)).toEqual([{ id: "project", worktree: "C:\\work", sandboxes: [] }])

      const providerConfig = await httpsCall(started.port, tls.cert, {
        path: "/config/providers",
        method: "GET",
        headers: { cookie },
      })
      expect(providerConfig.status).toBe(200)
      expect(providerConfig.body).not.toContain("provider-secret")
      expect(providerConfig.body).not.toContain("option-secret")
      expect(providerConfig.body).not.toContain("model-secret")
      expect(providerConfig.body).not.toContain("header-secret")
      expect(JSON.parse(providerConfig.body).providers[0].models["model-1"].id).toBe("model-1")

      const sessions = await httpsCall(started.port, tls.cert, {
        path: "/session?scope=global",
        method: "GET",
        headers: { cookie },
      })
      expect(sessions.status).toBe(200)
      expect(captured?.path).toBe("/session?scope=project")
      expect(JSON.parse(sessions.body).map((session: { id: string }) => session.id)).toEqual(["ses_123"])

      const sessionStatus = await httpsCall(started.port, tls.cert, {
        path: "/session/status",
        method: "GET",
        headers: { cookie },
      })
      expect(JSON.parse(sessionStatus.body)).toEqual({ ses_123: { type: "idle" } })

      const questions = await httpsCall(started.port, tls.cert, {
        path: "/question",
        method: "GET",
        headers: { cookie },
      })
      expect(JSON.parse(questions.body).map((question: { id: string }) => question.id)).toEqual(["que_123"])

      const unknownQuestion = await httpsCall(started.port, tls.cert, {
        path: "/question/que_other/reply",
        method: "POST",
        headers: {
          cookie,
          origin: `https://127.0.0.1:${started.port}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ answers: [] }),
      })
      expect(unknownQuestion.status).toBe(403)

      const prompt = JSON.stringify({
        parts: [{ type: "text", text: "continue" }],
      })
      const proxied = await httpsCall(started.port, tls.cert, {
        path: "/session/ses_123/prompt_async",
        method: "POST",
        headers: {
          cookie,
          origin: `https://127.0.0.1:${started.port}`,
          "content-type": "application/json",
        },
        body: prompt,
      })
      expect(proxied.status).toBe(200)
      expect(captured).toEqual({
        method: "POST",
        path: "/session/ses_123/prompt_async",
        authorization: `Basic ${Buffer.from("redcode:sidecar-secret").toString("base64")}`,
        cookie: undefined,
        directory: "C:\\work",
        body: prompt,
      })
      const unknownSessionPrompt = await httpsCall(started.port, tls.cert, {
        path: "/session/ses_other/prompt_async",
        method: "POST",
        headers: {
          cookie,
          origin: `https://127.0.0.1:${started.port}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ parts: [{ type: "text", text: "not allowed" }] }),
      })
      expect(unknownSessionPrompt.status).toBe(403)

      const reply = await httpsCall(started.port, tls.cert, {
        path: "/question/que_123/reply",
        method: "POST",
        headers: {
          cookie,
          origin: `https://127.0.0.1:${started.port}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ answers: [] }),
      })
      expect(reply.status).toBe(200)
      expect(captured?.path).toBe("/question/que_123/reply")
      const mismatchedPrompt = await httpsCall(started.port, tls.cert, {
        path: "/session/ses_123/prompt_async",
        method: "POST",
        headers: {
          cookie,
          origin: `https://127.0.0.1:${started.port}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ sessionID: "ses_other", parts: [] }),
      })
      expect(mismatchedPrompt.status).toBe(400)
      expect(gateway.revoke(credentials.deviceID)).toBe(true)
      const revoked = await httpsCall(started.port, tls.cert, {
        path: "/session/ses_123",
        method: "GET",
        headers: { cookie },
      })
      expect(revoked.status).toBe(401)
    } finally {
      await gateway.stop()
      await close(sidecar)
    }
  })

  test("filters global SSE, scopes live question replies, and revokes the device token", async () => {
    const sidecar = createServer((request, response) => {
      if (request.url === "/global/event") {
        response.writeHead(200, { "content-type": "text/event-stream" })
        response.write(
          `data: ${JSON.stringify({
            directory: "C:\\work",
            payload: { type: "question.asked", properties: { id: "que_live", sessionID: "ses_live" } },
          })}\n\n`,
        )
        response.write(
          `data: ${JSON.stringify({
            directory: "C:\\other",
            payload: { type: "question.asked", properties: { id: "que_other", sessionID: "ses_other" } },
          })}\n\n`,
        )
        return
      }
      void collect(request).then(() => {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify({ ok: true }))
      })
    })
    await listen(sidecar)

    const gateway = createMobileGateway({
      host: "127.0.0.1",
      sidecar: {
        url: `http://127.0.0.1:${(sidecar.address() as { port: number }).port}`,
        username: "redcode",
        password: "sidecar-secret",
      },
      scope: { directory: "C:\\work", initialSessionID: "ses_start" },
      tls,
    })

    try {
      const started = await gateway.start()
      const paired = await httpsCall(started.port, tls.cert, {
        path: "/__mobile/pair",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: started.pairingCode, name: "Phone" }),
      })
      const credentials = JSON.parse(paired.body) as { token: string; deviceID: string }
      const response = await httpsStream(started.port, tls.cert, {
        path: "/global/event",
        headers: { cookie: `rc_device=${credentials.token}` },
      })
      const firstChunk = await firstData(response)

      const data = firstChunk.split(/\r?\n/).find((line) => line.startsWith("data:"))?.slice(5).trimStart()
      expect(JSON.parse(data ?? "{}").directory).toBe("C:\\work")
      expect(firstChunk).not.toContain("other")

      const liveQuestion = await httpsCall(started.port, tls.cert, {
        path: "/question/que_live/reply",
        method: "POST",
        headers: {
          cookie: `rc_device=${credentials.token}`,
          origin: `https://127.0.0.1:${started.port}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ answers: [] }),
      })
      expect(liveQuestion.status).toBe(200)
      const otherQuestion = await httpsCall(started.port, tls.cert, {
        path: "/question/que_other/reply",
        method: "POST",
        headers: {
          cookie: `rc_device=${credentials.token}`,
          origin: `https://127.0.0.1:${started.port}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ answers: [] }),
      })
      expect(otherQuestion.status).toBe(403)
      expect(gateway.revoke(credentials.deviceID)).toBe(true)
      const revoked = await httpsCall(started.port, tls.cert, {
        path: "/global/health",
        method: "GET",
        headers: { cookie: `rc_device=${credentials.token}` },
      })
      expect(revoked.status).toBe(401)
    } finally {
      await gateway.stop()
      await close(sidecar)
    }
  })
})

function listen(server: ReturnType<typeof createServer>) {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })
}

function close(server: ReturnType<typeof createServer>) {
  return new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
}

function collect(request: IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    request.on("error", reject)
  })
}

function httpsCall(port: number, ca: Buffer, input: {
  path: string
  method: string
  headers?: Record<string, string>
  body?: string
}) {
  return new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
    const request = httpsRequest(
      {
        hostname: "127.0.0.1",
        port,
        path: input.path,
        method: input.method,
        headers: input.headers,
        ca,
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on("data", (chunk: Buffer) => chunks.push(chunk))
        response.on("end", () =>
          resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }),
        )
      },
    )
    request.on("error", reject)
    request.end(input.body)
  })
}

function httpsStream(port: number, ca: Buffer, input: { path: string; headers?: Record<string, string> }) {
  return new Promise<IncomingMessage>((resolve, reject) => {
    const request = httpsRequest(
      { hostname: "127.0.0.1", port, path: input.path, headers: input.headers, ca },
      (response) => {
        response.pause()
        response.on("error", reject)
        resolve(response)
      },
    )
    request.on("error", reject)
    request.end()
  })
}

function firstData(response: IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    response.once("data", (chunk: Buffer) => resolve(chunk.toString("utf8")))
    response.once("error", reject)
    response.resume()
  })
}
