import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
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
    )
    .middleware(Authorization),
)
