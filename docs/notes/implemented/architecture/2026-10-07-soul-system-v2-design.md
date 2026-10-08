# RedCode Soul System V2 — 多人格系统设计

- 日期：2026-10-07
- 类型：Feature Design / Architecture
- 目标：把 Soul 从「TUI 一个人、GUI 一个人」升级为真正可扩展的多人格系统
- 当前默认人格：柳智敏 / Karina、宋雨琦 / YuQi
- 未来人格：赤（Chi）及其它角色

> **Client chooses a default Soul; Session pins an active Soul; Soul defines identity.**

中文：

> **客户端只负责选择默认人格；会话创建时固定当前人格；只有 Soul 能定义“我是谁”。**

---

# 0. 为什么现在要做

当前 RedCode 已经有 Soul，但实际上还不是一个真正的“人格系统”。

现在的实现更接近：

```text
TUI = Tsoul.md = 柳智敏
GUI = Gsoul.md = 宋雨琦
```

由于当前只有两份 Soul，这个对应关系在日常使用中看起来成立。

但：

```text
TUI / GUI 是客户端类型
柳智敏 / 宋雨琦 / 赤 是身份
```

两者不属于同一维度。

当前只是：

```text
TUI 默认用了柳智敏
GUI 默认用了宋雨琦
```

而不是：

```text
TUI 本身就是柳智敏
GUI 本身就是宋雨琦
```

如果后续新增第三人格 Chi，现有二选一模型无法自然表达：

```text
TUI + Chi
GUI + Chi
TUI + YuQi
GUI + Karina
```

因此应在新增第三人格之前完成 Soul V2。

---

# 1. 当前身份硬绑定

## 1.1 `session/instruction.ts`

当前：

```ts
const soulFile = flags.client === "desktop" ? "Gsoul.md" : "Tsoul.md"
```

即：

```text
client
↓
选择 soul 文件
↓
身份
```

---

## 1.2 `session/prompt/shared.ts`

当前：

```ts
sessionSourceLabel(client)
```

内部仍根据 client 选择 `Gsoul/Tsoul`，再读取 Soul 第一行提取名字。

最终 commit 前缀因此走：

```text
client
↓
猜 soul
↓
读第一行
↓
猜身份
↓
[Karina] / [YuQi]
```

Commit 前缀表达的是“谁做的”，不是“从哪个 UI 做的”，这里 owner 错了。

---

## 1.3 TUI `context/local.tsx`

当前 TUI 显示名直接读取：

```text
~/.redcode/souls/Tsoul.md
```

TUI UI 本身也假设：

```text
TUI = Tsoul
```

---

## 1.4 MANUAL

当前文档同样固化：

```text
TUI → Tsoul.md
GUI → Gsoul.md
```

V2 后应降级为旧版默认映射，而不是人格架构定义。

---

# 2. V2 核心不变量

## 2.1 Soul 是身份唯一事实源

任何需要回答：

```text
当前 AI 是谁？
显示什么名字？
commit 用什么前缀？
当前人格正文是什么？
头像是什么？
```

的地方，只能从：

```text
session.soul
→ Soul Registry
```

获取。

禁止：

```text
client === TUI → Karina
client === GUI → YuQi
```

这种推导。

---

## 2.2 Client 只负责默认选择

Client 可以保存：

```text
tui.lastSoul
desktop.lastSoul
```

因为用户可能希望两个客户端长期使用不同人格。

但它表达的是：

```text
这个客户端最近一次选择了哪个 Soul
```

而不是：

```text
这个客户端属于哪个 Soul
```

---

## 2.3 Session 创建时 pin Soul

一个会话创建后：

```text
session.soul = "karina"
```

就保持不变。

后续用户修改：

```text
desktop.lastSoul = "chi"
```

不影响旧会话。

例如：

```text
Session A → karina
修改 GUI 默认 Soul → chi
Session B → chi
Session A 仍然 → karina
```

