import { describe, expect, test } from "bun:test"
import { block, infer, normalize, resolve, sourceFrom } from "../../src/session/reasoning-language"

// 构造消息的小工具：parts 里 [文本, 是否 ignored]
const msg = (role: string, ...parts: Array<[string, boolean?]>) => ({
  info: { role },
  parts: parts.map(([text, ignored]) => ({ type: "text" as const, text, ignored })),
})

describe("reasoning-language.sourceFrom", () => {
  test("取用户最后一条自撰文本", () => {
    expect(sourceFrom([msg("user", ["旧的"]), msg("assistant", ["回复"]), msg("user", ["新的问题"])])).toBe("新的问题")
  })

  test("★跳过 DCP 压缩通知这类 ignored 的注入消息 —— 260729 线上实测的 bug", () => {
    // 真实形态：用户说「怎么了敏敏」之后，DCP 又注入了一条 user 角色、ignored 的压缩通知。
    // 原实现只取最后一条 user 消息，过滤后剩空串，整条语言约束静默失效。
    const msgs = [
      msg("user", ["怎么了敏敏"]),
      msg("assistant", ["……"]),
      msg("user", ["▣ DCP | -148.1K removed, +5.2K summary", true]),
    ]
    expect(sourceFrom(msgs)).toBe("怎么了敏敏")
    expect(resolve(undefined, sourceFrom(msgs))).toBe("zh")
  })

  test("synthetic 的 part 同样跳过", () => {
    const msgs = [
      msg("user", ["帮我看看这个函数"]),
      { info: { role: "user" }, parts: [{ type: "text" as const, text: "injected", synthetic: true }] },
    ]
    expect(sourceFrom(msgs)).toBe("帮我看看这个函数")
  })

  test("全是注入消息时返回 undefined，不注入任何约束", () => {
    expect(sourceFrom([msg("user", ["▣ DCP | …", true])])).toBeUndefined()
    expect(block(resolve(undefined, sourceFrom([msg("user", ["▣ DCP | …", true])])))).toBeUndefined()
  })

  test("空列表不炸", () => {
    expect(sourceFrom([])).toBeUndefined()
  })

  test("同一条消息的多个文本 part 会拼起来", () => {
    expect(sourceFrom([msg("user", ["前半段"], ["后半段"])])).toBe("前半段\n后半段")
  })
})

describe("reasoning-language.normalize", () => {
  test("识别中文的多种写法", () => {
    for (const v of ["zh", "ZH", "cn", "Chinese", "中文", " zh "]) expect(normalize(v)).toBe("zh")
  })
  test("识别英文", () => {
    for (const v of ["en", "EN", "English"]) expect(normalize(v)).toBe("en")
  })
  test("未设置/无法识别一律 auto", () => {
    for (const v of [undefined, "", "ja", "垃圾值"]) expect(normalize(v)).toBe("auto")
  })
})

describe("reasoning-language.infer", () => {
  test("中文提问判为 zh", () => {
    expect(infer("帮我看看这个函数为什么会崩")).toBe("zh")
  })

  test("英文提问不注入（保持旧行为）", () => {
    expect(infer("why does this function crash on windows")).toBe("auto")
  })

  test("空/未定义不注入", () => {
    expect(infer(undefined)).toBe("auto")
    expect(infer("   ")).toBe("auto")
  })

  test("中文里嵌英文日志仍判为 zh —— 这是最常见的真实形态", () => {
    const s = "这个报错看不懂：\n```\nTypeError: undefined is not an object (evaluating 'model.api.id')\n```\n帮我查一下"
    expect(infer(s)).toBe("zh")
  })

  test("英文提问里贴了带中文注释的代码，不应误判", () => {
    // 代码块被剥掉后只剩英文，因此不注入
    const s = "please review this:\n```ts\n// 这里是中文注释，用来测试误判\nconst a = 1\n```"
    expect(infer(s)).toBe("auto")
  })

  test("剥掉 RedCode 自己注入的包装块", () => {
    const s = "<system-reminder>\n这是系统提醒里的中文，不代表用户在说中文\n</system-reminder>\nfix it"
    expect(infer(s)).toBe("auto")
  })

  test("少量汉字 + 中文标点也算 zh", () => {
    expect(infer("修一下，谢谢")).toBe("zh")
  })

  test("零星一两个汉字且无中文标点，保守不判定", () => {
    expect(infer("run the 测试 now")).toBe("auto")
  })
})

describe("reasoning-language.resolve + block", () => {
  test("显式设置优先于自动判定", () => {
    expect(resolve("en", "帮我看看这个函数")).toBe("en")
    expect(resolve("zh", "please fix this")).toBe("zh")
  })

  test("auto 时才看用户说什么语言", () => {
    expect(resolve("auto", "帮我看看这个函数")).toBe("zh")
    expect(resolve(undefined, "please fix this")).toBe("auto")
  })

  test("auto 判不出来时不注入任何东西", () => {
    expect(block(resolve(undefined, "please fix this"))).toBeUndefined()
  })

  test("中文块用命令式措辞，且声明不影响最终回答语言", () => {
    const b = block("zh")!
    expect(b).toContain("<reasoning-language>")
    expect(b).toContain("必须使用简体中文")
    expect(b).toContain("从第一个字开始")
    expect(b).toContain("不影响最终回答的语言")
  })

  test("英文块同样是命令式", () => {
    const b = block("en")!
    expect(b).toContain("from the first word onward")
    expect(b).toContain("does not affect the language of the final answer")
  })
})
