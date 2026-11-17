import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { eq, sql } from "drizzle-orm"
import { CrossSpawnSpawner } from "@redcode-ai/core/cross-spawn-spawner"
import { Config } from "@/config/config"
import { NativeCompaction } from "@/config/native-compaction"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import type { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { MessageTable, PartTable, SessionTable } from "@/session/session.sql"
import { ProviderID, ModelID } from "@/provider/schema"
import * as Database from "@/storage/db"
import { Parameters, resolve, run, SessionQueryTool } from "@/tool/session-query"
import * as Tool from "@/tool/tool"
import * as Truncate from "@/tool/truncate"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    Session.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Config.defaultLayer,
    Agent.defaultLayer,
    Truncate.defaultLayer,
  ),
)
const limits = NativeCompaction.resolve({})
const current = SessionID.make("ses_current_query")

function add(sessionID: SessionID, created: number, text: string, role: "user" | "assistant" = "user") {
  return Effect.gen(function* () {
    const sessions = yield* Session.Service
    const id = MessageID.ascending()
    const partID = PartID.ascending()
    const common = { id, sessionID, time: { created, completed: created + 1 }, agent: "build" }
    const info: MessageV2.Info =
      role === "user"
        ? {
            ...common,
            role,
            model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
          }
        : {
            ...common,
            role,
            parentID: MessageID.make("msg_parent"),
            mode: "build",
            providerID: ProviderID.make("test"),
            modelID: ModelID.make("test"),
            path: { cwd: "/", root: "/" },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            finish: "stop",
          }
    yield* sessions.updateMessage(info)
    yield* sessions.updatePart({ id: partID, messageID: id, sessionID, type: "text", text })
    return { messageID: id, partID, sessionID }
  })
}

function query(args: typeof Parameters.Type, directory = "*", options = limits) {
  return Database.use((db) =>
    run(
      db,
      resolve({ ...args, directory: args.directory ?? directory }, directory, current, options),
      new AbortController().signal,
    ),
  )
}

