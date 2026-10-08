import { describe, expect, test } from "bun:test"
import { resolveSoulAvatar } from "./soul-avatar"

const images: Record<string, string> = {
  inventor: "data:image/png;base64,AAAA",
  writer: "data:image/png;base64,BBBB",
  portrait: "data:image/png;base64,CCCC",
}
const avatar = (key: string) => images[key] ?? ""
const inventor = { id: "inventor", name: "Inventor", displayName: "Iris" }
const writer = { id: "writer", name: "Writer", displayName: "Willow" }

describe("session Soul avatars", () => {
  test("arbitrary Soul IDs resolve to independent local images", () => {
    expect(resolveSoulAvatar("inventor", inventor, avatar)).toEqual({ name: "Iris", src: images.inventor })
    expect(resolveSoulAvatar("writer", writer, avatar)).toEqual({ name: "Willow", src: images.writer })
  })

  test("never borrows another Soul's name or the future default", () => {
    expect(resolveSoulAvatar("inventor", writer, avatar)).toEqual({ name: "inventor", src: images.inventor })
    expect(resolveSoulAvatar(undefined, writer, avatar)).toEqual({ name: "AI", src: undefined })
  })

  test("missing registry entries retain their pinned ID without choosing another Soul", () => {
    expect(resolveSoulAvatar("missing", undefined, avatar)).toEqual({ name: "missing", src: undefined })
  })

  test("only resolves logical avatar keys from the controlled local map", () => {
    const custom = { id: "custom", name: "Custom", displayName: "C", avatar: "portrait" }
    expect(resolveSoulAvatar("custom", custom, avatar).src).toBe(images.portrait)
    for (const key of ["https://example.invalid/photo.png", "C:\\secret.png", "../portrait"]) {
      expect(resolveSoulAvatar("custom", { ...custom, avatar: key }, () => "").src).toBeUndefined()
    }
  })

  test("rejects uncontrolled or oversized media even if a store is tampered with", () => {
    for (const value of ["https://example.invalid/a", "data:image/svg+xml;base64,AAAA", `data:image/png;base64,${"A".repeat(256 * 1024)}`]) {
      expect(resolveSoulAvatar("inventor", inventor, () => value).src).toBeUndefined()
    }
  })
})
