import { ProxyUtil } from "@/server/proxy-util"
import { Effect, Stream } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpServerRequest, HttpServerResponse } from "effect/http"
import * as Socket from "effect/socket/Socket"
import { WebSocketTracker } from "../websocket-tracker"

function webSource(request: HttpServerRequest.HttpServerRequest): Request | undefined {
  return request.source instanceof Request ? request.source : undefined
}

function requestBody(request: HttpServerRequest.HttpServerRequest) {
  if (request.method === "GET" || request.method === "HEAD") return HttpBody.empty
  const len = request.headers["content-length"]
  return HttpBody.raw(webSource(request)?.body ?? null, {
    contentType: request.headers["content-type"],
    contentLength: len ? Number(len) : undefined,
  })
}

export function websocket(
  request: HttpServerRequest.HttpServerRequest,
  target: string | URL,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, Socket.WebSocketConstructor> {
  return Effect.scoped(
    Effect.gen(function* () {
      const inbound = yield* Effect.orDie(request.upgrade)
      const outbound = yield* Socket.makeWebSocket(ProxyUtil.websocketTargetURL(target), {
        protocols: ProxyUtil.websocketProtocols(request.headers),
      })
      const writerInbound = yield* inbound.writer
      const writerOutbound = yield* outbound.writer
      // 261022 Red: effect 4.0.5 移除 socket.runRaw，消费统一走 reader.pull 循环
      const drainUntilClosed = (socket: Socket.Socket, open?: Effect.Effect<void>) =>
        Effect.gen(function* () {
          const { pull } = yield* socket.reader
          if (open) yield* open
          while (true) yield* pull
        })
      const closeSocket = (socket: Socket.Socket, writer: Socket.Writer) =>
        drainUntilClosed(
          socket,
          writer.write(WebSocketTracker.SERVER_CLOSING_EVENT()).pipe(Effect.catch(() => Effect.void)),
        ).pipe(
          Effect.timeout("1 second"),
          Effect.catchReason("SocketError", "SocketCloseError", () => Effect.void),
          Effect.catch(() => Effect.void),
        )
      const closeAccepted = Effect.all(
        [closeSocket(inbound, writerInbound), closeSocket(outbound, writerOutbound)],
        {
          concurrency: "unbounded",
          discard: true,
        },
      )
      const registered = yield* WebSocketTracker.register(
        Effect.all(
          [
            writerInbound.write(WebSocketTracker.SERVER_CLOSING_EVENT()),
            writerOutbound.write(WebSocketTracker.SERVER_CLOSING_EVENT()),
          ],
          { concurrency: "unbounded", discard: true },
        ),
      )
      if (!registered) {
        yield* closeAccepted
        return HttpServerResponse.empty()
      }

      yield* Effect.gen(function* () {
        const { pull } = yield* outbound.reader
        while (true) {
          const batch = yield* pull
          for (const message of batch) {
            yield* writerInbound.write(message)
          }
        }
      }).pipe(
        Effect.catchReason("SocketError", "SocketCloseError", (reason) =>
          writerInbound.write(new Socket.CloseEvent(reason.code, reason.closeReason)).pipe(Effect.catch(() => Effect.void)),
        ),
        Effect.catch(() =>
          writerInbound.write(new Socket.CloseEvent(1011, "proxy error")).pipe(Effect.catch(() => Effect.void)),
        ),
        Effect.forkScoped,
      )

      yield* Effect.gen(function* () {
        const { pull } = yield* inbound.reader
        while (true) {
          const batch = yield* pull
          for (const message of batch) {
            yield* writerOutbound.write(typeof message === "string" ? message : message.slice())
          }
        }
      }).pipe(
        Effect.catch(() => Effect.void),
        Effect.ensuring(writerOutbound.write(new Socket.CloseEvent()).pipe(Effect.catch(() => Effect.void))),
      )
      return HttpServerResponse.empty()
    }).pipe(Effect.orDie),
  )
}

function statusText(response: unknown) {
  return (response as { source?: Response }).source?.statusText
}

export function http(
  client: HttpClient.HttpClient,
  url: string | URL,
  extra: HeadersInit | undefined,
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<HttpServerResponse.HttpServerResponse> {
  return Effect.gen(function* () {
    const response = yield* client.execute(
      HttpClientRequest.make(request.method as never)(url, {
        headers: ProxyUtil.headers(request.headers as HeadersInit, extra),
        body: requestBody(request),
      }),
    )
    const headers = new Headers(response.headers as HeadersInit)
    headers.delete("content-encoding")
    headers.delete("content-length")

    return HttpServerResponse.stream(response.stream.pipe(Stream.catchCause(() => Stream.empty)), {
      status: response.status,
      statusText: statusText(response),
      headers,
    })
  }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 500 }))))
}

export * as HttpApiProxy from "./proxy"
