import { expect, test } from "bun:test"
import { Schema } from "effect"
import { ToolJsonSchema } from "@/tool/json-schema"

// 261021 Red 幻觉参数第一道闸：unknownArgumentKeys 对照 schema 顶层 properties 找未知参数。
// 场景还原：模型把要写的正文塞进 read 的 content 参数（schema 外），AI SDK 静默 strip 后
// 模型得不到纠正信号，同错重试 10 次白烧额度——现在调用方据此在执行前显式报错。

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
