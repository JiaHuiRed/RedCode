import { describe, expect, test } from "bun:test"
import { planMediaMigration, type SettingsMedia } from "./settings"

// 260904 cc 头像与壁纸从 settings.v3 搬进自己的存储文件（Persist.media）。
// 这段只在启动瞬间跑一次，错了用户看到的是「头像和壁纸没了」，而且旧值已被清掉、找不回来。
// 所以决策抽成纯函数单独钉住。

const empty: SettingsMedia = {
  chatBackground: "",
  homeBackground: "",
  userAvatar: "",
  assistantAvatar: "",
}

describe("planMediaMigration", () => {
  test("nothing to do when the legacy fields are empty", () => {
    const plan = planMediaMigration({ legacy: {}, media: empty })
    expect(plan.write).toEqual([])
    expect(plan.clear).toEqual([])
  })

  test("moves legacy values across and clears the originals", () => {
    const plan = planMediaMigration({
      legacy: {
        chatBackground: "data:image/jpeg;base64,chat",
        homeBackground: "data:image/jpeg;base64,home",
        userAvatar: "data:image/jpeg;base64,me",
        assistantAvatar: "data:image/jpeg;base64,bot",
      },
      media: empty,
    })
    expect(plan.write).toEqual([
      ["chatBackground", "data:image/jpeg;base64,chat"],
      ["homeBackground", "data:image/jpeg;base64,home"],
      ["userAvatar", "data:image/jpeg;base64,me"],
      ["assistantAvatar", "data:image/jpeg;base64,bot"],
    ])
    expect(plan.clear).toEqual(["chatBackground", "homeBackground", "userAvatar", "assistantAvatar"])
  })

  // 搬过一次之后用户又换了图：新值住在 media 里，旧字段可能还留着陈值。
  // 这时**只清不写**——写就是拿旧图盖掉新图。
  test("never overwrites a value that already lives in the media store", () => {
    const plan = planMediaMigration({
      legacy: { userAvatar: "data:image/jpeg;base64,stale" },
      media: { ...empty, userAvatar: "data:image/jpeg;base64,current" },
    })
    expect(plan.write).toEqual([])
    expect(plan.clear).toEqual(["userAvatar"])
  })

  test("handles a partially populated legacy store", () => {
    const plan = planMediaMigration({
      legacy: { homeBackground: "data:image/jpeg;base64,home", userAvatar: "" },
      media: empty,
    })
    expect(plan.write).toEqual([["homeBackground", "data:image/jpeg;base64,home"]])
    expect(plan.clear).toEqual(["homeBackground"])
  })

  // 清空这步是 default.dat 真正瘦下来的地方：只搬不清等于留两份。
  test("clears every legacy field it found, even the ones it did not write", () => {
    const plan = planMediaMigration({
      legacy: { chatBackground: "data:a", userAvatar: "data:b" },
      media: { ...empty, chatBackground: "data:kept" },
    })
    expect(plan.write).toEqual([["userAvatar", "data:b"]])
    expect(plan.clear).toEqual(["chatBackground", "userAvatar"])
  })
})
