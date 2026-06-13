// 260613 Red chat room API handlers
import { Chat } from "@/chat"
import * as InstanceState from "@/effect/instance-state"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"

export const chatHandlers = HttpApiBuilder.group(InstanceHttpApi, "chat", (handlers) =>
  handlers
    .handle("ensureRoom", ({ params, payload }) =>
      Effect.gen(function* () {
        const ctx = yield* InstanceState.context
        const roomId = Chat.ensureRoom(ctx.project.id, params.roomId, payload.type)
        return {
          id: roomId,
          project_id: ctx.project.id,
          type: payload.type,
          time_created: Date.now(),
          time_updated: Date.now(),
        }
      }),
    )
    .handle("messages", ({ params, query }) =>
      Effect.try({
        try: () => Chat.getMessages(params.roomId, {
          limit: query.limit,
          before: query.before,
        }),
        catch: () => new Error("failed"),
      }).pipe(Effect.catch(() => Effect.succeed([] as Chat.MessageRow[]))),
    )
    .handle("send", ({ params, payload }) =>
      Effect.gen(function* () {
        // 260613 Red auto-ensure room before inserting message
        const ctx = yield* InstanceState.context
        Chat.ensureRoom(ctx.project.id, params.roomId, "group")
        return Chat.sendMessage({
          roomId: params.roomId,
          sender: payload.sender,
          text: payload.text,
          contentType: payload.contentType,
          sessionId: payload.sessionId,
        })
      }),
    ),
)
