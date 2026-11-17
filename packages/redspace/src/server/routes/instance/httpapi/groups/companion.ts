import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { Companion } from "@/companion/companion"
import { ConflictError, InvalidRequestError, UnknownError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { described } from "./metadata"

export const CompanionApi = HttpApi.make("companion").add(
  HttpApiGroup.make("companion")
    .add(
      HttpApiEndpoint.get("list", "/companion", {
        success: described(Schema.Array(Companion.Info), "Imported companion profiles without private memory content"),
        error: UnknownError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "companion.list",
          summary: "List companion profiles",
          description: "List the existing companion identities available to Chat in both terminal and desktop clients.",
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
