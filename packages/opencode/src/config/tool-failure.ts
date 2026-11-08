import { Schema } from "effect"

export const Limit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })).annotate({
  description: "Identical tool failures before one final correction opportunity (default: 2; maximum: 20).",
})

// 261108 Red 工具执行被中断（整轮 abort）的独立预算。中断不是工具自己报错——它走
// processor cleanup 的裸写路径，此前完全不计入失败预算，于是一个卡死的调用能把同一轮
// 回针十几次（实测 18 步、每步 5 分钟）。默认 5 步：留够换方法自救的余地，又不会烧到
// 步数硬顶（300）才停。
export const InterruptLimit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })).annotate({
  description: "Consecutive interrupted tool steps before automatic continuation stops (default: 5; maximum: 20).",
})

export function resolve(input?: number): number {
  return Schema.decodeUnknownSync(Limit)(input ?? 2)
}

export function resolveInterrupt(input?: number): number {
  return Schema.decodeUnknownSync(InterruptLimit)(input ?? 5)
}