这符合当前使用习惯：不需要中途切人格。

同时利于：

```text
prefix cache stability
reasoning identity consistency
commit attribution
conversation continuity
```

---

# 3. 非目标

V2 第一版明确不做：

```text
❌ 同一会话中途热切 Soul
❌ 一条消息一个 Soul
❌ Soul 自动根据模型切换
❌ Soul 自动根据 TUI/GUI 强制切换
❌ Soul 与主题强绑定
❌ Soul 与模型强绑定
❌ 把 Soul 做成大型插件框架
```

第一版目标只有：

```text
可发现
可选择
可持久化默认
会话固定
身份统一
方便新增人格
```

---

# 4. Soul 文件命名

当前：

```text
Tsoul.md
Gsoul.md
```

文件名携带客户端语义。

V2 建议迁移为：

```text
~/.redcode/souls/
  karina.md
  yuqi.md
  chi.md
  ...
```

文件名使用稳定 Soul ID，而不是客户端类型。

---

# 5. Soul 文件格式

继续使用 Markdown，但加入轻量 frontmatter。

例如：

```md
---
id: karina
name: 柳智敏
display_name: 敏敏
commit_prefix: Karina
avatar: karina
description: 冷静、细致的协作型助手
---

# 柳智敏 · RedCode Soul

...
```

宋雨琦：

```md
---
id: yuqi
name: 宋雨琦
display_name: 雨琦
commit_prefix: YuQi
avatar: yuqi
description: 直率、活泼的协作型助手
---

# 宋雨琦 · RedCode Soul

...
```

未来赤：

```md
---
id: chi
name: 赤
display_name: 赤
commit_prefix: Chi
avatar: chi
description: 擅长简洁分析与清晰解释
---

# 赤 · RedCode Soul

...
```

---

# 6. Frontmatter 最小字段

建议第一版只定义：

```ts
type SoulMetadata = {
  id: string
  name: string
  displayName?: string
  commitPrefix?: string
  avatar?: string
  description?: string
}
```

`description` 是可选的单行选择器说明，最多 256 个 UTF-8 字节；仅用于列表展示与搜索，不进入人格正文或模型上下文。无此字段的旧 Soul 继续以名称 / ID 作选择器说明。

## `id`

稳定机器标识：

```text
karina
yuqi
chi
```

要求：

```text
lowercase
[a-z0-9-_]
全局唯一
```

## `name`

完整身份名：

```text
柳智敏
宋雨琦
赤
```

## `display_name`

UI 短名：

```text
敏敏
雨琦
赤
```

缺省退到 `name`。

## `commit_prefix`

AI commit 前缀：

```text
Karina
YuQi
Chi
```

## `avatar`

只保存逻辑 key / asset ID。

第一版甚至可以不消费，仅为 GUI 后续头像留扩展位。

## `description`

TUI `/soul` 选择器中的简短说明，可按名称、ID 或说明搜索；超过 256 个 UTF-8 字节或类型错误的 metadata 会作为 Registry issue 暴露。

---

# 7. Metadata 边界

不要把 Soul frontmatter 发展成：

```text
默认模型
reasoning level
temperature
权限
主题
MCP
Skill
系统 prompt override
客户端限制
```

Soul 的职责是：

> **身份与人格。**

模型与执行策略属于其它 owner。

否则以后又会出现：

```text
“用了 Karina 就必须 Sol”
```

这种新的错误绑定。

---

# 8. 新增 Soul Registry

建议新增独立模块：

```text
packages/opencode/src/soul/
  index.ts
  schema.ts
```

职责：

```text
发现 souls/*.md
解析 frontmatter
验证 metadata
读取正文
提供 Soul summary
提供 session Soul lookup
提供 migration helper
```

---

# 9. Soul Registry API

概念接口：

