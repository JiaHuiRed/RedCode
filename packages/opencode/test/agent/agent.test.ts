import { afterEach, expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import path from "path"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Agent } from "../../src/agent/agent"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Global } from "@redcode-ai/core/global"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { Skill } from "../../src/skill"
import { Truncate } from "../../src/tool/truncate"

const agentLayer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  Agent.layer.pipe(
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Auth.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Skill.defaultLayer),
    Layer.provide(RuntimeFlags.layer(flags)),
  )

const it = testEffect(agentLayer())
const scout = testEffect(agentLayer({ experimentalScout: true }))

// Helper to evaluate permission for a tool with wildcard pattern
function evalPerm(agent: Agent.Info | undefined, permission: string): Permission.Action | undefined {
  if (!agent) return undefined
  return Permission.evaluate(permission, "*", agent.permission).action
}

function load<A>(fn: (svc: Agent.Interface) => Effect.Effect<A>) {
  return Agent.Service.use(fn)
}

const expectDefaultAgentError = Effect.fn("AgentTest.expectDefaultAgentError")(function* (message: string) {
  const exit = yield* load((svc) => svc.defaultAgent()).pipe(Effect.exit)
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain(message)
})

afterEach(async () => {
  await disposeAllInstances()
})

it.instance("returns default native agents when no config", () =>
  Effect.gen(function* () {
    const agents = yield* load((svc) => svc.list())
    const names = agents.map((a) => a.name)
    // 姿态 2 + 工种 3 + 机件 3。合并掉的老名字只活在别名表里，**不进 list()**
    expect(names).toContain("redmind")
    expect(names).toContain("plan")
    expect(names).toContain("explore")
    expect(names).toContain("advise")
    expect(names).toContain("execute")
    expect(names).toContain("compaction")
    expect(names).toContain("title")
    expect(names).toContain("summary")
    for (const gone of ["build", "general", "scout", "architect", "reviewer", "fixer"]) {
      expect(names).not.toContain(gone)
    }
  }),
)

// 260828 cc 第 4c-2 步：老名字只能经别名解析拿到，不能进任何列表。
// 硬约束是 session/prompt.ts 有四处对 agent 名做 get + 抛 agentNotFound（历史会话续跑、重放 task part、
// createUserMessage、slash 命令），别名一旦断了，老会话与老 subagent_type 直接终止而不是降级。
it.instance("legacy agent names resolve through the alias table", () =>
  Effect.gen(function* () {
    const expected: Record<string, string> = {
      build: "redmind",
      general: "execute",
      fixer: "execute",
      architect: "advise",
      reviewer: "advise",
      scout: "explore",
    }
    for (const [legacy, target] of Object.entries(expected)) {
      const agent = yield* load((svc) => svc.get(legacy))
      expect(agent).toBeDefined()
      expect(agent?.name).toBe(target)
    }
    // 阴性对照：不在别名表里的名字仍然解析不到
    expect(yield* load((svc) => svc.get("nope"))).toBeUndefined()
  }),
)

it.instance(
  "an explicitly configured agent wins over the alias pointing at the same name",
  () =>
    Effect.gen(function* () {
      // 直查优先、别名兜底：配置循环会把老 key 规范化到目标上，所以 `agent.general.description` 落在
      // execute 身上，而不是凭空造出一个 mode:"all" 的幽灵 general 把别名劫持掉。
      const names = (yield* load((svc) => svc.list())).map((a) => a.name)
      expect(names).not.toContain("general")
      const general = yield* load((svc) => svc.get("general"))
      expect(general?.name).toBe("execute")
      expect(general?.description).toBe("configured through the old name")
    }),
  { config: { agent: { general: { description: "configured through the old name" } } } },
)

it.instance(
  "disable on a legacy alias key is a no-op, not a way to delete the default agent",
  () =>
    Effect.gen(function* () {
      const names = (yield* load((svc) => svc.list())).map((a) => a.name)
      expect(names).toContain("redmind")
      expect(yield* load((svc) => svc.defaultAgent())).toBe("redmind")
    }),
  { config: { agent: { build: { disable: true } } } },
)

it.instance(
  "default_agent still accepts a legacy name",
  () =>
    Effect.gen(function* () {
      // 没有别名解析时这里会抛 `default agent "build" not found`；只补 defaultInfo 而不补排序谓词的话，
      // list() 会退化成 name-asc、客户端 at(0) 变成 plan。
      expect(yield* load((svc) => svc.defaultAgent())).toBe("redmind")
      expect((yield* load((svc) => svc.list()))[0]?.name).toBe("redmind")
    }),
  { config: { default_agent: "build" } },
)

