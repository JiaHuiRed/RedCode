import { describe, expect, test } from "bun:test"
import {
  JOB_STATUS,
  jobDetail,
  jobOpenTarget,
  ptyCommandLine,
  ptyOutputNotice,
  ptySourceNote,
  ptyStatusNote,
  PTY_STATUS,
  type BackgroundJob,
  type BackgroundPty,
} from "../../../../src/cli/cmd/tui/component/background-detail"

// 261116 Red A01/A02：后台面板的打开目标与终端详情判定。
// 这里只钉「按真实登记字段说话」：任务只能按服务端给的 sessionID 打开，终端只展示
// 真实 command/args/cwd 与状态，缺失来源如实写未知。
const job = (input: Partial<BackgroundJob> = {}): BackgroundJob => ({
  id: "job_01",
  type: "task",
  status: "running",
  startedAt: 0,
  ...input,
})

describe("jobOpenTarget", () => {
  test("opens the registered session for every status once it still exists", () => {
    for (const status of ["running", "completed", "error", "cancelled"] as const) {
      expect(jobOpenTarget(job({ status, sessionID: "ses_child" }))).toEqual({
        kind: "session",
        sessionID: "ses_child",
      })
    }
  })

  test("never derives a session id from the job id", () => {
    expect(jobOpenTarget(job({ id: "job_01" }))).toEqual({ kind: "missing" })
  })
})

describe("jobDetail", () => {
  test("marks jobs without a registered session as not directly openable", () => {
    expect(jobDetail(job({ title: "Explore", startedAt: 0, completedAt: 1500 }), 5000)).toContain(
      "无关联会话（无法直接打开）",
    )
    expect(jobDetail(job({ status: "completed", sessionID: "ses_child", startedAt: 0, completedAt: 1500 }), 5000)).toBe(
      `task · ${JOB_STATUS.completed} · 1.5s`,
    )
  })

  test("keeps the recorded error text when present", () => {
    expect(jobDetail(job({ status: "error", error: "boom", startedAt: 0, completedAt: 100 }), 200)).toContain("boom")
  })
})

describe("terminal detail", () => {
  const pty = (input: Partial<BackgroundPty> = {}): BackgroundPty => ({
    id: "pty_01",
    title: "Terminal 1",
    command: "bash",
    args: ["-l"],
    cwd: "E:\\work",
    status: "running",
    pid: 42,
    ...input,
  })

  test("shows the real command, args and cwd instead of guessing the inner command", () => {
    expect(ptyCommandLine(pty())).toBe("bash -l")
    expect(ptyCommandLine(pty({ args: [] }))).toBe("bash")
    expect(ptyStatusNote("running")).toContain("不会向进程发送输入")
  })

  test("explains exited and orphaned terminals differently", () => {
    expect(PTY_STATUS.orphaned).toBe("上次未正常结束")
    expect(ptyStatusNote("orphaned")).toContain("输出缓冲")
    expect(ptyStatusNote("exited")).toContain("已结束")
  })

  test("writes unknown provenance instead of inventing an owner", () => {
    expect(ptySourceNote()).toContain("未知")
    expect(ptySourceNote()).toContain("不按 PID 反推归属")
    expect(ptySourceNote({ sessionID: "ses_parent", title: "Dev server" })).toContain("ses_parent")
  })
})

describe("ptyOutputNotice", () => {
  test("states truncation and the cursor window", () => {
    expect(ptyOutputNotice({ truncated: true, shownChars: 20000, startCursor: 10, endCursor: 900 })).toContain(
      "已截断",
    )
    expect(ptyOutputNotice({ truncated: false, shownChars: 120, startCursor: 0, endCursor: 120 })).toContain(
      "游标 0–120",
    )
  })
})

// 组件本体不在这里渲染（缺少 Provider 树），但模块图必须能加载：JSX/import 的语法与
// 导出名错误会在 import 时立刻暴露，比等 typecheck 才拦便宜。
test("background dialogs load", async () => {
  const background = await import("../../../../src/cli/cmd/tui/component/dialog-background")
  const output = await import("../../../../src/cli/cmd/tui/component/dialog-pty-output")
  const steer = await import("../../../../src/cli/cmd/tui/component/dialog-subagent-steer")
  expect(typeof background.DialogBackground).toBe("function")
  expect(typeof output.DialogPtyOutput).toBe("function")
  expect(typeof steer.DialogSubagentSteer).toBe("function")
})

test("message action dialogs load", async () => {
  const message = await import("../../../../src/cli/cmd/tui/routes/session/dialog-message")
  const timeline = await import("../../../../src/cli/cmd/tui/routes/session/dialog-timeline")
  expect(typeof message.DialogMessage).toBe("function")
  expect(typeof timeline.DialogTimeline).toBe("function")
})