```ts
type Soul = {
  id: string
  name: string
  displayName: string
  commitPrefix: string
  avatar?: string
  path: string
  content: string
}

interface SoulService {
  list(): Effect<SoulSummary[]>
  get(id: string): Effect<Soul>
  exists(id: string): Effect<boolean>
  defaultForClient(client: "tui" | "desktop"): Effect<string>
}
```

UI 选择器只需要 `SoulSummary`，避免每次把几 KB Soul 正文全部传给客户端。

---

# 10. 数据模型：Session 增加 `soul`

当前 `SessionTable` 已有：

```text
client
agent
model
```

建议新增：

```ts
soul: text()
```

Session schema：

```ts
soul: optionalOmitUndefined(Schema.String)
```

CreateInput：

```ts
soul: Schema.optional(Schema.String)
```

`fromRow()` / `toRow()`、sync event、HTTP schema、SDK/OpenAPI 全部同步。

---

# 11. 为什么必须存 Session

不能只读取当前客户端 `lastSoul`。

否则修改默认 Soul 后：

```text
旧会话也会瞬间换人格
```

同时以下都会漂移：

```text
历史 commit attribution
session display name
prefix cache
conversation identity
```

因此：

> **Soul 必须是 Session 的持久属性。**

---

# 12. 新 root Session 解析顺序

建议：

```text
1. CreateInput.soul
2. 当前 client 的 lastSoul
3. legacy default
4. registry first valid Soul
5. no-soul fallback
```

概念上：

```ts
requestedSoul
  ?? preferences[client].lastSoul
  ?? legacyDefault(client)
  ?? registry.first()
  ?? undefined
```

---

# 13. 默认映射仍然可以保留

为了保持现有体验：

```text
TUI first migration default = karina
GUI first migration default = yuqi
```

但这里只是：

```text
migration/default preference
```

不是身份推理。

以下都应合法：

```text
TUI lastSoul = yuqi
GUI lastSoul = karina
TUI lastSoul = chi
GUI lastSoul = chi
```

---

# 14. Client Preference

概念上：

```ts
type SoulPreference = {
  lastSoul?: string
}
```

分客户端保存：

```text
tui.lastSoul
desktop.lastSoul
```

Preference 只回答：

> 下一个新 root session 默认用谁？

---

# 15. GUI 交互设计

设置增加：

```text
Personalization / 个性化
  └─ Soul
```

Soul 选择器和模型、主题一样：

```text
当前 Soul

[头像] 敏敏
       柳智敏

更换 >
```

列表：

```text
柳智敏 / 敏敏
宋雨琦 / 雨琦
赤
...
```

可显示：

```text
avatar
displayName
name
current selection
```

---

# 16. GUI 修改语义

GUI 设置里切 Soul：

```text
只更新 desktop.lastSoul
```

提示：

```text
“用于之后新建的会话；当前会话保持原人格。”
```

不做当前会话热替换。

---

# 17. GUI 新建会话流程

当前：

```text
first prompt
↓
session.create
```

V2：

```text
first prompt
↓
读取 desktop.lastSoul
↓
session.create({ soul })
↓
session.soul pinned
↓
首轮 prompt
```

Soul 必须在首轮 system prompt 前已经确定。

---

# 18. TUI 交互设计

用户期望：

> 新建对话时可通过 `/soul` 选择；不选择则继承上一次使用 Soul。

正式设计：

```text
/soul
```

打开：

```text
Soul

✓ 敏敏    柳智敏
  雨琦    宋雨琦
  赤      赤
```

选中后：

```text
pendingSoul = "chi"
tui.lastSoul = "chi"
```

尚未创建 Session 时不必提前建 Session。

---

# 19. `/soul <id>`

支持：

```text
/soul karina
/soul yuqi
/soul chi
```

未知 ID：

```text
Unknown Soul: xxx
Available: karina, yuqi, chi
```

---

# 20. 不选择 `/soul`

自动继承：

```text
tui.lastSoul
```

例如：

```text
昨天 /soul chi
今天新建会话不操作
→ 仍然 Chi
```

