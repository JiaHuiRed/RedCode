import { expect, test } from "bun:test"
import { createChatAttachments } from "./chat-attachments"

function file(name: string) {
  return new File([name], name, { type: "text/plain" })
}

test("late reads and acknowledgements only affect the files they own", async () => {
  let finish!: (url: string) => void
  const drafts = createChatAttachments((f) =>
    f.name === "slow"
      ? new Promise((resolve) => {
          finish = resolve
        })
      : Promise.resolve("data:" + f.name),
  )
  const pending = drafts.add("default", [file("slow")])
  drafts.assignDefault("A")
  await drafts.add("B", [file("second")])
  expect(drafts.pending("A")).toBe(true)
  expect(drafts.files("B").map((f) => f.filename)).toEqual(["second"])
  finish("data:slow")
  await pending
  const sent = new Set(drafts.files("A").map((f) => f.id))
  await drafts.add("A", [file("later")])
  drafts.remove(sent)
  expect(drafts.files("A").map((f) => f.filename)).toEqual(["later"])
  expect(drafts.files("B").map((f) => f.filename)).toEqual(["second"])
  expect(drafts.files("default")).toEqual([])
})

test("parallel picks reserve four slots total and a failed read releases its own slot", async () => {
  const drafts = createChatAttachments(async (f) => {
    if (f.name === "bad") throw new Error("read")
    return "data:" + f.name
  })
  const one = drafts.add("A", [file("1"), file("2"), file("bad")])
  const two = drafts.add("A", [file("3"), file("4")])
  expect(drafts.files("A")).toHaveLength(4)
  expect(drafts.error("A")?.type).toBe("tooMany")
  await Promise.all([one, two])
  expect(drafts.error("A")).toEqual({ type: "readFailed", name: "bad" })
  await drafts.add("A", [file("4")])
  expect(drafts.files("A").map((f) => f.filename)).toEqual(["1", "2", "3", "4"])
})
