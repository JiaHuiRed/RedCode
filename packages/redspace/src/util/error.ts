import { isRecord } from "./record"

export function errorFormat(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`
  }

  if (typeof error === "object" && error !== null) {
    try {
      const json = JSON.stringify(error, null, 2)
      // Plain objects whose own properties are all non-enumerable (or empty)
      // serialize to "{}", which prints as a useless bare `{}` on stderr.
      // Fall back to a custom toString first, then to ctor name + own prop names.
      if (json === "{}") {
        const str = String(error)
        if (str && str !== "[object Object]") return str
        const ctor = error.constructor?.name
        const prefix = ctor && ctor !== "Object" ? ctor : "Error"
        const names = Object.getOwnPropertyNames(error)
        return names.length === 0 ? `${prefix} (no message)` : `${prefix} { ${names.join(", ")} }`
      }
      return json
    } catch {
      return "Unexpected error (unserializable)"
    }
  }

  return String(error)
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.message) return error.message
    if (error.name) return error.name
  }

  if (isRecord(error) && typeof error.message === "string" && error.message) {
    return error.message
  }

  if (isRecord(error) && isRecord(error.data) && typeof error.data.message === "string" && error.data.message) {
    return error.data.message
  }

  const text = String(error)
  if (text && text !== "[object Object]") return text

  const formatted = errorFormat(error)
  if (formatted) return formatted
  return "unknown error"
}

export type ErrorLink = {
  type: string
  message: string
  code?: string
}

/**
 * 261111 Red 错误链摘要。AI SDK 的 APICallError 只带自己的 message，真正的原因
 * （`terminated` / `other side closed` / `ECONNRESET`）藏在 cause 里；只记 message
 * 就永远看不出连接是谁断的。上限 4 层、每层 300 字符，避免日志出现无界正文。
 */
export function errorChain(error: unknown, limit = 4): ErrorLink[] {
  const links: ErrorLink[] = []
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current !== undefined && current !== null && links.length < limit && !seen.has(current)) {
    seen.add(current)
    const record = isRecord(current) ? current : undefined
    const code = typeof record?.code === "string" ? record.code : undefined
    const type =
      current instanceof Error ? current.name : typeof record?.name === "string" ? record.name : typeof current
    links.push({ type, message: errorMessage(current).slice(0, 300), ...(code ? { code } : {}) })
    current = current instanceof Error ? current.cause : record?.cause
  }
  return links
}

export function errorData(error: unknown) {
  if (error instanceof Error) {
    return {
      type: error.name,
      message: errorMessage(error),
      stack: error.stack,
      cause: error.cause === undefined ? undefined : errorFormat(error.cause),
      formatted: errorFormat(error),
    }
  }

  if (!isRecord(error)) {
    return {
      type: typeof error,
      message: errorMessage(error),
      formatted: errorFormat(error),
    }
  }

  const data = Object.getOwnPropertyNames(error).reduce<Record<string, unknown>>((acc, key) => {
    const value = error[key]
    if (value === undefined) return acc
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      acc[key] = value
      return acc
    }
    // oxlint-disable-next-line no-base-to-string -- intentional coercion of arbitrary error properties
    acc[key] = value instanceof Error ? value.message : String(value)
    return acc
  }, {})

  if (typeof data.message !== "string") data.message = errorMessage(error)
  if (typeof data.type !== "string") data.type = error.constructor?.name
  data.formatted = errorFormat(error)
  return data
}