因此日常没有额外操作成本。

---

# 21. 已存在 Session 中调用 `/soul`

第一版不热切。

若当前：

```text
session.soul = karina
```

用户选择：

```text
/soul chi
```

则：

```text
tui.lastSoul = chi
current session remains karina
```

提示：

```text
“已设为新会话默认 Soul；当前会话继续使用敏敏。”
```

---

# 22. Active Soul 注入

当前 `instruction.ts`：

```ts
flags.client === "desktop" ? Gsoul : Tsoul
```

应删除。

改为：

```text
sessionID
↓
Session.get(sessionID).soul
↓
SoulRegistry.get(soulID)
↓
inject content
```

---

# 23. 推荐：Soul 从 Instruction 中拆出去

当前 `Instruction.system()` 负责 AGENTS / MEMORY / Soul / config instructions。

V2 推荐改为：

```ts
const [
  skills,
  env,
  instructions,
  soul,
  mcpGuide,
  modelMsgs
] = ...
```

其中：

```text
instructions = AGENTS + MEMORY + config instructions
soul = SoulService.forSession(sessionID)
```

优势：

```text
Soul 不再参与 instruction path discovery
Soul 不再依赖 client
Soul 不再与 nearby AGENTS 逻辑混在一起
Soul 可以独立 budget
身份 owner 清晰
```

---

# 24. Soul Budget

建议 Soul 独立硬上限，例如：

```text
SOUL_MAX_BYTES = 16 KiB
```

具体值可实测。

超限：

```text
整份拒绝加载
+ 清晰报错
```

不要静默截断人格正文。

---

# 25. Soul 缺失时

若旧 Session：

```text
soul = chi
```

但 `chi.md` 被删除：

禁止偷偷切到：

```text
Karina / YuQi
```

推荐：

```text
显示明确 warning
保留 session.soul = chi
使用 minimal no-soul fallback
```

例如：

```text
Soul "chi" is missing. This session remains pinned to "chi".
Restore the file or create a new session with another Soul.
```

---

# 26. Commit Prefix

当前 `sessionSourceLabel(client)` 应退役。

新链：

```text
session.soul
↓
SoulMetadata.commitPrefix
↓
[Karina] / [YuQi] / [Chi]
```

Fallback：

```text
commitPrefix
→ displayName
→ name
→ AI
```

永不 fallback 到：

```text
TUI / GUI
```

因为 Client 不是身份。

---

# 27. Session / UI 显示名

所有显示：

```text
敏敏
雨琦
赤
```

统一从：

```text
Session.soul
→ SoulMetadata.displayName
```

获取。

不再读取固定 Soul 文件第一行。

---

# 28. TUI `readAgentName()` 改造

当前写死读取 `Tsoul.md`。

改为：

```text
existing session
→ session.soul

new session
→ pendingSoul ?? tui.lastSoul

↓
SoulRegistry summary
↓
displayName
```

---

# 29. GUI 显示逻辑

GUI：

```text
已有 Session → session.soul
新会话页面 → desktop.lastSoul
```

禁止：

```text
client=desktop → YuQi
```

---

# 30. 子代理 Session

主会话：

```text
soul = karina
```

创建 execute / explore child session 时：

```text
child.soul = parent.soul
```

原因：

```text
子代理属于该主会话执行链
commit attribution 应保持主身份
日志和审计保持统一
```

但：

```text
身份归属继承
≠
子代理必须表演 Soul
```

execute / explore 仍可使用自己的专属 agent prompt。

---

# 31. Fork Session

Fork 必须：

```text
fork.soul = original.soul
```

而不是读取当前 `lastSoul`。

规则：

```text
new root → client default
fork → inherit original
child → inherit parent
resume → stored soul
```

---

# 32. Preference 与 Session 的区别

必须在代码和文档里写清：

```text
Preference = 下次用谁
Session = 这次是谁
```

Preference 可变：

```text
desktop.lastSoul = chi
```

