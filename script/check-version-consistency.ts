// 260603 Red 版本一致性自检：编译前自动扫描
// 260814 Red 版本线合并改造：TUI/GUI 不再分线，全仓单一版本号（以 packages/opencode 为准）
// 检查范围：全部 @redcode-ai/* 包 + sdk + vscode 同号、README 双语徽章、CHANGELOG 条目、GUI 标题栏徽章
import { readFileSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, "..")

function read(path: string): string {
  try {
    return readFileSync(join(root, path), "utf-8")
  } catch {
    return ""
  }
}

function extractPkgVersion(file: string): string {
  try {
    const json = JSON.parse(readFileSync(join(root, file), "utf-8"))
    return json.version || ""
  } catch {
    return ""
  }
}

// 版本号权威来源：TUI 包（合并线从 TUI 的 0.8.16 起递增）
const version = extractPkgVersion("packages/opencode/package.json")

// 全仓需同号的 package.json（storybook/script 无 version 字段，不列）
const VERSIONED_PACKAGES = [
  "packages/desktop/package.json",
  "packages/app/package.json",
  "packages/core/package.json",
  "packages/ui/package.json",
  "packages/web/package.json",
  "packages/llm/package.json",
  "packages/plugin/package.json",
  "packages/function/package.json",
  "packages/enterprise/package.json",
  "packages/slack/package.json",
  "packages/http-recorder/package.json",
  "packages/effect-drizzle-sqlite/package.json",
  "packages/sdk/js/package.json",
  "sdks/vscode/package.json",
]

const readmeZH = read("README.md")
const readmeEN = read("README.en.md")
const changelog = read("CHANGELOG.md")
const html = read("packages/desktop/src/renderer/index.html")

const mismatched = VERSIONED_PACKAGES
  .map((file) => ({ file, v: extractPkgVersion(file) }))
  .filter((p) => p.v !== version)

const checks = [
  {
    name: `全仓同号（${VERSIONED_PACKAGES.length} 包）`,
    ok: mismatched.length === 0,
    detail: mismatched.length === 0 ? version : mismatched.map((p) => `${p.file}=${p.v || "(空)"}`).join(", "),
  },
  {
    name: "README 中文徽章",
    ok: readmeZH.includes(`版本/${version}`),
    detail: version,
  },
  {
    name: "README 英文徽章",
    ok: readmeEN.includes(`Version/${version}`),
    detail: version,
  },
  {
    name: "CHANGELOG 条目",
    ok: changelog.includes(`[${version}]`),
    detail: version,
  },
  {
    // __RC_VERSION__ 占位符 = 构建时自动注入，永远跟随 package.json，视为一致
    name: "GUI 标题栏徽章",
    ok: html.includes("__RC_VERSION__") || html.includes(`v${version}`),
    detail: version,
  },
]

console.log("")
console.log("=== 版本一致性自检（单一版本线）===")
console.log("")
console.log(`  版本 v${version}`)
for (const c of checks) {
  console.log(`    ${c.name.padEnd(14)} ${c.ok ? "✅ " : "❌ "}${c.detail}`)
}
console.log("")

if (checks.every((c) => c.ok)) {
  console.log("  ✅ 版本一致，可以发布")
} else {
  console.log("  ❌ 版本不一致！上面标记 ❌ 的需要补")
  process.exit(1)
}
