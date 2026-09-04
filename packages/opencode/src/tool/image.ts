import { Effect, Schema } from "effect"
import path from "node:path"
import DESCRIPTION from "./image.md" with { type: "text" }
import * as Tool from "./tool"
import { Config } from "@/config/config"
import { Global } from "@redcode-ai/core/global"
import { AppFileSystem } from "@redcode-ai/core/filesystem"
import { InstanceState } from "@/effect/instance-state"

export const Parameters = Schema.Struct({
  prompt: Schema.String.annotate({
    description:
      "What the image should show. Subject first, then style, then anything to exclude. Both Chinese and English work.",
  }),
  image: Schema.optional(Schema.String).annotate({
    description:
      "Path to a source image. When given, the tool edits that image instead of generating a new one; say what should change AND what should stay.",
  }),
  size: Schema.optional(Schema.String).annotate({
    description: "Output size such as '1024x1024'. Omit to use the configured default.",
  }),
  output: Schema.optional(Schema.String).annotate({
    description: "Where to write the result. Defaults to .redcode/images/<timestamp>.png in the project.",
  }),
})

type Metadata = {
  mode: "generate" | "edit"
  model: string
  filepath: string
  bytes: number
  seed?: number
  finish?: string
}

/**
 * 260903 cc 图像工具。
 *
 * **后端是配置项不是代码常量**：`config.image` 给 baseURL / model / provider，
 * 换供应商是改配置不是改代码。工具只假设一个 OpenAI 形状的
 * `{baseURL}/images/generations`（JSON）与 `{baseURL}/images/edits`（multipart），
 * 这两条几乎是所有图像 API 的公约数。
 *
 * 渲染那半早就有了：0.10.9 给 `ToolPart` 加了 attachments 渲染，工具返回
 * `attachments: [{type:"file", mime, url:"data:..."}]` 就能在卡片里直接画出来、
 * 点开走灯箱。所以这里只负责把图拿回来。
 *
 * ⚠️ 落库体积：图片附件会整段进 `part.data`（性能体检 8.1 条记过，读到的 3MB 图会让
 * 单次 updatePart 从 2.8ms 涨到 29ms）。这里做两件事压住：图**先落盘**，附件只在
 * 小于 INLINE_LIMIT 时内联；超限时只给路径，模型仍可用 read 工具按需取。
 */
const INLINE_LIMIT = 2 * 1024 * 1024

const DEFAULTS = {
  baseURL: "https://api.stepfun.com/step_plan/v1",
  model: "step-image-edit-2",
  provider: "step_plan",
}

