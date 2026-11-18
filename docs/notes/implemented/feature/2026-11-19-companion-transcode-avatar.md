# 混合编码日记忠实转码与导入伙伴头像接线

状态：implemented

完整迁移目标与缺口清单见 [秋秋完整迁移路线](../../proposed/architecture/2026-11-18-qiuqiu-full-migration.md)；本提交落地其缺口一与缺口二。

## 问题

live 秋秋档案（`companion-10cf9da8b9c0`，2026-11-17 导入）存在两个缺口：

1. `2026-05-31.md`、`2026-06-21.md`、`2026-06-23.md` 是 **UTF-8 头 + GBK 主体**的混合编码（另有 3-11 处 GBK 双字节在换行前被截断的坏字节），严格 UTF-8 解码全部失败，被排除出 `companion_memory` 的搜索与读取——2026 年 5 月底最早的相处记录不可召回。
2. `qiuqiu-avatar.jpg`（153 KB）随档案导入 workspace，但所有头像（Code soul、companion、用户）都存 GUI 本地 settings（`soulAvatars: Record<soulID, dataURL>`），后端没有任何机制把 workspace 头像文件变成可显示的头像。

## 决策

### 忠实转码通道（`archive.ts`）

`transcodeMixed` 逐序列扫描：UTF-8 序列直通；歧义字节对（GBK 双字节频繁构成合法 UTF-8 形状，GBK 汉字第一字节约 64% 落在 UTF-8 lead 区）同时按两种编码解码，保留解出强字符（CJK/ASCII/常用标点）的一侧，都强或都弱时按 `tieBreak` 决定（UTF-8 优先与 GB18030 优先两种扫描取强字符率更高者，≥95% 门限）。坏字节位置输出 U+FFFD——Unicode 标准的损坏标记，不伪造内容；文件整体强率不足则维持既有 `unknown` 排除路径。

集成点保持三条不变量：

- **digest 稳定**：manifest hash 与 `source/` 副本保留原始字节，活动 workspace 副本才是转码结果。重导入同一来源时 `previous.digest === archive.digest` 依旧成立，走追加路径而不报冲突。
- **重导入修复已存在档案**：`appendHistory` 扩展处理 `encoding === "transcoded"` 的文件——仅当磁盘现存字节仍与记录的原始 hash 一致（未被本地修改）时覆盖写入，有本地改动则跳过并警告。实际没有任何写入时返回 `imported: false` 且不更新 warnings，与"没动任何东西"语义一致。
- **新导入双写**：staging 循环对转码文件分别写 `source/`（原字节）与活动副本（转码字节）。

真实档案验证：3 份日记解出连贯中文（"RedMon 游戏项目诞生 🎮"、"哥哥说秋秋今天「立大功」！"），强率 0.995-1.000；重导入后 `companion_memory.search` 命中三份文件，`source/` 字节逐一致，manifest 记录 `encoding: "transcoded"` 与原始 hash。单测 fixture 覆盖 GBK 主体、截断字节、歧义对与重导入幂等。

### 头像接线（跨端最小路径）

头像是纯客户端本地数据，因此不引入后端存储，只打通一条搬运链：

- `GET /companion/{id}`（Details）新增可选 `avatar` 字段：后端从 workspace 按 `avatar.*.{png,jpe?g,webp}` 找到文件（≤1 MiB，`Limits.avatar`），返回原始 MIME data URL。后端不重编码、不落库。
- 聊天页（`chat.tsx`）一次性收养 effect：仅当本地 settings **从未设置**该 soulID 头像（新增 `personalization.hasSoulAvatar` 区分"未设置"与"显式删除"，media store 就绪后才判定）时请求 details，经现成 `prepareSoulAvatar`（canvas 重编码 256×256 PNG、≤256 KB）后写入本地 settings。每会话每个 soulID 只尝试一次。删除过的头像不会被收养覆盖。
- 渲染器 `resolveSoulAvatar` 与存储格式零改动。

## 模型可见边界

转码只扩大既有工具预算内的可召回内容：`companion_memory.search/read` 的 8 KiB / 16 KiB 输出上限、启动快照 32 KiB、工具描述与固定前缀全部不变，KV cache 不受影响。Details.avatar 是 HTTP 响应字段，不进模型上下文。

## 备选与否决理由

- **修 `.openclaw` 源文件再重导入**：改活档案原字节，且个案处理不覆盖其他 Windows 档案的同病。
- **转码产物走 `workspace/history/`**：派生历史是会话视图，日记应在自己的路径被引用。
- **后端转存头像到 Soul frontmatter 或新资源库**：与"头像数据归客户端"的既有契约冲突，且 base64 进 frontmatter 有 IDENTITY.md 式前缀污染前科；前端已有有界重编码管线，直接复用。

## 后果

- 转码是逐序列仲裁：极端场景（GBK 符号区第二字节与 UTF-8 歧义且两侧都弱）可能产出个别错字，但强字符率门限与 U+FFFD 保证可审计；原字节永远在 `source/` 可比对。
- `appendHistory` 现在会改写 workspace 文件（转码修复），仍不触碰 MEMORY/SOUL/日记的已修改内容——hash 校验是唯一覆盖条件。
- 聊天页收养发生在进入 Chat 时；列表页头像在下一次进入聊天后生效。TUI 无头像显示，不受影响。
