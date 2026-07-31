#!/usr/bin/env bun
// 260731 Red 从 src-tauri/src/main.rs 生成 window.api 桥接可用的 command 契约。
//
// 为什么需要这个：`tauri-api-shim.ts` 用 `ElectronAPI` 类型守住了 **TS 那一半**
// （53 个方法漏一个编译不过），但 `invoke("store_get", { name, key })` 里的命令名和
// 参数名全是字符串字面量 —— Rust 侧改个函数名、改个参数名、忘了往
// `generate_handler![]` 里登记，编译器一句话都不会说，只会在用户点下去的那一刻
// 收到 "Command store_get not found"。这个生成器把 Rust 那一半也变成类型。
//
// 生成：bun --cwd packages/desktop run gen:tauri-commands
// 校验：bun --cwd packages/desktop run gen:tauri-commands -- --check
//       （tauri-command-contract.test.ts 也会跑同一份校验，CI 走 test 这条路）
//
// 刻意不做的事：不解析 Rust 的全部类型系统。遇到映射不了的类型直接抛错，让人来加
// 映射规则，而不是悄悄吐一个 `any` —— 一个错的类型比没有类型更糟。
import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

export const MAIN_RS = fileURLToPath(new URL("../src-tauri/src/main.rs", import.meta.url))
export const OUT_TS = fileURLToPath(new URL("../src/renderer/tauri-commands.generated.ts", import.meta.url))

// Tauri 自己注入的参数，不出现在 JS 侧的 payload 里
const INJECTED_PARAM_TYPES = new Set(["AppHandle", "State", "Window", "WebviewWindow", "Runtime"])

export interface RustField {
  rustName: string
  /** serde 序列化后的键名（受 rename / rename_all 影响） */
  jsName: string
  rustType: string
  optional: boolean
}

export interface RustStruct {
  name: string
  fields: RustField[]
}

export interface RustParam {
  /** Tauri v2 默认把 snake_case 参数名转成 camelCase 暴露给 JS */
  jsName: string
  rustType: string
}

export interface RustCommand {
  name: string
  params: RustParam[]
  /** `-> X` 里的 X，无返回值时为 "()" */
  returnType: string
  line: number
}

export interface Analysis {
  structs: Map<string, RustStruct>
  /** 源码里带 #[tauri::command] 的函数，按出现顺序 */
  defined: RustCommand[]
  /** generate_handler![] 里登记的名字，按登记顺序 */
  registered: string[]
  /** 登记了的 command，按登记顺序 */
  commands: RustCommand[]
}

// ── Rust 源码解析 ────────────────────────────────────────────────────────────

function splitTopLevel(input: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ""
  for (const ch of input) {
    if (ch === "<" || ch === "(" || ch === "[") depth++
    else if (ch === ">" || ch === ")" || ch === "]") depth--
    else if (ch === "," && depth === 0) {
      out.push(cur)
      cur = ""
      continue
    }
    cur += ch
  }
  out.push(cur)
  return out.map((s) => s.trim()).filter(Boolean)
}

function applyRenameAll(name: string, renameAll: string | undefined): string {
  if (!renameAll) return name
  if (renameAll === "camelCase") return name.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())
  throw new Error(`未支持的 serde rename_all = "${renameAll}"；需要先在 gen-tauri-commands.ts 里加规则`)
}

/** snake_case → camelCase，对应 Tauri v2 command 参数名的默认转换 */
function toCamel(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())
}

