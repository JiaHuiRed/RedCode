import { describe, expect, test } from "bun:test"
import { createSubmissionController } from "../../../src/cli/cmd/tui/component/prompt/submission"

// Regression test for the prompt submit race in
// packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx (`submit`).
//
// Before the fix, two concurrent `submit()` calls (e.g. a double-pressed
// Enter, or the input's native onSubmit racing another dispatch) each
// passed the `if (!store.prompt.input) return false` guard, each
// `await sdk.client.session.create(...)`, and each only captured
// `inputText = store.prompt.input` AFTER that await. The first invocation
// finished, sent the prompt, and cleared the store; the second invocation,
// now past its await, read the cleared store and sent an empty prompt to a
// second freshly-created session - leaving an orphaned session with the
// user's actual text and a phantom session visible to the user containing
// only an assistant reply.
//
// The submit harness uses the production submission controller so this test
// fails if the production gate or revision-safe consumption contract regresses.

type Store = { input: string }

type SubmitResult = { sessionID: string; text: string }

type Harness = {
  store: Store
  submissions: SubmitResult[]
  setSendError(error?: Error): void
  createSession(): Promise<string>
  sendPrompt(sessionID: string, text: string): Promise<void>
}

function createHarness(opts: { sessionCreateDelayMs: number }): Harness {
  let sessionCounter = 0
  let sendError: Error | undefined
  const submissions: SubmitResult[] = []

  return {
    store: { input: "" },
    submissions,
    setSendError(error) {
      sendError = error
    },
    async createSession() {
      sessionCounter += 1
      const id = `ses_${sessionCounter}`
      await Bun.sleep(opts.sessionCreateDelayMs)
      return id
    },
    async sendPrompt(sessionID, text) {
      if (sendError) throw sendError
      submissions.push({ sessionID, text })
    },
  }
}

function createSubmit() {
  const controller = createSubmissionController()
  return {
    changed() {
      controller.changed()
    },
    submit: async (h: Harness) => {
      if (!controller.acquire()) return false
      try {
        if (!h.store.input) return false
        const submission = controller.snapshot(h.store.input)
        const sessionID = await h.createSession()
        await h.sendPrompt(sessionID, submission.payload)
        if (controller.canConsume(submission)) h.store.input = ""
        return true
      } finally {
        controller.release()
      }
    },
  }
}

describe("Prompt.submit race", () => {
  test("concurrent submits must not lose the user's text", async () => {
    const submit = createSubmit()
    const h = createHarness({ sessionCreateDelayMs: 5 })
    h.store.input = "Hello there."

    // Two invocations back-to-back, mimicking a double-Enter.
    await Promise.all([submit.submit(h), submit.submit(h)])

    // Every submission that did make it through must carry the actual user
    // text, and no submission may have an empty text payload.
    expect(h.submissions.every((s) => s.text === "Hello there.")).toBe(true)
    expect(h.submissions.some((s) => s.text === "")).toBe(false)
  })

  test("a sequential second submit after clear is a no-op, not a phantom session", async () => {
    const submit = createSubmit()
    const h = createHarness({ sessionCreateDelayMs: 1 })
    h.store.input = "Hello there."

    await submit.submit(h)
    // After the first submission completes, the store is cleared; a second
    // Enter on an empty input must not create a phantom session.
    await submit.submit(h)

    expect(h.submissions).toHaveLength(1)
    expect(h.submissions[0].text).toBe("Hello there.")
  })

  test("freezes the payload and preserves a newer draft revision", async () => {
    const submit = createSubmit()
    const h = createHarness({ sessionCreateDelayMs: 5 })
    h.store.input = "A"

    const pending = submit.submit(h)
    h.store.input = "B"
    submit.changed()
    await pending

    expect(h.submissions[0].text).toBe("A")
    expect(h.store.input).toBe("B")
  })

  test("preserves the draft and releases the gate when sending fails", async () => {
    const submit = createSubmit()
    const h = createHarness({ sessionCreateDelayMs: 1 })
    h.store.input = "Keep this draft."
    h.setSendError(new Error("transport failed"))

    await expect(submit.submit(h)).rejects.toThrow("transport failed")
    expect(h.store.input).toBe("Keep this draft.")

    h.setSendError()
    await submit.submit(h)
    expect(h.submissions[0].text).toBe("Keep this draft.")
    expect(h.store.input).toBe("")
  })
})
