import { expect, test } from "bun:test"
import { NgramDetector } from "@/session/text-loop-detection"

const gram = "A".repeat(80)

test("detects three identical n-grams in streamed deltas", () => {
  const detector = new NgramDetector()
  const text = gram.repeat(6)
  let hit = false
  for (let i = 0; i < text.length; i += 100) hit = detector.feed(text.slice(i, i + 100)) || hit
  expect(hit).toBe(true)
})

test("does not flag ordinary long text", () => {
  const detector = new NgramDetector()
  let hit = false
  for (let i = 0; i < 200; i++) {
    hit = detector.feed(`${i}-${"内容".repeat(20)}`) || hit
  }
  expect(hit).toBe(false)
})

// 261108 Red 审计 RC-P2-09：check() 只读尾部 720 字符，buffer 不该无限增长。
test("keeps the scan buffer bounded by the tail it actually reads", () => {
  const detector = new NgramDetector()
  for (let i = 0; i < 500; i++) detector.feed("x".repeat(200))
  const buffer = (detector as unknown as { buffer: string }).buffer
  expect(buffer.length).toBeLessThanOrEqual(80 * 3 * 3)
})
