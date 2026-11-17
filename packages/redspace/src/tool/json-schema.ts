import type { JSONSchema7 } from "@ai-sdk/provider"
import { JsonSchema, Schema } from "effect"
import type * as Tool from "./tool"

type JsonObject = Record<string, unknown>
const cache = new WeakMap<Schema.Top, JSONSchema7>()

export function fromSchema(schema: Schema.Top): JSONSchema7 {
  const cached = cache.get(schema)
  if (cached) return cached

  const document = Schema.toJsonSchemaDocument(schema, { onExcessProperty: "ignore" })
  const result = normalize({
    $schema: JsonSchema.META_SCHEMA_URI_DRAFT_2020_12,
    ...document.schema,
    ...(Object.keys(document.definitions).length > 0 ? { $defs: document.definitions } : {}),
  })
  const inlined = dropDefinitionsIfResolved(inlineLocalReferences(result))
  if (!isJsonSchema(inlined)) throw new Error("tool JSON Schema helper produced a non-schema value")
  // 261023 Red Effect 4.0.5 把空 Struct 的编码从 anyOf[object,array]（normalize 的
  // isEmptyStructUnion 分支能兜成 object）改成了 {not:{type:"null"}}（任意非 null 值），
  // 顶层不再有 type——严格网关直接拒整单请求（`schema must be a JSON Schema of
  // 'type: "object"', got 'type: "None"'`，Step / GPT-6 Luna 实证，ses_ffe5e999）。
  // 工具参数在传输层永远是对象：根节点没有任何 schema 意图键时兜底补对象定义。
  if (!isRecord(inlined) || hasSchemaIntent(inlined)) {
    cache.set(schema, inlined)
    return inlined
  }
  const { not: _, ...rest } = inlined
  const withRoot: JSONSchema7 = { ...rest, type: "object", properties: {} }
  cache.set(schema, withRoot)
  return withRoot
}

export function fromTool(tool: Tool.Def): JSONSchema7 {
  return tool.jsonSchema ?? fromSchema(tool.parameters as Schema.Top)
}

// 261021 Red 模型幻觉参数的第一道闸：AI SDK 会将原始参数传入工具 execute，额外字段随后
// 才会被 Tool.define 的 Effect Schema 解码忽略。这里对照 schema 顶层 properties 找出未知
// 顶层参数，调用方据此显式报错。schema 无 properties（freeform/MCP 动态 schema）时跳过。
export function unknownArgumentKeys(schema: JSONSchema7, args: unknown): string[] {
  const properties = isRecord(schema) && isRecord(schema.properties) ? schema.properties : undefined
  if (!properties) return []
  if (!args || typeof args !== "object" || Array.isArray(args)) return []
  return Object.keys(args).filter((key) => !(key in properties))
}

