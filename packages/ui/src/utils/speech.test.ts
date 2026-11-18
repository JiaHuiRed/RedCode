import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import {
  requestSpeech,
  SPEECH_TEXT_LIMIT,
  SPEECH_TIMEOUT_MS,
  SPEECH_VOICES,
  SpeechError,
  speechErrorKey,
} from "./speech"

const input = { apiKey: "example-key", voice: "茉莉", text: "Hello" }
const audioResponse = () => Response.json({ choices: [{ message: { audio: { data: btoa("RIFFaudio") } } }] })
const waitForAbort = Object.assign(
  (...[_url, init]: Parameters<typeof globalThis.fetch>) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true })
    }),
  { preconnect: () => undefined },
)

afterEach(() => mock.restore())

describe("speech requests", () => {
  test("uses the configured voice, caps input text and returns a WAV blob", async () => {
    const fetch = spyOn(globalThis, "fetch").mockResolvedValue(audioResponse())
    const timeout = spyOn(AbortSignal, "timeout")
    const result = await requestSpeech({ ...input, text: "a".repeat(SPEECH_TEXT_LIMIT + 20) })
    const [url, options] = fetch.mock.calls[0]
    expect(url).toBe("https://api.xiaomimimo.com/v1/chat/completions")
    const body = JSON.parse(String(options?.body))
    expect(body.model).toBe("mimo-v2.5-tts")
    expect(body.messages[1].content).toHaveLength(5_000)
    expect(body.audio).toEqual({ format: "wav", voice: "茉莉" })
    expect(timeout).toHaveBeenCalledWith(SPEECH_TIMEOUT_MS)
    expect(result.type).toBe("audio/wav")
    expect(await result.text()).toBe("RIFFaudio")
    expect(SPEECH_VOICES).toHaveLength(8)
  })

  test("reports a missing API key without making a request", async () => {
    const fetch = spyOn(globalThis, "fetch")
    const error = await requestSpeech({ ...input, apiKey: " " }).catch((error: unknown) => error)
    expect(speechErrorKey(error)).toBe("ui.speech.error.missingKey")
    expect(fetch).not.toHaveBeenCalled()
  })

  test("does not surface credentials echoed by an HTTP error body", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(new Response("example-key: rejected", { status: 401 }))
    const error = await requestSpeech(input).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(SpeechError)
    expect(speechErrorKey(error)).toBe("ui.speech.error.authorization")
    expect(String(error)).not.toContain(input.apiKey)
  })

  test("does not surface details from a network exception", async () => {
    spyOn(globalThis, "fetch").mockRejectedValue(new Error("request containing example-key failed"))
    const error = await requestSpeech(input).catch((error: unknown) => error)
    expect(speechErrorKey(error)).toBe("ui.speech.error.network")
    expect(String(error)).not.toContain(input.apiKey)
  })

  test("reports malformed and missing audio", async () => {
    const fetch = spyOn(globalThis, "fetch")
    for (const value of [{}, { choices: [{ message: { audio: { data: "not base64!" } } }] }]) {
      fetch.mockResolvedValueOnce(Response.json(value))
      const error = await requestSpeech(input).catch((error: unknown) => error)
      expect(speechErrorKey(error)).toBe("ui.speech.error.invalidAudio")
    }
  })

  test("distinguishes timeout from a user cancellation", async () => {
    const timeout = new AbortController()
    spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal)
    spyOn(globalThis, "fetch").mockImplementation(waitForAbort)
    const pending = requestSpeech(input).catch((error: unknown) => error)
    timeout.abort()
    expect(speechErrorKey(await pending)).toBe("ui.speech.error.timeout")

    const cancelled = await requestSpeech({ ...input, signal: AbortSignal.abort() }).catch((error: unknown) => error)
    expect((cancelled as Error).name).toBe("AbortError")
  })

  test("aborts an in-flight request without reporting a service failure", async () => {
    spyOn(globalThis, "fetch").mockImplementation(waitForAbort)
    const controller = new AbortController()
    const pending = requestSpeech({ ...input, signal: controller.signal }).catch((error: unknown) => error)
    controller.abort()
    expect(((await pending) as Error).name).toBe("AbortError")
  })
})
