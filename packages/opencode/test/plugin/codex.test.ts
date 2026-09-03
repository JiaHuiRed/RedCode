import { rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import {
  CodexAuthPlugin,
  parseJwtClaims,
  extractAccountIdFromClaims,
  extractAccountId,
  parseDefaultConnectionSettings,
  type IdTokenClaims,
} from "../../src/plugin/codex"

function createTestJwt(payload: object): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${header}.${body}.sig`
}

describe("plugin.codex", () => {
  describe("parseJwtClaims", () => {
    test("parses valid JWT with claims", () => {
      const payload = { email: "test@example.com", chatgpt_account_id: "acc-123" }
      const jwt = createTestJwt(payload)
      const claims = parseJwtClaims(jwt)
      expect(claims).toEqual(payload)
    })

    test("returns undefined for JWT with less than 3 parts", () => {
      expect(parseJwtClaims("invalid")).toBeUndefined()
      expect(parseJwtClaims("only.two")).toBeUndefined()
    })

    test("returns undefined for invalid base64", () => {
      expect(parseJwtClaims("a.!!!invalid!!!.b")).toBeUndefined()
    })

    test("returns undefined for invalid JSON payload", () => {
      const header = Buffer.from("{}").toString("base64url")
      const invalidJson = Buffer.from("not json").toString("base64url")
      expect(parseJwtClaims(`${header}.${invalidJson}.sig`)).toBeUndefined()
    })
  })

  describe("extractAccountIdFromClaims", () => {
    test("extracts chatgpt_account_id from root", () => {
      const claims: IdTokenClaims = { chatgpt_account_id: "acc-root" }
      expect(extractAccountIdFromClaims(claims)).toBe("acc-root")
    })

    test("extracts chatgpt_account_id from nested https://api.openai.com/auth", () => {
      const claims: IdTokenClaims = {
        "https://api.openai.com/auth": { chatgpt_account_id: "acc-nested" },
      }
      expect(extractAccountIdFromClaims(claims)).toBe("acc-nested")
    })

    test("prefers root over nested", () => {
      const claims: IdTokenClaims = {
        chatgpt_account_id: "acc-root",
        "https://api.openai.com/auth": { chatgpt_account_id: "acc-nested" },
      }
      expect(extractAccountIdFromClaims(claims)).toBe("acc-root")
    })

    test("extracts from organizations array as fallback", () => {
      const claims: IdTokenClaims = {
        organizations: [{ id: "org-123" }, { id: "org-456" }],
      }
      expect(extractAccountIdFromClaims(claims)).toBe("org-123")
    })

    test("returns undefined when no accountId found", () => {
      const claims: IdTokenClaims = { email: "test@example.com" }
      expect(extractAccountIdFromClaims(claims)).toBeUndefined()
    })
  })

  describe("extractAccountId", () => {
    test("extracts from id_token first", () => {
      const idToken = createTestJwt({ chatgpt_account_id: "from-id-token" })
      const accessToken = createTestJwt({ chatgpt_account_id: "from-access-token" })
      expect(
        extractAccountId({
          id_token: idToken,
          access_token: accessToken,
          refresh_token: "rt",
        }),
      ).toBe("from-id-token")
    })

    test("falls back to access_token when id_token has no accountId", () => {
      const idToken = createTestJwt({ email: "test@example.com" })
      const accessToken = createTestJwt({
        "https://api.openai.com/auth": { chatgpt_account_id: "from-access" },
      })
      expect(
        extractAccountId({
          id_token: idToken,
          access_token: accessToken,
          refresh_token: "rt",
        }),
      ).toBe("from-access")
    })

    test("returns undefined when no tokens have accountId", () => {
      const token = createTestJwt({ email: "test@example.com" })
      expect(
        extractAccountId({
          id_token: token,
          access_token: token,
          refresh_token: "rt",
        }),
      ).toBeUndefined()
    })

    test("handles missing id_token", () => {
      const accessToken = createTestJwt({ chatgpt_account_id: "acc-123" })
      expect(
        extractAccountId({
          id_token: "",
          access_token: accessToken,
          refresh_token: "rt",
        }),
      ).toBe("acc-123")
    })
  })

  describe("parseDefaultConnectionSettings", () => {
    // 260831 Red xxx：实测 blob（reg.exe 取回），flags=0x452 含 PROXY_TYPE_PROXY(0x2)，
    // proxy server 以 ASCII 存于长度字段 0x0E=14 之后
    test("extracts proxy from Windows blob", () => {
      const hex =
        "4600000052040000010000000E0000003132372E302E302E313A37383937B6000000" +
        "6C6F63616C686F73743B3132372E2A3B3139322E3136382E2A3B31302E2A3B313732" +
        "2E31362E2A3B3137322E31372E2A3B3137322E31382E2A3B3137322E31392E2A3B31" +
        "37322E32302E2A3B3137322E32312E2A3B3137322E32322E2A3B3137322E32332E2A" +
        "3B3137322E32342E2A3B3137322E32352E2A3B3137322E32362E2A3B3137322E3237" +
        "2E2A3B3137322E32382E2A3B3137322E32392E2A3B3137322E33302E2A3B3137322E" +
        "33312E2A3B3C6C6F63616C3E2800000066696C653A2F2F2F433A2F55736572732F41" +
        "646D696E6973747261746F722F70726F78792E706163"
      expect(parseDefaultConnectionSettings(hex)).toBe("http://127.0.0.1:7897")
    })

    // 260902 Red 代理关闭时 proxyEnable=0（offset 8），与 flags 无关——权威开关
    test("returns undefined when proxyEnable is off", () => {
      const hex =
        "4600000050040000000000000E0000003132372E302E302E313A37383937B6000000" +
        "6C6F63616C686F73743B3132372E2A3B3C6C6F63616C3E2800000066696C653A2F2F" +
        "2F433A2F55736572732F41646D696E6973747261746F722F70726F78792E706163"
      expect(parseDefaultConnectionSettings(hex)).toBeUndefined()
    })

    // 260902 Red 本机实况：Clash Verge PAC 模式 flags=0x464（0x4=AUTO_PROXY_URL）
    // 不含 0x2（PROXY_TYPE_PROXY），但 proxyEnable=1 且 proxyServer 字段有值——
    // 老判据（flags&0x2）会误杀，新判据以 proxyEnable 为准
    test("extracts proxy without PROXY_TYPE flag (PAC mode, flags=0x464)", () => {
      const hex =
        "4600000064040000010000000E0000003132372E302E302E313A37383937B6000000" +
        "6C6F63616C686F73743B3132372E2A3B3C6C6F63616C3E2800000066696C653A2F2F" +
        "2F433A2F55736572732F41646D696E6973747261746F722F70726F78792E706163"
      expect(parseDefaultConnectionSettings(hex)).toBe("http://127.0.0.1:7897")
    })

    // 260902 Red PAC-only 兜底：proxyServer 字段为空、PAC 指向 file:// 时读文件取第一个 PROXY
    test("falls back to file:// PAC when proxyServer field is empty", () => {
      const pacPath = join(tmpdir(), "redcode-pac-test.pac")
      const pacUrl = "file:///" + pacPath.replace(/\\/g, "/")
      writeFileSync(pacPath, 'function FindProxyForURL(url, host) { return "PROXY 127.0.0.1:7898; DIRECT" }')
      try {
        const head = Buffer.alloc(20)
        head.writeUInt32LE(0x46, 0)
        head.writeUInt32LE(0x464, 4)
        head.writeUInt32LE(1, 8)
        const pacLen = Buffer.alloc(4)
        pacLen.writeUInt32LE(pacUrl.length)
        const blob = Buffer.concat([head, pacLen, Buffer.from(pacUrl)]).toString("hex")
        expect(parseDefaultConnectionSettings(blob)).toBe("http://127.0.0.1:7898")
      } finally {
        rmSync(pacPath, { force: true })
      }
    })

    test("returns undefined for garbage", () => {
      expect(parseDefaultConnectionSettings("zzzz")).toBeUndefined()
      expect(parseDefaultConnectionSettings("00")).toBeUndefined()
    })
  })

  test("deduplicates concurrent Codex token refreshes", async () => {
    let auth = {
      type: "oauth" as const,
      refresh: "refresh-old",
      access: "",
      expires: 0,
    }
    const authUpdates: Array<{
      body: { refresh: string; access: string; expires: number; accountId?: string }
    }> = []
    let resolveRefresh: (() => void) | undefined
    const refreshReady = new Promise<void>((resolve) => {
      resolveRefresh = resolve
    })
    let refreshRequests = 0
    const apiRequests: { authorization: string | null; accountId: string | null }[] = []

    using server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === "/oauth/token") {
          expect(await request.text()).toContain("refresh_token=refresh-old")
          refreshRequests += 1
          await refreshReady
          return Response.json({
            id_token: createTestJwt({ chatgpt_account_id: "acc-123" }),
            access_token: "access-new",
            refresh_token: "refresh-new",
            expires_in: 3600,
          })
        }

        if (url.pathname === "/backend-api/codex/responses") {
          apiRequests.push({
            authorization: request.headers.get("authorization"),
            accountId: request.headers.get("ChatGPT-Account-Id"),
          })
          return new Response("{}", { status: 200 })
        }

        return new Response("unexpected request", { status: 500 })
      },
    })

    const hooks = await CodexAuthPlugin(
      {
        client: {
          auth: {
            async set(input: { body: { refresh: string; access: string; expires: number; accountId?: string } }) {
              authUpdates.push(input)
              auth = {
                type: "oauth",
                refresh: input.body.refresh,
                access: input.body.access,
                expires: input.body.expires,
                ...(input.body.accountId && { accountId: input.body.accountId }),
              }
            },
          },
        } as never,
        project: {} as never,
        directory: "",
        worktree: "",
        experimental_workspace: {
          register() {},
        },
        serverUrl: new URL("https://example.com"),
        $: {} as never,
      },
      {
        issuer: server.url.origin,
        codexApiEndpoint: new URL("/backend-api/codex/responses", server.url).toString(),
      },
    )
    const loaded = await hooks.auth!.loader!(async () => auth as never, {} as never)

    const first = loaded.fetch!("https://api.openai.com/v1/responses")
    const second = loaded.fetch!("https://api.openai.com/v1/responses")

    await waitFor(() => refreshRequests === 1)
    expect(apiRequests).toHaveLength(0)

    resolveRefresh!()
    await Promise.all([first, second])

    expect(refreshRequests).toBe(1)
    expect(authUpdates).toHaveLength(1)
    expect(authUpdates[0]?.body.refresh).toBe("refresh-new")
    expect(authUpdates[0]?.body.access).toBe("access-new")
    expect(authUpdates[0]?.body.accountId).toBe("acc-123")
    expect(apiRequests).toEqual([
      { authorization: "Bearer access-new", accountId: "acc-123" },
      { authorization: "Bearer access-new", accountId: "acc-123" },
    ])
  })
})

async function waitFor(predicate: () => boolean) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > 1_000) throw new Error("timed out waiting for condition")
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}
