import { describe, expect, test } from "bun:test"
import { activeCommandRegistrations, addCommandRegistration } from "./command"

describe("command registrations", () => {
  test("shadows keyed registrations while retaining the previous owner", () => {
    const one = () => [{ id: "one", title: "One" }]
    const two = () => [{ id: "two", title: "Two" }]

    const registrations = addCommandRegistration([{ key: "layout", options: one }], {
      key: "layout",
      options: two,
    })
    const active = activeCommandRegistrations(registrations)

    expect(registrations).toHaveLength(2)
    expect(active).toHaveLength(1)
    expect(active[0]?.options).toBe(two)

    // 后注册者卸载后，先注册的那份必须还能恢复——旧实现直接把它从数组里删掉了
    const restored = activeCommandRegistrations(registrations.filter((entry) => entry.options !== two))
    expect(restored).toHaveLength(1)
    expect(restored[0]?.options).toBe(one)
  })

  test("keeps unkeyed registrations additive", () => {
    const one = () => [{ id: "one", title: "One" }]
    const two = () => [{ id: "two", title: "Two" }]

    const next = activeCommandRegistrations(addCommandRegistration([{ options: one }], { options: two }))

    expect(next).toHaveLength(2)
    expect(next[0]?.options).toBe(two)
    expect(next[1]?.options).toBe(one)
  })
})
