import { Effect, Stream } from "effect"
import os from "os"
import { createWriteStream, mkdirSync } from "node:fs"
import * as Tool from "./tool"
import path from "path"
import * as Log from "@redcode-ai/core/util/log"
import { containsPath, type InstanceContext } from "../project/instance-context"
import { InstanceState } from "@/effect/instance-state"
import { lazy } from "@/util/lazy"
import { Language, type Node } from "web-tree-sitter"

import { AppFileSystem } from "@redcode-ai/core/filesystem"
import { fileURLToPath } from "url"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Shell } from "@/shell/shell"
import { ShellID } from "./shell/id"

import * as Truncate from "./truncate"
import { Plugin } from "@/plugin"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { ShellPrompt, type Parameters } from "./shell/prompt"
import { BashArity } from "@/permission/arity"

export { Parameters } from "./shell/prompt"

const MAX_METADATA_LENGTH = 30_000
const CWD = new Set(["cd", "chdir", "popd", "pushd", "push-location", "set-location"])
const FILES = new Set([
  ...CWD,
  "rm",
  "cp",
  "mv",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "cat",
  // Leave PowerShell aliases out for now. Common ones like cat/cp/mv/rm/mkdir
  // already hit the entries above, and alias normalization should happen in one
  // place later so we do not risk double-prompting.
  "get-content",
  "set-content",
  "add-content",
  "copy-item",
  "move-item",
  "remove-item",
  "new-item",
  "rename-item",
])
const CMD_FILES = new Set([
  "copy",
  "del",
  "dir",
  "erase",
  "md",
  "mkdir",
  "move",
  "rd",
  "ren",
  "rename",
  "rmdir",
  "type",
])

// 260728 Karina FILES/CMD_FILES 回答的是"这个命令带不带路径参数"（驱动 external_directory
// 扫描），此前被直接当成"这个命令有没有破坏性"用了，于是 cd / cat / dir / type /
// get-content / set-location 这些只读和导航命令全被标成 destructive，弹的是最重的那种授权。
// 破坏性单独一张表：只收会删除、覆盖、改权限的，创建类（mkdir/new-item/touch）和
// 纯读取、纯导航都不算。
const DESTRUCTIVE = new Set([
  "rm",
  "cp",
  "mv",
  "chmod",
  "chown",
  "set-content",
  "add-content",
  "copy-item",
  "move-item",
  "remove-item",
  "rename-item",
  // cmd
  "copy",
  "del",
  "erase",
  "move",
  "rd",
  "ren",
  "rename",
  "rmdir",
  // 260731 Red 进程/系统级破坏命令。文件操作表和 git 门都管不到它们：
  // taskkill 杀进程、shutdown 关机、clear-content 清空文件（内容没了文件还在）、
  // reg delete / format / diskpart / sc delete / schtasks / vssadmin / bcdedit
  // 都是系统级改动，agent 不该静默执行。reg/sc/schtasks/vssadmin/bcdedit 有只读
  // 用法（query/list/enum），但 agent 极少用它们做只读诊断，整命令进门宁可多问。
  "taskkill",
  "stop-process",
  "shutdown",
  "stop-computer",
  "restart-computer",
  "clear-content",
  "reg",
  "format",
  "format-volume",
  "diskpart",
  "sc",
  "schtasks",
  "vssadmin",
  "bcdedit",
])
// 260730 Karina git 写操作纳入 destructive 门。上面那张表只收文件操作命令，git 一个字
// 都没有 —— 于是 `cp` 会弹授权，`git push --force`、`git reset --hard`、`git clean -fd`
// 反而静默执行。哥哥 07-30 在某项目里被自作主张 commit 了一次，就是从这个口子过去的
// （AGENTS.md 的红线写的是"不擅自 push / amend / tag"，连 commit 都没覆盖，而且那只是
// 提示词，本来也没有强制力）。
//
// 用**白名单反向判定**：只读子命令放行，其余一律进授权门。不用"危险子命令黑名单"是因为
// 黑名单漏一个就是静默执行，白名单漏一个只是多问一次 —— 今天一整天的教训都是"静默的
// 损坏最贵"。stash / remote / config / tag 故意不放进白名单：它们都有会改状态的用法，
// 按子命令一刀切分不开，宁可多问一次。
const GIT_READONLY = new Set([
  "status",
  "log",
  "diff",
  "show",
  "blame",
  "describe",
  "shortlog",
  "whatchanged",
  "rev-parse",
  "rev-list",
  "ls-files",
  "ls-remote",
  "ls-tree",
  "cat-file",
  "for-each-ref",
  "name-rev",
  "merge-base",
  "symbolic-ref",
  "count-objects",
  "check-ignore",
  "grep",
  "version",
  "help",
  "fetch",
])
// git 自己的全局开关里这几个要吃掉后面一个参数，否则会把参数当成子命令
const GIT_VALUE_FLAGS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"])
// `git branch` 裸用是列分支（agent 高频，别拦），带这些开关才是改动
const GIT_BRANCH_WRITE = new Set([
  "-d",
  "-D",
  "--delete",
  "-m",
  "-M",
  "--move",
  "-c",
  "-C",
  "--copy",
  "-f",
  "--force",
  "-u",
  "--set-upstream-to",
  "--unset-upstream",
  "--edit-description",
])

