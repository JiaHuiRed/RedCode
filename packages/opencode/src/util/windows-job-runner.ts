import { dlopen } from "bun:ffi"

const RUNNER_ENV = "REDCODE_WINDOWS_JOB_RUNNER"
const STARTF_USESTDHANDLES = 0x100
const HANDLE_FLAG_INHERIT = 1
const CREATE_SUSPENDED = 4
const CREATE_UNICODE_ENVIRONMENT = 0x400
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
const JobObjectExtendedLimitInformation = 9
const JobObjectBasicAccountingInformation = 1
const WAIT_TIMEOUT = 258
const STILL_ACTIVE = 259
const INVALID_HANDLE_VALUE = -1
const INVALID_FILE_DESCRIPTOR = -2
const WINDOWS_SPAWN_ERROR_CODES: Record<number, string> = {
  2: "ENOENT",
  3: "ENOENT",
  5: "EACCES",
  32: "EACCES",
  126: "ENOENT",
  193: "ENOEXEC",
  267: "ENOENT",
  740: "EACCES",
}

type Start = {
  type: "start"
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
}

type Result =
  | { type: "ready" }
  | { type: "exit"; code: number }
  | {
      type: "error"
      error: { name: string; message: string; code?: string; errno?: string | number; syscall?: string; path?: string }
    }

function wide(value: string) {
  return Buffer.from(value + "\0", "utf16le")
}

