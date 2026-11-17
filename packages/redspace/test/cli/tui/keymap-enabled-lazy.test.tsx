/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal, type Accessor } from "solid-js"
import { OpencodeKeymapProvider, useBindings } from "@/cli/cmd/tui/keymap"

// 260904 cc 钉住「enabled 的写法决定键位层重不重注册」这条不变式（黄档 A10）。
//
// `useBindings` 是一个 createEffect：它同步调用 createLayer()，所以**在那里面读到的任何信号
// 都成了 effect 的依赖**，一变就 dispose 掉整层再 registerLayer 注册回来。prompt 输入框原先
// 把 enabled 写成立即求值的 IIFE 并在里面读一个 cursorVersion 计数器（光标一动就自增），
// 于是每一次按键都要重注册四层键位——而 enabled 的值大多数时候根本没变。
//
// opentui 的 enabled 收 `boolean | (() => boolean) | ReactiveMatcher`（addons/universal/enabled.d.ts），
// 函数形式交给 `ctx.activeWhen`，在按键判定时才求值。改成函数之后 effect 不再依赖那个信号。
//
// 这两个用例是对照组：同样的信号变化，eager 会重注册，lazy 不会。

async function countRegistrations(input: {
  version: Accessor<number>
  mode: "eager" | "lazy"
  bump: () => void
}): Promise<{ initial: number; afterBumps: number }> {
  let registrations = 0
  const counts = { initial: 0, afterBumps: 0 }

  function Inner(props: { mode: "eager" | "lazy" }) {
    useBindings(() => ({
      enabled:
        props.mode === "lazy"
          ? // 惰性：信号在 activeWhen 调用时才被读，effect 追踪不到它
            () => input.version() >= 0
          : // 立即：IIFE 在 createLayer() 里同步跑，信号成了 effect 的依赖
            (() => {
              input.version()
              return true
            })(),
      bindings: [{ key: "f13", desc: "probe", group: "Probe", cmd: () => {} }],
    }))
    return <box />
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const original = keymap.registerLayer.bind(keymap)
    keymap.registerLayer = ((layer: Parameters<typeof original>[0]) => {
      registrations += 1
      return original(layer)
    }) as typeof keymap.registerLayer

    return (
      <OpencodeKeymapProvider keymap={keymap}>
        <Inner mode={input.mode} />
      </OpencodeKeymapProvider>
    )
  }

  const app = await testRender(() => <Harness />)
  try {
    counts.initial = registrations
    for (let i = 0; i < 5; i++) input.bump()
    await Promise.resolve()
    counts.afterBumps = registrations
  } finally {
    app.renderer.destroy()
  }
  return counts
}

test("eager enabled re-registers the layer on every signal bump", async () => {
  const [version, setVersion] = createSignal(0)
  const counts = await countRegistrations({
    version,
    mode: "eager",
    bump: () => setVersion((value) => value + 1),
  })

  expect(counts.initial).toBe(1)
  // 这就是 A10 的病：5 次光标变化 = 5 次额外重注册
  expect(counts.afterBumps).toBe(6)
})

test("lazy enabled predicate leaves the layer registered", async () => {
  const [version, setVersion] = createSignal(0)
  const counts = await countRegistrations({
    version,
    mode: "lazy",
    bump: () => setVersion((value) => value + 1),
  })

  expect(counts.initial).toBe(1)
  expect(counts.afterBumps).toBe(1)
})