function destructiveGit(tokens: string[]): boolean {
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]
    if (GIT_VALUE_FLAGS.has(token)) {
      i++
      continue
    }
    if (token.startsWith("-")) continue
    const sub = token.toLowerCase()
    if (sub === "branch") return tokens.slice(i + 1).some((t) => GIT_BRANCH_WRITE.has(t))
    return !GIT_READONLY.has(sub)
  }
  return false // 光一个 `git`，等于打印用法
}

const FLAGS = new Set(["-destination", "-literalpath", "-path"])
const SWITCHES = new Set(["-confirm", "-debug", "-force", "-nonewline", "-recurse", "-verbose", "-whatif"])

type Part = {
  type: string
  text: string
}

type Scan = {
  dirs: Set<string>
  patterns: Set<string>
  always: Set<string>
  destructive: boolean
}

type Chunk = {
  text: string
  size: number
}

export const log = Log.create({ service: "shell-tool" })

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

function parts(node: Node) {
  const out: Part[] = []
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    if (child.type === "command_elements") {
      for (let j = 0; j < child.childCount; j++) {
        const item = child.child(j)
        if (!item || item.type === "command_argument_sep" || item.type === "redirection") continue
        out.push({ type: item.type, text: item.text })
      }
      continue
    }
    if (
      child.type !== "command_name" &&
      child.type !== "command_name_expr" &&
      child.type !== "word" &&
      child.type !== "string" &&
      child.type !== "raw_string" &&
      child.type !== "concatenation"
    ) {
      continue
    }
    out.push({ type: child.type, text: child.text })
  }
  return out
}

function source(node: Node) {
  return (node.parent?.type === "redirected_statement" ? node.parent.text : node.text).trim()
}

function commands(node: Node) {
  return node.descendantsOfType("command").filter((child): child is Node => Boolean(child))
}

function unquote(text: string) {
  if (text.length < 2) return text
  const first = text[0]
  const last = text[text.length - 1]
  if ((first === '"' || first === "'") && first === last) return text.slice(1, -1)
  return text
}

function home(text: string) {
  if (text === "~") return os.homedir()
  if (text.startsWith("~/") || text.startsWith("~\\")) return path.join(os.homedir(), text.slice(2))
  return text
}

function envValue(key: string) {
  if (process.platform !== "win32") return process.env[key]
  const name = Object.keys(process.env).find((item) => item.toLowerCase() === key.toLowerCase())
  return name ? process.env[name] : undefined
}

function auto(key: string, cwd: string, shell: string) {
  const name = key.toUpperCase()
  if (name === "HOME") return os.homedir()
  if (name === "PWD") return cwd
  if (name === "PSHOME") return path.dirname(shell)
}

function expand(text: string, cwd: string, shell: string) {
  const out = unquote(text)
    .replace(/\$\{env:([^}]+)\}/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$(HOME|PWD|PSHOME)(?=$|[\\/])/gi, (_, key: string) => auto(key, cwd, shell) || "")
  return home(out)
}

function provider(text: string) {
  const match = text.match(/^([A-Za-z]+)::(.*)$/)
  if (match) {
    if (match[1].toLowerCase() !== "filesystem") return
    return match[2]
  }
  const prefix = text.match(/^([A-Za-z]+):(.*)$/)
  if (!prefix) return text
  if (prefix[1].length === 1) return text
  return
}

function dynamic(text: string, ps: boolean) {
  if (text.startsWith("(") || text.startsWith("@(")) return true
  if (text.includes("$(") || text.includes("${") || text.includes("`")) return true
  if (ps) return /\$(?!env:)/i.test(text)
  return text.includes("$")
}

