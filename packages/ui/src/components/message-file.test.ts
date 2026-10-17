import { describe, expect, test } from "bun:test"
import type { FilePart } from "@redcode-ai/sdk/v2"
import { attached, inline, kind } from "./message-file"

function file(part: Partial<FilePart> = {}): FilePart {
  return {
    id: "part_1",
    sessionID: "ses_1",
    messageID: "msg_1",
    type: "file",
    mime: "text/plain",
    url: "file:///repo/README.txt",
    filename: "README.txt",
    ...part,
  }
}

describe("message-file", () => {
  test("treats data URLs and dropped local files as attachments", () => {
    expect(attached(file({ url: "data:text/plain;base64,SGVsbG8=" }))).toBe(true)
    // 261017 Red 桌面端拖进来的文件落盘为 file://、没有 source 范围，
    // 旧判定让它既不算附件也不算 inline，用户消息里看不出发过文件。
    expect(attached(file())).toBe(true)
  })

  test("treats only non-attachment source ranges as inline references", () => {
    const ref = file({
      source: {
        type: "file",
        path: "/repo/README.txt",
        text: { value: "@README.txt", start: 0, end: 11 },
      },
    })
    expect(inline(ref)).toBe(true)
    expect(attached(ref)).toBe(false)

    expect(
      inline(
        file({
          url: "data:text/plain;base64,SGVsbG8=",
          source: {
            type: "file",
            path: "/repo/README.txt",
            text: { value: "@README.txt", start: 0, end: 11 },
          },
        }),
      ),
    ).toBe(false)
  })

  test("separates image and file attachment kinds", () => {
    expect(kind(file({ mime: "image/png" }))).toBe("image")
    expect(kind(file({ mime: "application/pdf" }))).toBe("file")
  })
})
