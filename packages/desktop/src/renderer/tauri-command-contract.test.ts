// 260731 Red Rust ↔ 渲染进程之间的边界契约。
//
// 类型检查（tsgo）已经能守住「命令名、参数键名、返回类型」这一层 —— 那是
// tauri-commands.generated.ts 的功劳。这份测试守的是编译器看不见的另一半：
//
//   1. 生成物没跟着 main.rs 更新（本地改完忘了跑生成器）
//   2. 写了 #[tauri::command] 却忘了往 generate_handler![] 里登记 —— 编译得过，
//      调用时才 "Command not found"
//   3. 集合类型的返回值被 Option 包住 —— 前端拿到 null 而不是 []，`.map()` 当场炸
//   4. 有人绕过 shim 的 call() 直接 invoke("字面量")，重新引入无人校验的字符串
//
// 第 3 条是这套测试的核心，也是本文件存在的原因。Rust 的 `Vec<T>` 序列化出来一定是
// 数组，永远不会是 null —— 但 `Option<Vec<T>>` 会。前端把「空集合」和「没有」当成
// 两件事去写防御的成本，远高于在这里立一条规矩：集合就返回空集合，不要返回 null。
// 目前 28 个 command 里唯一返回集合的 store_keys 已经是 `unwrap_or_default()`，
// 这条规矩是给后面陆续落地的 command（任务 #6 事件通道、窗口控制、更新器）立的。
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { analyze, MAIN_RS, OUT_TS, render, rustTypeToTs } from "../../scripts/gen-tauri-commands"

const RENDERER_DIR = fileURLToPath(new URL(".", import.meta.url))
const SHIM = join(RENDERER_DIR, "tauri-api-shim.ts")

const analysis = analyze()
const shimSource = readFileSync(SHIM, "utf8")

/** Rust 的 Err 走 reject，契约只关心 Ok 那一侧 */
function resolvedReturn(returnType: string): string {
  const result = /^Result\s*<([\s\S]+)>$/.exec(returnType.trim())
  if (!result) return returnType.trim()
  return result[1].split(",")[0].trim()
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return walk(full)
    return /\.tsx?$/.test(entry.name) ? [full] : []
  })
}

describe("tauri command 契约", () => {
  test("生成物与 main.rs 同步", () => {
    // 等价于 `bun run gen:tauri-commands -- --check`，放进测试是因为 CI 跑的是
    // `bun turbo test:ci`，不会单独去调生成器
    expect(readFileSync(OUT_TS, "utf8")).toBe(render(analysis))
  })

  test("每个 #[tauri::command] 都在 generate_handler![] 里登记", () => {
    const registered = new Set(analysis.registered)
    const orphans = analysis.defined.filter((cmd) => !registered.has(cmd.name))
    expect(
      orphans.map((cmd) => `main.rs:${cmd.line} ${cmd.name}() 有 #[tauri::command] 但没登记，前端调不到`),
    ).toEqual([])
  })

  test("generate_handler![] 里没有不存在的名字", () => {
    const defined = new Set(analysis.defined.map((cmd) => cmd.name))
    expect(analysis.registered.filter((name) => !defined.has(name))).toEqual([])
  })

  // ── 集合返回值不得可空（对应 Go 侧的 bound-array 契约）─────────────────────
  test("返回集合的 command 不得把集合包在 Option 里", () => {
    const violations = analysis.commands
      .filter((cmd) => /^Option\s*<\s*(?:Vec|HashMap|BTreeMap)\s*</.test(resolvedReturn(cmd.returnType)))
      .map(
        (cmd) =>
          `main.rs:${cmd.line} ${cmd.name}() 返回 ${cmd.returnType}；` +
          `序列化后前端会拿到 null 而不是空集合，改成返回空集合（如 unwrap_or_default()）`,
      )
    expect(violations).toEqual([])
  })

  test("生成的返回类型里不存在「可空的数组/字典」", () => {
    // 上一条从 Rust 侧看，这条从生成物看 —— 万一将来加了别的会产出 `T[] | null`
    // 的类型构造（比如新的泛型映射规则），这条兜住
    const violations = analysis.commands
      .map((cmd) => [cmd.name, rustTypeToTs(cmd.returnType, analysis.structs, cmd.name)] as const)
      .filter(([, ts]) => /(\[\]|^Record<[\s\S]*>)\s*\|\s*null$/.test(ts))
      .map(([name, ts]) => `${name}() 的 TS 返回类型是 ${ts}`)
    expect(violations).toEqual([])
  })

  // ── 未定型的返回值必须是明确的决定，不能是手滑 ───────────────────────────
  test("返回 unknown 的 command 只有清单内那些", () => {
    // serde_json::Value 在 TS 侧只能是 unknown，调用方必须显式 as 收窄 —— 每多一个
    // 就多一处无人校验的形状约定，所以要求它是清单里写下的决定。
    // 这两个 picker 的形状（取消 null / multiple 数组 / 否则字符串）来自 Electron 侧
    // ipc.ts:112 起的既有契约，见 main.rs:384。
    const allowed = ["open_directory_picker", "open_file_picker"]
    const untyped = analysis.commands
      .filter((cmd) => rustTypeToTs(cmd.returnType, analysis.structs, cmd.name) === "unknown")
      .map((cmd) => cmd.name)
    expect(untyped.sort()).toEqual([...allowed].sort())
  })

  // ── 没人绕过 call() ────────────────────────────────────────────────────────
  test("只有 shim 直接 import invoke", () => {
    const offenders = walk(RENDERER_DIR)
      .filter((file) => file !== SHIM && !file.endsWith(".test.ts"))
      .filter((file) => /from\s+["']@tauri-apps\/api\/core["']/.test(readFileSync(file, "utf8")))
      .map((file) => file.slice(RENDERER_DIR.length))
    expect(offenders).toEqual([])
  })

  test("shim 里没有写死命令名的裸 invoke 调用", () => {
    // call() 传的是变量，不会命中；命中的一定是绕过了类型约束的字面量调用
    const literals = [...shimSource.matchAll(/\binvoke\s*(?:<[^>]*>)?\s*\(\s*["']([^"']+)["']/g)].map((m) => m[1])
    expect(literals).toEqual([])
  })

  test("每个登记过的 command 都被 shim 用上了", () => {
    // 挡的是「Rust 侧实现了但前端忘了接」—— 那种情况下功能看起来做完了，实际没通
    const unused = analysis.commands.filter((cmd) => !shimSource.includes(`"${cmd.name}"`)).map((cmd) => cmd.name)
    expect(unused).toEqual([])
  })
})

describe("tauri command 解析器自身", () => {
  test("认得出 Tauri 注入的参数，不把它们算进 payload", () => {
    // set_background_color(state: tauri::State<'_, BackgroundColor>, color: String)
    // 只有 color 该出现在 payload 里
    const cmd = analysis.commands.find((c) => c.name === "set_background_color")!
    expect(cmd.params.map((p) => p.jsName)).toEqual(["color"])
  })

  test("snake_case 参数名按 Tauri 的规则转成 camelCase", () => {
    const cmd = analysis.commands.find((c) => c.name === "write_attachment")!
    expect(cmd.params.map((p) => p.jsName)).toEqual(["sessionDir", "filename", "data"])
  })

  test("解析的是真实源码而不是空集合", () => {
    // 万一哪天 main.rs 挪了地方或正则失配，上面所有「没有违规」的断言都会因为
    // 集合为空而假通过 —— 这条兜底
    expect(readFileSync(MAIN_RS, "utf8")).toContain("#[tauri::command]")
    expect(analysis.commands.length).toBeGreaterThan(20)
  })
})
