# 设计系统硬约束进 frontend-design skill

状态:implemented

## 问题

ZCode（v3.14.3）审计里最值得学的一层，是它把「给 agent 看的规范」做成一等公民：`DESIGN.md` 537 行，开头即声明 This file is meant for coding agents。真正起作用的不是它长，而是其中三条是**硬约束**而非风格建议：

- **字阶是封闭集**：禁止 Tailwind 内置字号与任意值（`text-[13px]`），唯一缩放入口是 `--ui-font-size`；「违反本节视为设计系统缺陷而非风格偏好」。
- **最小档带用途禁令**：`text-ui-2xs` 只准用于图表轴家具。没有这条禁令，最小档会渗进所有地方——层级就是这么塌的。
- **语义色 token 带用途禁令**：background → surface → card → popover → menu 的 elevation 链不许混用，结构面禁作通用卡片色；成功/警告/危险各配一对 foreground token，色盲用户不必只靠色相读状态。

RedCode 自己有一套更细的 token 体系（`packages/ui/src/styles/theme.css` 660 行，surface/text/border/icon/syntax/markdown 六族，明暗 + 三套配色方案），但**零门禁**。两个可复现的实证：

- `--font-size-x-small` 全仓 **6 处引用、0 处定义**（`packages/app/src/index.css:136,161`、`packages/ui/src/components/{context,dropdown}-menu.css:89,102,89,103`）。CSS 变量未定义时 `font-size` 落到继承值，六处静默失效，无报错无告警。
- `packages/ui/src` 与 `packages/app/src` 共 **100 处 `font-size: Npx` 字面量**绕过标度，其中 44 处是 11–14px——而标度只有 13/14/16/20 四档，11px 与 12px 根本不在标度上。`v2/components/*.css` 是重灾区（radio-v2、line-comment-v2、tool-error-card-v2 各 5 处）。

即：标度存在，圆角逐档也已三份合一（260831，唯一定义在 `packages/ui/src/styles/tailwind/index.css` 的 `@theme`），但没有任何东西在守。

## 决策

把上述硬约束写进 `frontend-design` skill，**不新建文档体系**。skill 的 body 只在被 skill 工具加载时进上下文，不进每轮固定前缀——这是它区别于 AGENTS.md / DESIGN.md 的关键成本属性，也是选它做载体的理由。追加两节（`## Typography scale is a hard constraint`、`## Semantic tokens carry usage bans`）加一节 `## Enforcement`，规则用可迁移的机制表述，但每条都锚到 RedCode 自己的 token 名与文件行号，使规则在本仓可直接执行。

顺带修掉一个既有的 seed/live 分叉：`~/.redcode/skill/frontend-design/SKILL.md`（live）比 `seed/skill/frontend-design/SKILL.md` 多出 260921 的「Cards: gentle lift」偏好段。`seed/{skill,command}` 是 seed-only——本机已有同名则不覆盖，只改 seed 本机永不生效。方向只能是 live → seed（live 是本机事实来源），先把那段并回 seed 使两份内容一致，再对两份追加同样的新章节。

## 备选与否决理由

- **照抄 ZCode 新建 DESIGN.md / CONTEXT.md**：否决——RedCode 的同类信息已由 `theme.css` 与 CHANGELOG 圆角注释承载，再立一份文档体系就是第三处真相；且新文档不在任何自动加载路径上，等于没人读。
- **写进 `packages/app/AGENTS.md`**：否决——包级 AGENTS.md 不自动注入（引擎只取全局 + 第一个命中的项目级，见 `session/instruction.ts:127`），要人主动 read；且规则定义在 `packages/ui`，写在 app 包指令里位置错。
- **CI 加 lint 规则扫 `font-size` 字面量与未定义 token**：本轮否决——ZCode 自己的审计就发现 `text-ui-2xs` 没有 lint 规则在守；而 RedCode 现存 100 处字面量，一次性收编是大范围视觉回归，远超「扩展 skill」的范围。规则本轮是「有文档无牙齿」，见后果。
- **改 skill frontmatter description 提升触发精度**：否决——description 随 `<available_skills>` **每轮全量注入**，为它付固定前缀不值；现有描述已覆盖「构建前端界面 / 参考图实现风格」的触发场景。

## 后果

- skill 159 行 / 6377 字节 → 218 行 / 9907 字节，**无字节上限**。skill body 不进固定前缀，tools schema 未变，**不触发 KV cache 前缀作废**；只在被 skill 工具加载的那一轮进对话流。
- 零代码改动，无 typecheck 必要。验证：`bun test ./test/skill/skill.test.ts ./test/tool/skill.test.ts` 18 pass 0 fail（确认 frontmatter 仍可解析、skill 工具仍可取到内容）；seed 与 live 逐字节相同。
- **未做**：100 处 `font-size` 字面量的收编、`--font-size-x-small` 的定义或删除。规则现在是文档而非门禁，识别签名是「新代码里出现 `font-size: Npx` 或引用一个 `theme.css` 里没有的 `--font-size-*`」。要做的时候先定义最小档（它已有隐含角色：菜单分组标签 / 条目描述 / 快捷键提示，即「弱元数据」），再逐包收编，别一次全改。