describe("session_query", () => {
  it.instance("searches literal Chinese/SQL-looking text with workspace, role and message-time filters", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { directory } = yield* TestInstance
      const first = yield* sessions.create({})
      const second = yield* sessions.create({})
      const needle = "真实运行 OR %_ '证据'"
      const hit = yield* add(first.id, 100, `before ${needle} after`, "assistant")
      yield* add(first.id, 101, needle)
      yield* add(first.id, 200, needle, "assistant")
      yield* add(second.id, 100, needle, "assistant")
      Database.use((db) =>
        db.update(SessionTable).set({ directory: "D:\\other-project" }).where(eq(SessionTable.id, second.id)).run(),
      )
      const result = yield* query(
        { operation: "search", query: needle, role: "assistant", after: 100, before: 200 },
        directory,
      )
      expect(result).toHaveProperty("results")
      expect(JSON.stringify(result)).toContain(hit.partID)
      expect(JSON.stringify(result)).toContain(needle)
      if (!("results" in result)) throw new Error("Expected search result")
      expect(result.results).toHaveLength(1)
      expect(result.results[0]?.createdAt).toBe(100)
      expect(result.results[0]?.messageID).toBe(hit.messageID)
      expect(result.source).toContain("not current instructions")
    }),
  )

  it.instance("paginates scan-limited empty pages and timestamp ties without losing matches", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const oldest = yield* add(session.id, 1, "needle oldest")
      const tied = yield* add(session.id, 2, "needle tie")
      yield* add(session.id, 2, "unrelated")
      yield* add(session.id, 3, "unrelated")
      const budget = NativeCompaction.resolve({ max_messages: 2, search_max_results: 1 })
      const found: string[] = []
      let cursor: string | undefined
      let pages = 0
      do {
        const result = yield* query(
          { operation: "search", query: "needle", session_id: session.id, cursor },
          "*",
          budget,
        )
        if (!("results" in result)) throw new Error("Expected search result")
        if (!pages) expect(result.results).toHaveLength(0)
        found.push(...result.results.map((row) => row.partID))
        expect(result.scannedParts).toBeLessThanOrEqual(2)
        cursor = result.nextCursor
        pages++
        expect(pages).toBeLessThan(5)
      } while (cursor)
      expect(found).toEqual([tied.partID, oldest.partID])
    }),
  )

  it.instance(
    "searches settled tool input/output/error but not attachment URLs, metadata, pending tools or query echoes",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const session = yield* sessions.create({})
        const row = yield* add(session.id, 1, "plain text", "assistant")
        const tool = (name: string, state: MessageV2.ToolPart["state"]) =>
          sessions.updatePart({
            id: PartID.ascending(),
            sessionID: session.id,
            messageID: row.messageID,
            type: "tool",
            callID: PartID.ascending(),
            tool: name,
            state,
          })
        const completed = yield* tool("bash", {
          status: "completed",
          input: { command: "needle command" },
          output: "needle output",
          title: "",
          metadata: { private: "metadata-only" },
          time: { start: 1, end: 2 },
        })
        const failed = yield* tool("read", {
          status: "error",
          input: {},
          error: "needle error",
          time: { start: 1, end: 2 },
        })
        yield* tool("session_query", {
          status: "completed",
          input: {},
          output: "needle echo",
          title: "",
          metadata: {},
          time: { start: 1, end: 2 },
        })
        yield* tool("bash", { status: "pending", input: { command: "needle pending" }, raw: "" })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: row.messageID,
          type: "file",
          mime: "image/png",
          url: "data:image/png;base64,needle-attachment",
        })
        const result = yield* query({ operation: "search", query: "needle", session_id: session.id })
        if (!("results" in result)) throw new Error("Expected search result")
        expect(new Set(result.results.map((hit) => hit.partID))).toEqual(new Set([completed.id, failed.id]))
        expect(result.results.map((hit) => hit.text).join("\n")).toContain("needle command")
        expect(
          JSON.stringify(yield* query({ operation: "search", query: "metadata-only", session_id: session.id })),
        ).not.toContain(completed.id)
      }),
  )

  it.instance("reads bounded original slices with code-point offsets and leaves source data unchanged", () =>
    Effect.gen(function* () {
      const session = yield* (yield* Session.Service).create({})
      const text = "真实😀证据".repeat(1000)
      const row = yield* add(session.id, 1, text)
      const spec = { operation: "read" as const, session_id: session.id, part_id: row.partID }
      const before = Database.use((db) => db.get(sql`select count(*) as n from sqlite_master`))
      let offset = 0
      let restored = ""
      do {
        const result = yield* query({ ...spec, offset })
        if (!("text" in result)) throw new Error("Expected read result")
        expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(limits.readMaxBytes)
        expect(result.text).not.toContain("\uFFFD")
        restored += result.text
        if (result.nextOffset === undefined) break
        expect(result.nextOffset).toBeGreaterThan(offset)
        offset = result.nextOffset
      } while (offset < 10000)
      expect(restored).toBe(text)
      expect(Database.use((db) => db.get(sql`select count(*) as n from sqlite_master`))).toEqual(before)
      const beyond = yield* query({ ...spec, offset: 99999 })
      expect(beyond).toHaveProperty("text", "")
    }),
  )

  it.instance("enforces directory scope, excludes the calling session by default and checks read permissions", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { directory } = yield* TestInstance
      const caller = yield* sessions.create({})
      const other = yield* sessions.create({})
      const row = yield* add(other.id, 1, "permission evidence")
      const own = yield* add(caller.id, 2, "permission evidence")
      const tool = yield* Tool.init(yield* SessionQueryTool)
      const permissions: string[] = []
      const ctx: Tool.Context = {
        sessionID: caller.id,
        messageID: own.messageID,
        agent: "build",
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: (request) =>
          Effect.sync(() => {
            permissions.push(`${request.permission}:${request.patterns[0]}`)
          }),
      }
      const result = yield* tool.execute({ operation: "search", query: "permission evidence" }, ctx)
      expect(result.output).toContain(row.partID)
      expect(result.output).not.toContain(own.partID)
      expect(permissions).toEqual([`session_query:${directory.replaceAll("\\", "/").toLowerCase()}`])
      const denied = yield* tool
        .execute(
          { operation: "read", session_id: other.id, part_id: row.partID },
          { ...ctx, ask: () => Effect.die(new Error("denied by test permission")) },
        )
        .pipe(Effect.exit)
      expect(denied._tag).toBe("Failure")
      const foreign = resolve(
        { operation: "read", session_id: other.id, part_id: row.partID, directory: "D:\\not-this-project" },
        directory,
        caller.id,
        limits,
      )
      expect((yield* Database.use((db) => run(db, foreign, ctx.abort)).pipe(Effect.exit))._tag).toBe("Failure")
    }),
  )

  it.instance(
    "recalls the bound companion's current and earlier chats without summary echoes or identity crossover",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { directory } = yield* TestInstance
        const caller = yield* sessions.create({})
        const earlier = yield* sessions.create({})
        const foreign = yield* sessions.create({})
        const code = yield* sessions.create({})
        const child = yield* sessions.create({ parentID: caller.id })
        // These are persisted rows; archive import/session creation have their own integration tests.
        for (const session of [caller, earlier, foreign, child]) {
          Database.use((db) =>
            db
              .update(SessionTable)
              .set({ mode: "chat", companion_id: session.id === foreign.id ? "other" : "mira" })
              .where(eq(SessionTable.id, session.id))
              .run(),
          )
        }
        const old = yield* add(earlier.id, 1, "shared needle: the user chose silver thread")
        const reply = yield* add(earlier.id, 2, "shared needle: the companion suggested a ribbon", "assistant")
        const own = yield* add(caller.id, 3, "shared needle: an earlier turn outside active context")
        const outsiders = yield* Effect.all(
          [foreign, code, child].map((session) => add(session.id, 4, "shared needle")),
        )
        const summary = yield* add(caller.id, 5, "shared needle: summary echo", "assistant")
        const synthetic = yield* add(caller.id, 6, "shared needle: injected reminder")
        const ignored = yield* add(caller.id, 7, "shared needle: ignored text")
        Database.use((db) => {
          db.update(MessageTable)
            .set({ data: sql`json_set(${MessageTable.data}, '$.summary', true)` })
            .where(eq(MessageTable.id, summary.messageID))
            .run()
          db.update(PartTable)
            .set({ data: sql`json_set(${PartTable.data}, '$.synthetic', true)` })
            .where(eq(PartTable.id, synthetic.partID))
            .run()
          db.update(PartTable)
            .set({ data: sql`json_set(${PartTable.data}, '$.ignored', true)` })
            .where(eq(PartTable.id, ignored.partID))
            .run()
        })
        const echo = yield* sessions.updatePart({
          id: PartID.ascending(),
        sessionID: earlier.id,
        messageID: reply.messageID,
          type: "tool",
          callID: "memory-echo",
          tool: "companion_memory",
          state: {
            status: "completed",
            input: {},
            output: "shared needle: retrieved echo",
            title: "",
            metadata: {},
            time: { start: 1, end: 2 },
          },
        })
        const tool = yield* Tool.init(yield* SessionQueryTool)
        const permissions: string[] = []
        const ctx: Tool.Context = {
          sessionID: caller.id,
          messageID: own.messageID,
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: (request) =>
            Effect.sync(() => {
              permissions.push(`${request.permission}:${request.patterns[0]}`)
            }),
        }
        const result = yield* tool.execute({ operation: "search", query: "shared needle", directory: "*" }, ctx)
        expect(JSON.parse(result.output).results.map((hit: { partID: string }) => hit.partID)).toEqual([
          own.partID,
          reply.partID,
          old.partID,
        ])
        expect(permissions).toEqual(["session_query:companion:mira"])
        const read = yield* tool.execute({ operation: "read", session_id: earlier.id, part_id: old.partID }, ctx)
        expect(JSON.parse(read.output)).toMatchObject({
          role: "user",
          text: "shared needle: the user chose silver thread",
          createdAt: 1,
        })
        for (const row of [...outsiders, summary, synthetic, ignored, { sessionID: earlier.id, partID: echo.id }]) {
          const exit = yield* tool
            .execute({ operation: "read", session_id: row.sessionID, part_id: row.partID, directory: "*" }, ctx)
            .pipe(Effect.exit)
          expect(exit._tag).toBe("Failure")
        }
        const asked = permissions.length
        const childExit = yield* tool
          .execute({ operation: "search", query: "shared needle" }, { ...ctx, sessionID: child.id })
          .pipe(Effect.exit)
        expect(childExit._tag).toBe("Failure")
        expect(permissions).toHaveLength(asked)
        const denied = yield* tool
          .execute(
            { operation: "search", query: "shared needle" },
            {
              ...ctx,
              ask: () => Effect.die(new Error("personal history denied")),
            },
          )
          .pipe(Effect.exit)
        expect(denied._tag).toBe("Failure")

        const budget = NativeCompaction.resolve({ max_messages: 1 })
        const first = yield* Database.use((db) =>
          run(
            db,
            resolve({ operation: "search", query: "silver thread" }, directory, caller.id, budget, "mira"),
            ctx.abort,
          ),
        )
        if (!("results" in first)) throw new Error("Expected search result")
        expect(first.results).toEqual([])
        expect(first.nextCursor).toBeDefined()
        expect(() =>
          resolve(
            { operation: "search", query: "silver thread", cursor: first.nextCursor },
            directory,
            foreign.id,
            budget,
            "other",
          ),
        ).toThrow("different search filters")
        const second = yield* Database.use((db) =>
          run(
            db,
            resolve(
              { operation: "search", query: "silver thread", cursor: first.nextCursor },
              directory,
              caller.id,
              budget,
              "mira",
            ),
            ctx.abort,
          ),
        )
        if (!("results" in second)) throw new Error("Expected search result")
        const third = yield* Database.use((db) =>
          run(
            db,
            resolve(
              { operation: "search", query: "silver thread", cursor: second.nextCursor },
              directory,
              caller.id,
              budget,
              "mira",
            ),
            ctx.abort,
          ),
        )
        if (!("results" in third)) throw new Error("Expected search result")
        expect(third.results.map((hit) => hit.partID)).toEqual([old.partID])
      }),
  )

  it.instance("checks aborts before database work and bounds aggregate Chinese output", () =>
    Effect.gen(function* () {
      const session = yield* (yield* Session.Service).create({})
      for (let i = 0; i < 20; i++) yield* add(session.id, i, "中文证据".repeat(2000))
      const budget = NativeCompaction.resolve({ read_max_bytes: 2048, read_max_tokens: 512 })
      const result = yield* query({ operation: "search", query: "中文证据", session_id: session.id }, "*", budget)
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(2048)
      const controller = new AbortController()
      controller.abort()
      const spec = resolve({ operation: "search", query: "中文证据" }, "*", current, limits)
      expect((yield* Database.use((db) => run(db, spec, controller.signal)).pipe(Effect.exit))._tag).toBe("Failure")
    }),
  )

  test("validates required fields, time bounds, literal queries and cursor scope", () => {
    const decode = Schema.decodeUnknownSync(Parameters)
    expect(() => decode({ operation: "search", query: "x", limit: 0 })).toThrow()
    expect(() => resolve({ operation: "read" }, ".", current, limits)).toThrow("session_id and part_id")
    expect(() => resolve({ operation: "search", query: " " }, ".", current, limits)).toThrow("nonblank")
    expect(() => resolve({ operation: "search", query: "\0" }, ".", current, limits)).toThrow("NUL")
    expect(() => resolve({ operation: "search", query: "x", after: 2, before: 1 }, ".", current, limits)).toThrow(
      "earlier",
    )
    const cursor = Buffer.from(JSON.stringify({ time: 1, message: "msg_1", part: "prt_1", scope: "other" })).toString(
      "base64url",
    )
    expect(() => resolve({ operation: "search", query: "x", cursor }, ".", current, limits)).toThrow(
      "different search filters",
    )
  })
})
