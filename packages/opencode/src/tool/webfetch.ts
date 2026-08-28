import { Effect, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Parser } from "htmlparser2"
import * as Tool from "./tool"
import TurndownService from "turndown"
import DESCRIPTION from "./webfetch.md" with { type: "text" }
import { isImageAttachment } from "@/util/media"
import { Config } from "@/config/config"
import { assertPublicDestination } from "@/util/net-address"

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024 // 5MB
const DEFAULT_TIMEOUT = 30 * 1000 // 30 seconds
const MAX_TIMEOUT = 120 * 1000 // 2 minutes
// 260828 cc：重定向改为手动跟随，因为每一跳都要重新校验目的地 —— 一个公网 URL
// 302 到 http://169.254.169.254/ 是这类守卫最经典的绕过方式。fetch 默认 follow，
// 那样第一次校验通过之后剩下的跳数就完全没人看了。
const MAX_REDIRECTS = 5

export const Parameters = Schema.Struct({
  url: Schema.String.annotate({ description: "The URL to fetch content from" }),
  format: Schema.Literals(["text", "markdown", "html"])
    .annotate({
      description: "The format to return the content in (text, markdown, or html). Defaults to markdown.",
      default: "markdown",
    })
    .pipe(Schema.optional, Schema.withDecodingDefault(Effect.succeed("markdown" as const))),
  timeout: Schema.optional(Schema.Number).annotate({ description: "Optional timeout in seconds (max 120)" }),
})

export const WebFetchTool = Tool.define(
  "webfetch",
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const config = yield* Config.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (!params.url.startsWith("http://") && !params.url.startsWith("https://")) {
            throw new Error("URL must start with http:// or https://")
          }

          // 审批在 DNS 解析之前：否则一次被拒的调用也已经替模型做过一次名字解析，
          // 审批本身就成了探测原语。
          yield* ctx.ask({
            permission: "webfetch",
            patterns: [params.url],
            always: ["*"],
            metadata: {
              url: params.url,
              format: params.format,
              timeout: params.timeout,
            },
          })

          const allowPrivateHosts = (yield* config.get()).webfetch?.allow_private_hosts ?? false
          const timeout = Math.min((params.timeout ?? DEFAULT_TIMEOUT / 1000) * 1000, MAX_TIMEOUT)

          // Build Accept header based on requested format with q parameters for fallbacks
          let acceptHeader = "*/*"
          switch (params.format) {
            case "markdown":
              acceptHeader = "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1"
              break
            case "text":
              acceptHeader = "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1"
              break
            case "html":
              acceptHeader =
                "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1"
              break
            default:
              acceptHeader =
                "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8"
          }
          const headers = {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
            Accept: acceptHeader,
            "Accept-Language": "en-US,en;q=0.9",
          }

          // 手动跟随重定向：每一跳都要重新过目的地校验。fetch 默认 follow，那样只有
          // 第一跳被看过，302 到内网就是一条免费通道。
          const send = (url: string, userAgent?: string) =>
            http
              .execute(
                HttpClientRequest.get(url).pipe(
                  HttpClientRequest.setHeaders(userAgent ? { ...headers, "User-Agent": userAgent } : headers),
                ),
              )
              .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }))

          const fetched = yield* Effect.gen(function* () {
            let current = params.url
            for (let hop = 0; ; hop++) {
              // 校验每一跳，且不受 allowPrivateHosts 短路 —— 该配置只放宽"人会在上面
              // 跑服务"的那几类（环回/RFC1918/CGNAT/ULA），link-local 这类云元数据端点
              // 无论如何都拦。
              const blocked = yield* Effect.promise(() =>
                assertPublicDestination(new URL(current), { allowPrivate: allowPrivateHosts }).then(
                  () => undefined,
                  (err: unknown) => err as Error,
                ),
              )
              if (blocked) throw blocked

              let res = yield* send(current)
              // Retry with honest UA if blocked by Cloudflare bot detection (TLS fingerprint mismatch)
              if (res.status === 403 && res.headers["cf-mitigated"] === "challenge") {
                res = yield* send(current, "opencode")
              }

              const location = res.headers["location"]
              if (res.status >= 300 && res.status < 400 && location) {
                if (hop >= MAX_REDIRECTS) throw new Error(`Too many redirects (limit ${MAX_REDIRECTS})`)
                const next = new URL(location, current)
                if (next.protocol !== "http:" && next.protocol !== "https:") {
                  throw new Error(`Refusing to follow a redirect to a non-HTTP(S) URL: ${next.protocol}//…`)
                }
                current = next.toString()
                continue
              }

              if (res.status < 200 || res.status >= 300) {
                throw new Error(`Request failed with status ${res.status}`)
              }
              return res
            }
          }).pipe(Effect.timeoutOrElse({ duration: timeout, orElse: () => Effect.die(new Error("Request timed out")) }))

          const response = fetched

          // Check content length
          const contentLength = response.headers["content-length"]
          if (contentLength && parseInt(contentLength) > MAX_RESPONSE_SIZE) {
            throw new Error("Response too large (exceeds 5MB limit)")
          }

          const arrayBuffer = yield* response.arrayBuffer
          if (arrayBuffer.byteLength > MAX_RESPONSE_SIZE) {
            throw new Error("Response too large (exceeds 5MB limit)")
          }

          const contentType = response.headers["content-type"] || ""
          const mime = contentType.split(";")[0]?.trim().toLowerCase() || ""
          const title = `${params.url} (${contentType})`

          if (isImageAttachment(mime)) {
            const base64Content = Buffer.from(arrayBuffer).toString("base64")
            return {
              title,
              output: "Image fetched successfully",
              metadata: {},
              attachments: [
                {
                  type: "file" as const,
                  mime,
                  url: `data:${mime};base64,${base64Content}`,
                },
              ],
            }
          }

          const content = new TextDecoder().decode(arrayBuffer)

          // Handle content based on requested format and actual content type
          switch (params.format) {
            case "markdown":
              if (contentType.includes("text/html")) {
                const markdown = convertHTMLToMarkdown(content)
                return {
                  output: markdown,
                  title,
                  metadata: {},
                }
              }
              return { output: content, title, metadata: {} }

            case "text":
              if (contentType.includes("text/html")) {
                return { output: extractTextFromHTML(content), title, metadata: {} }
              }
              return { output: content, title, metadata: {} }

            case "html":
              return { output: content, title, metadata: {} }

            default:
              return { output: content, title, metadata: {} }
          }
        }).pipe(Effect.orDie),
    }
  }),
)

function extractTextFromHTML(html: string) {
  let text = ""
  let skipDepth = 0

  const parser = new Parser({
    onopentag(name) {
      if (skipDepth > 0 || ["script", "style", "noscript", "iframe", "object", "embed"].includes(name)) {
        skipDepth++
      }
    },
    ontext(input) {
      if (skipDepth === 0) text += input
    },
    onclosetag() {
      if (skipDepth > 0) skipDepth--
    },
  })

  parser.write(html)
  parser.end()

  return text.trim()
}

function convertHTMLToMarkdown(html: string): string {
  const turndownService = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  })
  turndownService.remove(["script", "style", "meta", "link"])
  return turndownService.turndown(html)
}
