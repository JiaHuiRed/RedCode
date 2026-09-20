import { describe, expect, test } from "bun:test"
import type { ConfigInvalidError, ProviderModelNotFoundError } from "./server-errors"
import { formatServerError, parseReadableConfigInvalidError } from "./server-errors"

function fill(text: string, vars?: Record<string, string | number>) {
  if (!vars) return text
  return text.replace(/{{\s*(\w+)\s*}}/g, (_, key: string) => {
    const value = vars[key]
    if (value === undefined) return ""
    return String(value)
  })
}

function useLanguageMock() {
  const dict: Record<string, string> = {
    "error.chain.unknown": "Erro desconhecido",
    "error.chain.configInvalid": "Arquivo de config em {{path}} invalido",
    "error.chain.configInvalidWithMessage": "Arquivo de config em {{path}} invalido: {{message}}",
    "error.chain.modelNotFound": "Modelo nao encontrado: {{provider}}/{{model}}",
    "error.chain.didYouMean": "Voce quis dizer: {{suggestions}}",
    "error.chain.checkConfig": "Revise provider/model no config",
    "error.chain.resources": "Recursos do projeto esgotados",
    "error.chain.processStart": "Processo auxiliar nao iniciou",
  }
  return {
    t(key: string, vars?: Record<string, string | number>) {
      const text = dict[key]
      if (!text) return key
      return fill(text, vars)
    },
  }
}

const language = useLanguageMock()

describe("parseReadableConfigInvalidError", () => {
  test("formats issues with file path", () => {
    const error = {
      name: "ConfigInvalidError",
      data: {
        path: "RedCode.config.ts",
        issues: [
          { path: ["settings", "host"], message: "Required" },
          { path: ["mode"], message: "Invalid" },
        ],
      },
    } satisfies ConfigInvalidError

    const result = parseReadableConfigInvalidError(error, language.t)

    expect(result).toBe(
      ["Arquivo de config em RedCode.config.ts invalido: settings.host: Required", "mode: Invalid"].join("\n"),
    )
  })

  test("uses trimmed message when issues are missing", () => {
    const error = {
      name: "ConfigInvalidError",
      data: {
        path: "config",
        message: "  Bad value  ",
      },
    } satisfies ConfigInvalidError

    const result = parseReadableConfigInvalidError(error, language.t)

    expect(result).toBe("Arquivo de config em config invalido: Bad value")
  })
})

describe("formatServerError", () => {
  test("formats config invalid errors", () => {
    const error = {
      name: "ConfigInvalidError",
      data: {
        message: "Missing host",
      },
    } satisfies ConfigInvalidError

    const result = formatServerError(error, language.t)

    expect(result).toBe("Arquivo de config em config invalido: Missing host")
  })

  test("returns error messages", () => {
    expect(formatServerError(new Error("Request failed with status 503"), language.t)).toBe(
      "Request failed with status 503",
    )
  })

  test("classifies exhausted system resources", () => {
    expect(formatServerError(new Error("spawn ENOMEM"), language.t)).toBe("Recursos do projeto esgotados")
    expect(formatServerError(new Error("ERR_INSUFFICIENT_RESOURCES"), language.t)).toBe("Recursos do projeto esgotados")
  })

  test("classifies helper process startup failures", () => {
    expect(formatServerError(new Error("spawn UNKNOWN"), language.t)).toBe("Processo auxiliar nao iniciou")
    expect(formatServerError(new Error("spawn git UNKNOWN"), language.t)).toBe("Processo auxiliar nao iniciou")
    expect(formatServerError(new Error("spawn EAGAIN"), language.t)).toBe("Processo auxiliar nao iniciou")
  })

  test("returns provided string errors", () => {
    expect(formatServerError("Failed to connect to server", language.t)).toBe("Failed to connect to server")
  })

  test("uses translated unknown fallback", () => {
    expect(formatServerError(0, language.t)).toBe("Erro desconhecido")
  })

  test("falls back for unknown error objects and names", () => {
    expect(formatServerError({ name: "ServerTimeoutError", data: { seconds: 30 } }, language.t)).toBe(
      "Erro desconhecido",
    )
  })

  test("formats provider model errors using provider/model", () => {
    const error = {
      name: "ProviderModelNotFoundError",
      data: {
        providerID: "openai",
        modelID: "gpt-4.1",
      },
    } satisfies ProviderModelNotFoundError

    expect(formatServerError(error, language.t)).toBe(
      ["Modelo nao encontrado: openai/gpt-4.1", "Revise provider/model no config"].join("\n"),
    )
  })

  test("formats provider model suggestions", () => {
    const error = {
      name: "ProviderModelNotFoundError",
      data: {
        providerID: "x",
        modelID: "y",
        suggestions: ["x/y2", "x/y3"],
      },
    } satisfies ProviderModelNotFoundError

    expect(formatServerError(error, language.t)).toBe(
      ["Modelo nao encontrado: x/y", "Voce quis dizer: x/y2, x/y3", "Revise provider/model no config"].join("\n"),
    )
  })

  test("unwraps SDK-wrapped errors from cause.body", () => {
    const body = {
      name: "ConfigInvalidError",
      data: {
        message: "Missing host",
      },
    } satisfies ConfigInvalidError

    const wrapped = new Error("ConfigInvalidError", { cause: { body, status: 400 } })

    expect(formatServerError(wrapped, language.t)).toBe("Arquivo de config em config invalido: Missing host")
  })
})
