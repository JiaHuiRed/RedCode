import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import type { Agent } from "../../src/agent/agent"
import { Config } from "../../src/config/config"
import { NamedError } from "@redcode-ai/core/util/error"
import type { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { Skill } from "../../src/skill"
import { Permission } from "../../src/permission"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { SystemPrompt } from "../../src/session/system"
import { testEffect } from "../lib/effect"

const skills: Skill.Info[] = [
  {
    name: "zeta-skill",
    description: "Zeta skill.",
    location: "/tmp/zeta-skill/SKILL.md",
    content: "# zeta-skill",
  },
  {
    name: "alpha-skill",
    description: "Alpha skill.",
    location: "/tmp/alpha-skill/SKILL.md",
    content: "# alpha-skill",
  },
  {
    name: "middle-skill",
    description: "Middle skill.",
    location: "/tmp/middle-skill/SKILL.md",
    content: "# middle-skill",
  },
  {
    name: "manual-skill",
    location: "/tmp/manual-skill/SKILL.md",
    content: "# manual-skill",
  },
]

const build: Agent.Info = {
  name: "build",
  mode: "primary",
  permission: Permission.fromConfig({ "*": "allow" }),
  options: {},
}

const model: Provider.Model = {
  id: ModelID.make("test-model"),
  providerID: ProviderID.make("test"),
  api: { id: "test-model", url: "https://example.com", npm: "@ai-sdk/openai" },
  name: "Test Model",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 0, input: 0, output: 0 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}

const it = testEffect(
  SystemPrompt.layer.pipe(
    Layer.provide(
      Layer.succeed(
        Skill.Service,
        Skill.Service.of({
          get: (name) => Effect.succeed(skills.find((skill) => skill.name === name)),
          all: () => Effect.succeed(skills),
          dirs: () => Effect.succeed([]),
          available: () => Effect.succeed(skills),
        }),
      ),
    ),
    Layer.provide(RuntimeFlags.layer()),
    // 260731 Red SystemPrompt.layer 自 558aa66 起依赖 Config.Service（正文称呼），测试没跟上
    Layer.provide(Config.defaultLayer),
  ),
)

describe("session.system", () => {
  it.effect("skills output is sorted by name and stable across calls", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const first = yield* prompt.skills(build)
      const second = yield* prompt.skills(build)
      const output = first ?? (yield* Effect.fail(new NamedError.Unknown({ message: "missing skills output" })))

      expect(first).toBe(second)

      const alpha = output.indexOf("<name>alpha-skill</name>")
      const middle = output.indexOf("<name>middle-skill</name>")
      const zeta = output.indexOf("<name>zeta-skill</name>")

      expect(alpha).toBeGreaterThan(-1)
      expect(middle).toBeGreaterThan(alpha)
      expect(zeta).toBeGreaterThan(middle)
      expect(output).not.toContain("manual-skill")
    }),
  )

  it.instance(
    "environment exposes configured address as a preference fact",
    () =>
      Effect.gen(function* () {
        const prompt = yield* SystemPrompt.Service
        const output = (yield* prompt.environment(model)).join("\n")

        expect(output).toContain("Preferred form of address: 哥哥")
        expect(output).not.toContain("尽量用这个称呼")
        expect(output).not.toContain("可见思考文本")
      }),
    { config: { username: "哥哥" } },
  )

  it.instance(
    "environment caps the configured address fact",
    () =>
      Effect.gen(function* () {
        const prompt = yield* SystemPrompt.Service
        const name = "哥".repeat(129)
        const output = (yield* prompt.environment(model)).join("\n")

        expect(output).toContain(`Preferred form of address: ${name.slice(0, 128)}`)
        expect(output).not.toContain(name)
      }),
    { config: { username: "哥".repeat(129) } },
  )
})
