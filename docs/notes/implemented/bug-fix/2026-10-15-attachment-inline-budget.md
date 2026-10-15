# 附件解析：读盘前的字节与数量闸门（审计 A02）

状态:implemented

## 问题

`prompt.ts` 的 `resolvePart` 对二进制 / 图片附件此前走这条分支：

```ts
url: `data:${mime};base64,` + Buffer.from(yield* fsys.readFile(filepath)...).toString("base64")
```

`fsys.readFile` **之前没有任何尺寸检查**：整个文件读进内存，再编成 base64 字符串，两者同时在场。
实测放大（`.redcode/temp/a02-probe.mjs`，合成缓冲、RSS 口径）：

| 文件 | base64 长度 | RSS 增量 | 放大 |
| --- | --- | --- | --- |
| 1 MiB | 1.33 MiB | +2.3 MiB | 2.30× |
| 4 MiB | 5.33 MiB | +9.4 MiB | 2.35× |
| 16 MiB | 21.33 MiB | +37.4 MiB | 2.34× |

⇒ 常驻 ≈ 1 + 4/3 = 2.33× 文件字节，与算术一致。一个 500 MiB 的 `.bin` 就是约 1.2 GiB 瞬时。

同时 `Effect.forEach(input.parts, resolvePart, { concurrency: "unbounded" })` 对 `PromptInput.parts`
**全无数量上界**（文件末尾是普通 `Schema.Array`），而最贵的这条路径正是 unbounded 并发 ——
N 个附件就是 N 份完整副本。

**既有限额挡不住它**：`image-tokens.ts` 的 `MAX_ATTACHMENT_BASE64_BYTES = 5 MiB` /
`MAX_ATTACHMENTS = 32` 管的是**已经在内存里**的 base64 载荷（由共享 fitter 在 parts 建好之后裁决），
峰值之后才生效；`tool/read.ts` 的图片上限只覆盖工具路径，不覆盖用户附件路径。

**统计口径**：本项**没有**生产事故证据 —— 审计也明确指出不能据此认定它导致此前的 GUI ENOMEM。
结论是「无上界的输入 × 无上界的并发」，属本仓「没有上限就是缺陷不是待办」那一类，不是性能回归。

## 决策

- **读盘前的字节闸门**（`attachmentInlineBytesExceeded`）：按 base64 长度公式 `4*ceil(n/3)` 反算原始
  字节上限（取 3/4 的保守近似 = 3.75 MiB），超限**一个字节都不读**，只回一句可读说明；文件仍在磁盘上。
  与 `tool/read.ts` 图片分支同形（那里也是超限在 `readFile` 之前返回）。
- **数量闸门**（`splitByAttachmentBudget`）：按**既有的** `MAX_ATTACHMENTS = 32` 切分，超量附件不在
  原位置解析，而是逐个补一句可读说明 —— 不静默丢弃、不改变保留项顺序、不新增第二套限额常量。
- **并发压到 8**：家规是 `instruction.ts` 读本地文件用 8、拉远端用 4。数量封顶后最坏峰值
  ≈ 并发 × 2.33 × 3.75 MiB：8 → 约 70 MiB，unbounded(32) → 约 280 MiB。**没有测墙钟耗时，因此不
  声称提速**；这一项换的是峰值上界。

## 备选与否决理由

- **只加数量闸门、不动并发**：否决 —— 32 × 2.33 × 3.75 MiB ≈ 280 MiB 的瞬时峰值仍会落在那台已经
  内存告警的设备上；压到 8 是既有家规，不是新造的数字。
- **只压并发、不加字节闸门**：否决 —— 单个超大文件与并发无关，照样 1.2 GiB。
- **自己新造一套限额**：否决 —— 同一条预算线已有两个消费者（工具侧与 fitter），第三套必然漂移；
  审计原话就是「首先查仓库现有 Read / Image / MCP 限额，避免双重限制互相矛盾」。
- **超限直接抛错**：否决 —— 用户贴了一个大附件就把整条消息打掉，可恢复性差。改为「不内联 + 一句
  说明」：模型仍看到文件名与原因，用户仍能改小重发。

## 后果

- 正常路径（单件 ≤ 3.75 MiB、文件数 ≤ 32）行为不变：同样的 part 顺序、同样的内容；并发从 unbounded
  变 8（`Effect.forEach` 保序，取消与逐 part 失败分支都不动）。
- 异常路径：超字节上限的附件不再被读入（峰值从 ≈2.33× 文件字节降到 0）；超数量的附件在原位置留下
  一句说明，而不是被静默吞掉。
- 验证：`attachment-budget.test.ts` 5 pass（新增）、`image-tokens.test.ts` 13 pass、
  `prompt.test.ts` 84 pass / 13 skip / 0 fail、opencode `typecheck` EXIT=0。
- **未覆盖**：`resolvePart` 是闭包内局部函数，无法在隔离环境驱动 —— 断言只覆盖两个纯函数（闸门判定
  与切分），真实读盘 + base64 的峰值没有集成夹具。要长期看住这个峰值，应把该分支抽成可测单元。
- **未覆盖**：某次 `prompt.test.ts` 出现 1 例失败，同代码复跑两次均 84/0；该套件在负载下本就有已知
  波动（项目记忆），未定位到失败用例，如实记下而不是当作已通过。
- 模型可见四问：① 无提示词 / 工具 schema 改动；② token 无变化（正常路径内容相同）；③ 前缀不受影响；
  ④ **新增两条硬上限**（单件 3.75 MiB、单条消息 32 个文件附件）—— 这正是本项的目的。