function prefix(text: string) {
  const match = /[?*[]/.exec(text)
  if (!match) return text
  if (match.index === 0) return
  return text.slice(0, match.index)
}

function pathArgs(list: Part[], ps: boolean, cmd = false) {
  if (!ps) {
    return list
      .slice(1)
      .filter(
        (item) =>
          !item.text.startsWith("-") &&
          !(cmd && item.text.startsWith("/")) &&
          !(list[0]?.text === "chmod" && item.text.startsWith("+")),
      )
      .map((item) => item.text)
  }

  const out: string[] = []
  let want = false
  for (const item of list.slice(1)) {
    if (want) {
      out.push(item.text)
      want = false
      continue
    }
    if (item.type === "command_parameter") {
      const flag = item.text.toLowerCase()
      if (SWITCHES.has(flag)) continue
      want = FLAGS.has(flag)
      continue
    }
    out.push(item.text)
  }
  return out
}

function preview(text: string) {
  if (text.length <= MAX_METADATA_LENGTH) return text
  return "...\n\n" + text.slice(-MAX_METADATA_LENGTH)
}

function tail(text: string, maxLines: number, maxBytes: number) {
  const lines = text.split("\n")
  if (lines.length <= maxLines && Buffer.byteLength(text, "utf-8") <= maxBytes) {
    return {
      text,
      cut: false,
    }
  }

  const out: string[] = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) {
      if (out.length === 0) {
        const buf = Buffer.from(lines[i], "utf-8")
        let start = buf.length - maxBytes
        if (start < 0) start = 0
        while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
        out.unshift(buf.subarray(start).toString("utf-8"))
      }
      break
    }
    out.unshift(lines[i])
    bytes += size
  }
  return {
    text: out.join("\n"),
    cut: true,
  }
}

const parse = Effect.fn("ShellTool.parse")(function* (command: string, ps: boolean) {
  const tree = yield* Effect.promise(() => parser().then((p) => (ps ? p.ps : p.bash).parse(command)))
  if (!tree) throw new Error("Failed to parse command")
  return tree
})

const ask = Effect.fn("ShellTool.ask")(function* (ctx: Tool.Context, scan: Scan) {
  if (scan.dirs.size > 0) {
    const globs = Array.from(scan.dirs).map((dir) => {
      if (process.platform === "win32") return AppFileSystem.normalizePathPattern(path.join(dir, "*"))
      return path.join(dir, "*")
    })
    yield* ctx.ask({
      permission: "external_directory",
      patterns: globs,
      always: globs,
      metadata: {},
    })
  }

  if (scan.patterns.size === 0) return
  yield* ctx.ask({
    permission: scan.destructive ? "destructive" : ShellID.ToolID,
    patterns: Array.from(scan.patterns),
    always: Array.from(scan.always),
    metadata: {},
  })
})

// 260728 Karina 输出按 UTF-8 解（shell.ts 里 Stream.decodeText 默认就是 UTF-8），但
// Windows PowerShell 5.1 默认按系统 ANSI 代码页写 stdout/stderr —— 中文 Windows 上是
// GBK(936)。结果任何带中文的输出、以及 PowerShell 自己的报错信息，到工具输出里全是乱码，
// 模型读到的就是 "����λ�� ��:1 �ַ�"。发现于 shell abort 测试的报错内容。
// clipboard.ts:129 早就单独这么干过一次，这里补上通用的：进命令前先把控制台输出编码
// 和 $OutputEncoding 都置成 UTF-8。$OutputEncoding 管的是管道传给下游原生程序的编码。
const PS_UTF8 =
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [Console]::OutputEncoding; "

// 260730 Karina 上面那行只管输出，读侧还漏着：Get-Content 在 Windows PowerShell 5.1
// 里默认按系统 ANSI 代码页解码（中文 Windows = GBK 936），读一个 UTF-8 中文文件进来
// 就已经是乱码了 —— "中文测试" 读成 "涓枃娴嬭瘯"。之后不管怎么写回都是在写乱码，
// 写入侧的 detectGarbled 护栏也拦不住（PUA/FFFD 占比不够）。07-30 dossier 的
// index.html 就是这么被 Get-Content + WriteAllLines 毁掉的。
//
// 只改读侧：5.1 里给写侧 cmdlet 指定 utf8 会强制写出 BOM，代价大于收益；写文件本来就
// 该走 write/edit 工具（shell/prompt.ts 已经这么要求）。显式带了 -Encoding 的命令不受
// 影响（PSDefaultParameterValues 只在参数缺省时生效），Env:/Function: 等非文件系统
// provider 实测也不报错。PS 7+ 本来就是 UTF-8，这几行是无害的空操作。
const PS_READ_UTF8 = [
  "$PSDefaultParameterValues['Get-Content:Encoding']='utf8'",
  "$PSDefaultParameterValues['Import-Csv:Encoding']='utf8'",
  "$PSDefaultParameterValues['Select-String:Encoding']='utf8'",
  "",
].join("; ")

