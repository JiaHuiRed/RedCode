import { describe, expect } from "bun:test"
import path from "path"
import { Global } from "@redcode-ai/core/global"
import { Database } from "@/storage/db"

describe("Database.getChannelPath", () => {
  it("returns the shared redcode.db path", () => {
    expect(Database.getChannelPath()).toBe(path.join(Global.Path.data, "redcode.db"))
  })
})