export function parseStructs(src: string): Map<string, RustStruct> {
  const structs = new Map<string, RustStruct>()
  const lines = src.split(/\r?\n/)
  let attrs: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line.startsWith("#[")) {
      attrs.push(line)
      continue
    }
    const head = /^(?:pub\s+)?struct\s+([A-Za-z_]\w*)\s*\{$/.exec(line)
    if (!head) {
      if (line !== "" && !line.startsWith("//") && !line.startsWith("///")) attrs = []
      continue
    }
    const attrText = attrs.join("\n")
    attrs = []
    // 只关心会跨边界序列化的结构体
    if (!/derive\([^)]*\b(?:Serialize|Deserialize)\b/.test(attrText)) continue

    const renameAll = /\brename_all\s*=\s*"([^"]+)"/.exec(attrText)?.[1]
    const fields: RustField[] = []
    let fieldAttrs: string[] = []

    for (i++; i < lines.length; i++) {
      const raw = lines[i].trim()
      if (raw === "}") break
      if (raw.startsWith("#[")) {
        fieldAttrs.push(raw)
        continue
      }
      if (raw === "" || raw.startsWith("//")) continue
      const field = /^(?:pub\s+)?([A-Za-z_]\w*)\s*:\s*(.+?),?$/.exec(raw)
      if (!field) {
        fieldAttrs = []
        continue
      }
      // 注意 \brename\s*= 不会命中 rename_all（后面紧跟的是 `_` 不是 `=`）
      const rename = /\brename\s*=\s*"([^"]+)"/.exec(fieldAttrs.join("\n"))?.[1]
      fieldAttrs = []
      const rustType = field[2].replace(/,$/, "").trim()
      fields.push({
        rustName: field[1],
        jsName: rename ?? applyRenameAll(field[1], renameAll),
        rustType,
        optional: rustType.startsWith("Option<"),
      })
    }
    structs.set(head[1], { name: head[1], fields })
  }
  return structs
}

export function parseCommands(src: string): RustCommand[] {
  const lines = src.split(/\r?\n/)
  const commands: RustCommand[] = []

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== "#[tauri::command]") continue

    // #[tauri::command] 和 fn 之间还可能夹别的属性
    let j = i + 1
    while (j < lines.length && lines[j].trim().startsWith("#[")) j++
    if (j >= lines.length || !/\bfn\s/.test(lines[j])) {
      throw new Error(`main.rs:${i + 1} 的 #[tauri::command] 后面没跟上函数定义`)
    }

    // 签名可能跨行：一直吃到 paren 平衡之后的第一个 `{`
    let sig = lines[j]
    let depth = countChar(sig, "(") - countChar(sig, ")")
    while ((depth > 0 || !sig.includes("{")) && j + 1 < lines.length) {
      j++
      sig += " " + lines[j].trim()
      depth += countChar(lines[j], "(") - countChar(lines[j], ")")
    }

    const m = /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)\s*\(([\s\S]*?)\)\s*(?:->\s*([^{]+?))?\s*\{/.exec(sig)
    if (!m) throw new Error(`main.rs:${j + 1} 无法解析 command 签名：${sig.trim()}`)

    const params: RustParam[] = []
    for (const param of splitTopLevel(m[2])) {
      const pm = /^(?:mut\s+)?([A-Za-z_]\w*)\s*:\s*([\s\S]+)$/.exec(param)
      if (!pm) throw new Error(`command ${m[1]} 的参数无法解析：${param}`)
      const baseType = pm[2].replace(/^&(?:mut\s+)?/, "").replace(/^tauri::/, "").split("<")[0].trim()
      if (INJECTED_PARAM_TYPES.has(baseType)) continue // Tauri 注入，不进 payload
      params.push({ jsName: toCamel(pm[1]), rustType: pm[2].trim() })
    }

    commands.push({ name: m[1], params, returnType: (m[3] ?? "()").trim(), line: j + 1 })
    i = j
  }
  return commands
}

function countChar(s: string, ch: string): number {
  let n = 0
  for (const c of s) if (c === ch) n++
  return n
}

export function parseRegistered(src: string): string[] {
  const m = /generate_handler!\s*\[([\s\S]*?)\]/.exec(src)
  if (!m) throw new Error("main.rs 里找不到 tauri::generate_handler![...]")
  return m[1]
    .split(",")
    .map((s) => s.replace(/\/\/.*$/gm, "").trim())
    .filter(Boolean)
}