export const ImageTool = Tool.define(
  "image",
  Effect.gen(function* () {
    const config = yield* Config.Service
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      // 出图是纯网络等待，实测单张 1024×1024 约 10–30s；给足预算但别无限挂
      timeoutMs: 180_000,
      // 与 read/git 同约定：主体可以 Effect.fail(Error)，在这里 orDie 收成 defect —
      // Tool 的错误通道是 never，失败信息由执行层统一呈现给模型。
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const cfg = (yield* config.get()).image ?? {}
          const baseURL = (cfg.baseURL ?? DEFAULTS.baseURL).replace(/\/+$/, "")
          const model = cfg.model ?? DEFAULTS.model
          const providerID = cfg.provider ?? DEFAULTS.provider

          // 直接读 auth.json 而不是 yield* Auth.Service：Auth 不在工具注册表的 layer 里，
          // 引它会把依赖漏进整张 layer 图（本仓那条链已经顶到 TS 推断上限，见
          // reference-redcode-infra 里 SessionPrompt 那段）。这里只做一次只读文件解析。
          const key = yield* Effect.gen(function* () {
            const fromEnv = process.env["REDCODE_IMAGE_API_KEY"]?.trim()
            if (fromEnv) return fromEnv
            const authFile = path.join(Global.Path.data, "auth.json")
            const parsed = yield* Effect.tryPromise({
              try: () =>
                import("node:fs/promises")
                  .then((m) => m.readFile(authFile, "utf8"))
                  .then((raw) => JSON.parse(raw) as Record<string, { type?: string; key?: string }>),
              catch: () => new Error("unreadable"),
            }).pipe(Effect.catch(() => Effect.succeed(undefined)))
            const entry = parsed?.[providerID]
            return entry && entry.type === "api" ? entry.key : undefined
          })
          if (!key)
            return yield* Effect.fail(
              new Error(
                `No API key for the image backend. Configure "image": { "provider": "<auth id>" } in redcode config, or set REDCODE_IMAGE_API_KEY.`,
              ),
            )

          const mode: "generate" | "edit" = params.image ? "edit" : "generate"
          const size = params.size ?? cfg.size

          const body = yield* Effect.gen(function* () {
            if (mode === "generate") {
              return {
                url: `${baseURL}/images/generations`,
                init: {
                  method: "POST",
                  headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json; charset=utf-8" },
                  // ⚠️ 非 ASCII 提示词必须由 JSON.stringify 编码后作为 UTF-8 body 发出。
                  // 260903 实测：走 shell 命令行传中文会被本机编码搞坏，而服务端不报错、
                  // 回落成一张无关的默认人像并照报 finish_reason: "success" —— 查不出来。
                  body: JSON.stringify({
                    model,
                    prompt: params.prompt,
                    ...(size ? { size } : {}),
                    response_format: "b64_json",
                  }),
                } satisfies RequestInit,
              }
            }
            const source = AppFileSystem.resolveFrom(instance.directory, params.image!)
            const bytes = yield* Effect.tryPromise({
              try: () => import("node:fs/promises").then((m) => m.readFile(source)),
              catch: (cause) => new Error(`Cannot read source image ${source}: ${cause}`),
            })
            const form = new FormData()
            form.set("model", model)
            form.set("prompt", params.prompt)
            form.set("response_format", "b64_json")
            if (size) form.set("size", size)
            form.set("image", new Blob([bytes as unknown as BlobPart]), path.basename(source))
            return {
              url: `${baseURL}/images/edits`,
              init: { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form } satisfies RequestInit,
            }
          })

          const init: RequestInit = { ...(body.init as RequestInit), signal: ctx.abort }
          const res = yield* Effect.tryPromise({
            try: () => fetch(body.url, init),
            catch: (cause) => new Error(`Image request failed: ${cause}`),
          })
          const json = (yield* Effect.tryPromise({
            try: () => res.json() as Promise<any>,
            catch: (cause) => new Error(`Image response was not JSON: ${cause}`),
          })) as { error?: { message?: string }; data?: { b64_json?: string; seed?: number; finish_reason?: string }[] }

          if (json.error?.message) return yield* Effect.fail(new Error(json.error.message))
          const item = json.data?.[0]
          if (!item?.b64_json) return yield* Effect.fail(new Error("Image backend returned no image data"))

          const buffer = Buffer.from(item.b64_json, "base64")
          const filepath = params.output
            ? AppFileSystem.resolveFrom(instance.directory, params.output)
            : path.join(instance.directory, ".redcode", "images", `${Date.now()}.png`)
          yield* fs.writeWithDirs(filepath, buffer).pipe(Effect.orDie)

          const relative = path.relative(instance.directory, filepath).replaceAll("\\", "/")
          const metadata: Metadata = {
            mode,
            model,
            filepath,
            bytes: buffer.byteLength,
            seed: item.seed,
            finish: item.finish_reason,
          }

          return {
            title: relative,
            output: `${mode === "edit" ? "Edited" : "Generated"} image saved to ${relative} (${(buffer.byteLength / 1024).toFixed(0)} KB)`,
            metadata,
            // 超过 INLINE_LIMIT 就不内联 —— 见文件头关于落库体积那段
            attachments:
              buffer.byteLength <= INLINE_LIMIT
                ? [{ type: "file" as const, mime: "image/png", url: `data:image/png;base64,${item.b64_json}` }]
                : undefined,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
