import { Schema } from "effect"

export abstract class NamedError extends Error {
  abstract schema(): Schema.Top
  abstract toObject(): { name: string; data: unknown }

  static hasName(error: unknown, name: string): boolean {
    return (
      typeof error === "object" && error !== null && "name" in error && (error as Record<string, unknown>).name === name
    )
  }

  static create<Name extends string, Fields extends Schema.Struct.Fields>(
    name: Name,
    fields: Fields,
  ): ReturnType<typeof NamedError.createSchemaClass<Name, Schema.Struct<Fields>>>
  static create<Name extends string, DataSchema extends Schema.Top>(
    name: Name,
    data: DataSchema,
  ): ReturnType<typeof NamedError.createSchemaClass<Name, DataSchema>>
  static create<Name extends string>(name: Name, data: Schema.Top | Schema.Struct.Fields) {
    return NamedError.createSchemaClass(name, Schema.isSchema(data) ? data : Schema.Struct(data))
  }

  private static createSchemaClass<Name extends string, DataSchema extends Schema.Top>(name: Name, data: DataSchema) {
    const schema = Schema.Struct({
      name: Schema.Literal(name),
      data,
    }).annotate({ identifier: name })
    type Data = Schema.Schema.Type<DataSchema>

    const result = class extends NamedError {
      public static readonly Schema = schema
      public static readonly EffectSchema = schema
      public static readonly tag = name

      public override readonly name = name

      constructor(
        public readonly data: Data,
        options?: ErrorOptions,
      ) {
        // 260731 Karina 原本无条件 super(name)，于是 Error.message 永远等于错误类名，
        // data 里辛苦拼出来的 message 一个字都到不了日志。线上实测：配置里多了一个
        // 本端 schema 不认识的键，日志只有 "ConfigInvalidError: ConfigInvalidError"，
        // 键名、文件路径全在 data.issues 里躺着，排查只能靠猜。
        // 带了 message 字段的就用它，没带的行为不变（仍是类名）。
        const detail = (data as { message?: unknown } | undefined)?.message
        super(typeof detail === "string" && detail ? detail : name, options)
        this.name = name
      }

      static isInstance(input: unknown): input is InstanceType<typeof result> {
        return NamedError.hasName(input, name)
      }

      schema() {
        return schema
      }

      toObject() {
        return {
          name: name,
          data: this.data,
        }
      }
    }
    Object.defineProperty(result, "name", { value: name })
    return result
  }

  public static readonly Unknown = NamedError.create("UnknownError", {
    message: Schema.String,
    ref: Schema.optional(Schema.String),
  })
}
