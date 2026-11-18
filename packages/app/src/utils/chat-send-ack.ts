import type { Event, OpencodeClient, Session } from "@redcode-ai/sdk/v2/client"

type Signal = { type: "accepted" } | { type: "error"; error: unknown }

/** A 204 only starts the backend task. Require the exact user message to exist before consuming a draft. */
export async function submitAcknowledgedChat(input: {
  submit: (signal: AbortSignal) => Promise<unknown>
  lookup: (signal: AbortSignal) => Promise<boolean>
  subscribe: (listener: (signal: Signal) => void) => () => void
  timeoutMessage: string
  timeoutMs?: number
  pollMs?: number
}) {
  let accepted = false
  let failure: unknown
  let wake: (() => void) | undefined
  const controller = new AbortController()
  const timeout = new Error(input.timeoutMessage)
  const deadline = Date.now() + (input.timeoutMs ?? 8000)
  let rejectDeadline!: (error: Error) => void
  const expired = new Promise<never>((_, reject) => {
    rejectDeadline = reject
  })
  const deadlineTimer = setTimeout(() => {
    controller.abort(timeout)
    rejectDeadline(timeout)
  }, input.timeoutMs ?? 8000)
  const run = <T>(action: (signal: AbortSignal) => Promise<T>) => Promise.race([action(controller.signal), expired])
  let unsubscribe = () => {}
  try {
    unsubscribe = input.subscribe((signal) => {
      if (signal.type === "accepted") accepted = true
      else failure = signal.error
      wake?.()
    })
    try {
      await run(input.submit)
    } catch (error) {
      if (accepted) return
      if (controller.signal.aborted) throw timeout
      if (
        await run(input.lookup).catch((lookupError) => {
          if (controller.signal.aborted) throw lookupError
          return false
        })
      )
        return
      throw failure ?? error
    }
    while (!accepted) {
      if (await run(input.lookup)) return
      if (accepted) return
      if (failure) throw failure
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw timeout
      await Promise.race([
        new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer)
            wake = undefined
            resolve()
          }
          const timer = setTimeout(finish, Math.min(input.pollMs ?? 250, remaining))
          wake = finish
        }),
        expired,
      ])
    }
  } finally {
    clearTimeout(deadlineTimer)
    wake?.()
    controller.abort()
    unsubscribe()
  }
}

export function sendCompanionMessage(input: {
  client: Pick<OpencodeClient, "session">
  listen: (directory: string, listener: (event: Event) => void) => () => void
  session: Pick<Session, "id" | "directory">
  messageID: string
  text: string
  timeoutMessage: string
}) {
  const { session, messageID } = input
  return submitAcknowledgedChat({
    timeoutMessage: input.timeoutMessage,
    submit: (signal) =>
      input.client.session.promptAsync(
        {
          directory: session.directory,
          sessionID: session.id,
          messageID,
          parts: [{ type: "text", text: input.text }],
        },
        { throwOnError: true, signal },
      ),
    lookup: async (signal) => {
      const result = await input.client.session.message(
        { directory: session.directory, sessionID: session.id, messageID },
        { throwOnError: false, signal },
      )
      if (result.data)
        return (
          result.data.info.role === "user" &&
          result.data.info.id === messageID &&
          result.data.parts.some((part) => part.type === "text" && !!part.text.trim())
        )
      if (result.response.status === 404) return false
      throw result.error
    },
    subscribe: (notify) =>
      input.listen(session.directory, (event) => {
        if (
          event.type === "message.part.updated" &&
          event.properties.part.sessionID === session.id &&
          event.properties.part.messageID === messageID &&
          event.properties.part.type === "text" &&
          !!event.properties.part.text.trim()
        )
          notify({ type: "accepted" })
        if (event.type === "session.error" && event.properties.sessionID === session.id && event.properties.error)
          notify({ type: "error", error: event.properties.error })
      }),
  })
}

/** Read the server's resolved active provider list; model precedence remains entirely on the server. */
export async function requireCompanionModel(
  client: Pick<OpencodeClient, "config">,
  directory: string,
  message: string,
) {
  const { data } = await client.config.providers({ directory }, { throwOnError: true })
  if (!data.providers.some((provider) => Object.keys(provider.models).length > 0)) throw new Error(message)
}
