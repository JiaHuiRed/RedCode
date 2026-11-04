import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/background"

// 261104 Red 后台活动的只读视图：不返回 output（子代理完整输出可达数 MB），
// 只带定位与状态字段，供 TUI/GUI 的「后台活动」面板展示与终止。
export const Job = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  title: Schema.optional(Schema.String),
  status: Schema.Literals(["running", "completed", "error", "cancelled"]),
  startedAt: Schema.Number,
  completedAt: Schema.optional(Schema.Number),
  error: Schema.optional(Schema.String),
  sessionID: Schema.optional(Schema.String),
  parentSessionID: Schema.optional(Schema.String),
})
export type Job = typeof Job.Type

export const Cancelled = Schema.Struct({ cancelled: Schema.Array(Schema.String) })

export const BackgroundApi = HttpApi.make("background")
  .add(
    HttpApiGroup.make("background")
      .add(
        HttpApiEndpoint.get("list", root, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Job), "List background activities"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "background.list",
            summary: "List background activities",
            description:
              "List background jobs registered by this instance (running and recently finished). Full output is not included.",
          }),
        ),
        HttpApiEndpoint.post("cancel", `${root}/:jobID/cancel`, {
          params: { jobID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(Cancelled, "Cancelled job ids (job and its descendants)"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "background.cancel",
            summary: "Cancel a background activity",
            description: "Cancel a running background job and any background jobs nested under it.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "background",
          description: "Background activity routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "redcode background HttpApi",
      version: "0.0.1",
      description: "Background activity surface for the TUI and desktop clients.",
    }),
  )
