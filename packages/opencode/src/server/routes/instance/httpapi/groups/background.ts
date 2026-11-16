import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { ApiNotFoundError, ConflictError, ForbiddenError, InvalidRequestError, TimeoutError } from "../errors"
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

// 261115 Red UX-17 按需结果：output 单独一个端点按需取，列表仍然零重量。output 有界
// （末尾 32,000 字符 + 截断标记与总量），完整输出走 sessionID 的会话记录。
export const JobResult = Schema.Struct({
  id: Schema.String,
  found: Schema.Boolean,
  status: Schema.optional(Schema.Literals(["running", "completed", "error", "cancelled"])),
  title: Schema.optional(Schema.String),
  output: Schema.optional(Schema.String),
  truncated: Schema.Boolean,
  totalChars: Schema.Number,
  error: Schema.optional(Schema.String),
  sessionID: Schema.optional(Schema.String),
  parentSessionID: Schema.optional(Schema.String),
})
export type JobResult = typeof JobResult.Type

// 261116 Red 用户直接给运行中的子任务补充要求：requestID 是客户端重试幂等键；
// state 只反映消息持久化后的 delivery，不代表模型已理解或执行。
export const SteerPayload = Schema.Struct({
  message: Schema.String,
  requestID: Schema.String,
})
export type SteerPayload = typeof SteerPayload.Type

export const SteerReceipt = Schema.Struct({
  messageID: Schema.String,
  state: Schema.Literals(["queued", "delivered"]),
})
export type SteerReceipt = typeof SteerReceipt.Type

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
        HttpApiEndpoint.get("result", `${root}/:jobID/result`, {
          params: { jobID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(JobResult, "Background job result (bounded)"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "background.result",
            summary: "Get a background job result",
            description:
              "On-demand result of a finished background job. The output is bounded to the last 32,000 characters with a truncation flag and total size; open the linked session for the full transcript. Jobs are recycled 30 minutes after completion.",
          }),
        ),
        HttpApiEndpoint.post("steer", `${root}/tasks/:sessionID/steer`, {
          params: { sessionID: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: SteerPayload,
          success: described(SteerReceipt, "Steering delivery receipt"),
          error: [InvalidRequestError, ForbiddenError, ApiNotFoundError, ConflictError, TimeoutError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "background.steer",
            summary: "Send guidance to a running background task",
            description:
              "Persist user guidance into a running child task. The guidance is applied at the next safe step and does not interrupt a running tool. The receipt reflects the persisted message state; 'delivered' means the message was included in a request, not that the model understood or executed it.",
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
