import { describe, test, expect } from "bun:test"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { AppFileSystem } from "@redcode-ai/core/filesystem"
import { Effect, FileSystem, Layer } from "effect"
import { Truncate } from "@/tool/truncate"
import { ImageTokens } from "@/session/image-tokens"
import { Config } from "@/config/config"
import { Identifier } from "../../src/id/id"
import { Process } from "@/util/process"
import path from "path"
import { testEffect } from "../lib/effect"
import { writeFileStringScoped } from "../lib/filesystem"
import { TestConfig } from "../fixture/config"

const FIXTURES_DIR = path.join(import.meta.dir, "fixtures")
const ROOT = path.resolve(import.meta.dir, "..", "..")

const it = testEffect(Layer.mergeAll(Truncate.defaultLayer, NodeFileSystem.layer, AppFileSystem.defaultLayer))

const configuredLayer = (cfg: Config.Info) =>
  Layer.mergeAll(
    Truncate.defaultLayer,
    NodeFileSystem.layer,
    AppFileSystem.defaultLayer,
    TestConfig.layer({ get: () => Effect.succeed(cfg) }),
  )
const configuredIt = (cfg: Config.Info) => testEffect(configuredLayer(cfg))

describe("Truncate", () => {
  describe("output", () => {
    it.live("truncates large json file by bytes", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const fsys = yield* AppFileSystem.Service
        const content = yield* fsys.readFileString(path.join(FIXTURES_DIR, "models-api.json"))
        const result = yield* svc.output(content)

        expect(result.truncated).toBe(true)
        expect(result.content).toContain("truncated...")
        if (result.truncated) expect(result.outputPath).toBeDefined()
      }),
    )

    it.live("returns content unchanged when under limits", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const content = "line1\nline2\nline3"
        const result = yield* svc.output(content)

        expect(result.truncated).toBe(false)
        expect(result.content).toBe(content)
      }),
    )

    it.live("truncates by line count", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
        const result = yield* svc.output(lines, { maxLines: 10 })

        expect(result.truncated).toBe(true)
        expect(result.content).toContain("...90 lines truncated...")
      }),
    )

    it.live("truncates by byte count", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const content = "a".repeat(1000)
        const result = yield* svc.output(content, { maxBytes: 100 })

        expect(result.truncated).toBe(true)
        expect(result.content).toContain("truncated...")
      }),
    )

    it.live("keeps head and tail by default (both, 4:1 split)", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
        const result = yield* svc.output(lines, { maxLines: 10 })

        expect(result.truncated).toBe(true)
        // head 80% = 8 行保留
        expect(result.content).toContain("line0")
        expect(result.content).toContain("line7")
        // tail 20% = 2 行保留
        expect(result.content).toContain("line98")
        expect(result.content).toContain("line99")
        // 中间省略
        expect(result.content).toContain("truncated...")
        expect(result.content).not.toContain("line50")
        // 顺序：head 在前、tail 在后
        expect(result.content.indexOf("line0")).toBeLessThan(result.content.indexOf("line98"))
      }),
    )

    it.live("truncates from head when direction is head", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const lines = Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n")
        const result = yield* svc.output(lines, { maxLines: 3, direction: "head" })

        expect(result.truncated).toBe(true)
        expect(result.content).toContain("line0")
        expect(result.content).toContain("line1")
        expect(result.content).toContain("line2")
        expect(result.content).not.toContain("line9")
      }),
    )

    it.live("truncates from tail when direction is tail", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const lines = Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n")
        const result = yield* svc.output(lines, { maxLines: 3, direction: "tail" })

        expect(result.truncated).toBe(true)
        expect(result.content).toContain("line7")
        expect(result.content).toContain("line8")
        expect(result.content).toContain("line9")
        expect(result.content).not.toContain("line0")
      }),
    )

    test("uses default MAX_LINES and MAX_BYTES", () => {
      expect(Truncate.MAX_LINES).toBe(2000)
      expect(Truncate.MAX_BYTES).toBe(50 * 1024)
    })

    it.live("limits() falls back to MAX_LINES/MAX_BYTES when Config is not provided", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const resolved = yield* svc.limits()
        expect(resolved.maxLines).toBe(Truncate.MAX_LINES)
        expect(resolved.maxBytes).toBe(Truncate.MAX_BYTES)
      }),
    )

    describe("with tool_output config", () => {
      const limitsIt = configuredIt({ tool_output: { max_lines: 123, max_bytes: 456 } })
      limitsIt.live("limits() reflects config overrides", () =>
        Effect.gen(function* () {
          const resolved = yield* (yield* Truncate.Service).limits()
          expect(resolved.maxLines).toBe(123)
          expect(resolved.maxBytes).toBe(456)
        }),
      )

      // Huge byte budget isolates line truncation. 100 lines against max_lines: 10
      // proves the configured line limit is what `output()` enforces.
      const lineIt = configuredIt({ tool_output: { max_lines: 10, max_bytes: 1024 * 1024 } })
      lineIt.live("output() truncates to configured max_lines", () =>
        Effect.gen(function* () {
          const content = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
          const result = yield* (yield* Truncate.Service).output(content)
          expect(result.truncated).toBe(true)
          expect(result.content).toContain("...90 lines truncated...")
        }),
      )

      // Huge line budget isolates byte truncation.
      const byteIt = configuredIt({ tool_output: { max_lines: 1_000_000, max_bytes: 100 } })
      byteIt.live("output() truncates to configured max_bytes", () =>
        Effect.gen(function* () {
          const content = "a".repeat(1000)
          const result = yield* (yield* Truncate.Service).output(content)
          expect(result.truncated).toBe(true)
          expect(result.content).toContain("bytes truncated...")
        }),
      )

      const overrideIt = configuredIt({ tool_output: { max_lines: 10, max_bytes: 100 } })
      overrideIt.live("per-call options still override config", () =>
        Effect.gen(function* () {
          const content = Array.from({ length: 50 }, (_, i) => `line${i}`).join("\n")
          const result = yield* (yield* Truncate.Service).output(content, {
            maxLines: 1000,
            maxBytes: 1024 * 1024,
          })
          expect(result.truncated).toBe(false)
        }),
      )
    })

    it.live("large single-line file truncates with byte message", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const fsys = yield* AppFileSystem.Service
        const content = yield* fsys.readFileString(path.join(FIXTURES_DIR, "models-api.json"))
        const result = yield* svc.output(content)

        expect(result.truncated).toBe(true)
        expect(result.content).toContain("bytes truncated...")
        expect(Buffer.byteLength(content, "utf-8")).toBeGreaterThan(Truncate.MAX_BYTES)
      }),
    )

    it.live("writes full output to file when truncated", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
        const result = yield* svc.output(lines, { maxLines: 10 })

        expect(result.truncated).toBe(true)
        expect(result.content).toContain("The tool call succeeded but the output was truncated")
        expect(result.content).toContain("Grep")
        if (!result.truncated) throw new Error("expected truncated")
        expect(result.outputPath).toBeDefined()
        expect(result.outputPath).toContain("tool_")

        const fsys = yield* AppFileSystem.Service
        const written = yield* fsys.readFileString(result.outputPath!)
        expect(written).toBe(lines)
      }),
    )

    it.live("suggests Task tool when agent has task permission", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
        const agent = { permission: [{ permission: "task", pattern: "*", action: "allow" as const }] }
        const result = yield* svc.output(lines, { maxLines: 10 }, agent as any)

        expect(result.truncated).toBe(true)
        expect(result.content).toContain("Grep")
        expect(result.content).toContain("Task tool")
      }),
    )

    it.live("omits Task tool hint when agent lacks task permission", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
        const agent = { permission: [{ permission: "task", pattern: "*", action: "deny" as const }] }
        const result = yield* svc.output(lines, { maxLines: 10 }, agent as any)

        expect(result.truncated).toBe(true)
        expect(result.content).toContain("Grep")
        expect(result.content).not.toContain("Task tool")
      }),
    )

    it.live("does not write file when not truncated", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const content = "short content"
        const result = yield* svc.output(content)

        expect(result.truncated).toBe(false)
        if (result.truncated) throw new Error("expected not truncated")
        expect("outputPath" in result).toBe(false)
      }),
    )

    test("loads truncate effect in a fresh process", async () => {
      const out = await Process.run([process.execPath, "run", path.join(ROOT, "src", "tool", "truncate.ts")], {
        cwd: ROOT,
      })

      expect(out.code).toBe(0)
    }, 20000)
  })

  describe("result", () => {
    const image = (label: string) => ({
      mime: "image/png",
      url: `data:image/png;base64,${Buffer.from(label).toString("base64")}`,
    })

    // spill 写盘一律失败：验证 fail-soft —— 预览仍然有界，且如实说「没能保存」
    const spillFailIt = testEffect(
      Truncate.layer.pipe(
        Layer.provide(
          Layer.mock(AppFileSystem.Service)({
            ensureDir: () => Effect.die("simulated spill failure"),
            writeFileString: () => Effect.die("simulated spill failure"),
            writeWithDirs: () => Effect.die("simulated spill failure"),
            readDirectory: () => Effect.succeed([]),
            // PartialEffectful 只把 Effect 方法变可选，globMatch / sink / [TypeId] 这类
            // 非 Effect 成员仍然要求齐 —— 文件系统 mock 填不出有意义的值，只覆盖本用例
            // 真正走到的四个方法
          } as any),
        ),
        Layer.provide(NodePath.layer),
      ),
    )

    it.live("keeps text and images within the model-visible token budget and spills the rest", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const fsys = yield* AppFileSystem.Service
        const text = "x".repeat(52_000)
        const images = Array.from({ length: 32 }, (_, i) => image(`image-${i}`))
        const result = yield* svc.result({ output: text, attachments: images }, { model: { providerID: "deepseek" } })

        expect(result.metadata.truncated).toBe(true)
        const model = { providerID: "deepseek" }
        expect(
          ImageTokens.estimateToolResult({ text: result.output, attachments: result.attachments ?? [] }, model),
        ).toBeLessThanOrEqual(ImageTokens.TOOL_RESULT_TOKEN_BUDGET)
        // 32 张装得下（32 × 416 ≤ 14000 − 400），文本被截，notice 自己也占预算
        expect(result.attachments).toHaveLength(32)
        expect(result.output).toContain("chars omitted")
        expect(result.output).toContain("Full output saved to:")

        const written = yield* fsys.readFileString(result.metadata.outputPath!)
        expect(written).toBe(text)
      }),
    )

    it.live("drops attachments from the tail and saves them beside the text", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const fsys = yield* AppFileSystem.Service
        const text = "y".repeat(52_000)
        const images = Array.from({ length: 40 }, (_, i) => image(`image-${i}`))
        const result = yield* svc.result({ output: text, attachments: images }, { model: { providerID: "deepseek" } })

        expect(result.metadata.truncated).toBe(true)
        expect(result.attachments!.length).toBeLessThan(40)
        expect(result.metadata.mediaPath).toBeDefined()
        const saved = yield* fsys.readDirectory(result.metadata.mediaPath!)
        expect(saved.length).toBe(40 - result.attachments!.length)
        expect(saved.some((name) => name.endsWith(".png"))).toBe(true)
      }),
    )

    spillFailIt.live("keeps the preview bounded and reports that the spill failed", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const text = "z".repeat(80_000)
        const result = yield* svc.result({ output: text }, { model: { providerID: "deepseek" } })

        expect(result.metadata.truncated).toBe(true)
        expect(result.metadata.outputPath).toBeUndefined()
        expect(result.output).toContain("could not be saved")
        expect(result.output).toContain("model-visible token budget")
        expect(result.output).not.toContain(text)
        expect(ImageTokens.estimateToolResult({ text: result.output }, { providerID: "deepseek" })).toBeLessThanOrEqual(
          ImageTokens.TOOL_RESULT_TOKEN_BUDGET,
        )
      }),
    )

    it.live("reuses an existing full-output file without overwriting it with the preview", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const fsys = yield* AppFileSystem.Service
        const full = "full output from tool before its preview"
        const outputPath = yield* svc.write(full)
        const result = yield* svc.result(
          { output: "z".repeat(80_000), outputPath },
          { model: { providerID: "deepseek" } },
        )

        expect(result.metadata.truncated).toBe(true)
        expect(result.metadata.outputPath).toBe(outputPath)
        expect(result.output).toContain(`Full output saved to: ${outputPath}`)
        expect(result.output).not.toContain("could not be saved")
        expect(yield* fsys.readFileString(outputPath)).toBe(full)
      }),
    )
  })

  describe("cleanup", () => {
    const DAY_MS = 24 * 60 * 60 * 1000

    it.live("deletes files older than 7 days and preserves recent files", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const fs = yield* FileSystem.FileSystem

        yield* fs.makeDirectory(Truncate.DIR, { recursive: true })

        const old = path.join(Truncate.DIR, Identifier.create("tool", "ascending", Date.now() - 10 * DAY_MS))
        const recent = path.join(Truncate.DIR, Identifier.create("tool", "ascending", Date.now() - 3 * DAY_MS))

        yield* writeFileStringScoped(old, "old content")
        yield* writeFileStringScoped(recent, "recent content")
        yield* svc.cleanup()

        expect(yield* fs.exists(old)).toBe(false)
        expect(yield* fs.exists(recent)).toBe(true)
      }),
    )
  })
})
