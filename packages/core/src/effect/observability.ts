import { Effect, Layer, Logger } from "effect"
import { FetchHttpClient } from "effect/http"
import { OtlpExporter, OtlpLogger, OtlpSerialization } from "effect/observability"
import * as EffectLogger from "./logger"
import { createFileSpanProcessor, traceFileEnabled } from "./trace-file"
import { Flag } from "../flag/flag"
import { InstallationChannel, InstallationVersion } from "../installation/version"
import { ensureProcessMetadata } from "../util/redcode-process"

const base = Flag.OTEL_EXPORTER_OTLP_ENDPOINT
export const enabled = !!base
const processID = crypto.randomUUID()

const headers = Flag.OTEL_EXPORTER_OTLP_HEADERS
  ? Flag.OTEL_EXPORTER_OTLP_HEADERS.split(",").reduce(
      (acc, x) => {
        const [key, ...value] = x.split("=")
        acc[key] = value.join("=")
        return acc
      },
      {} as Record<string, string>,
    )
  : undefined

export function resource(): { serviceName: string; serviceVersion: string; attributes: Record<string, string> } {
  const processMetadata = ensureProcessMetadata("main")
  const attributes: Record<string, string> = (() => {
    const value = process.env.OTEL_RESOURCE_ATTRIBUTES
    if (!value) return {}
    try {
      return Object.fromEntries(
        value.split(",").map((entry) => {
          const index = entry.indexOf("=")
          if (index < 1) throw new Error("Invalid OTEL_RESOURCE_ATTRIBUTES entry")
          return [decodeURIComponent(entry.slice(0, index)), decodeURIComponent(entry.slice(index + 1))]
        }),
      )
    } catch {
      return {}
    }
  })()

  return {
    serviceName: "redcode",
    serviceVersion: InstallationVersion,
    attributes: {
      ...attributes,
      "deployment.environment.name": InstallationChannel,
      "RedCode.client": Flag.REDCODE_CLIENT,
      "RedCode.process_role": processMetadata.processRole,
      "RedCode.run_id": processMetadata.runID,
      "service.instance.id": processID,
    },
  }
}

function logs() {
  return Logger.layer(
    [
      EffectLogger.logger,
      OtlpLogger.make({
        url: `${base}/v1/logs`,
        resource: resource(),
        headers,
      }),
    ],
    { mergeWithExisting: false },
  ).pipe(Layer.provide(OtlpSerialization.layerJson), Layer.provide(FetchHttpClient.layer))
}

const traces = async () => {
  const NodeSdk = await import("@effect/opentelemetry/NodeSdk")
  const OTLP = await import("@opentelemetry/exporter-trace-otlp-http")
  const SdkBase = await import("@opentelemetry/sdk-trace-base")

  // @effect/opentelemetry creates a NodeTracerProvider but never calls
  // register(), so the global @opentelemetry/api context manager stays
  // as the no-op default. Non-Effect code (like the AI SDK) that calls
  // tracer.startActiveSpan() relies on context.active() to find the
  // parent span - without a real context manager every span starts a
  // new trace. Registering AsyncLocalStorageContextManager fixes this.
  const { AsyncLocalStorageContextManager } = await import("@opentelemetry/context-async-hooks")
  const { context } = await import("@opentelemetry/api")
  const mgr = new AsyncLocalStorageContextManager()
  mgr.enable()
  context.setGlobalContextManager(mgr)

  // 261107 Red 探针与 OTLP 并行：文件处理器追加本地 JSONL，不影响远端导出。
  const fileProcessor = traceFileEnabled() ? createFileSpanProcessor() : undefined

  return NodeSdk.layer(() => ({
    resource: resource(),
    spanProcessor: fileProcessor
      ? [
          new SdkBase.BatchSpanProcessor(
            new OTLP.OTLPTraceExporter({
              url: `${base}/v1/traces`,
              headers,
            }),
          ),
          fileProcessor,
        ]
      : new SdkBase.BatchSpanProcessor(
          new OTLP.OTLPTraceExporter({
            url: `${base}/v1/traces`,
            headers,
          }),
        ),
  }))
}

const signals = !base
  ? Layer.unwrap(
      Effect.gen(function* () {
        // 261107 Red 无 OTLP 端点时的本地探针分支：span 落 JSONL 文件（trace-file.ts），
        // 未启用则维持原有的纯本地日志。
        if (traceFileEnabled()) {
          const NodeSdk = yield* Effect.promise(() => import("@effect/opentelemetry/NodeSdk"))
          return NodeSdk.layer(() => ({
            resource: resource(),
            spanProcessor: createFileSpanProcessor(),
          }))
        }
        return EffectLogger.layer
      }),
    )
  : Layer.unwrap(
      Effect.gen(function* () {
        const trace = yield* Effect.promise(traces)
        return Layer.mergeAll(trace, logs())
      }),
    )

export const layer = signals.pipe(Layer.provideMerge(OtlpExporter.layerFlusher))

export const Observability = { enabled, layer }
