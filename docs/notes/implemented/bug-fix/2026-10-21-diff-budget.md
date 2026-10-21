# 文件预览 diff 的预算（RC21-05 尾巴）

状态:implemented

审计原文：`docs/2026-10-21-third-party-audit.md` 的 RC21-05「大 diff 限制上下文、按需请求」。
本轮先把正文与媒体分支的读取上限做完（`2026-10-21-audit-rc21-batch.md`），把 diff 部分单独
留作评估——它会动 GUI 的 diff 展示面。

## 评估结论：审计的假设要修正

原假设是 `context: Infinity` 让 diff 变大、变慢。按 `file/index.ts` 的真实调用形状
（两份全文 + `ignoreWhitespace`）实测，**context 不是瓶颈**：

| 行数             | 场景   | diff 耗时 | 输出   |
| ---------------- | ------ | --------- | ------ |
| 5,000            | 改一行 | 3ms       | 0.2 MB |
| 20,000           | 改一行 | 7ms       | 1 MB   |
| 50,000（≈2 MiB） | 改一行 | 21ms      | 2.5 MB |

换个形状就炸：**5,000 行 / 0.2 MB 整体重写**（每行都变）时 `structuredPatch` 跑了 **18 秒**、
堆 +28 MB。Myers 是 O(ND)，代价由差异规模决定，不是文件大小。而且是同步 CPU，那 18 秒里
整个 sidecar 事件循环停住。

同时发现第二个缺口：`git.show` 读 HEAD 版本**没有上限**。工作区正文有 2 MiB 闸门，基线没有，
所以「HEAD 里一个大文件被改成小文件」会把整份 HEAD 读进内存再拿去 diff。

## 决策

- **diff 计算加时间闸门**：`structuredPatch(..., { timeout: 300 })`。diff 8.x 的 `timeout`
  到点直接返回 `undefined`（实测 200ms 档位恰好 202ms 返回 undefined），不用自己按行数猜阈值。
  正常场景 21ms，300ms 留十倍余量。
- **基线加输出上限**：新增 `Git.showBounded(cwd, ref, file, prefix?, maxBytes?)`，返回
  `{ text, truncated }`。`show` 的契约不动（它还有别的消费者）。截断时**不生成 diff**——
  把截断的字符串当全文会让 diff 变成「整文件新增」，那是假信息。
- **超限行为**：返回 `content`，不带 `patch` / `diff`，`log.warn("diff.skipped", { file, reason })`
  区分 `baseline-too-large` 与 `timeout`。
- **`context: Infinity` 保持不变**：完整上下文是消费者要的语义，且实测不贵。

## 备选与否决理由

- **按行数/字节数设阈值**：否决 —— 代价由差异规模决定，两个都不准：5000 行改一行是 3ms，
  5000 行全改是 18 秒。时间闸门直接测真实代价。
- **改小 `context`（例如 3 行）**：否决 —— 治不了 18 秒那个病（耗时在 diff 计算，不在 hunk
  输出），却牺牲了「看到全文上下文」这个能力。
- **给 `Content` 加 `diffSkipped` 字段并重新生成 SDK**：暂缓 —— 现在 GUI 不渲染文件预览的
  `patch`（`packages/app` 里对 `content.patch` 的唯一消费是 `content-cache.ts` 的字节统计），
  加了没有消费者。等 GUI 真要做「diff 未生成」提示时再加字段并重新生成 SDK。
- **按需请求完整 diff（新端点）**：暂缓 —— 同上，没有消费面；先让病态场景有界。

## 后果

- 病态差异从 18 秒同步阻塞降到 300ms 有界。
- 基线超过 2 MiB 时不再读全量，也不再产出假 diff。
- 正常大文件的完整上下文 diff 不受影响（两万行改一行仍有 diff，`line 0` 仍在上下文里）。
- 验证：`test/file/index.test.ts` 新增 3 条（基线超限跳过、差异过大跳过且整体 < 5s、大文件
  小改动保留完整上下文），全文件 57 pass；`test/git/git.test.ts` 9 pass；`packages/opencode`
  typecheck 通过。
- **未做**：GUI 的「diff 未生成」提示与按需加载完整 diff。前者需要新字段 + SDK 重新生成 +
  界面落点，后者需要新端点；两者都等有真实消费需求时再做。
