import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { ApiNotFoundError, ConflictError, InvalidRequestError, UnknownError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { described } from "./metadata"

const Summary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  displayName: Schema.String,
  commitPrefix: Schema.String,
  avatar: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
})

const Issue = Schema.Struct({
  path: Schema.String,
  message: Schema.String,
})

const Details = Schema.Struct({
  ...Summary.fields,
  path: Schema.String,
  content: Schema.String,
  sources: Schema.Struct({
    id: Schema.Literals(["frontmatter", "fallback", "absent"]),
    name: Schema.Literals(["frontmatter", "fallback", "absent"]),
    displayName: Schema.Literals(["frontmatter", "fallback", "absent"]),
    commitPrefix: Schema.Literals(["frontmatter", "fallback", "absent"]),
    avatar: Schema.Literals(["frontmatter", "fallback", "absent"]),
    description: Schema.Literals(["frontmatter", "fallback", "absent"]),
  }),
})

// 261113 Red 两种输入互斥：结构化字段 + content，或一份完整 markdown。互斥与必填校验在
// handler 的 toCreateInput 里显式完成——OpenAPI 生成器会把 Schema.Union 降级成「所有分支
// 字段可选」的单个对象（Never 变成 unknown），SDK 类型因此两个分支都无法满足。用宽松
// payload + 运行时校验，换取生成客户端真正可用；混合载荷仍然 400。
const CreatePayload = Schema.Struct({
  id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  displayName: Schema.optional(Schema.String),
  commitPrefix: Schema.optional(Schema.String),
  avatar: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
  markdown: Schema.optional(Schema.String),
})

export const SoulApi = HttpApi.make("soul").add(
  HttpApiGroup.make("soul")
    .add(
      HttpApiEndpoint.get("list", "/soul", {
        success: described(Schema.Array(Summary), "Available Soul summaries"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "soul.list",
          summary: "List available Souls",
          description: "List available Soul identity summaries without returning Soul content.",
        }),
      ),
      HttpApiEndpoint.get("get", "/soul/:id", {
        params: { id: Schema.String },
        success: described(Details, "Soul details including bounded content and metadata provenance"),
        error: ApiNotFoundError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "soul.get",
          summary: "Get Soul details",
          description: "Get a registered Soul by ID, including content bounded by the registry file-size limit.",
        }),
      ),
      HttpApiEndpoint.get("issues", "/soul/issues", {
        success: described(Schema.Array(Issue), "Soul registry configuration issues"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "soul.issues",
          summary: "List Soul configuration issues",
          description: "List invalid or unreadable Soul files so configuration errors remain visible.",
        }),
      ),
      HttpApiEndpoint.get("default", "/soul/default", {
        query: Schema.Struct({ client: Schema.Literals(["tui", "desktop"]) }),
        success: Schema.Struct({ id: Schema.optional(Schema.String) }),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "soul.default",
          summary: "Get a new-session default Soul",
          description: "Resolve a client default without changing any existing session identity.",
        }),
      ),
      HttpApiEndpoint.post("create", "/soul", {
        payload: CreatePayload,
        success: described(Summary, "Created Soul summary"),
        error: [InvalidRequestError, ConflictError, UnknownError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "soul.create",
          summary: "Create a Soul",
          description:
            "Create a Soul in the global registry without overwriting existing files. Send either structured metadata plus content, or a complete Markdown document whose YAML frontmatter and body are validated by the registry parser. Creation never changes the current session or the default Soul.",
        }),
      ),
    )
    .middleware(Authorization),
)