function normalize(value: unknown, options: { stripNull?: boolean } = {}): unknown {
  if (Array.isArray(value)) return value.map((item) => normalize(item))
  if (!isRecord(value)) return value

  const required = Array.isArray(value.required)
    ? new Set(value.required.filter((item) => typeof item === "string"))
    : undefined
  const schema = Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      key === "properties" && isRecord(item)
        ? Object.fromEntries(
            Object.entries(item).map(([name, property]) => [
              name,
              normalize(property, { stripNull: !required?.has(name) }),
            ]),
          )
        : normalize(item),
    ]),
  )

  if (schema.additionalProperties === true) delete schema.additionalProperties

  if (options.stripNull && Array.isArray(schema.anyOf)) {
    const withoutNull = schema.anyOf.filter((item) => !isRecord(item) || item.type !== "null")
    if (withoutNull.length !== schema.anyOf.length) return normalize({ ...schema, anyOf: withoutNull })
  }

  if (Array.isArray(schema.anyOf)) {
    const withoutNull = schema.anyOf
    const number = withoutNull.find((item) => isRecord(item) && item.type === "number")
    const nonFinite = withoutNull.filter(
      (item) => isRecord(item) && Array.isArray(item.enum) && item.enum.every((entry) => isNonFiniteNumber(entry)),
    )
    if (number && nonFinite.length === withoutNull.length - 1) {
      const { anyOf: _, ...rest } = schema
      return normalize({ ...number, ...rest })
    }

    if (isEmptyStructUnion(withoutNull)) {
      const { anyOf: _, ...rest } = schema
      return normalize({ type: "object", properties: {}, ...rest })
    }

    if (withoutNull.length === 1 && isRecord(withoutNull[0])) {
      const { anyOf: _, ...rest } = schema
      return normalize({ ...withoutNull[0], ...rest })
    }
  }

  if (Array.isArray(schema.allOf) && schema.allOf.every(isRecord) && canFlattenAllOf(schema.allOf, schema)) {
    const { allOf, ...rest } = schema
    return normalize({ ...Object.assign({}, ...allOf), ...rest })
  }

  if (schema.type === "integer" && schema.maximum === undefined) {
    return { minimum: Number.MIN_SAFE_INTEGER, ...schema, maximum: Number.MAX_SAFE_INTEGER }
  }

  return schema
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// 顶层 schema 意图键：出现任一即认为根已经是明确的 schema 定义。故意不含 not——
// Effect 4.0.5 的「任意值」编码 {not:{type:"null"}} 只带 not，正是要被兜底成对象的形态。
const SCHEMA_INTENT_KEYS: readonly string[] = [
  "type",
  "properties",
  "items",
  "anyOf",
  "oneOf",
  "allOf",
  "$ref",
  "enum",
  "const",
  "prefixItems",
]

function hasSchemaIntent(schema: JsonObject): boolean {
  return SCHEMA_INTENT_KEYS.some((key) => key in schema)
}

function isJsonSchema(value: unknown): value is JSONSchema7 {
  return typeof value === "boolean" || isRecord(value)
}

function isNonFiniteNumber(value: unknown) {
  return value === "NaN" || value === "Infinity" || value === "-Infinity"
}

function isEmptyStructUnion(items: unknown[]) {
  return (
    items.length === 2 &&
    items.some((item) => isRecord(item) && item.type === "object" && item.properties === undefined) &&
    items.some((item) => isRecord(item) && item.type === "array" && item.items === undefined)
  )
}

function canFlattenAllOf(allOf: JsonObject[], parent: JsonObject) {
  const keys = new Set(Object.keys(parent).filter((key) => key !== "allOf"))
  return allOf.every((item) =>
    Object.keys(item).every((key) => {
      if (keys.has(key)) return false
      keys.add(key)
      return true
    }),
  )
}

function inlineLocalReferences(value: unknown, definitions?: JsonObject, seen = new Set<string>()): unknown {
  if (Array.isArray(value)) return value.map((item) => inlineLocalReferences(item, definitions, seen))
  if (!isRecord(value)) return value

  const localDefinitions = definitions ?? (isRecord(value.$defs) ? value.$defs : undefined)
  if (typeof value.$ref === "string" && localDefinitions) {
    const name = value.$ref.match(/^#\/\$defs\/(.+)$/)?.[1] ?? value.$ref.match(/^#\/definitions\/(.+)$/)?.[1]
    if (name && !seen.has(name)) {
      const target = localDefinitions[name]
      if (target) {
        const { $ref: _, ...rest } = value
        return inlineLocalReferences(
          { ...(isRecord(target) ? target : {}), ...rest },
          localDefinitions,
          new Set(seen).add(name),
        )
      }
    }
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, inlineLocalReferences(item, localDefinitions, seen)]),
  )
}

function dropDefinitionsIfResolved(value: unknown): unknown {
  if (!isRecord(value) || hasLocalReference(value)) return value
  const { $defs: _, definitions: __, ...rest } = value
  return rest
}

function hasLocalReference(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasLocalReference)
  if (!isRecord(value)) return false
  if (
    typeof value.$ref === "string" &&
    (value.$ref.startsWith("#/$defs/") || value.$ref.startsWith("#/definitions/"))
  ) {
    return true
  }
  return Object.values(value).some(hasLocalReference)
}

export * as ToolJsonSchema from "./json-schema"
