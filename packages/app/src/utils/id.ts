const prefixes = {
  session: "ses",
  message: "msg",
  permission: "per",
  user: "usr",
  part: "prt",
  pty: "pty",
} as const

const LENGTH = 30
let lastTimestamp = 0
let counter = 0

type Prefix = keyof typeof prefixes
export namespace Identifier {
  export function ascending(prefix: Prefix, given?: string) {
    return generateID(prefix, false, given)
  }

  export function descending(prefix: Prefix, given?: string) {
    return generateID(prefix, true, given)
  }
}

function generateID(prefix: Prefix, descending: boolean, given?: string): string {
  if (!given) {
    return create(prefix, descending)
  }

  if (!given.startsWith(prefixes[prefix])) {
    throw new Error(`ID ${given} does not start with ${prefixes[prefix]}`)
  }

  return given
}

function create(prefix: Prefix, descending: boolean, timestamp?: number): string {
  const currentTimestamp = timestamp ?? Date.now()

  if (currentTimestamp !== lastTimestamp) {
    lastTimestamp = currentTimestamp
    counter = 0
  }

  counter += 1

  let now = BigInt(currentTimestamp) * BigInt(0x1000) + BigInt(counter)

  if (descending) {
    now = ~now
  }

  // 260814 Red 6 字节(48 位) → 8 字节(64 位)：旧编码回绕周期 2^36 ms ≈ 795 天
  // （2026-08-14 19:19:55.136 已第 26 次回绕，ID 字典序比较全部失真，见 compareTime）。
  // 64 位下时间戳空间 2^52 ms（约 14 万年）内不回绕。
  const timeBytes = new Uint8Array(8)
  for (let i = 0; i < 8; i += 1) {
    timeBytes[i] = Number((now >> BigInt(56 - 8 * i)) & BigInt(0xff))
  }

  return prefixes[prefix] + "_" + bytesToHex(timeBytes) + randomBase62(LENGTH - 16)
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = ""
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i].toString(16).padStart(2, "0")
  }
  return hex
}

function randomBase62(length: number): string {
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
  const bytes = getRandomBytes(length)
  let result = ""
  for (let i = 0; i < length; i += 1) {
    result += chars[bytes[i] % 62]
  }
  return result
}

function getRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  const cryptoObj = typeof globalThis !== "undefined" ? globalThis.crypto : undefined

  if (cryptoObj && typeof cryptoObj.getRandomValues === "function") {
    cryptoObj.getRandomValues(bytes)
    return bytes
  }

  for (let i = 0; i < length; i += 1) {
    bytes[i] = Math.floor(Math.random() * 256)
  }

  return bytes
}

// 260814 Red ID 48 位编码 795 天回绕（2026-08-14 19:19:55.136 已第 26 次发生），
// 回绕后新 ID 字典序小于旧 ID。先后比较必须走 time.created，同毫秒 tie-break 用 ID 字典序
// （同 ms 内 counter 递增、字典序正确）。created 缺失的对象退化为 ID 字典序。
export function compareTime(
  a: { id: string; time?: { created?: number } },
  b: { id: string; time?: { created?: number } },
): number {
  const ac = a.time?.created
  const bc = b.time?.created
  if (ac !== undefined && bc !== undefined && ac !== bc) return ac - bc
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}
