import { SessionID } from "@/session/schema"
import { SessionMessage } from "@redcode-ai/core/session-message"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { InvalidCursorError, SessionNotFoundError, UnknownError } from "../../errors"
import { V2Authorization } from "../../middleware/authorization"
import { WorkspaceRoutingQueryFields } from "../../middleware/workspace-routing"

export const MessagesQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  limit: Schema.optional(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(200)),
  ).annotate({
    description: "Maximum number of messages to return. When omitted, the endpoint returns its default page size.",
  }),
  order: Schema.optional(Schema.Union([Schema.Literal("asc"), Schema.Literal("desc")])).annotate({
    description: "Message order for the first page. Use desc for newest first or asc for oldest first.",
  }),
  cursor: Schema.optional(
    Schema.String.annotate({
      description:
        "Opaque pagination cursor returned as cursor.previous or cursor.next in the previous response. Do not combine with order.",
    }),
  ),
}).annotate({ identifier: "V2SessionMessagesQuery" })

// 260820 cc 同 groups/v2/session.ts 里那四个：这个端点读的 session_message 投影自 0.9.2
// 摘除事件双写后只剩 agent-switched / model-switched 两类行（实测 live 库 782 行里一条
// 对话都没有），但它的 OpenAPI 文档与 SDK 方法一应俱全。标 deprecated 让调用方一眼看出。
export const MessageGroup = HttpApiGroup.make("v2.message")
  .add(
    HttpApiEndpoint.get("messages", "/api/session/:sessionID/message", {
      params: { sessionID: SessionID },
      query: MessagesQuery,
      success: Schema.Struct({
        items: Schema.Array(SessionMessage.Message),
        cursor: Schema.Struct({
          previous: Schema.String.pipe(Schema.optional),
          next: Schema.String.pipe(Schema.optional),
        }),
      }).annotate({ identifier: "V2SessionMessagesResponse" }),
      error: [InvalidCursorError, SessionNotFoundError, UnknownError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.session.messages",
        summary: "Get v2 session messages",
        description:
          "DEPRECATED — reads the session_message projection, which since 0.9.2 only receives agent/model switch rows; conversation content lives in the legacy message table. Use GET /session/{sessionID}/message instead.",
        deprecated: true,
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "v2 messages",
      description: "Experimental v2 message routes.",
    }),
  )
  .middleware(V2Authorization)
