import { expect, test } from "bun:test"
import { Schema } from "effect"
import { ToolJsonSchema } from "@/tool/json-schema"

// 261021 Red 幻觉参数第一道闸：unknownArgumentKeys 对照 schema 顶层 properties 找未知参数。
// 261021 Red unknownArgumentKeys 检查 SessionTools 送入 SDK 的原始参数；Effect Schema 解码
// 仍会忽略额外字段，但它发生在校验之后，不能把未知参数误归因给 SDK 静默 strip。

const readSchema = ToolJsonSchema.fromSchema(Schema.Struct({ filePath: Schema.String }))

test("known arguments pass, unknown top-level arguments are surfaced", () => {
  expect(ToolJsonSchema.unknownArgumentKeys(readSchema, { filePath: "a.txt" })).toEqual([])
  expect(ToolJsonSchema.unknownArgumentKeys(readSchema, { filePath: "a.txt", content: "body" })).toEqual(["content"])
  expect(ToolJsonSchema.unknownArgumentKeys(readSchema, { content: "body", junk: 1 })).toEqual(["content", "junk"])
})

test("schemas without properties and non-object args skip the check", () => {
  expect(ToolJsonSchema.unknownArgumentKeys({ type: "string" }, "raw text")).toEqual([])
  expect(ToolJsonSchema.unknownArgumentKeys(readSchema, "not-an-object")).toEqual([])
  expect(ToolJsonSchema.unknownArgumentKeys(readSchema, null)).toEqual([])
})

// 261023 Red Effect 4.0.5 把空 Struct 编码成 {not:{type:"null"}}（顶层无 type），
// 严格网关（Step / GPT-6 Luna）拒整单请求。根节点必须兜底成对象 schema。
test("empty Struct root falls back to an object schema", () => {
  expect(ToolJsonSchema.fromSchema(Schema.Struct({}))).toEqual({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {},
  })
})
