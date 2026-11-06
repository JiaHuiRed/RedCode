export function stripFileProtocol(input: string) {
  if (!input.startsWith("file://")) return input
  return input.slice("file://".length)
}

export function stripQueryAndHash(input: string) {
  const hashIndex = input.indexOf("#")
  const queryIndex = input.indexOf("?")

  if (hashIndex !== -1 && queryIndex !== -1) {
    return input.slice(0, Math.min(hashIndex, queryIndex))
  }

  if (hashIndex !== -1) return input.slice(0, hashIndex)
  if (queryIndex !== -1) return input.slice(0, queryIndex)
  return input
}

export function unquoteGitPath(input: string) {
  if (!input.startsWith('"')) return input
  if (!input.endsWith('"')) return input
  const body = input.slice(1, -1)
  const bytes: number[] = []

  for (let i = 0; i < body.length; i++) {
    const char = body[i]!
    if (char !== "\\") {
      bytes.push(char.charCodeAt(0))
      continue
    }

    const next = body[i + 1]
    if (!next) {
      bytes.push("\\".charCodeAt(0))
      continue
    }

    if (next >= "0" && next <= "7") {
      const chunk = body.slice(i + 1, i + 4)
      const match = chunk.match(/^[0-7]{1,3}/)
      if (!match) {
        bytes.push(next.charCodeAt(0))
        i++
        continue
      }
      bytes.push(parseInt(match[0], 8))
      i += match[0].length
      continue
    }

    const escaped =
      next === "n"
        ? "\n"
        : next === "r"
          ? "\r"
          : next === "t"
            ? "\t"
            : next === "b"
              ? "\b"
              : next === "f"
                ? "\f"
                : next === "v"
                  ? "\v"
                  : next === "\\" || next === '"'
                    ? next
                    : undefined

    bytes.push((escaped ?? next).charCodeAt(0))
    i++
  }

  return new TextDecoder().decode(new Uint8Array(bytes))
}

export function decodeFilePath(input: string) {
  try {
    return decodeURIComponent(input)
  } catch {
    return input
  }
}

// 261106 Red 审计：Windows 根形态判定（盘符或 UNC），createPathHelpers 与
// canonicalizeTreePath 共用，同形判定不散落多处。
export function isWindowsRoot(input: string): boolean {
  return /^[A-Za-z]:/.test(input) || input.startsWith("\\\\")
}

// 261106 Red 审计：树键族规范形。服务端 file.list（path.relative）与 watcher 事件
// 在 win32 带原生反斜杠，而 filter/kinds/active 等 git 侧数据（numstat 输出）恒为
// / 形；树入库与树查找统一归一成 /，不归一则 Windows 下整族比对失配。
// 自身审计 P2-02：归一只对 Windows 根的工作区做——POSIX 文件名允许字面反斜杠
// （literal\name.txt 是单层文件名），无条件替换会把树键拆成不存在的两级，且与
// git 侧同样保留反斜杠的 path.test.ts 断言矛盾；POSIX 下服务端路径本来就是 / 形，
// 恒等返回即正确。内容缓存与标签键族（store.file / tabs）不走此函数。
export function canonicalizeTreePath(path: string, windows: boolean): string {
  return windows ? path.replaceAll("\\", "/") : path
}

export function encodeFilePath(filepath: string): string {
  // Normalize Windows paths: convert backslashes to forward slashes
  let normalized = filepath.replace(/\\/g, "/")

  // Handle Windows absolute paths (D:/path -> /D:/path for proper file:// URLs)
  if (/^[A-Za-z]:/.test(normalized)) {
    normalized = "/" + normalized
  }

  // Encode each path segment (preserving forward slashes as path separators)
  // Keep the colon in Windows drive letters (`/C:/...`) so downstream file URL parsers
  // can reliably detect drives.
  return normalized
    .split("/")
    .map((segment, index) => {
      if (index === 1 && /^[A-Za-z]:$/.test(segment)) return segment
      return encodeURIComponent(segment)
    })
    .join("/")
}

export function createPathHelpers(scope: () => string) {
  const normalize = (input: string) => {
    const root = scope()

    // 261106 Red 自审计：URL 解析规则只作用于 file:// URI 输入。普通文件系统路径里的
    // #/?/% 是合法文件名字符，无条件剥查询/片段、做百分号解码会把 src/feature#1.ts
    // 在进入读取逻辑之前就截成 src/feature（src/100%done.txt 同理）。
    let path =
      input.startsWith("file://")
        ? unquoteGitPath(decodeFilePath(stripQueryAndHash(stripFileProtocol(input))))
        : unquoteGitPath(input)

    // Separator-agnostic prefix stripping for Cygwin/native Windows compatibility
    // Only case-insensitive on Windows (drive letter or UNC paths)
    const windows = isWindowsRoot(root)
    const canonRoot = windows ? root.replace(/\\/g, "/").toLowerCase() : root.replace(/\\/g, "/")
    const canonPath = windows ? path.replace(/\\/g, "/").toLowerCase() : path.replace(/\\/g, "/")
    if (
      canonPath.startsWith(canonRoot) &&
      (canonRoot.endsWith("/") || canonPath === canonRoot || canonPath[canonRoot.length] === "/")
    ) {
      // Slice from original path to preserve native separators
      path = path.slice(root.length)
    }

    if (path.startsWith("./") || path.startsWith(".\\")) {
      path = path.slice(2)
    }

    if (path.startsWith("/") || path.startsWith("\\")) {
      path = path.slice(1)
    }
    return path
  }

  const tab = (input: string) => {
    const path = normalize(input)
    return `file://${encodeFilePath(path)}`
  }

  const pathFromTab = (tabValue: string) => {
    if (!tabValue.startsWith("file://")) return
    return normalize(tabValue)
  }

  const normalizeDir = (input: string) => {
    const path = normalize(input)
    const root = scope()
    const windows = isWindowsRoot(root)
    return (windows ? path.replace(/\\/g, "/") : path).replace(/\/+$/, "")
  }

  return {
    normalize,
    tab,
    pathFromTab,
    normalizeDir,
  }
}
