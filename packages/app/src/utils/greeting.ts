// 260828 cc 按时段问候。新建会话页（字标与输入框之间）与首页底部共用同一组文案 ——
// 同一个产品的同一个声音，不该在两个页面上是两套东西。
//
// 分档取整点：5–11 早上 / 11–13 中午 / 13–18 下午 / 18–23 晚上 / 其余 深夜。
// 每档两句，进页面时抽一次。
//
// **用 createSignal 抽而不是 createMemo**：memo 里的 Math.random() 不是响应式的，
// 看着像"每次重算"，实际只在首次求值时抽一次、之后被永久缓存 —— 今天首页那 50 条
// tips 就是栽在这个写法上（见 home.tsx HomeShortcutBar 的注释）。这里要的正是
// "每次进页面抽一次"，signal 的初值恰好就是这个语义，也不会被后续渲染改掉。
const GREETINGS = {
  morning: ["greeting.morning.a", "greeting.morning.b"],
  noon: ["greeting.noon.a", "greeting.noon.b"],
  afternoon: ["greeting.afternoon.a", "greeting.afternoon.b"],
  evening: ["greeting.evening.a", "greeting.evening.b"],
  night: ["greeting.night.a", "greeting.night.b"],
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
