import { Schema } from "effect"
import { PositiveInt } from "@redcode-ai/core/schema"

export const Server = Schema.Struct({
  port: Schema.optional(PositiveInt).annotate({
    description: "Port to listen on",
  }),
  hostname: Schema.optional(Schema.String).annotate({ description: "Hostname to listen on" }),
  mdns: Schema.optional(Schema.Boolean).annotate({ description: "Enable mDNS service discovery" }),
  mdnsDomain: Schema.optional(Schema.String).annotate({
    description: "Custom domain name for mDNS service (default: redcode.local)",
  }),
  cors: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Additional domains to allow for CORS",
  }),
  sse: Schema.optional(
    Schema.Struct({
      max_events: Schema.optional(PositiveInt).annotate({
        description: "Maximum buffered events per global SSE connection (default: 256)",
      }),
      max_bytes: Schema.optional(PositiveInt).annotate({
        description: "Maximum buffered UTF-8 event data bytes per global SSE connection (default: 8388608)",
      }),
    }),
  ).annotate({ description: "Global SSE buffer limits; overflow closes the stream for authoritative resync" }),
}).annotate({ identifier: "ServerConfig" })
export type Server = Schema.Schema.Type<typeof Server>

// 261009 Red 队列预算在配置拥有方显式解析，不能把缺省值藏进流构造器。
export function resolveEventBuffer(config?: Server) {
  return {
    maxEvents: config?.sse?.max_events ?? 256,
    maxBytes: config?.sse?.max_bytes ?? 8 * 1024 * 1024,
  }
}

export * as ConfigServer from "./server"
