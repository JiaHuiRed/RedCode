// 260613 Red chat room API group
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
} from "../middleware/workspace-routing"
import { described } from "./metadata"

const MessageInfo = Schema.Struct({
  id: Schema.String,
  room_id: Schema.String,
  sender: Schema.String,
  text: Schema.NullOr(Schema.String),
  content_type: Schema.String,
  session_id: Schema.NullOr(Schema.String),
  time_created: Schema.Number,
})

const RoomInfo = Schema.Struct({
  id: Schema.String,
  project_id: Schema.String,
  type: Schema.String,
  time_created: Schema.Number,
  time_updated: Schema.Number,
})

const SendPayload = Schema.Struct({
  roomId: Schema.String,
  sender: Schema.Literals(["user", "tui", "gui"]),
  text: Schema.String,
  contentType: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
})

const MessagesQuery = Schema.Struct({
  limit: Schema.optional(Schema.NumberFromString),
  before: Schema.optional(Schema.NumberFromString),
})

export const ChatPaths = {
  room: "/chat/room/:roomId",
  messages: "/chat/room/:roomId/message",
  send: "/chat/room/:roomId/message",
} as const

export const ChatApi = HttpApi.make("chat")
  .add(
    HttpApiGroup.make("chat")
      .add(
        HttpApiEndpoint.post("ensureRoom", ChatPaths.room, {
          params: { roomId: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: Schema.Struct({ type: Schema.Literals(["group", "direct"]) }),
          success: described(RoomInfo, "Room ensured"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "chat.ensureRoom",
            summary: "Ensure chat room exists",
          }),
        ),
        HttpApiEndpoint.get("messages", ChatPaths.messages, {
          params: { roomId: Schema.String },
          query: MessagesQuery,
          success: described(Schema.Array(MessageInfo), "Chat messages"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "chat.messages",
            summary: "Get chat messages",
          }),
        ),
        HttpApiEndpoint.post("send", ChatPaths.send, {
          params: { roomId: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: SendPayload,
          success: described(Schema.Struct({ id: Schema.String }), "Message sent"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "chat.send",
            summary: "Send chat message",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "chat",
          description: "Chat room messaging routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