Session 第一版不可变：

```text
session.soul = karina
```

---

# 33. 不公开普通 `setSoul(sessionID)`

第一版不要提供一般性的 mid-session Soul 修改 API。

数据库 migration 可以内部更新，但产品层不提供：

```text
PUT /session/:id/soul
```

避免无意中重新支持热切。

---

# 34. 旧 Session 迁移

旧 Session 只有：

```text
client
```

没有 `soul`。

迁移可以一次性按旧版本真实语义：

```text
client=tui → soul=karina
client=desktop → soul=yuqi
```

这里允许 client→Soul 映射，因为它是在解释历史版本，而不是新架构运行时推断身份。

---

# 35. 文件迁移

首次 V2 migration：

```text
Tsoul.md exists && karina.md missing
→ 迁移到 karina.md

Gsoul.md exists && yuqi.md missing
→ 迁移到 yuqi.md
```

第一版建议保守：

```text
copy
```

不要直接删除旧文件。

稳定一个版本后再清理 legacy 文件。

---

# 36. 自定义旧 Soul 的迁移

不能假设所有用户的：

```text
Tsoul.md = 柳智敏
Gsoul.md = 宋雨琦
```

产品代码应：

1. 尝试解析已有 metadata / 第一行；
2. 若匹配官方模板，迁移为 `karina` / `yuqi`；
3. 若明显自定义，生成稳定 ID，如：
   ```text
   legacy-tui
   legacy-gui
   ```
   或 slug；
4. 不覆盖用户正文。

当前用户本人可直接落到：

```text
karina / yuqi
```

但迁移代码不能写死所有用户如此。

---

# 37. Seed 模板

当前：

```text
project/template/Tsoul.md
project/template/Gsoul.md
```

建议迁为：

```text
project/template/souls/karina.md
project/template/souls/yuqi.md
```

未来可以再加：

```text
chi.md
```

是否默认播种第三人格，可单独决定。

---

# 38. Soul 发现与排序

Registry 扫描：

```text
~/.redcode/souls/*.md
```

每个文件：

```text
parse frontmatter
validate id
build summary
```

第一版排序：

```text
stable filename sort
```

未来如需自定义 order 再加，不必现在过度设计。

---

# 39. Duplicate / Invalid Soul

重复 ID：

```text
a.md → id: karina
b.md → id: karina
```

必须显式报错。

不要后一个静默覆盖。

Invalid Soul 包括：

```text
frontmatter malformed
id 非法
duplicate id
正文为空
文件超限
```

一个坏 Soul 不应让整个 Registry 崩溃。

建议：

```text
valid souls 正常列出
invalid souls 作为 issue 返回
```

GUI 可以显示：

```text
⚠ chi.md — invalid frontmatter
```

---

# 40. Soul API

建议：

```text
GET /soul
```

返回 summaries：

```json
[
  {
    "id": "karina",
    "name": "柳智敏",
    "displayName": "敏敏",
    "commitPrefix": "Karina",
    "avatar": "karina"
  }
]
```

普通列表不返回正文。

如未来有编辑器，再提供：

```text
GET /soul/:id
```

---

# 41. Session API

`session.create`：

```json
{
  "soul": "karina"
}
```

Session response：

```json
{
  "id": "...",
  "client": "tui",
  "soul": "karina"
}
```

`client` 继续保留，用来记录会话从哪个客户端创建。

但：

> client 不再具有身份语义。

---

# 42. Plugin Event

当前 `session.start` 建议增加：

```ts
soul?: string
```

插件如果需要知道当前人格，直接读取该字段。

禁止插件根据 client 自己猜。

---

# 43. Prefix Cache

Session pin Soul 后：

```text
Soul 对同一 session 稳定
```

因此天然利于 prefix cache。

关键不变量：

```text
修改 desktop.lastSoul
```

不得：

```text
invalidate 已存在 Session prefix
```

---

# 44. 用户编辑 Soul 文件

