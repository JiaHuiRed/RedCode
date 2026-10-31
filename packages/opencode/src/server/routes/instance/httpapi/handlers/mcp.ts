import { MCP } from "@/mcp"
import { Config } from "@/config/config"
import { Effect, Schema } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/http-api"
import { InstanceHttpApi } from "../api"
import { AddPayload, AuthCallbackPayload, StatusMap, UnsupportedOAuthError } from "../groups/mcp"

export const mcpHandlers = HttpApiBuilder.group(InstanceHttpApi, "mcp", (handlers) =>
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    const config = yield* Config.Service

    const status = Effect.fn("McpHttpApi.status")(function* () {
      return yield* mcp.status()
    })

    const add = Effect.fn("McpHttpApi.add")(function* (ctx: { payload: typeof AddPayload.Type }) {
      const result = (yield* mcp.add(ctx.payload.name, ctx.payload.config)).status
      return yield* Schema.decodeUnknownEffect(StatusMap)(
        "status" in result ? { [ctx.payload.name]: result } : result,
      ).pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
    })

    const authStart = Effect.fn("McpHttpApi.authStart")(function* (ctx: { params: { name: string } }) {
      if (!(yield* mcp.supportsOAuth(ctx.params.name))) {
        return yield* new UnsupportedOAuthError({ error: `MCP server ${ctx.params.name} does not support OAuth` })
      }
      return yield* mcp.startAuth(ctx.params.name)
    })

    const authCallback = Effect.fn("McpHttpApi.authCallback")(function* (ctx: {
      params: { name: string }
      payload: typeof AuthCallbackPayload.Type
    }) {
      return yield* mcp.finishAuth(ctx.params.name, ctx.payload.code)
    })

    const authAuthenticate = Effect.fn("McpHttpApi.authAuthenticate")(function* (ctx: { params: { name: string } }) {
      if (!(yield* mcp.supportsOAuth(ctx.params.name))) {
        return yield* new UnsupportedOAuthError({ error: `MCP server ${ctx.params.name} does not support OAuth` })
      }
      return yield* mcp.authenticate(ctx.params.name)
    })

    const authRemove = Effect.fn("McpHttpApi.authRemove")(function* (ctx: { params: { name: string } }) {
      yield* mcp.removeAuth(ctx.params.name)
      return { success: true as const }
    })

    const connect = Effect.fn("McpHttpApi.connect")(function* (ctx: { params: { name: string } }) {
      yield* mcp.connect(ctx.params.name)
      return true
    })

    const disconnect = Effect.fn("McpHttpApi.disconnect")(function* (ctx: { params: { name: string } }) {
      yield* mcp.disconnect(ctx.params.name)
      return true
    })

    // 261031 Red 先断开再删定义：只删配置的话，当前实例里还挂着旧客户端与工具表。
    // 配置可能写在本地覆盖层，所以交给 Config.removeGlobalMCP 逐文件处理。
    const remove = Effect.fn("McpHttpApi.remove")(function* (ctx: { params: { name: string } }) {
      yield* mcp.disconnect(ctx.params.name)
      const { files } = yield* config.removeGlobalMCP(ctx.params.name)
      return files.length > 0
    })

    return handlers
      .handle("status", status)
      .handle("add", add)
      .handle("authStart", authStart)
      .handle("authCallback", authCallback)
      .handle("authAuthenticate", authAuthenticate)
      .handle("authRemove", authRemove)
      .handle("connect", connect)
      .handle("disconnect", disconnect)
      .handle("remove", remove)
  }),
)