function cmd(shell: string, command: string, cwd: string, env: NodeJS.ProcessEnv) {
  if (process.platform === "win32" && Shell.ps(shell)) {
    return ChildProcess.make(
      shell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", PS_UTF8 + PS_READ_UTF8 + command],
      {
        cwd,
        env,
        stdin: "ignore",
        detached: false,
      },
    )
  }

  return ChildProcess.make(command, [], {
    shell,
    cwd,
    env,
    stdin: "ignore",
    detached: process.platform !== "win32",
  })
}
const parser = lazy(async () => {
  const { Parser } = await import("web-tree-sitter")
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  const treePath = resolveWasm(treeWasm)
  await Parser.init({
    locateFile() {
      return treePath
    },
  })
  const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
    with: { type: "wasm" },
  })
  const { default: psWasm } = await import("tree-sitter-powershell/tree-sitter-powershell.wasm" as string, {
    with: { type: "wasm" },
  })
  const bashPath = resolveWasm(bashWasm)
  const psPath = resolveWasm(psWasm)
  const [bashLanguage, psLanguage] = await Promise.all([Language.load(bashPath), Language.load(psPath)])
  const bash = new Parser()
  bash.setLanguage(bashLanguage)
  const ps = new Parser()
  ps.setLanguage(psLanguage)
  return { bash, ps }
})

