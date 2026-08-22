export * as ProviderV2 from "./provider"

import { withStatics } from "./schema"
import { Schema } from "effect"

export const ID = Schema.String.pipe(
  Schema.brand("ProviderV2.ID"),
  withStatics((schema) => ({
    // Well-known providers
    RedCode: schema.make("redcode"),
    anthropic: schema.make("anthropic"),
    openai: schema.make("openai"),
    google: schema.make("google"),
    googleVertex: schema.make("google-vertex"),
    githubCopilot: schema.make("github-copilot"),
    amazonBedrock: schema.make("amazon-bedrock"),
    azure: schema.make("azure"),
    openrouter: schema.make("openrouter"),
    mistral: schema.make("mistral"),
    gitlab: schema.make("gitlab"),
  })),
)
export type ID = typeof ID.Type

const OpenAIResponses = Schema.Struct({
  type: Schema.Literal("openai/responses"),
  url: Schema.String,
  websocket: Schema.optional(Schema.Boolean),
})

// 260822 cc 下面的 reasoning 字段全仓零生产者、零消费者，别把它接成第三条链路。
//
// openai/completions 这个 endpoint 变体（连同 openai/responses、anthropic/messages）
// 是上游 v2 的前瞻分类，本仓从来只构造 aisdk 与 unknown 两种；reasoning 想表达的
// 「这个 endpoint 的思维链走哪个字段」在本仓已经有两个活的载体：
//   · AI SDK 路径：Model.capabilities.interleaved.field（provider/transform.ts 消费）
//   · native 路径：Message.native[provider]（@redcode-ai/llm，openai-chat lowering 消费）
//
// 保留而不删：Endpoint 在公开 schema 面上——packages/sdk/openapi.json 有逐字节漂移门禁
// （script/check-openapi-drift.ts，进 CI 与 pre-push），packages/sdk/js 的 types.gen.ts
// 是生成物，specs/v2/provider-model.md 还抄着同一段。为一个休眠可选字段动这条链，代价
// 是两份生成物重跑 + 与上游 specs 分叉，不划算。真要删，删的是整个变体而不是单个字段。
const OpenAICompletions = Schema.Struct({
  type: Schema.Literal("openai/completions"),
  url: Schema.String,
  reasoning: Schema.Union([
    Schema.Struct({
      type: Schema.Literal("reasoning_content"),
    }),
    Schema.Struct({
      type: Schema.Literal("reasoning_details"),
    }),
  ]).pipe(Schema.optional),
})
export type OpenAICompletions = typeof OpenAICompletions.Type

const AISDK = Schema.Struct({
  type: Schema.Literal("aisdk"),
  package: Schema.String,
  url: Schema.String.pipe(Schema.optional),
})

const AnthropicMessages = Schema.Struct({
  type: Schema.Literal("anthropic/messages"),
  url: Schema.String,
})

const UnknownEndpoint = Schema.Struct({
  type: Schema.Literal("unknown"),
})

export const Endpoint = Schema.Union([
  UnknownEndpoint,
  OpenAIResponses,
  OpenAICompletions,
  AnthropicMessages,
  AISDK,
]).pipe(Schema.toTaggedUnion("type"))
export type Endpoint = typeof Endpoint.Type

export const Options = Schema.Struct({
  headers: Schema.Record(Schema.String, Schema.String),
  body: Schema.Record(Schema.String, Schema.Any),
  aisdk: Schema.Struct({
    provider: Schema.Record(Schema.String, Schema.Any),
    request: Schema.Record(Schema.String, Schema.Any),
  }),
})
export type Options = typeof Options.Type

export class Info extends Schema.Class<Info>("ProviderV2.Info")({
  id: ID,
  name: Schema.String,
  enabled: Schema.Union([
    Schema.Literal(false),
    Schema.Struct({
      via: Schema.Literal("env"),
      name: Schema.String,
    }),
    Schema.Struct({
      via: Schema.Literal("account"),
      service: Schema.String,
    }),
    Schema.Struct({
      via: Schema.Literal("custom"),
      data: Schema.Record(Schema.String, Schema.Any),
    }),
  ]),
  env: Schema.String.pipe(Schema.Array),
  endpoint: Endpoint,
  options: Options,
}) {
  static empty(providerID: ID) {
    return new Info({
      id: providerID,
      name: providerID,
      enabled: false,
      env: [],
      endpoint: {
        type: "unknown",
      },
      options: {
        headers: {},
        body: {},
        aisdk: {
          provider: {},
          request: {},
        },
      },
    })
  }
}
