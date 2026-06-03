// 260603 Red 版本一致性自检：编译前自动扫描
// 检查 package.json / README / CHANGELOG / index.html 版本号是否一致
import { readFileSync, existsSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, "..")

interface VersionInfo {
  pkg: string
  readme: string
  changelog: string
  badge: string
}

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

function checkGUI(): VersionInfo {
  const version = extractPkgVersion("packages/desktop/package.json")
  const readmeZH = read("README.md")
  const readmeEN = read("README.en.md")
  const changelog = read("CHANGELOG.md")
  const html = read("packages/desktop/src/renderer/index.html")
  return {
    pkg: version,
    readme: (readmeZH.includes(`Desktop-${version}`) || readmeZH.includes(`Desktop ${version}`)) ? version : `${version} ✗`,
    changelog: changelog.includes(`[${version}]`) ? version : `${version} ✗`,
    badge: html.includes(`v${version}`) ? version : `${version} ✗`,
  }
}

function checkTUI(): VersionInfo {
  const version = extractPkgVersion("packages/opencode/package.json")
  const readmeZH = read("README.md")
  const readmeEN = read("README.en.md")
  const changelog = read("CHANGELOG.md")
  return {
    pkg: version,
    readme: (readmeZH.includes(`TUI-${version}`) || readmeZH.includes(`TUI ${version}`)) ? version : `${version} ✗`,
    changelog: changelog.includes(`[${version}]`) ? version : `${version} ✗`,
    badge: "N/A",
  }
}

function pad(s: string, n: number): string {
  return s.padEnd(n)
}

console.log("")
console.log("=== 版本一致性自检 ===")
console.log("")

const gui = checkGUI()
const tui = checkTUI()

console.log(`  GUI v${gui.pkg}`)
console.log(`    README 徽章  ${gui.readme.includes("✗") ? "❌ " : "✅ "}${gui.readme}`)
console.log(`    CHANGELOG   ${gui.changelog.includes("✗") ? "❌ " : "✅ "}${gui.changelog}`)
console.log(`    标题栏徽章  ${gui.badge.includes("✗") ? "❌ " : "✅ "}${gui.badge}`)
console.log("")
console.log(`  TUI v${tui.pkg}`)
console.log(`    README 徽章  ${tui.readme.includes("✗") ? "❌ " : "✅ "}${tui.readme}`)
console.log(`    CHANGELOG   ${tui.changelog.includes("✗") ? "❌ " : "✅ "}${tui.changelog}`)
console.log("")

const ok = !gui.readme.includes("✗") && !gui.changelog.includes("✗") && !gui.badge.includes("✗")
  && !tui.readme.includes("✗") && !tui.changelog.includes("✗")

if (ok) {
  console.log("  ✅ 版本一致，可以发布")
} else {
  console.log("  ❌ 版本不一致！上面标记 ✗ 的需要补")
  process.exit(1)
}
