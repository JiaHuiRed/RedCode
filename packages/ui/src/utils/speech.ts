export const SPEECH_VOICES = [
  { value: "冰糖", label: "冰糖 (Bīng Táng)" },
  { value: "茉莉", label: "茉莉 (Mò Lì)" },
  { value: "苏打", label: "苏打 (Sū Dǎ)" },
  { value: "白桦", label: "白桦 (Bái Huà)" },
  { value: "Mia", label: "Mia (EN)" },
  { value: "Chloe", label: "Chloe (EN)" },
  { value: "Milo", label: "Milo (EN)" },
  { value: "Dean", label: "Dean (EN)" },
]

export const SPEECH_TEXT_LIMIT = 5_000
export const SPEECH_TIMEOUT_MS = 30_000

const errorKeys = {
  "missing-key": "ui.speech.error.missingKey",
  "empty-text": "ui.speech.error.emptyText",
  authorization: "ui.speech.error.authorization",
  request: "ui.speech.error.request",
  network: "ui.speech.error.network",
  timeout: "ui.speech.error.timeout",
  "invalid-audio": "ui.speech.error.invalidAudio",
} as const

export class SpeechError extends Error {
  constructor(readonly code: keyof typeof errorKeys) {
    super(code)
    this.name = "SpeechError"
  }
}

export const speechErrorKey = (error: unknown) =>
  error instanceof SpeechError ? errorKeys[error.code] : "ui.speech.error.playback"

export async function requestSpeech(input: {
  apiKey: string
  voice?: string
  text: string
  signal?: AbortSignal
}): Promise<Blob> {
  if (input.signal?.aborted) throw new DOMException("Speech request cancelled", "AbortError")
  if (!input.apiKey.trim()) throw new SpeechError("missing-key")
  if (!input.text.trim()) throw new SpeechError("empty-text")
  const timeout = AbortSignal.timeout(SPEECH_TIMEOUT_MS)
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout
  try {
    const response = await fetch("https://api.xiaomimimo.com/v1/chat/completions", {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json", "api-key": input.apiKey.trim() },
      body: JSON.stringify({
        model: "mimo-v2.5-tts",
        messages: [
          { role: "user", content: "" },
          { role: "assistant", content: input.text.slice(0, SPEECH_TEXT_LIMIT) },
        ],
        audio: { format: "wav", voice: input.voice || SPEECH_VOICES[0].value },
      }),
    })
    if (!response.ok) {
      // Discard provider error bodies; they may echo credentials and must not reach the UI.
      await response.body?.cancel().catch(() => undefined)
      throw new SpeechError(response.status === 401 || response.status === 403 ? "authorization" : "request")
    }
    const payload: unknown = await response.json().catch(() => {
      throw new SpeechError("invalid-audio")
    })
    const encoded = audioData(payload)
    if (!encoded) throw new SpeechError("invalid-audio")
    let bytes: string
    try {
      bytes = atob(encoded)
    } catch {
      // This boundary decodes untrusted provider data; malformed base64 is a visible format error.
      throw new SpeechError("invalid-audio")
    }
    if (!bytes.length) throw new SpeechError("invalid-audio")
    return new Blob([Uint8Array.from(bytes, (char) => char.charCodeAt(0))], { type: "audio/wav" })
  } catch (error) {
    if (input.signal?.aborted) throw new DOMException("Speech request cancelled", "AbortError")
    if (timeout.aborted) throw new SpeechError("timeout")
    if (error instanceof SpeechError) throw error
    throw new SpeechError("network")
  }
}

function audioData(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || !("choices" in value) || !Array.isArray(value.choices)) return
  const choice: unknown = value.choices[0]
  if (!choice || typeof choice !== "object" || !("message" in choice)) return
  const message = choice.message
  if (!message || typeof message !== "object" || !("audio" in message)) return
  const audio = message.audio
  if (!audio || typeof audio !== "object" || !("data" in audio) || typeof audio.data !== "string") return
  return audio.data
}
