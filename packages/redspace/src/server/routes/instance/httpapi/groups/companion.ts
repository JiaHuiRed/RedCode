import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { Companion } from "@/companion/companion"
import { ApiNotFoundError, ConflictError, InvalidRequestError, UnknownError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { described } from "./metadata"

export const CompanionApi = HttpApi.make("companion").add(
  HttpApiGroup.make("companion")
    .add(
      HttpApiEndpoint.get("list", "/companion", {
        success: described(Schema.Array(Companion.Info), "Companion profiles without private memory content"),
        error: UnknownError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "companion.list",
          summary: "List companion profiles",
          description: "List the existing companion identities available to Chat in both terminal and desktop clients.",
        }),
      ),
      HttpApiEndpoint.post("initialize", "/companion/initialize", {
        success: Companion.InitializeResult,
        error: [InvalidRequestError, ConflictError, ApiNotFoundError, UnknownError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "companion.initialize",
          summary: "Initialize Chat",
          description:
            "Return the existing companion, or create a neutral companion and private workspace if none exists. Repeated calls reuse the same profile.",
        }),
      ),
      HttpApiEndpoint.post("create", "/companion", {
        payload: Companion.CreateInput,
        success: Companion.InitializeResult,
        error: [InvalidRequestError, ConflictError, ApiNotFoundError, UnknownError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "companion.create",
          summary: "Create a companion",
          description:
            "Create a neutral companion, up to two in total. Supply a stable requestID to safely retry a request without using another place. Existing profiles are never replaced.",
        }),
      ),
      HttpApiEndpoint.get("get", "/companion/:id", {
        params: { id: Schema.String },
        success: Companion.Details,
        error: [InvalidRequestError, ConflictError, ApiNotFoundError, UnknownError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "companion.get",
          summary: "Get companion settings",
          description: "Read companion profile, user notes and the actual registry Soul path.",
        }),
      ),
      HttpApiEndpoint.patch("update", "/companion/:id", {
        params: { id: Schema.String },
        payload: Companion.UpdateInput,
        success: Companion.Details,
        error: [InvalidRequestError, ConflictError, ApiNotFoundError, UnknownError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "companion.update",
          summary: "Update companion settings",
          description:
            "Update current conversation names, user notes or introduction state without replacing memories or the bound Soul. Names may remain unset. userName changes only the managed preferred-name field; it cannot be combined with a complete user document. State changes only when explicitly supplied.",
        }),
      ),
      HttpApiEndpoint.post("import", "/companion/import", {
        payload: Companion.ImportInput,
        success: described(Companion.ImportResult, "Imported profile and whether this call created it"),
        error: [InvalidRequestError, ConflictError, UnknownError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "companion.import",
          summary: "Import an existing companion archive",
          description:
            "Import a local OpenClaw directory or ZIP on the server into a private companion workspace. Source files are preserved; credentials, old runtime instructions and scheduled jobs are not activated. Existing profiles are never overwritten.",
        }),
      ),
    )
    .middleware(Authorization),
)