it.instance("legacy \"build\" resolves to redmind with the same default properties", () =>
  Effect.gen(function* () {
    const build = yield* load((svc) => svc.get("build"))
    expect(build).toBeDefined()
    expect(build?.mode).toBe("primary")
    expect(build?.native).toBe(true)
    expect(evalPerm(build, "edit")).toBe("allow")
    expect(evalPerm(build, "bash")).toBe("allow")
    expect(evalPerm(build, "repo_clone")).toBe("deny")
    expect(evalPerm(build, "repo_overview")).toBe("deny")
  }),
)

it.instance("plan agent denies edits except .redcode/plans/*", () =>
  Effect.gen(function* () {
    const plan = yield* load((svc) => svc.get("plan"))
    expect(plan).toBeDefined()
    // Wildcard is denied
    expect(evalPerm(plan, "edit")).toBe("deny")
    // But specific path is allowed
    expect(Permission.evaluate("edit", ".redcode/plans/foo.md", plan!.permission).action).toBe("allow")
  }),
)

it.instance("explore agent denies edit and write", () =>
  Effect.gen(function* () {
    const explore = yield* load((svc) => svc.get("explore"))
    expect(explore).toBeDefined()
    expect(explore?.mode).toBe("subagent")
    expect(evalPerm(explore, "edit")).toBe("deny")
    expect(evalPerm(explore, "write")).toBe("deny")
    expect(evalPerm(explore, "todowrite")).toBe("deny")
  }),
)

it.instance("explore agent asks for external directories and allows whitelisted external paths", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const explore = yield* load((svc) => svc.get("explore"))
    expect(explore).toBeDefined()
    expect(Permission.evaluate("external_directory", "/some/other/path", explore!.permission).action).toBe("ask")
    expect(Permission.evaluate("external_directory", Truncate.GLOB, explore!.permission).action).toBe("allow")
    expect(
      Permission.evaluate("external_directory", path.join(Global.Path.tmp, "agent-work"), explore!.permission).action,
    ).toBe("allow")
    // 260803 Red workspace temp is whitelisted alongside the global tmp dir
    expect(
      Permission.evaluate(
        "external_directory",
        path.join(test.directory, ".redcode", "temp", "agent-work"),
        explore!.permission,
      ).action,
    ).toBe("allow")
  }),
)

// 260828 cc 第 4c-1 步：explore / advise / execute 的定义单一来源是 src/agent/definition/*.md，
// 内建那份直接吃 frontmatter。下面四条守的是「frontmatter 真被吃进去了」以及「扁平白名单第一条
// "*": deny 没有把 defaults 里的**对象型**权限一起打掉」——后者是 findLast 语义下最容易回归的一处。
it.instance("md-defined subagents carry their frontmatter", () =>
  Effect.gen(function* () {
    const explore = yield* load((svc) => svc.get("explore"))
    const advise = yield* load((svc) => svc.get("advise"))
    const execute = yield* load((svc) => svc.get("execute"))
    for (const agent of [explore, advise, execute]) {
      expect(agent).toBeDefined()
      expect(agent?.mode).toBe("subagent")
      expect(agent?.native).toBe(true)
      expect(agent?.prompt?.startsWith("---")).toBe(false)
      expect(agent?.description).toBeTruthy()
    }
    // model 是 branded 类型（ModelID / ProviderID），toBe/toEqual 会把参数收窄成 brand —— 拼成
    // 普通字符串再比，顺便和 md 里 `model:` 那一行的写法一模一样。
    const modelOf = (agent: Agent.Info | undefined) => `${agent?.model?.providerID}/${agent?.model?.modelID}`
    expect(modelOf(explore)).toBe("stepfun-step-plan/step-3.7-flash")
    expect(modelOf(advise)).toBe("deepseek/deepseek-v4-flash-vision-exp")
    expect(modelOf(execute)).toBe("opencode-go/glm-5.3-flash")
    // 三个工种都配了超时兑底：timeout_ms 罩整个子代理运行，超时换 fallback_model 重跑一次
    const fallbackOf = (agent: Agent.Info | undefined) =>
      `${agent?.fallbackModel?.providerID}/${agent?.fallbackModel?.modelID}`
    expect(explore?.timeoutMs).toBe(180000)
    expect(advise?.timeoutMs).toBe(600000)
    expect(execute?.timeoutMs).toBe(900000)
    expect(fallbackOf(explore)).toBe("opencode-go/glm-5.3-flash")
    expect(fallbackOf(advise)).toBe("opencode-go/glm-5.3-flash")
    expect(fallbackOf(execute)).toBe("opencode-go/mimo-v2.5")
    // 兑底必须换族，同族换路由治不了「模型自己卡住」这种失效
    for (const agent of [explore, advise, execute]) {
      expect(fallbackOf(agent)).not.toBe(modelOf(agent))
    }
    // 不写 variant：glm-5.3-flash 的 effort 只有 low/high/max，没有 none
    expect(execute?.variant).toBeUndefined()
    // 阴性对照：md 的白名单里有 indexgraph_*，4c 之前手写的内建块没有。命中即证明吃的是 frontmatter。
    expect(evalPerm(explore, "indexgraph_explore")).toBe("allow")
    // 反向阴性对照：白名单外的 MCP 工具仍被 "*": deny 拦下
    expect(evalPerm(explore, "some_random_mcp_tool")).toBe("deny")
  }),
)

