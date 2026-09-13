import crossSpawn from "cross-spawn"

type Options = { cwd: string; env: Record<string, string> }
type Parsed = {
  command: string
  args: string[]
  file?: string
  options: { windowsVerbatimArguments?: boolean }
}

// 260913 Red 复用已固定的 cross-spawn 7 解析（PATH、shebang、.cmd 与 npm shim 双层转义）。
// _parse 是其内部接口，调用集中在这里，版本升级必须重跑 Windows 参数往返用例。
const parse = (
  crossSpawn as typeof crossSpawn & {
    _parse: (command: string, args: string[], options: Options) => Parsed
  }
)._parse

export function windowsCommand(command: string, args: string[], options: Options) {
  if ([command, ...args, options.cwd].some((value) => value.includes("\0"))) {
    throw new Error("Windows process arguments must not contain null bytes")
  }
  const parsed = parse(command, args, options)
  if (!parsed.file) throw notFound(command)
  const executable = parsed.command === command ? parsed.file : parse(parsed.command, [], options).file
  if (!executable) throw notFound(parsed.command)
  return {
    executable,
    // 260913 Red cmd 参数已按解释器规则转义，不可再按 CRT 规则加反斜杠/引号。
    commandLine: parsed.options.windowsVerbatimArguments
      ? [quote(executable), ...parsed.args].join(" ")
      : [executable, ...parsed.args].map(quote).join(" "),
  }
}

function notFound(command: string) {
  return Object.assign(new Error(`spawn ${command} ENOENT`), {
    code: "ENOENT",
    errno: "ENOENT",
    syscall: `spawn ${command}`,
    path: command,
  })
}

export function quote(argument: string) {
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