// ── Rust 类型 → TS 类型 ──────────────────────────────────────────────────────

const PRIMITIVES: Record<string, string> = {
  String: "string",
  str: "string",
  bool: "boolean",
  u8: "number",
  u16: "number",
  u32: "number",
  u64: "number",
  usize: "number",
  i8: "number",
  i16: "number",
  i32: "number",
  i64: "number",
  isize: "number",
  f32: "number",
  f64: "number",
  // Rust 说「随便什么 JSON」，那 TS 侧就得如实是 unknown：调用方必须显式收窄，
  // 而不是假装它已经是某个形状。目前只有两个 picker 走这条路。
  "serde_json::Value": "unknown",
  Value: "unknown",
}

export function rustTypeToTs(rustType: string, structs: Map<string, RustStruct>, what: string): string {
  const t = rustType.replace(/^&(?:mut\s+)?/, "").trim()
  if (t === "()" || t === "") return "void"
  if (PRIMITIVES[t]) return PRIMITIVES[t]

  const generic = /^([A-Za-z_][\w:]*)\s*<([\s\S]+)>$/.exec(t)
  if (generic) {
    const outer = generic[1].replace(/^std::[\w:]*::/, "")
    const args = splitTopLevel(generic[2])
    switch (outer) {
      case "Option": {
        const inner = rustTypeToTs(args[0], structs, what)
        return inner === "void" ? "null" : `${inner} | null`
      }
      case "Result":
        // Err 走 invoke 的 reject 通道，resolve 出来的只有 Ok
        return rustTypeToTs(args[0], structs, what)
      case "Vec": {
        const inner = rustTypeToTs(args[0], structs, what)
        return inner.includes("|") ? `(${inner})[]` : `${inner}[]`
      }
      case "HashMap":
      case "BTreeMap":
        return `Record<string, ${rustTypeToTs(args[1], structs, what)}>`
      default:
        throw new Error(`${what}：未支持的泛型 Rust 类型 \`${t}\`；需要先在 gen-tauri-commands.ts 里加映射`)
    }
  }

  if (structs.has(t)) return `Rust${t}`
  throw new Error(`${what}：未支持的 Rust 类型 \`${t}\`；需要先在 gen-tauri-commands.ts 里加映射`)
}

// ── 分析 + 渲染 ──────────────────────────────────────────────────────────────

export function analyze(src: string = readFileSync(MAIN_RS, "utf8")): Analysis {
  const structs = parseStructs(src)
  const defined = parseCommands(src)
  const registered = parseRegistered(src)
  const byName = new Map(defined.map((c) => [c.name, c]))
  const commands = registered.map((name) => {
    const cmd = byName.get(name)
    if (!cmd) throw new Error(`generate_handler![] 登记了 \`${name}\`，但源码里没有对应的 #[tauri::command] 函数`)
    return cmd
  })
  return { structs, defined, registered, commands }
}

/** 只有被 command 直接或间接引用到的结构体才需要生成 */
function reachableStructs(analysis: Analysis): RustStruct[] {
  const wanted = new Set<string>()
  const visit = (rustType: string) => {
    for (const [name] of analysis.structs) {
      if (new RegExp(`\\b${name}\\b`).test(rustType)) wanted.add(name)
    }
  }
  for (const cmd of analysis.commands) {
    visit(cmd.returnType)
    for (const p of cmd.params) visit(p.rustType)
  }
  let grew = true
  while (grew) {
    grew = false
    // 快照后再遍历：visit() 会往 wanted 里加东西，不能边迭代边改
    for (const name of Array.from(wanted)) {
      for (const field of analysis.structs.get(name)!.fields) {
        const before = wanted.size
        visit(field.rustType)
        if (wanted.size !== before) grew = true
      }
    }
  }
  return [...analysis.structs.values()].filter((s) => wanted.has(s.name))
}

