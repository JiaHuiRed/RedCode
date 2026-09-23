/** @jsxImportSource @opentui/solid */
/**
 * TUI bootstrap second stage must be fail-soft. The phase-2 Promise.all used to
 * be `void`-ed without its own catch and without being returned to the outer
 * chain, so a single rejecting optional request left store.status stuck at
 * "partial" forever (the outer bootstrap .catch cannot see a fire-and-forget
 * promise). Reachable rejection vectors: a 200 response whose body fails
 * JSON.parse (client.gen.ts parses inside the async request fn, so the method
 * rejects), listSessions shape mismatches, and any explicit throwOnError.
 * Plain HTTP 500s and network errors do NOT reject — the generated client
 * swallows them into { data: undefined } — so the second test pins that.
 */
import { describe, expect, test } from "bun:test"
import { Global } from "@redcode-ai/core/global"
import { tmpdir } from "../../../fixture/fixture"
import { directory, json, mount } from "./sync-fixture"

// 200 with a JSON content-type but an unparseable body: the SDK client rejects
// instead of resolving with { data: undefined }.
const broken = () => new Response("not json", { headers: { "content-type": "application/json" } })

const sessionPayload = {
  id: "ses_optional",
  title: "optional",
  time: { created: 0, updated: 0 },
  version: "1.14.42",
  directory,
  project_id: "proj_test",
}

describe("tui bootstrap optional phase", () => {
  test("rejecting optional endpoints still reach complete and keep defaults", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")

    // mount() itself waits for status === "complete", so resolving at all is
    // the assertion that the phase did not get stuck on "partial".
    const { app, sync } = await mount((url) => {
      if (url.pathname === "/session") return json([sessionPayload])
      if (url.pathname === "/lsp") return broken()
      if (url.pathname === "/provider/quota") return broken()
      if (url.pathname === "/vcs") return broken()
      return undefined
    })

    try {
      expect(sync.status).toBe("complete")
      // the request that succeeded still lands in the store
      expect(sync.data.session.map((s) => s.id)).toEqual(["ses_optional"])
      // failed requests keep their defaults instead of blocking complete
      expect(sync.data.lsp).toEqual([])
      expect(sync.data.provider_quota).toEqual([])
      expect(sync.data.vcs).toBeUndefined()
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("HTTP 500 on optional endpoints is client-soft and still completes", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")

    const { app, sync } = await mount((url) => {
      if (url.pathname === "/lsp") return json([], { status: 500 })
      if (url.pathname === "/provider/quota") return json([], { status: 500 })
      if (url.pathname === "/vcs") return json([], { status: 500 })
      return undefined
    })

    try {
      expect(sync.status).toBe("complete")
      expect(sync.data.lsp).toEqual([])
      expect(sync.data.provider_quota).toEqual([])
      expect(sync.data.vcs).toBeUndefined()
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })
})