it.instance("md-defined subagents keep the external directory whitelist", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    for (const name of ["advise", "execute"]) {
      const agent = yield* load((svc) => svc.get(name))
      expect(agent).toBeDefined()
      // md 里没有 external_directory，全靠 agent.ts 在 md 之后、user 之前重新宣告一遍
      expect(Permission.evaluate("external_directory", "/some/other/path", agent!.permission).action).toBe("ask")
      expect(Permission.evaluate("external_directory", Truncate.GLOB, agent!.permission).action).toBe("allow")
      expect(
        Permission.evaluate("external_directory", path.join(Global.Path.tmp, "agent-work"), agent!.permission).action,
      ).toBe("allow")
      expect(
        Permission.evaluate(
          "external_directory",
          path.join(test.directory, ".redcode", "temp", "agent-work"),
          agent!.permission,
        ).action,
      ).toBe("allow")
    }
  }),
)

it.instance("md-defined subagents keep the .env read guard", () =>
  Effect.gen(function* () {
    for (const name of ["explore", "advise", "execute"]) {
      const agent = yield* load((svc) => svc.get(name))
      expect(agent).toBeDefined()
      expect(Permission.evaluate("read", "src/index.ts", agent!.permission).action).toBe("allow")
      expect(Permission.evaluate("read", "packages/app/.env", agent!.permission).action).toBe("ask")
      expect(Permission.evaluate("read", "packages/app/.env.local", agent!.permission).action).toBe("ask")
      expect(Permission.evaluate("read", "packages/app/.env.example", agent!.permission).action).toBe("allow")
    }
  }),
)

it.instance(
  "per-agent config still wins over the md whitelist",
  () =>
    Effect.gen(function* () {
      const explore = yield* load((svc) => svc.get("explore"))
      expect(evalPerm(explore, "bash")).toBe("deny")
      // 同一份 md 的其余白名单不受影响
      expect(evalPerm(explore, "grep")).toBe("allow")
    }),
  { config: { agent: { explore: { permission: { bash: "deny" } } } } },
)

// 260828 cc scout 已并入 explore：agent 没了，flag（experimentalScout）留着，因为它还门控 @reference
// 的 git 物化与 repo_clone/repo_overview 的注册。连带后果是这两个工具**没有任何角色再放行** ——
// 依赖缓存能力就此退役（全量历史零调用，这正是 0.9.8 把它们放进 GATED_TOOLS 的原因）。
scout.instance("scout is merged into explore and the repo cache tools are retired", () =>
  Effect.gen(function* () {
    const names = (yield* load((svc) => svc.list())).map((agent) => agent.name)
    expect(names).not.toContain("scout")
    const scoutAgent = yield* load((svc) => svc.get("scout"))
    expect(scoutAgent?.name).toBe("explore")
    expect(evalPerm(scoutAgent, "repo_clone")).toBe("deny")
    expect(evalPerm(scoutAgent, "repo_overview")).toBe("deny")
    expect(evalPerm(scoutAgent, "edit")).toBe("deny")
  }),
)

scout.instance(
  "reference config does not create subagents",
  () =>
    Effect.gen(function* () {
      const agents = yield* load((svc) => svc.list())
      const names = agents.map((agent) => agent.name)
      expect(names).not.toContain("effect")
      expect(names).not.toContain("effectFull")
      expect(names).not.toContain("localdocs")
      expect(names).not.toContain("localdocsFull")
    }),
  {
    config: {
      reference: {
        effect: "github.com/effect/effect-smol",
        effectFull: {
          repository: "Effect-TS/effect",
          branch: "main",
        },
        localdocs: "../docs",
        localdocsFull: {
          path: "../local-docs",
        },
      },
    },
  },
)