function quote(argument: string) {
  if (argument === "") return '""'
  if (!/[\s"]/u.test(argument)) return argument
  let result = '"'
  for (let index = 0; index < argument.length; index++) {
    let slashes = 0
    while (index < argument.length && argument[index] === "\\") {
      slashes += 1
      index += 1
    }
    if (index === argument.length) result += "\\".repeat(slashes * 2)
    else if (argument[index] === '"') result += "\\".repeat(slashes * 2 + 1) + '"'
    else result += "\\".repeat(slashes) + argument[index]
  }
  return result + '"'
}

function environment(env: Record<string, string>) {
  return Buffer.from(
    `${Object.entries(env)
      .sort(([left], [right]) => left.toUpperCase().localeCompare(right.toUpperCase()))
      .map(([key, value]) => `${key}=${value}`)
      .join("\0")}\0\0`,
    "utf16le",
  )
}

function error(reason: unknown) {
  if (reason instanceof Error) {
    const detail = reason as Error & { code?: string; errno?: string | number; syscall?: string; path?: string }
    return {
      name: reason.name,
      message: reason.message,
      ...(detail.code === undefined ? {} : { code: detail.code }),
      ...(detail.errno === undefined ? {} : { errno: detail.errno }),
      ...(detail.syscall === undefined ? {} : { syscall: detail.syscall }),
      ...(detail.path === undefined ? {} : { path: detail.path }),
    }
  }
  return { name: "Error", message: String(reason) }
}

function spawnError(command: string, win32Code: number) {
  const code = WINDOWS_SPAWN_ERROR_CODES[win32Code] ?? "UNKNOWN"
  return Object.assign(new Error(`spawn ${command} ${code}`), {
    code,
    errno: code,
    syscall: `spawn ${command}`,
    path: command,
  })
}

function startMessage(value: unknown): value is Start {
  if (!value || typeof value !== "object") return false
  if (!("type" in value) || value.type !== "start") return false
  return (
    "command" in value &&
    typeof value.command === "string" &&
    "args" in value &&
    Array.isArray(value.args) &&
    value.args.every((item) => typeof item === "string") &&
    "cwd" in value &&
    typeof value.cwd === "string" &&
    "env" in value &&
    typeof value.env === "object" &&
    value.env !== null &&
    Object.values(value.env).every((item) => typeof item === "string")
  )
}

function native() {
  const kernel32 = dlopen("kernel32.dll", {
    AssignProcessToJobObject: { args: ["ptr", "ptr"], returns: "i32" },
    CloseHandle: { args: ["ptr"], returns: "i32" },
    CreateJobObjectW: { args: ["ptr", "ptr"], returns: "ptr" },
    CreateProcessW: { args: ["ptr", "ptr", "ptr", "ptr", "i32", "u32", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
    GetExitCodeProcess: { args: ["ptr", "ptr"], returns: "i32" },
    GetLastError: { args: [], returns: "u32" },
    QueryInformationJobObject: { args: ["ptr", "i32", "ptr", "u32", "ptr"], returns: "i32" },
    ResumeThread: { args: ["ptr"], returns: "u32" },
    SetHandleInformation: { args: ["ptr", "u32", "u32"], returns: "i32" },
    SetInformationJobObject: { args: ["ptr", "i32", "ptr", "u32"], returns: "i32" },
    TerminateJobObject: { args: ["ptr", "u32"], returns: "i32" },
    WaitForSingleObject: { args: ["ptr", "u32"], returns: "u32" },
  })
  const current = dlopen(process.execPath, {
    uv_get_osfhandle: { args: ["i32"], returns: "ptr" },
  })
  return {
    assignProcessToJobObject: kernel32.symbols.AssignProcessToJobObject,
    closeHandle: kernel32.symbols.CloseHandle,
    createJobObjectW: kernel32.symbols.CreateJobObjectW,
    createProcessW: kernel32.symbols.CreateProcessW,
    getExitCodeProcess: kernel32.symbols.GetExitCodeProcess,
    getLastError: kernel32.symbols.GetLastError,
    queryInformationJobObject: kernel32.symbols.QueryInformationJobObject,
    resumeThread: kernel32.symbols.ResumeThread,
    setHandleInformation: kernel32.symbols.SetHandleInformation,
    setInformationJobObject: kernel32.symbols.SetInformationJobObject,
    terminateJobObject: kernel32.symbols.TerminateJobObject,
    uvGetOsfhandle: current.symbols.uv_get_osfhandle,
    waitForSingleObject: kernel32.symbols.WaitForSingleObject,
  }
}

type API = ReturnType<typeof native>
type Handle = NonNullable<ReturnType<API["createJobObjectW"]>>

export async function run() {
  if (process.platform !== "win32" || process.env[RUNNER_ENV] !== "1") return
  delete process.env[RUNNER_ENV]
  const api = native()
  let job: Handle | undefined
  let target: Handle | undefined
  let poll: ReturnType<typeof setInterval> | undefined
  let ready: ReturnType<typeof setInterval> | undefined
  let delivered = false
  let finished = false
  let terminateRequested = false
  const completion = Promise.withResolvers<void>()

  const finish = (code: number) => {
    if (finished) return
    finished = true
    if (poll) clearInterval(poll)
    if (ready) clearInterval(ready)
    if (target !== undefined) api.closeHandle(target)
    if (job !== undefined) api.closeHandle(job)
    process.exitCode = code
    if (process.connected) process.disconnect()
    completion.resolve()
  }
  const send = (result: Result) =>
    new Promise<boolean>((resolve) => {
      if (!process.connected || process.send === undefined) {
        resolve(false)
        return
      }
      process.send(result, (failure) => resolve(failure === null))
    })
  const fail = async (reason: unknown) => {
    if (finished) return
    if (job !== undefined) api.terminateJobObject(job, 1)
    await send({ type: "error", error: error(reason) })
    finish(127)
  }
  const pollExit = () => {
    if (finished || job === undefined) return
    try {
      const wait = target === undefined ? -1 : api.waitForSingleObject(target, 0)
      let exitCode: number | undefined
      if (target !== undefined) {
        const output = Buffer.alloc(4)
        if (api.getExitCodeProcess(target, output) === 0) {
          throw new Error(`GetExitCodeProcess failed (${api.getLastError()})`)
        }
        exitCode = output.readUInt32LE()
      }
      const accounting = Buffer.alloc(48)
      if (
        api.queryInformationJobObject(job, JobObjectBasicAccountingInformation, accounting, accounting.length, null) ===
        0
      ) {
        throw new Error(`QueryInformationJobObject failed (${api.getLastError()})`)
      }
      if (target !== undefined && (wait !== WAIT_TIMEOUT || exitCode !== STILL_ACTIVE)) {
        const code = exitCode ?? 1
        api.closeHandle(target)
        target = undefined
        void send({ type: "exit", code }).then((ok) => {
          delivered = ok
          if (!ok) finish(127)
          if (job === undefined && ok) finish(0)
        })
      }
      if (accounting.readUInt32LE(40) !== 0) return
      api.closeHandle(job)
      job = undefined
      if (delivered) finish(0)
    } catch (reason) {
      void fail(reason)
    }
  }
  process.once("disconnect", () => finish(127))
  process.on("message", (value: unknown) => {
    if (value && typeof value === "object" && "type" in value && value.type === "terminate") {
      terminateRequested = true
      if (job === undefined) return
      const terminated = api.terminateJobObject(job, 1)
      if (terminated === 0) {
        void fail(new Error(`TerminateJobObject failed (${api.getLastError()})`))
        return
      }
      return
    }
    if (!startMessage(value) || job !== undefined) {
      void fail(new Error("Invalid Windows Job runner request"))
      return
    }
    if (ready) clearInterval(ready)
    try {
      const createdJob = api.createJobObjectW(null, null)
      if (!createdJob) throw new Error(`CreateJobObjectW failed (${api.getLastError()})`)
      job = createdJob
      const limits = Buffer.alloc(144)
      limits.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, 16)
      if (api.setInformationJobObject(job, JobObjectExtendedLimitInformation, limits, limits.length) === 0) {
        throw new Error(`SetInformationJobObject failed (${api.getLastError()})`)
      }
      const carriers = [0, 1, 2].map((fd) => api.uvGetOsfhandle(fd))
      if (
        carriers.some(
          (handle) =>
            handle === null || handle === 0 || handle === INVALID_HANDLE_VALUE || handle === INVALID_FILE_DESCRIPTOR,
        )
      ) {
        throw new Error("Windows Job runner received an invalid stdio handle")
      }
      const handles = carriers as [Handle, Handle, Handle]
      for (const handle of handles) {
        if (api.setHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) === 0) {
          throw new Error(`SetHandleInformation failed (${api.getLastError()})`)
        }
      }
      const startup = Buffer.alloc(104)
      startup.writeUInt32LE(startup.length, 0)
      startup.writeUInt32LE(STARTF_USESTDHANDLES, 60)
      handles.forEach((handle, index) => startup.writeBigUInt64LE(BigInt(handle as unknown as number), 80 + index * 8))
      const information = Buffer.alloc(24)
      try {
        const created = api.createProcessW(
          // 260908 Red: 留空 lpApplicationName，让 Windows 按命令行执行 PATH 搜索。
          // 决策记录：docs/notes/implemented/bug-fix/2026-09-08-windows-job-path-resolution.md
          null,
          wide([value.command, ...value.args].map(quote).join(" ")),
          null,
          null,
          1,
          CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
          environment(value.env),
          wide(value.cwd),
          startup,
          information,
        )
        if (created === 0) throw spawnError(value.command, api.getLastError())
        target = Number(information.readBigUInt64LE(0)) as unknown as Handle
        const thread = Number(information.readBigUInt64LE(8)) as unknown as Handle
        if (api.assignProcessToJobObject(job, target) === 0)
          throw new Error(`AssignProcessToJobObject failed (${api.getLastError()})`)
        if (api.resumeThread(thread) === 0xffffffff) throw new Error(`ResumeThread failed (${api.getLastError()})`)
        api.closeHandle(thread)
      } finally {
        for (const handle of handles) api.setHandleInformation(handle, HANDLE_FLAG_INHERIT, 0)
      }
      poll = setInterval(pollExit, 10)
      pollExit()
      if (terminateRequested && api.terminateJobObject(job, 1) === 0) {
        void fail(new Error(`TerminateJobObject failed (${api.getLastError()})`))
      }
    } catch (reason) {
      void fail(reason)
    }
  })
  ready = setInterval(() => void send({ type: "ready" }), 10)
  if (!(await send({ type: "ready" }))) finish(127)
  await completion.promise
}

if (process.env[RUNNER_ENV] === "1") await run()
