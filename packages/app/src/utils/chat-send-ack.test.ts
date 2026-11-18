import { describe, expect, test } from "bun:test"
import type { Event, OpencodeClient } from "@redcode-ai/sdk/v2/client"
import { sendCompanionMessage, submitAcknowledgedChat } from "./chat-send-ack"

describe("Chat transport acknowledgement", () => {
  test("204 without a stored user message is not acceptance; a model error rejects it", async () => {
    let notify!: Parameters<Parameters<typeof submitAcknowledgedChat>[0]["subscribe"]>[0]
    let cleanup = 0
    let accepted = false
    const modelError = new Error("No model configured")
    const pending = submitAcknowledgedChat({
      submit: async () => undefined,
      lookup: async () => false,
      subscribe: (listener) => {
        notify = listener
        return () => {
          cleanup++
        }
      },
      timeoutMessage: "Unconfirmed",
      pollMs: 1,
    }).then(() => {
      accepted = true
    })
    expect(accepted).toBe(false)
    notify({ type: "error", error: modelError })
    await expect(pending).rejects.toThrow("No model configured")
    expect(accepted).toBe(false)
    expect(cleanup).toBe(1)
  })

  test("a database lookup confirms the exact message when its SSE event is missed", async () => {
    let lookups = 0
    let cleanup = 0
    await submitAcknowledgedChat({
      submit: async () => undefined,
      lookup: async () => ++lookups === 2,
      subscribe: () => () => {
        cleanup++
      },
      timeoutMessage: "Unconfirmed",
      pollMs: 1,
    })
    expect(lookups).toBe(2)
    expect(cleanup).toBe(1)
  })

  test("a persisted message can confirm an otherwise lost HTTP response", async () => {
    let cleanup = 0
    await submitAcknowledgedChat({
      submit: async () => {
        throw new Error("Response lost")
      },
      lookup: async () => true,
      subscribe: () => () => {
        cleanup++
      },
      timeoutMessage: "Unconfirmed",
    })
    expect(cleanup).toBe(1)
  })

  test("waiting for a missing message is bounded and removes its event listener", async () => {
    let cleanup = 0
    await expect(
      submitAcknowledgedChat({
        submit: async () => undefined,
        lookup: async () => false,
        subscribe: () => () => {
          cleanup++
        },
        timeoutMessage: "Unconfirmed",
        timeoutMs: 5,
        pollMs: 1,
      }),
    ).rejects.toThrow("Unconfirmed")
    expect(cleanup).toBe(1)
  })

  test("a never-resolving submit is aborted at the same deadline", async () => {
    let signal: AbortSignal | undefined
    let cleanup = 0
    await expect(
      submitAcknowledgedChat({
        submit: (value) => {
          signal = value
          return new Promise(() => {})
        },
        lookup: async () => false,
        subscribe: () => () => {
          cleanup++
        },
        timeoutMessage: "Submit deadline",
        timeoutMs: 5,
      }),
    ).rejects.toThrow("Submit deadline")
    expect(signal?.aborted).toBe(true)
    expect(cleanup).toBe(1)
  })

  test("a never-resolving lookup is aborted at the same deadline", async () => {
    let signal: AbortSignal | undefined
    let cleanup = 0
    await expect(
      submitAcknowledgedChat({
        submit: async () => undefined,
        lookup: (value) => {
          signal = value
          return new Promise(() => {})
        },
        subscribe: () => () => {
          cleanup++
        },
        timeoutMessage: "Lookup deadline",
        timeoutMs: 5,
      }),
    ).rejects.toThrow("Lookup deadline")
    expect(signal?.aborted).toBe(true)
    expect(cleanup).toBe(1)
  })

  test("a message header cannot consume the draft before its text part is persisted", async () => {
    let event!: (value: Event) => void
    let lookupStarted!: () => void
    const lookedUp = new Promise<void>((resolve) => {
      lookupStarted = resolve
    })
    let accepted = false
    const client = {
      session: {
        promptAsync: async () => undefined,
        message: async () => {
          lookupStarted()
          return { data: { info: { id: "message-a", role: "user" }, parts: [] } }
        },
      },
    } as unknown as Pick<OpencodeClient, "session">
    const pending = sendCompanionMessage({
      client,
      listen: (_, listener) => {
        event = listener
        return () => {}
      },
      session: { id: "session-a", directory: "/a" },
      messageID: "message-a",
      text: "hello",
      timeoutMessage: "Unconfirmed",
    }).then(() => {
      accepted = true
    })
    await lookedUp
    event({
      type: "message.updated",
      properties: { info: { id: "message-a", sessionID: "session-a", role: "user" } },
    } as Event)
    await Promise.resolve()
    expect(accepted).toBe(false)
    event({
      type: "message.part.updated",
      properties: {
        part: {
          id: "part-a",
          sessionID: "session-a",
          messageID: "message-a",
          type: "text",
          text: "plugin-adjusted hello",
        },
      },
    } as Event)
    await pending
    expect(accepted).toBe(true)
  })

  test("GET confirmation requires text while allowing plugin-adjusted user content", async () => {
    let calls = 0
    const client = {
      session: {
        promptAsync: async () => undefined,
        message: async () => {
          calls++
          return {
            data: { info: { id: "message-a", role: "user" }, parts: [{ type: "text", text: "rewritten by plugin" }] },
          }
        },
      },
    } as unknown as Pick<OpencodeClient, "session">
    await sendCompanionMessage({
      client,
      listen: () => () => {},
      session: { id: "session-a", directory: "/a" },
      messageID: "message-a",
      text: "original",
      timeoutMessage: "Unconfirmed",
    })
    expect(calls).toBe(1)
  })
})