it.instance("legacy \"general\" resolves to execute, which still denies todo tools", () =>
  Effect.gen(function* () {
    const general = yield* load((svc) => svc.get("general"))
    expect(general).toBeDefined()
    expect(general?.mode).toBe("subagent")
    expect(general?.hidden).toBeUndefined()
    expect(evalPerm(general, "todowrite")).toBe("deny")
  }),
)

it.instance("compaction agent denies all permissions", () =>
  Effect.gen(function* () {
    const compaction = yield* load((svc) => svc.get("compaction"))
    expect(compaction).toBeDefined()
    expect(compaction?.hidden).toBe(true)
    expect(evalPerm(compaction, "bash")).toBe("deny")
    expect(evalPerm(compaction, "edit")).toBe("deny")
    expect(evalPerm(compaction, "read")).toBe("deny")
  }),
)

it.instance(
  "custom agent from config creates new agent",
  () =>
    Effect.gen(function* () {
      const custom = yield* load((svc) => svc.get("my_custom_agent"))
      expect(custom).toBeDefined()
      expect(String(custom?.model?.providerID)).toBe("openai")
      expect(String(custom?.model?.modelID)).toBe("gpt-4")
      expect(custom?.description).toBe("My custom agent")
      expect(custom?.temperature).toBe(0.5)
      expect(custom?.topP).toBe(0.9)
      expect(custom?.native).toBe(false)
      expect(custom?.mode).toBe("all")
    }),
  {
    config: {
      agent: {
        my_custom_agent: {
          model: "openai/gpt-4",
          description: "My custom agent",
          temperature: 0.5,
          top_p: 0.9,
        },
      },
    },
  },
)

it.instance(
  "custom agent config overrides native agent properties",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      expect(build).toBeDefined()
      expect(String(build?.model?.providerID)).toBe("anthropic")
      expect(String(build?.model?.modelID)).toBe("claude-3")
      expect(build?.description).toBe("Custom build agent")
      expect(build?.temperature).toBe(0.7)
      expect(build?.color).toBe("#FF0000")
      expect(build?.native).toBe(true)
    }),
  {
    config: {
      agent: {
        build: {
          model: "anthropic/claude-3",
          description: "Custom build agent",
          temperature: 0.7,
          color: "#FF0000",
        },
      },
    },
  },
)

it.instance(
  "agent disable removes agent from list",
  () =>
    Effect.gen(function* () {
      const explore = yield* load((svc) => svc.get("explore"))
      expect(explore).toBeUndefined()
      const agents = yield* load((svc) => svc.list())
      const names = agents.map((a) => a.name)
      expect(names).not.toContain("explore")
    }),
  {
    config: {
      agent: {
        explore: { disable: true },
      },
    },
  },
)

it.instance(
  "agent permission config merges with defaults",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      expect(build).toBeDefined()
      // Specific pattern is denied
      expect(Permission.evaluate("bash", "rm -rf *", build!.permission).action).toBe("deny")
      // Edit still allowed
      expect(evalPerm(build, "edit")).toBe("allow")
    }),
  {
    config: {
      agent: {
        build: {
          permission: {
            bash: {
              "rm -rf *": "deny",
            },
          },
        },
      },
    },
  },
)

it.instance(
  "global permission config applies to all agents",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      expect(build).toBeDefined()
      expect(evalPerm(build, "bash")).toBe("deny")
    }),
  {
    config: {
      permission: {
        bash: "deny",
      },
    },
  },
)

it.instance(
  "agent steps/maxSteps config sets steps property",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      const plan = yield* load((svc) => svc.get("plan"))
      expect(build?.steps).toBe(50)
      expect(plan?.steps).toBe(100)
    }),
  {
    config: {
      agent: {
        build: { steps: 50 },
        plan: { maxSteps: 100 },
      },
    },
  },
)

it.instance(
  "agent mode can be overridden",
  () =>
    Effect.gen(function* () {
      const explore = yield* load((svc) => svc.get("explore"))
      expect(explore?.mode).toBe("primary")
    }),
  {
    config: {
      agent: {
        explore: { mode: "primary" },
      },
    },
  },
)

it.instance(
  "agent name can be overridden",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      expect(build?.name).toBe("Builder")
    }),
  {
    config: {
      agent: {
        build: { name: "Builder" },
      },
    },
  },
)