export function render(analysis: Analysis = analyze()): string {
  const { structs, commands } = analysis
  const out: string[] = []

  out.push("// 由 scripts/gen-tauri-commands.ts 从 src-tauri/src/main.rs 生成，请勿手改。")
  out.push("// 重新生成：bun --cwd packages/desktop run gen:tauri-commands")
  out.push("//")
  out.push("// 这份文件的作用是把「Rust 有哪些 command、参数叫什么、返回什么」变成编译期约束，")
  out.push("// 让 tauri-api-shim.ts 里那些字符串字面量不再是无人校验的运行时赌博。")
  out.push("")

  for (const struct of reachableStructs(analysis)) {
    out.push(`/** 对应 main.rs 的 \`struct ${struct.name}\` */`)
    out.push(`export interface Rust${struct.name} {`)
    for (const field of struct.fields) {
      const ts = rustTypeToTs(field.rustType, structs, `${struct.name}.${field.rustName}`)
      out.push(`  ${field.jsName}${field.optional ? "?" : ""}: ${ts}`)
    }
    out.push("}")
    out.push("")
  }

  out.push("/** 每个 command 的 invoke payload。键名 = Tauri 把 snake_case 参数转成的 camelCase。 */")
  out.push("export interface TauriCommandArgs {")
  for (const cmd of commands) {
    if (cmd.params.length === 0) {
      out.push(`  ${cmd.name}: undefined`)
      continue
    }
    const fields = cmd.params.map((p) => {
      const ts = rustTypeToTs(p.rustType, structs, `${cmd.name}(${p.jsName})`)
      // Option<T> 的参数允许整个键缺席：JSON.stringify 会丢掉 undefined 的键，
      // serde 那边收到的就是 None
      return `${p.jsName}${p.rustType.startsWith("Option<") ? "?" : ""}: ${ts}`
    })
    out.push(`  ${cmd.name}: { ${fields.join("; ")} }`)
  }
  out.push("}")
  out.push("")

  out.push("/** 每个 command resolve 出来的类型。Rust 的 Err 走 reject，不出现在这里。 */")
  out.push("export interface TauriCommandResult {")
  for (const cmd of commands) {
    out.push(`  ${cmd.name}: ${rustTypeToTs(cmd.returnType, structs, `${cmd.name}() 返回值`)}`)
  }
  out.push("}")
  out.push("")

  out.push("export type TauriCommand = keyof TauriCommandArgs")
  out.push("")
  out.push("/** generate_handler![] 里登记过、因而真正可调用的 command，按登记顺序。 */")
  out.push("export const TAURI_COMMANDS = [")
  for (const cmd of commands) out.push(`  "${cmd.name}",`)
  out.push("] as const satisfies readonly TauriCommand[]")
  out.push("")

  return out.join("\n")
}

// ── CLI ──────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const check = process.argv.includes("--check")
  const expected = render()
  if (check) {
    let actual: string
    try {
      actual = readFileSync(OUT_TS, "utf8")
    } catch {
      console.error("tauri-commands.generated.ts 不存在；跑 `bun --cwd packages/desktop run gen:tauri-commands`")
      process.exit(1)
    }
    if (actual !== expected) {
      const a = actual.split("\n")
      const e = expected.split("\n")
      const at = a.findIndex((line, i) => line !== e[i])
      console.error("tauri-commands.generated.ts 与 main.rs 不同步。")
      console.error(`首个差异在第 ${at + 1} 行：`)
      console.error(`  磁盘上： ${JSON.stringify(a[at])}`)
      console.error(`  应当是： ${JSON.stringify(e[at])}`)
      console.error("跑 `bun --cwd packages/desktop run gen:tauri-commands` 重新生成。")
      process.exit(1)
    }
    console.log(`tauri-commands.generated.ts 与 main.rs 同步（${analyze().commands.length} 个 command）`)
  } else {
    writeFileSync(OUT_TS, expected)
    console.log(`已生成 ${OUT_TS}（${analyze().commands.length} 个 command）`)
  }
}
