import { SessionID } from "@/session/schema"
import { SessionMessage } from "@redcode-ai/core/session-message"
import { Prompt } from "@redcode-ai/core/session-prompt"
import { SessionV2 } from "@/v2/session"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import {
  InvalidCursorError,
  InvalidRequestError,
  ServiceUnavailableError,
  SessionNotFoundError,
  UnknownError,
} from "../../errors"
import { V2Authorization } from "../../middleware/authorization"
import { InstanceContextMiddleware } from "../../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../../middleware/workspace-routing"
import { QueryBoolean } from "../query"

export const SessionsQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  limit: Schema.optional(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(200)),
  ).annotate({
    description: "Maximum number of sessions to return. Defaults to the newest 50 sessions.",
  }),
  order: Schema.optional(Schema.Union([Schema.Literal("asc"), Schema.Literal("desc")])).annotate({
    description: "Session order for the first page. Use desc for newest first or asc for oldest first.",
  }),
  path: Schema.optional(Schema.String),
  roots: Schema.optional(QueryBoolean),
  start: Schema.optional(Schema.NumberFromString),
  search: Schema.optional(Schema.String),
  cursor: Schema.optional(
    Schema.String.annotate({
      description:
        "Opaque pagination cursor returned as cursor.previous or cursor.next in the previous response. Do not combine with order or filters.",
    }),
  ),
}).annotate({ identifier: "V2SessionsQuery" })

export const SessionGroup = HttpApiGroup.make("v2.session")
  .add(
    HttpApiEndpoint.get("sessions", "/api/session", {
      query: SessionsQuery,
      success: Schema.Struct({
        items: Schema.Array(SessionV2.Info),
        cursor: Schema.Struct({
          previous: Schema.String.pipe(Schema.optional),
          next: Schema.String.pipe(Schema.optional),
        }),
      }).annotate({ identifier: "V2SessionsResponse" }),
      error: [InvalidCursorError, InvalidRequestError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.session.list",
        summary: "List v2 sessions",
        description:
          "Retrieve sessions in the requested order. Items keep that order across pages; use cursor.next or cursor.previous to move through the ordered list.",
      }),
    ),
  )
  // 260820 cc 下面四个端点全部标 deprecated —— 它们有完整的 OpenAPI 文档、有生成好的 SDK
  // 方法、有类型，唯独**调了什么也拿不到**：prompt/compact/wait 恒抛 ServiceUnavailable
  // （v2 的 agent loop 从未实现），context 读的 session_message 投影自 0.9.2 摘除双写后
  // 不再收到对话内容。这种「看起来能用、调了是空的」比端点不存在更坑，08-20 我自己就是
  // 照它们的文档下的判断。
  //
  // 标记而不是删除：specs/v2/api.ts 描述的目标 API 恰好就是这几个，删掉等于把「备将来」
  // 那条路的桩一起拆了。去留是独立决定，见 docs/parallel-systems-plan.md。
  .add(
    HttpApiEndpoint.post("prompt", "/api/session/:sessionID/prompt", {
      params: { sessionID: SessionID },
      query: WorkspaceRoutingQuery,
      payload: Schema.Struct({
        prompt: Prompt,
        delivery: SessionV2.Delivery.pipe(Schema.optional),
      }),
      success: SessionMessage.Message,
      error: [SessionNotFoundError, ServiceUnavailableError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.session.prompt",
        summary: "Send v2 message",
        description:
          "NOT IMPLEMENTED — always fails with 503 ServiceUnavailableError; the v2 agent loop was never built. Use POST /session/{sessionID}/message instead.",
        deprecated: true,
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("compact", "/api/session/:sessionID/compact", {
      params: { sessionID: SessionID },
      query: WorkspaceRoutingQuery,
      success: HttpApiSchema.NoContent,
      error: [SessionNotFoundError, ServiceUnavailableError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.session.compact",
        summary: "Compact v2 session",
        description:
          "NOT IMPLEMENTED — always fails with 503 ServiceUnavailableError. Use POST /session/{sessionID}/summarize instead.",
        deprecated: true,
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("wait", "/api/session/:sessionID/wait", {
      params: { sessionID: SessionID },
      query: WorkspaceRoutingQuery,
      success: HttpApiSchema.NoContent,
      error: [SessionNotFoundError, ServiceUnavailableError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.session.wait",
        summary: "Wait for v2 session",
        description:
          "NOT IMPLEMENTED — always fails with 503 ServiceUnavailableError; there is no v2 agent loop to wait for.",
        deprecated: true,
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("context", "/api/session/:sessionID/context", {
      params: { sessionID: SessionID },
      query: WorkspaceRoutingQuery,
      success: Schema.Array(SessionMessage.Message),
      error: [SessionNotFoundError, UnknownError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.session.context",
        summary: "Get v2 session context",
        description:
          "DEPRECATED — reads the session_message projection, which stopped receiving conversation content when the event dual-write was removed in 0.9.2, so this returns an empty array for real sessions. Use GET /session/{sessionID}/context-inspect for what the current request is actually made of.",
        deprecated: true,
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "v2",
      description: "Experimental v2 routes.",
    }),
  )
  .middleware(InstanceContextMiddleware)
  .middleware(WorkspaceRoutingMiddleware)
  .middleware(V2Authorization)