it.instance(
  "agent prompt can be set from config",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      expect(build?.prompt).toBe("Custom system prompt")
    }),
  {
    config: {
      agent: {
        build: { prompt: "Custom system prompt" },
      },
    },
  },
)

it.instance(
  "unknown agent properties are placed into options",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      expect(build?.options.random_property).toBe("hello")
      expect(build?.options.another_random).toBe(123)
    }),
  {
    config: {
      agent: {
        build: {
          random_property: "hello",
          another_random: 123,
        },
      },
    },
  },
)

it.instance(
  "agent options merge correctly",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      expect(build?.options.custom_option).toBe(true)
      expect(build?.options.another_option).toBe("value")
    }),
  {
    config: {
      agent: {
        build: {
          options: {
            custom_option: true,
            another_option: "value",
          },
        },
      },
    },
  },
)

it.instance(
  "multiple custom agents can be defined",
  () =>
    Effect.gen(function* () {
      const agentA = yield* load((svc) => svc.get("agent_a"))
      const agentB = yield* load((svc) => svc.get("agent_b"))
      expect(agentA?.description).toBe("Agent A")
      expect(agentA?.mode).toBe("subagent")
      expect(agentB?.description).toBe("Agent B")
      expect(agentB?.mode).toBe("primary")
    }),
  {
    config: {
      agent: {
        agent_a: {
          description: "Agent A",
          mode: "subagent",
        },
        agent_b: {
          description: "Agent B",
          mode: "primary",
        },
      },
    },
  },
)

it.instance(
  "Agent.list keeps the default agent first and sorts the rest by name",
  () =>
    Effect.gen(function* () {
      const names = (yield* load((svc) => svc.list())).map((a) => a.name)
      expect(names[0]).toBe("plan")
      expect(names.slice(1)).toEqual(names.slice(1).toSorted((a, b) => a.localeCompare(b)))
    }),
  {
    config: {
      default_agent: "plan",
      agent: {
        zebra: {
          description: "Zebra",
          mode: "subagent",
        },
        alpha: {
          description: "Alpha",
          mode: "subagent",
        },
      },
    },
  },
)

it.instance("Agent.get returns undefined for non-existent agent", () =>
  Effect.gen(function* () {
    const nonExistent = yield* load((svc) => svc.get("does_not_exist"))
    expect(nonExistent).toBeUndefined()
  }),
)

it.instance("default permission includes doom_loop and external_directory as ask", () =>
  Effect.gen(function* () {
    const build = yield* load((svc) => svc.get("build"))
    expect(evalPerm(build, "doom_loop")).toBe("ask")
    expect(evalPerm(build, "external_directory")).toBe("ask")
  }),
)

it.instance("webfetch is allowed by default", () =>
  Effect.gen(function* () {
    const build = yield* load((svc) => svc.get("build"))
    expect(evalPerm(build, "webfetch")).toBe("allow")
  }),
)

it.instance(
  "legacy tools config converts to permissions",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      expect(evalPerm(build, "bash")).toBe("deny")
      expect(evalPerm(build, "read")).toBe("deny")
    }),
  {
    config: {
      agent: {
        build: {
          tools: {
            bash: false,
            read: false,
          },
        },
      },
    },
  },
)

it.instance(
  "legacy tools config maps write/edit/patch to edit permission",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      expect(evalPerm(build, "edit")).toBe("deny")
    }),
  {
    config: {
      agent: {
        build: {
          tools: {
            write: false,
          },
        },
      },
    },
  },
)

it.instance(
  "Truncate.GLOB is allowed even when user denies external_directory globally",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      expect(Permission.evaluate("external_directory", Truncate.GLOB, build!.permission).action).toBe("allow")
      expect(Permission.evaluate("external_directory", Truncate.DIR, build!.permission).action).toBe("deny")
      expect(Permission.evaluate("external_directory", "/some/other/path", build!.permission).action).toBe("deny")
    }),
  {
    config: {
      permission: {
        external_directory: "deny",
      },
    },
  },
)

it.instance("global tmp directory children are allowed for external_directory", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const build = yield* load((svc) => svc.get("build"))
    expect(
      Permission.evaluate("external_directory", path.join(Global.Path.tmp, "scratch"), build!.permission).action,
    ).toBe("allow")
    // 260803 Red workspace temp is whitelisted alongside the global tmp dir
    expect(
      Permission.evaluate(
        "external_directory",
        path.join(test.directory, ".redcode", "temp", "scratch"),
        build!.permission,
      ).action,
    ).toBe("allow")
    expect(Permission.evaluate("external_directory", "/some/other/path", build!.permission).action).toBe("ask")
  }),
)

