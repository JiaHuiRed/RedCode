// 260828 cc 按时段问候。新建会话页（字标与输入框之间）与首页底部共用同一组文案 ——
// 同一个产品的同一个声音，不该在两个页面上是两套东西。
//
// 分档取整点：5–11 早上 / 11–13 中午 / 13–18 下午 / 18–23 晚上 / 其余 深夜。
// 每档八句（260915 Red 从两句扩到八句，同档内随机，避免两天就看腻），进页面时抽一次。
// 注意三语必须同步：i18n/parity.test.ts 按 en 基准做全键 diff，少一个键就红。
//
// **用 createSignal 抽而不是 createMemo**：memo 里的 Math.random() 不是响应式的，
// 看着像"每次重算"，实际只在首次求值时抽一次、之后被永久缓存 —— 今天首页那 50 条
// tips 就是栽在这个写法上（见 home.tsx HomeShortcutBar 的注释）。这里要的正是
// "每次进页面抽一次"，signal 的初值恰好就是这个语义，也不会被后续渲染改掉。
const GREETINGS = {
  morning: [
    "greeting.morning.a",
    "greeting.morning.b",
    "greeting.morning.c",
    "greeting.morning.d",
    "greeting.morning.e",
    "greeting.morning.f",
    "greeting.morning.g",
    "greeting.morning.h",
  ],
  noon: [
    "greeting.noon.a",
    "greeting.noon.b",
    "greeting.noon.c",
    "greeting.noon.d",
    "greeting.noon.e",
    "greeting.noon.f",
    "greeting.noon.g",
    "greeting.noon.h",
  ],
  afternoon: [
    "greeting.afternoon.a",
    "greeting.afternoon.b",
    "greeting.afternoon.c",
    "greeting.afternoon.d",
    "greeting.afternoon.e",
    "greeting.afternoon.f",
    "greeting.afternoon.g",
    "greeting.afternoon.h",
  ],
  evening: [
    "greeting.evening.a",
    "greeting.evening.b",
    "greeting.evening.c",
    "greeting.evening.d",
    "greeting.evening.e",
    "greeting.evening.f",
    "greeting.evening.g",
    "greeting.evening.h",
  ],
  night: [
    "greeting.night.a",
    "greeting.night.b",
    "greeting.night.c",
    "greeting.night.d",
    "greeting.night.e",
    "greeting.night.f",
    "greeting.night.g",
    "greeting.night.h",
  ],
} as const

function greetingBucket(hour: number): keyof typeof GREETINGS {
  if (hour >= 5 && hour < 11) return "morning"
  if (hour >= 11 && hour < 13) return "noon"
  if (hour >= 13 && hour < 18) return "afternoon"
  if (hour >= 18 && hour < 23) return "evening"
  return "night"
}

export function pickGreetingKey(hour: number, roll = Math.random()): string {
  const options = GREETINGS[greetingBucket(hour)]
  return options[Math.floor(roll * options.length)] ?? options[0]
}
