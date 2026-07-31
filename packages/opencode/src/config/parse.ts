export * as ConfigParse from "./parse"

import { type ParseError as JsoncParseError, parse as parseJsoncImpl, printParseErrorCode } from "jsonc-parser"
import { Cause, Exit, Schema as EffectSchema, SchemaIssue } from "effect"
import type { DeepMutable } from "@redcode-ai/core/schema"
import { InvalidError, JsonError } from "./error"

export function jsonc(text: string, filepath: string): unknown {
  const errors: JsoncParseError[] = []
  const data = parseJsoncImpl(text, errors, { allowTrailingComma: true })
  if (errors.length) {
    const lines = text.split("\n")
    const issues = errors
      .map((e) => {
        const beforeOffset = text.substring(0, e.offset).split("\n")
        const line = beforeOffset.length
        const column = beforeOffset[beforeOffset.length - 1].length + 1
        const problemLine = lines[line - 1]

        const error = `${printParseErrorCode(e.error)} at line ${line}, column ${column}`
        if (!problemLine) return error

        return `${error}\n   Line ${line}: ${problemLine}\n${"".padStart(column + 9)}^`
      })
      .join("\n")
    throw new JsonError({
      path: filepath,
      message: `\n--- JSONC Input ---\n${text}\n--- Errors ---\n${issues}\n--- End ---`,
    })
  }

  return data
}

export function schema<S extends EffectSchema.Decoder<unknown, never>>(
  schema: S,
  data: unknown,
  source: string,
): DeepMutable<S["Type"]> {
  const extra = topLevelExtraKeys(schema, data)
  if (extra.length) {
    // 260731 Karina 这里本来就把出错的键名算出来了，但只放进 issues、没进 message，
    // 而日志打的是 Error.message —— 于是线上只看到光秃秃的 "ConfigInvalidError:
    // ConfigInvalidError"，一个字的线索都没有。实测踩过一次：往共用的
    // ~/.redcode/redcode.jsonc 里加了个 TUI 0.8.0 才有的键，编译于更早的 GUI 包不认识它，
    // 整个 server 起不来，表现是"无法加载会话/列出文件失败/无法重新加载"三连，
    // 只能靠"我知道自己刚改了什么"才定位到。键名必须进 message。
    const detail = `Unrecognized key${extra.length === 1 ? "" : "s"}: ${extra.join(", ")}`
    throw new InvalidError({
      path: source,
      // TUI 与 GUI 版本号独立演进却共用同一份全局配置，新版加的键会打死旧版的另一端，
      // 提示里点出这条，省得下次又从头查
      message: `${source}: ${detail}. If this key was added by a newer client, that client and this one are reading the same config file — upgrade this one or remove the key.`,
      issues: [
        {
          code: "unrecognized_keys",
          keys: extra,
          path: [],
          message: detail,
        },
      ],
    })
  }

  const decoded = EffectSchema.decodeUnknownExit(schema)(data, { errors: "all", propertyOrder: "original" })
  if (Exit.isSuccess(decoded)) return decoded.value as DeepMutable<S["Type"]>
  const error = Cause.squash(decoded.cause)

  const issues = EffectSchema.isSchemaError(error)
    ? SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues.map((issue) => ({
        ...issue,
        message: issue.message,
        path: issue.path?.map(String) ?? [],
      }))
    : [{ message: String(error), path: [] }]

  throw new InvalidError(
    {
      path: source,
      // 同上：把出错的字段路径拼进 message，否则日志里只剩错误类名
      message: `${source}: ${issues
        .map((issue) => (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
        .join("; ")}`,
      issues,
    },
    { cause: error },
  )
}

function topLevelExtraKeys(schema: EffectSchema.Top, data: unknown) {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return []
  if (schema.ast._tag !== "Objects" || schema.ast.indexSignatures.length > 0) return []
  const known = new Set(schema.ast.propertySignatures.map((item) => String(item.name)))
  return Object.keys(data).filter((key) => !known.has(key))
}
