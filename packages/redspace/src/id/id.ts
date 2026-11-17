import { randomBytes } from "crypto"

const prefixes = {
  job: "job",
  event: "evt",
  session: "ses",
  message: "msg",
  permission: "per",
  question: "que",
  part: "prt",
  pty: "pty",
  tool: "tool",
  workspace: "wrk",
} as const

const LENGTH = 30

// State for monotonic ID generation
let lastTimestamp = 0
let counter = 0

export function ascending(prefix: keyof typeof prefixes, given?: string) {
  return generateID(prefix, "ascending", given)
}

export function descending(prefix: keyof typeof prefixes, given?: string) {
  return generateID(prefix, "descending", given)
}

function generateID(prefix: keyof typeof prefixes, direction: "descending" | "ascending", given?: string): string {
  if (!given) {
    return create(prefixes[prefix], direction)
  }

  if (!given.startsWith(prefixes[prefix])) {
    throw new Error(`ID ${given} does not start with ${prefixes[prefix]}`)
  }
  return given
}

function randomBase62(length: number): string {
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
  let result = ""
  const bytes = randomBytes(length)
  for (let i = 0; i < length; i++) {
    result += chars[bytes[i] % 62]
  }
  return result
}

export function create(prefix: string, direction: "descending" | "ascending", timestamp?: number): string {
  const currentTimestamp = timestamp ?? Date.now()

  if (currentTimestamp !== lastTimestamp) {
    lastTimestamp = currentTimestamp
    counter = 0
  }
  counter++

  let now = BigInt(currentTimestamp) * BigInt(0x1000) + BigInt(counter)

  now = direction === "descending" ? ~now : now

  // 260814 Red 6 字节(48 位) → 8 字节(64 位)：旧编码回绕周期 2^36 ms ≈ 795 天，
  // 2026-08-14 19:19:55.136 已第 26 次回绕，此后新 ID 字典序反小于回绕前旧 ID，
  // 一切按 ID 字典序表达"先后"的比较全部失真（曾致 runLoop 空转死循环，见 MessageV2.compareTime）。
  // 64 位下时间戳空间 2^52 ms（约 14 万年）内不回绕。
  const timeBytes = Buffer.alloc(8)
  for (let i = 0; i < 8; i++) {
    timeBytes[i] = Number((now >> BigInt(56 - 8 * i)) & BigInt(0xff))
  }

  return prefix + "_" + timeBytes.toString("hex") + randomBase62(LENGTH - 16)
}

/** Extract timestamp from an ascending ID. Does not work with descending IDs. */
export function timestamp(id: string): number {
  const prefix = id.split("_")[0]
  const rest = id.slice(prefix.length + 1)
  // 260814 Red 兼容旧 6 字节(12 hex)与新 8 字节(16 hex)：random 尾部恒 14 位
  const hexLen = rest.length - (LENGTH - 16)
  const encoded = BigInt("0x" + rest.slice(0, hexLen))
  return Number(encoded / BigInt(0x1000))
}

export * as Identifier from "./id"
