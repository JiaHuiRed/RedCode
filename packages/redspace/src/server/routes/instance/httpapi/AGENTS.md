# HttpApi Route Patterns

Use `HttpApiBuilder.group(...)` for normal HTTP endpoints, including streaming HTTP responses such as server-sent events. Handlers should yield stable services once while building the handler layer, then close over those services in endpoint implementations.

```ts
export const sessionHandlers = HttpApiBuilder.group(InstanceHttpApi, "session", (handlers) =>
  Effect.gen(function* () {
    const session = yield* Session.Service

    return handlers.handle("list", () => session.list())
  }),
)
```

For SSE endpoints, stay in `HttpApiBuilder.group(...)` and return `HttpServerResponse.stream(...)` from the handler. Annotate the endpoint success schema with `HttpApiSchema.asText({ contentType: "text/event-stream" })` so OpenAPI documents the stream content type.

Use raw `HttpRouter.use(...)` only for routes that do not fit the request/response HttpApi model, such as WebSocket upgrade routes or catch-all fallback routes. Yield stable services at route-layer construction and close over them in `router.add(...)` callbacks.

```ts
export const rawRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const pty = yield* Pty.Service

    yield* router.add("GET", PtyPaths.connect, (request) => connectPty(request, pty))
  }),
)
```

Avoid `Effect.provide(SomeLayer)` inside request handlers or raw route callbacks. Stable layers should be provided once at the application/layer boundary, not rebuilt or scoped per request.

Avoid `HttpRouter.provideRequest(...)` unless the dependency is intentionally request-level. Prefer `HttpRouter.use(...)` for stable app services.

Use `Effect.provideService(...)` in middleware only for request-derived context, such as `WorkspaceRouteContext`, `InstanceRef`, or `WorkspaceRef`. Do not use it to smuggle stable services through request effects when they can be yielded at layer construction.

Public JSON errors should be explicit `Schema.ErrorClass` contracts declared on each endpoint. Use built-in `HttpApiError.*` classes only when their empty/tagged body is the intended wire shape; for SDK-visible errors with messages, define an API error schema such as `ApiNotFoundError` and fail with that exact declared error. Keep domain and storage services free of HttpApi types, and translate expected domain errors at the handler boundary.

When adding middleware, compose it at the layer boundary and keep the route tree explicit in `server.ts`. Shared router middleware such as auth, workspace routing, and instance context should stay visible where routes are assembled.

## 加一个路由 = 必须同时加一个覆盖场景

`bun run test:httpapi` 用 `--fail-on-missing` 跑三遍（coverage / auth / effect）。任何在
openapi 里出现、而 `test/server/httpapi-exercise/index.ts` 里没有对应场景的路由，会让这三遍
全部失败并退出——不是警告，是门禁。

```ts
http.protected
  .get("/session/{sessionID}/todo", "session.todo") // 第二个参数是 operationId
  .seeded((ctx) => ctx.session({ title: "Todo session" }))
  .at((ctx) => ({ path: route("/session/{sessionID}/todo", { sessionID: ctx.state.id }), headers: ctx.headers() }))
  .json(200, (body, ctx) => check(stable(body) === stable(ctx.state.todos), "todos should match"))
```

单跑一条：`bun run script/httpapi-exercise.ts --mode effect --include <operationId 片段>`。

场景里的种子走 `ctx` 上的 helper，helper 用 `AppLayer` 提供服务。**不在 `AppLayer` 里的服务
要在种子处单独 provide**（例：`Goal` 只由 `server.ts` 那份 layer 列表提供，`AppLayer` 里没有），
不要为了让测试跑通去改生产接线。