例如：

```text
session.soul = karina
```

用户修改 `karina.md`。

第一版建议继续：

```text
当前 Session 不 hot reload
新 Session 生效
```

落地记录：正文冻结已由 `soul_version` 内容寻址版本表 + `session.soul_body_hash` 跨重启/缓存回收成立，见实现记录「持久版本决策」：`docs/notes/implemented/architecture/2026-10-07-soul-system-v2.md`。

未来如真需要，可设计显式：

```text
/reload-soul
```

但第一版不要自动热加载，避免缓存和身份漂移。

---

# 45. GUI 的产品可见收益

这次功能不是纯后端重构。

可见形态：

```text
Settings
→ Personalization
→ Soul

当前默认 Soul
[头像] 敏敏
       柳智敏
       Karina
       更换 >
```

这是用户可以每天直接感受到的功能。

---

# 46. TUI 的产品可见收益

TUI：

```text
/soul
```

可以在新会话阶段快速选人格。

状态栏 / 输入区如需要可显示：

```text
RedMind · Karina · GPT-6.1 Sol
```

但不是第一版硬要求。

关键是名字来自 active Soul。

---

# 47. Slash Command 统一

正式命令：

```text
/soul
```

旧：

```text
/tui-persona
/gui-persona
```

进入 deprecated。

迁移期可作为别名：

```text
/tui-persona → /soul karina
/gui-persona → /soul yuqi
```

---

# 48. 产品术语统一

以后统一叫：

```text
Soul
```

不要长期混用：

```text
persona
character
identity profile
```

避免 owner 再次分裂。

---

# 49. 推荐数据流

```text
┌────────────────────┐
│ ~/.redcode/souls/  │
│ karina.md           │
│ yuqi.md             │
│ chi.md              │
└──────────┬─────────┘
           │
           ▼
      Soul Registry
           │
      ┌────┴────┐
      │         │
      ▼         ▼
 GUI prefs    TUI prefs
desktop.last  tui.last
      │         │
      └────┬────┘
           │ new root session
           ▼
      Session.soul
        (pinned)
           │
   ┌───────┼────────┬───────────┐
   ▼       ▼        ▼           ▼
 prompt   commit   UI name    plugins
 inject   prefix   / label    / events
```

---

# 50. 推荐模块边界

## `soul/schema.ts`

只定义：

```text
metadata
summary
validation
```

## `soul/index.ts`

负责：

```text
discover
parse
get
list
legacy migration helper
```

## `session`

只保存：

```text
soul id
```

不知道 Markdown 细节。

## GUI / TUI

只消费：

```text
SoulSummary
```

不直接读文件。

## instruction / prompt

只消费：

```text
resolved session soul content
```

不根据 client 选 Soul。

---

# 51. 不要让客户端直接读 Soul 文件

当前 TUI 自己 `Bun.file(Tsoul.md)` 属于 layering leak。

V2 应删除。

客户端统一通过：

```text
SDK/API
```

获取：

```text
Soul summaries
current Session.soul
```

这样 GUI / TUI 共用同一份 registry 真相。

---

# 52. 实施阶段

## Phase 1 — Soul Registry

新增：

```text
soul/schema.ts
soul/index.ts
```

支持：

```text
karina.md
yuqi.md
list/get/validate
```

暂不动 UI。

## Phase 2 — Session pin

数据库增加：

```text
session.soul
```

更新：

```text
Info
CreateInput
createNext
fork
child session
sync
HTTP
SDK/OpenAPI
```

规则：

```text
new root → requested/default Soul
fork → inherit original
child → inherit parent
```

## Phase 3 — Prompt identity 解耦

删除：

```text
instruction.ts client→Tsoul/Gsoul
```

Soul 独立注入。

删除：

```text
sessionSourceLabel(client)
```

commit identity 改从 Session Soul 获取。

## Phase 4 — TUI

实现：

```text
/soul
/soul <id>
tui.lastSoul
```

