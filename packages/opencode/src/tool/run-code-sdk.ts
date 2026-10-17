import type { JSONSchema7, JSONSchema7Definition } from "@ai-sdk/provider"

// 261017 Red PTC 形态的 SDK 声明生成（对齐 deepseek-harness 的 run_code 设计：
// 模型写一段程序调工具，中间结果不进对话，只有外层输出进上下文）。
//
// 这里只生成 TypeScript 声明文本，不参与类型检查——声明是给模型看的接口说明书，
// 执行时参数仍是 JSON。因此未知形状一律退成 unknown，绝不为了"看起来精确"去猜，
// 猜错的类型会把模型引到错误的参数形状上。

export type VisibleTool = {
  id: string
  description: string
  schema: JSONSchema7
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

// 261017 Red 硬上限：SDK 会随可见工具（含用户挂的 MCP 工具）线性增长，不设顶等于把
// 工具表再翻一倍。超预算时只保留能完整放下的声明，剩下的退化成 id 列表——它们仍然可调，
// 只是模型看不到签名，需要时用 search_tools 查。
const SDK_BUDGET = 24_000
const OMITTED_IDS = 20

function literal(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (value === null) return "null"
  return "unknown"
}

function some(value: JSONSchema7Definition | undefined): JSONSchema7 | undefined {
  return typeof value === "object" ? value : undefined
}

// 联合类型成员里有对象字面量时必须加括号，否则 `{a:1} | null` 会被读成属性类型。
function member(text: string): string {
  return text.includes(" | ") || text.startsWith("{") ? `(${text})` : text
}

function type(schema: JSONSchema7 | undefined): string {
  if (schema === undefined) return "unknown"
  // fromSchema 会把 $defs 内联掉；残留的 $ref 只可能是环，展开会无限递归。
  if (schema.$ref) return "unknown"
  const any = schema.anyOf ?? schema.oneOf
  if (Array.isArray(any)) {
    const parts = [...new Set(any.map((item) => type(some(item))))]
    if (parts.length === 1) return parts[0]
    return parts.map(member).join(" | ")
  }
  if (schema.const !== undefined) return literal(schema.const)
  if (Array.isArray(schema.enum)) {
    const parts = [...new Set(schema.enum.map(literal))]
    return parts.length === 0 ? "never" : parts.map(member).join(" | ")
  }
  const declared = Array.isArray(schema.type) ? schema.type : schema.type === undefined ? [] : [schema.type]
  if (declared.length > 1) return declared.map((name) => type({ ...schema, type: name })).join(" | ")
  switch (declared[0]) {
    case "string":
      return "string"
    case "number":
    case "integer":
      return "number"
    case "boolean":
      return "boolean"
    case "null":
      return "null"
    case "array": {
      const items = schema.items
      if (Array.isArray(items)) return `[${items.map((item) => type(some(item))).join(", ")}]`
      const element = type(some(items))
      return element === "unknown" ? "unknown[]" : `${member(element)}[]`
    }
    case "object":
      return object(schema)
    default:
      return schema.properties === undefined ? "unknown" : object(schema)
  }
}

function object(schema: JSONSchema7): string {
  const required = new Set(Array.isArray(schema.required) ? schema.required : [])
  const properties = Object.entries(schema.properties ?? {}).map(([name, value]) => {
    const key = IDENTIFIER.test(name) ? name : JSON.stringify(name)
    return `${key}${required.has(name) ? "" : "?"}: ${type(some(value))}`
  })
  // additionalProperties === false 时不能给索引签名，否则声明比真实校验更宽松。
  if (schema.additionalProperties !== false && properties.length === 0) return "Record<string, unknown>"
  return properties.length === 0 ? "{}" : `{ ${properties.join("; ")} }`
}

// 工具描述只留第一句：完整描述已经在各自的工具 schema 里，重复一遍纯烧固定前缀。
function summary(text: string): string | undefined {
  const line = text.replace(/\s+/g, " ").trim()
  if (!line) return undefined
  const first = line.split(/(?<=\.)\s/)[0] ?? line
  return first.length > 140 ? `${first.slice(0, 137)}...` : first
}

function callable(id: string, tool: VisibleTool): string {
  const name = IDENTIFIER.test(id) ? id : JSON.stringify(id)
  return `${name}(input: ${type(tool.schema)}): Promise<string>`
}

/**
 * 生成 `tools` 绑定的 TypeScript 声明。
 *
 * 排序按工具 id：同一组可见工具必须产出逐字节相同的文本，否则每个会话的前缀都不同，
 * KV cache 从 SDK 段起全废。
 */
export function declaration(tools: readonly VisibleTool[]): string {
  const sorted = [...tools].toSorted((a, b) => a.id.localeCompare(b.id))
  const lines: string[] = []
  const omitted: string[] = []
  let used = 0
  for (const tool of sorted) {
    const text = summary(tool.description)
    const block = [
      ...(text === undefined ? [] : [`  /** ${text.replace(/\*\//g, "* /")} */`]),
      `  ${callable(tool.id, tool)}`,
    ]
    const size = block.join("\n").length + 1
    if (used + size > SDK_BUDGET) {
      omitted.push(tool.id)
      continue
    }
    lines.push(...block)
    used += size
  }
  if (omitted.length > 0) {
    lines.push(
      `  // ${omitted.length} more visible tool(s) omitted from this declaration: ${omitted.slice(0, OMITTED_IDS).join(", ")}${omitted.length > OMITTED_IDS ? ", ..." : ""}`,
    )
  }
  return [
    "```ts",
    "// Program-only SDK bindings. These names are not directly callable tools.",
    "// Argument types are advisory; every call still needs a valid JSON object.",
    "declare const tools: {",
    ...lines,
    "}",
    "```",
  ].join("\n")
}

export * as RunCodeSdk from "./run-code-sdk"
