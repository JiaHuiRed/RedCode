import { describe, expect, test } from "bun:test"
import os from "os"
import { addressFrom } from "./reasoning-language"

// 261015 Red 锁住 addressFrom 的两道判据。
//
// 旧实现把 os.userInfo() 与 os.hostname() 两个比较罩在同一个 try 里：userInfo() 一抛
// （用户名非 UTF-8、平台不支持等），hostname 那道跟着失效 —— 电脑名会被当成「称呼偏好」
// 注入模型（本文件注释原话：比不注入更糟）。下面最后两条就是这条回归的守卫。
//
// 不 mock node:os：mock.module 是进程级替换，把 os 打坏会毒到同进程后续加载的所有测试文件
// （记忆 #658），而 os 是几乎所有模块都会碰的核心内建。改用 addressFrom 的注入点把
// 「取不到系统用户名」喂进去，直调真实现（记忆 #183 的注入口径）。
//
// 另：node:os 的属性写不动，monkey-patch `os.userInfo = …` 会静默不生效 —— 第一版测试就是这么
// 假绿的，靠 sanity 断言（计数须 > 0）当场抓到。这里不再走那条路。

const broken: () => string = () => {
  throw new Error("os.userInfo unavailable")
}

describe("addressFrom", () => {
  test("排除系统用户名与电脑名", () => {
    expect(addressFrom(os.hostname())).toBeUndefined()
    expect(addressFrom(os.userInfo().username)).toBeUndefined()
  })

  test("空值、纯空白返回 undefined", () => {
    expect(addressFrom(undefined)).toBeUndefined()
    expect(addressFrom("   ")).toBeUndefined()
  })

  test("正常名字去空白后原样返回", () => {
    expect(addressFrom("  哥哥  ")).toBe("哥哥")
  })

  test("按 code point 截断到 128", () => {
    expect(addressFrom("名".repeat(200))).toHaveLength(128)
  })

  // 回归守卫：取系统用户名抛错时，hostname 判据必须仍然生效。
  test("系统用户名取不到时，电脑名判据仍然生效", () => {
    expect(addressFrom(os.hostname(), broken)).toBeUndefined()
  })

  // 同一条件下的反向守卫：普通名字不能被误伤。
  test("系统用户名取不到时，普通名字照常返回", () => {
    expect(addressFrom("哥哥", broken)).toBe("哥哥")
  })
})
