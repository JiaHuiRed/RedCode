import { describe, expect, test } from "bun:test"
import { formatMcpPairs, validateMcpForm, type McpFormValues } from "./settings-mcp-form"

const form = (patch: Partial<McpFormValues> = {}): McpFormValues => ({
  name: "example",
  type: "local",
  command: '["node", "C:\\\\My Tools\\\\server.js"]',
  url: "https://example.com/mcp",
  cwd: "",
  timeout: "",
  tools: "",
  toolsMode: "all",
  enabled: false,
  environment: "",
  headers: "",
  ...patch,
})

describe("MCP settings form", () => {
  test("preserves quoted paths and explicitly clears the environment while omitting resettable fields", () => {
    expect(validateMcpForm(form())).toEqual({
      id: "example",
      config: {
        type: "local",
        command: ["node", "C:\\My Tools\\server.js"],
        environment: {},
        enabled: false,
      },
    })
  })

  test("keeps all, none and selected tools distinct", () => {
    expect(validateMcpForm(form({ toolsMode: "none" })).config?.tools).toEqual([])
    expect(validateMcpForm(form({ toolsMode: "list", tools: "read, write, read" })).config?.tools).toEqual([
      "read",
      "write",
    ])
    expect(validateMcpForm(form({ toolsMode: "list" })).error).toBe("settings.mcp.toast.toolsRequired")
  })

  test("keeps equals signs and spaces in environment values", () => {
    expect(validateMcpForm(form({ environment: "TOKEN=first=second\nMESSAGE= two words " })).config).toMatchObject({
      environment: { TOKEN: "first=second", MESSAGE: " two words " },
    })
  })

  test("round-trips multiline environment values through JSON", () => {
    const values = { CERTIFICATE: "first\nsecond" }
    expect(validateMcpForm(form({ environment: formatMcpPairs(values, "=") })).config).toMatchObject({
      environment: values,
    })
  })

  test("clears remote headers explicitly and rejects case-insensitive duplicates", () => {
    expect(validateMcpForm(form({ type: "remote" })).config).toEqual({
      type: "remote",
      url: "https://example.com/mcp",
      headers: {},
      enabled: false,
    })
    expect(
      validateMcpForm(form({ type: "remote", headers: "Authorization: first\nauthorization: second" })).error,
    ).toBe("settings.desktop.mcp.headersInvalid")
  })

  test("rejects incomplete commands, unsafe header lines, invalid URLs and nonpositive timeouts", () => {
    expect(validateMcpForm(form({ command: "" })).error).toBe("settings.desktop.mcp.commandRequired")
    expect(validateMcpForm(form({ command: '["node", 42]' })).error).toBe("settings.mcp.toast.commandInvalid")
    expect(validateMcpForm(form({ type: "remote", headers: '{"X-Test":"one\\r\\nInjected: two"}' })).error).toBe(
      "settings.desktop.mcp.headersInvalid",
    )
    expect(validateMcpForm(form({ type: "remote", url: "file:///tmp/server" })).error).toBe(
      "settings.desktop.mcp.urlInvalid",
    )
    for (const timeout of ["0", "-1", "1.5", "NaN"]) {
      expect(validateMcpForm(form({ timeout })).error).toBe("settings.desktop.mcp.timeoutInvalid")
    }
  })
})