删除：

```text
readAgentName() → Tsoul.md
```

## Phase 5 — GUI

新增：

```text
Settings → Personalization → Soul
```

支持：

```text
desktop.lastSoul
```

新 Session create 时带 Soul。

## Phase 6 — Migration

迁移：

```text
Tsoul/Gsoul
旧 sessions
旧 slash commands
MANUAL
seed templates
```

## Phase 7 — 第三人格验证

加入最小测试 Soul：

```text
chi.md
```

不是为了立即正式发布，而是证明：

> 系统已经不再写死只有 Karina / YuQi。

如果加第三人格无需修改：

```text
instruction.ts
session logic
commit logic
TUI logic
GUI logic
```

只需增加 `.md`，架构才算真正通过。

---

# 53. 测试矩阵

## Registry

```text
列出 2/3/N 个 Soul
stable sort
frontmatter parse
invalid id
duplicate id
missing metadata
oversize
```

## New Session

```text
TUI lastSoul=karina → new session=karina
GUI lastSoul=yuqi → new session=yuqi
explicit soul=chi → session=chi
unknown soul → clear error
```

## Persistence

```text
session A = karina
change default = chi
resume A
→ still karina

new B
→ chi
```

## Fork

```text
A=karina
default=chi
fork A
→ fork=karina
```

## Child

```text
parent=yuqi
execute child
→ child.soul=yuqi
```

## Commit

```text
karina → [Karina]
yuqi → [YuQi]
chi → [Chi]
```

不得读取 client。

## TUI Display

```text
client=tui
session=chi
→ 显示 Chi / 赤
```

不得显示 Karina。

## GUI Display

```text
client=desktop
session=karina
→ 显示 Karina
```

不得显示 YuQi。

## Cache

```text
change desktop.lastSoul
→ existing session prefix unchanged
```

## File deletion

```text
session=chi
delete chi.md
resume
→ explicit missing Soul warning
→ 不偷偷切 Karina / YuQi
```

---

# 54. 第三人格验收

新增：

```text
~/.redcode/souls/chi.md
```

GUI：

```text
Settings → Soul → 赤
→ new session
```

TUI：

```text
/soul chi
→ new session
```

最终必须同时满足：

```text
模型自认：赤
UI 显示：赤
session.soul：chi
commit prefix：[Chi]
旧 Karina/YuQi session 不变
```

且核心代码中不得新增：

```text
if soul === "chi"
```

否则仍然是假扩展。

---

# 55. 迁移验收

升级前：

```text
TUI → 柳智敏
GUI → 宋雨琦
```

升级后，用户什么都不设置：

```text
TUI 仍默认柳智敏
GUI 仍默认宋雨琦
```

用户体验无感。

内部语义从：

```text
client decides identity
```

变成：

```text
client default preference chooses Soul
```

---

# 56. 最终架构原则

建议写入架构 note 与核心代码注释：

> **Soul is the sole source of truth for assistant identity.**

> **Client type may choose a default Soul, but must never be used to infer identity.**

> **A Session pins its Soul at creation and does not silently change identity later.**

> **Adding a new Soul must not require changes to core session, prompt, commit, TUI, or GUI identity logic.**

第四条是最重要的扩展性验收。

---

# 57. 最终产品形态

GUI：

```text
Settings
→ Personalization
→ Soul
→ 柳智敏 / 宋雨琦 / 赤 / ...
```

TUI：

```text
/soul
→ 选择人格
→ 后续新会话默认继承
```

底层：

```text
Soul Registry
+
client lastSoul preference
+
session pinned soul
+
single identity source
```

这样 RedCode 就从：

```text
“两套客户端各带一个人格”
```

真正升级为：

# **“一个拥有可扩展人格阵容的长期 Code Agent。”**

这是一项用户能在前端直接感受到的功能，而不只是继续修补缓存、提示词、竞态和内部工作流。

---

_End of design._