it.instance(
  "Truncate.GLOB is allowed even when user denies external_directory per-agent",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      expect(Permission.evaluate("external_directory", Truncate.GLOB, build!.permission).action).toBe("allow")
      expect(Permission.evaluate("external_directory", Truncate.DIR, build!.permission).action).toBe("deny")
      expect(Permission.evaluate("external_directory", "/some/other/path", build!.permission).action).toBe("deny")
    }),
  {
    config: {
      agent: {
        build: {
          permission: {
            external_directory: "deny",
          },
        },
      },
    },
  },
)

it.instance(
  "explicit Truncate.GLOB deny is respected",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      expect(Permission.evaluate("external_directory", Truncate.GLOB, build!.permission).action).toBe("deny")
      expect(Permission.evaluate("external_directory", Truncate.DIR, build!.permission).action).toBe("deny")
    }),
  {
    config: {
      permission: {
        external_directory: {
          "*": "deny",
          [Truncate.GLOB]: "deny",
        },
      },
    },
  },
)

it.instance(
  "skill directories are allowed for external_directory",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const skillDir = path.join(test.directory, ".redcode", "skill", "perm-skill")
      yield* Effect.promise(() =>
        Bun.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: perm-skill
description: Permission skill.
---

# Permission Skill
`,
        ),
      )

      const home = process.env.REDCODE_TEST_HOME
      process.env.REDCODE_TEST_HOME = test.directory
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          process.env.REDCODE_TEST_HOME = home
        }),
      )

      const build = yield* load((svc) => svc.get("build"))
      const target = path.join(skillDir, "reference", "notes.md")
      expect(Permission.evaluate("external_directory", target, build!.permission).action).toBe("allow")
    }),
  { git: true },
)

it.instance("defaultAgent returns redmind when no default_agent config", () =>
  Effect.gen(function* () {
    const agent = yield* load((svc) => svc.defaultAgent())
    expect(agent).toBe("redmind")
  }),
)

it.instance("defaultInfo returns resolved redmind agent when no default_agent config", () =>
  Effect.gen(function* () {
    const agent = yield* load((svc) => svc.defaultInfo())
    expect(agent.name).toBe("redmind")
    expect(agent.mode).toBe("primary")
  }),
)

it.instance(
  "defaultAgent respects default_agent config set to plan",
  () =>
    Effect.gen(function* () {
      const agent = yield* load((svc) => svc.defaultAgent())
      expect(agent).toBe("plan")
    }),
  {
    config: {
      default_agent: "plan",
    },
  },
)

it.instance(
  "defaultAgent respects default_agent config set to custom agent with mode all",
  () =>
    Effect.gen(function* () {
      const agent = yield* load((svc) => svc.defaultAgent())
      expect(agent).toBe("my_custom")
    }),
  {
    config: {
      default_agent: "my_custom",
      agent: {
        my_custom: {
          description: "My custom agent",
        },
      },
    },
  },
)

it.instance(
  "defaultAgent throws when default_agent points to subagent",
  () => expectDefaultAgentError('default agent "explore" is a subagent'),
  {
    config: {
      default_agent: "explore",
    },
  },
)

it.instance(
  "defaultAgent throws when default_agent points to hidden agent",
  () => expectDefaultAgentError('default agent "compaction" is hidden'),
  {
    config: {
      default_agent: "compaction",
    },
  },
)

it.instance(
  "defaultAgent throws when default_agent points to non-existent agent",
  () => expectDefaultAgentError('default agent "does_not_exist" not found'),
  {
    config: {
      default_agent: "does_not_exist",
    },
  },
)

it.instance(
  "defaultAgent returns plan when build and redmind are disabled and default_agent not set",
  () =>
    Effect.gen(function* () {
      const agent = yield* load((svc) => svc.defaultAgent())
      // build 与 redmind 都被禁用，于是回落到下一个 primary agent
      expect(agent).toBe("plan")
    }),
  {
    config: {
      agent: {
        build: { disable: true },
        redmind: { disable: true },
      },
    },
  },
)

it.instance(
  "defaultAgent throws when all primary agents are disabled",
  () => expectDefaultAgentError("no primary visible agent found"),
  {
    config: {
      agent: {
        build: { disable: true },
        plan: { disable: true },
        redmind: { disable: true },
        agent: { disable: true },
      },
    },
  },
)