export const ShellTool = Tool.define(
  ShellID.ToolID,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const spawner = yield* ChildProcessSpawner
    const fs = yield* AppFileSystem.Service
    const trunc = yield* Truncate.Service
    const plugin = yield* Plugin.Service
    const flags = yield* RuntimeFlags.Service
    const defaultTimeout = flags.bashDefaultTimeoutMs ?? 2 * 60 * 1000
    const maxTimeout = flags.bashMaxTimeoutMs ?? 10 * 60 * 1000

    const cygpath = Effect.fn("ShellTool.cygpath")(function* (shell: string, text: string) {
      const lines = yield* spawner
        .lines(ChildProcess.make(shell, ["-lc", 'cygpath -w -- "$1"', "_", text]))
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      const file = lines[0]?.trim()
      if (!file) return
      return AppFileSystem.normalizePath(file)
    })

    const resolvePath = Effect.fn("ShellTool.resolvePath")(function* (text: string, root: string, shell: string) {
      if (process.platform === "win32") {
        if (Shell.posix(shell) && text.startsWith("/") && AppFileSystem.windowsPath(text) === text) {
          const file = yield* cygpath(shell, text)
          if (file) return file
        }
        return AppFileSystem.normalizePath(path.resolve(root, AppFileSystem.windowsPath(text)))
      }
      return path.resolve(root, text)
    })

    const argPath = Effect.fn("ShellTool.argPath")(function* (arg: string, cwd: string, ps: boolean, shell: string) {
      const text = ps ? expand(arg, cwd, shell) : home(unquote(arg))
      const file = text && prefix(text)
      if (!file || dynamic(file, ps)) return
      const next = ps ? provider(file) : file
      if (!next) return
      return yield* resolvePath(next, cwd, shell)
    })

    const collect = Effect.fn("ShellTool.collect")(function* (
      root: Node,
      cwd: string,
      ps: boolean,
      shell: string,
      instance: InstanceContext,
    ) {
      const scan: Scan = {
        dirs: new Set<string>(),
        patterns: new Set<string>(),
        always: new Set<string>(),
        destructive: false,
      }
      const shellKind = ShellID.toKind(Shell.name(shell))
      let seen = 0

      for (const node of commands(root)) {
        seen++
        const command = parts(node)
        const tokens = command.map((item) => item.text)
        const cmd = ps || shellKind === "cmd" ? tokens[0]?.toLowerCase() : tokens[0]

        // git 不在 FILES 里，单独判：写操作走 destructive 门，只读子命令照常放行
        if (cmd === "git" && destructiveGit(tokens)) scan.destructive = true

        // 260731 Red destructive 判定独立于 FILES：文件命令之外还有进程/系统级命令
        // （taskkill/shutdown/reg 等）也要进授权门，不能只挂在 FILES 分支里。
        if (cmd && DESTRUCTIVE.has(cmd)) scan.destructive = true

        if (cmd && (FILES.has(cmd) || (shellKind === "cmd" && CMD_FILES.has(cmd)))) {
          for (const arg of pathArgs(command, ps, shellKind === "cmd")) {
            const resolved = yield* argPath(arg, cwd, ps, shell)
            log.info("resolved path", { arg, resolved })
            if (!resolved || containsPath(resolved, instance)) continue
            const dir = (yield* fs.isDir(resolved)) ? resolved : path.dirname(resolved)
            scan.dirs.add(dir)
          }
        }

        if (tokens.length && (!cmd || !CWD.has(cmd))) {
          scan.patterns.add(source(node))
          scan.always.add(BashArity.prefix(tokens).join(" ") + " *")
        }
      }

      // 260730 Karina 一个命令都解析不出来时不能静默放行。ask() 里 `patterns.size === 0`
      // 就直接 return，本意是给 cd 这类纯导航命令留口子（它们被 CWD 拦在 patterns 之外），
      // 但 tree-sitter 解析失败时 patterns 同样是空的 —— 于是**任何解析不了的写法都绕过了
      // 整个授权门**。实测 PowerShell 下 `git checkout -- .` 就解析不出命令节点，一路直接执行。
      // 解析不出来 = 不知道它要干什么，那就更该问。回退成拿整条原始命令去要授权。
      if (seen === 0) {
        const raw = source(root).trim()
        if (raw) {
          scan.patterns.add(raw)
          scan.always.add(raw)
          // 结构解析不出来，至少按空白切一遍跑同样的破坏性判定 —— 否则 `git checkout -- .`
          // 这种真该拦的命令，会因为"解析失败"反而降级成最轻的授权。
          const tokens = raw.split(/\s+/)
          const first = ps || shellKind === "cmd" ? tokens[0]?.toLowerCase() : tokens[0]
          if (first === "git" && destructiveGit(tokens)) scan.destructive = true
          if (first && DESTRUCTIVE.has(first)) scan.destructive = true
        }
      }

      return scan
    })

    const shellEnv = Effect.fn("ShellTool.shellEnv")(function* (ctx: Tool.Context, cwd: string) {
      const extra = yield* plugin.trigger(
        "shell.env",
        { cwd, sessionID: ctx.sessionID, callID: ctx.callID },
        { env: {} },
      )
      return {
        ...process.env,
        ...extra.env,
      }
    })

    const run = Effect.fn("ShellTool.run")(function* (
      input: {
        shell: string
        command: string
        cwd: string
        env: NodeJS.ProcessEnv
        timeout: number
        description: string
      },
      ctx: Tool.Context,
    ) {
      const limits = yield* trunc.limits()
      const keep = limits.maxBytes * 2
      let full = ""
      let last = ""
      const list: Chunk[] = []
      let used = 0
      let file = ""
      let sink: ReturnType<typeof createWriteStream> | undefined
      let cut = false
      let expired = false
      let aborted = false

      const closeSink = Effect.fnUntraced(function* () {
        const stream = sink
        if (!stream) return
        sink = undefined
        if (stream.destroyed || stream.closed) return
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              let settled = false
              const done = () => {
                if (settled) return
                settled = true
                stream.off("close", done)
                stream.off("error", done)
                stream.off("finish", done)
                resolve()
              }
              stream.once("close", done)
              stream.once("error", done)
              stream.once("finish", done)
              stream.end(done)
            }),
        ).pipe(Effect.catch(() => Effect.void))
      })

      yield* ctx.metadata({
        metadata: {
          output: "",
          description: input.description,
        },
      })

      const code: number | null = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(closeSink)
          const handle = yield* spawner.spawn(cmd(input.shell, input.command, input.cwd, input.env))

          yield* Effect.forkScoped(
            Stream.runForEach(Stream.decodeText(handle.all), (chunk) => {
              const size = Buffer.byteLength(chunk, "utf-8")
              list.push({ text: chunk, size })
              used += size
              while (used > keep && list.length > 1) {
                const item = list.shift()
                if (!item) break
                used -= item.size
                cut = true
              }

              last = preview(last + chunk)

              if (file) {
                sink?.write(chunk)
              } else {
                full += chunk
                if (Buffer.byteLength(full, "utf-8") > limits.maxBytes) {
                  return trunc.write(full).pipe(
                    Effect.andThen((next) =>
                      Effect.sync(() => {
                        file = next
                        cut = true
                        sink = createWriteStream(next, { flags: "a" })
                        full = ""
                      }),
                    ),
                    Effect.andThen(
                      ctx.metadata({
                        metadata: {
                          output: last,
                          description: input.description,
                        },
                      }),
                    ),
                  )
                }
              }

              return ctx.metadata({
                metadata: {
                  output: last,
                  description: input.description,
                },
              })
            }),
          )

          const abort = Effect.callback<void>((resume) => {
            if (ctx.abort.aborted) return resume(Effect.void)
            const handler = () => resume(Effect.void)
            ctx.abort.addEventListener("abort", handler, { once: true })
            return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
          })

          const timeout = Effect.sleep(`${input.timeout + 100} millis`)

          const exit = yield* Effect.raceAll([
            handle.exitCode.pipe(Effect.map((code) => ({ kind: "exit" as const, code }))),
            abort.pipe(Effect.map(() => ({ kind: "abort" as const, code: null }))),
            timeout.pipe(Effect.map(() => ({ kind: "timeout" as const, code: null }))),
          ])

          if (exit.kind === "abort") {
            aborted = true
            yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
          }
          if (exit.kind === "timeout") {
            expired = true
            yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
          }

          return exit.kind === "exit" ? exit.code : null
        }),
      ).pipe(Effect.orDie)

      const meta: string[] = []
      if (expired) {
        meta.push(
          `shell tool terminated command after exceeding timeout ${input.timeout} ms. If this command is expected to take longer and is not waiting for interactive input, retry with a larger timeout value in milliseconds.`,
        )
      }
      if (aborted) meta.push("User aborted the command")
      const raw = list.map((item) => item.text).join("")
      const end = tail(raw, limits.maxLines, limits.maxBytes)
      if (end.cut) cut = true
      if (!file && end.cut) {
        file = yield* trunc.write(raw)
      }

      let output = end.text
      if (!output) output = "(no output)"

      if (cut && file) {
        output = `...output truncated...\n\nFull output saved to: ${file}\n\n` + output
      }

      if (meta.length > 0) {
        output += "\n\n<shell_metadata>\n" + meta.join("\n") + "\n</shell_metadata>"
      }
      return {
        title: input.description,
        metadata: {
          output: last || preview(output),
          exit: code,
          description: input.description,
          truncated: cut,
          ...(cut && file ? { outputPath: file } : {}),
        },
        output,
      }
    })

    return () =>
      Effect.gen(function* () {
        const cfg = yield* config.get()
        const shell = Shell.acceptable(cfg.shell)
        const name = Shell.name(shell)
        const limits = yield* trunc.limits()
        // 260803 Red workspace temp: point ${tmp} at the workspace's own
        // .redcode/temp instead of the global C-drive temp dir
        const instanceCtx = yield* InstanceState.context
        const tmpDir = path.join(instanceCtx.directory, ".redcode", "temp")
        mkdirSync(tmpDir, { recursive: true })
        const prompt = ShellPrompt.render(name, process.platform, limits, tmpDir)
        log.info("shell tool using shell", { shell })

        return {
          description: prompt.description,
          parameters: prompt.parameters,
          execute: (params: Parameters, ctx: Tool.Context) =>
            Effect.gen(function* () {
              const instanceCtx = yield* InstanceState.context
              const cwd = params.workdir
                ? yield* resolvePath(params.workdir, instanceCtx.directory, shell)
                : instanceCtx.directory
              if (params.timeout !== undefined && params.timeout < 0) {
                throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
              }
              const timeout = Math.min(params.timeout ?? defaultTimeout, maxTimeout)
              const ps = Shell.ps(shell)
              yield* Effect.scoped(
                Effect.gen(function* () {
                  const tree = yield* Effect.acquireRelease(parse(params.command, ps), (tree) =>
                    Effect.sync(() => tree.delete()),
                  )
                  const scan = yield* collect(tree.rootNode, cwd, ps, shell, instanceCtx)
                  if (!containsPath(cwd, instanceCtx)) scan.dirs.add(cwd)
                  yield* ask(ctx, scan)
                }),
              )

              return yield* run(
                {
                  shell,
                  command: params.command,
                  cwd,
                  env: yield* shellEnv(ctx, cwd),
                  timeout,
                  description: params.description,
                },
                ctx,
              )
            }),
        }
      })
  }),
)
