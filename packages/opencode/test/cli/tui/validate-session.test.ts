import { describe, expect, test } from "bun:test"
import path from "path"
import { validateSession } from "../../../src/cli/cmd/tui/validate-session"

function fakeFetch(session: unknown, onRequest?: (url: URL) => void): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url)
    onRequest?.(url)
    return new Response(JSON.stringify(session), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch
}

describe("tui validate session", () => {
  test("accepts a session that belongs to the requested directory", async () => {
    const directory = path.join(process.cwd(), "project-a")
    const requests: URL[] = []
    await validateSession({
      url: "http://redcode.internal",
      sessionID: "ses_match",
      directory,
      fetch: fakeFetch({ id: "ses_match", directory }, (url) => requests.push(url)),
    })
    expect(requests.length).toBeGreaterThan(0)
    expect(requests[0]!.searchParams.get("directory")).toBe(directory)
  })

  test("rejects a session that belongs to another directory instead of rerouting", async () => {
    const directory = path.join(process.cwd(), "project-a")
    const other = path.join(process.cwd(), "project-b")
    const error = await validateSession({
      url: "http://redcode.internal",
      sessionID: "ses_foreign",
      directory,
      fetch: fakeFetch({ id: "ses_foreign", directory: other }),
    }).catch((error) => error)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("ses_foreign")
    expect((error as Error).message).toContain(other)
    expect((error as Error).message).toContain(directory)
  })

  test("does not hit the network when no session is requested", async () => {
    let calls = 0
    await validateSession({
      url: "http://redcode.internal",
      directory: process.cwd(),
      fetch: fakeFetch({}, () => {
        calls += 1
      }),
    })
    expect(calls).toBe(0)
  })
})
