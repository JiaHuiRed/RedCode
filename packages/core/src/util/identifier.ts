import { randomBytes } from "crypto"

export namespace Identifier {
  const LENGTH = 30

  // State for monotonic ID generation
  let lastTimestamp = 0
  let counter = 0

  export function ascending() {
    return create(false)
  }

  export function descending() {
    return create(true)
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

  export function create(descending: boolean, timestamp?: number): string {
    const currentTimestamp = timestamp ?? Date.now()

    if (currentTimestamp !== lastTimestamp) {
      lastTimestamp = currentTimestamp
      counter = 0
    }
    counter++

    let now = BigInt(currentTimestamp) * BigInt(0x1000) + BigInt(counter)

    now = descending ? ~now : now

    // 260814 Red 6 字节(48 位) → 8 字节(64 位)：旧编码回绕周期 2^36 ms ≈ 795 天，
    // 回绕后 ID 字典序不再单调。64 位下时间戳空间 2^52 ms（约 14 万年）内不回绕。
    const timeBytes = Buffer.alloc(8)
    for (let i = 0; i < 8; i++) {
      timeBytes[i] = Number((now >> BigInt(56 - 8 * i)) & BigInt(0xff))
    }

    return timeBytes.toString("hex") + randomBase62(LENGTH - 16)
  }
}
