# Module reading pack：进场先读有界上下文

状态:implemented

## 问题

改造一个模块前， agent 习惯「进场先翻几十个文件」：目录树逐个 glob、入口逐个 read、
测试逐个找。本仓 3973 个 TS 文件、8 个 workspace 包，这套动作每次都把主线上下文烧掉一大块，
而且翻出来的信息没有结构——哪是公开入口、谁在消费、spec 与测试在哪，全靠临场拼。

ZCode 用 `pnpm architecture:context <module-id>` 解决同一件事（`scripts/architecture/index.mjs`），
输出 owner/managed/requires/files/publicEntrypoints/direct dependency contracts/boundaries。
RedCode 没有 module.ts + contract.ts 那套显式模块清单（见 todo #8，尚未落地），但
package.json 的 exports、workspace 依赖表、docs/notes、test/ 目录这四样现成信息已经足够拼出
一份可用的阅读包。

## 决策

- 新增 `script/module-context.ts`，根 package.json 加别名 `module:context`：
  `bun run module:context <packages/app | packages/opencode/src/session | ...>`。
- 只读、无副作用、不引入依赖（node:fs + node:path，Bun 直接跑），单次约 270ms。
- 输出固定七段，顺序即阅读顺序：
  1. header —— repo 路径 + HEAD 短 sha + 生成时间（ HEAD 直接读 `.git/HEAD` 并解引用 ref，
     不起 git 子进程）
  2. Package —— name / version / 相关 scripts（dev/build/typecheck/test/lint）
  3. Public entrypoints —— 解析 package.json `exports` 的每个子路径并标注是否真的存在，
     退化成 main/module/types；子路径模块额外列出自身 index
  4. Source map —— 按目录聚合文件数与行数（降序），再列 largest files top 8
  5. Internal dependencies —— 自身依赖里的 workspace 包
  6. Consumed by —— 包级反向依赖（扫所有 workspace 包的 package.json）
  7. Specs & decision notes —— 扫 docs/notes 全量 markdown，正文含模块路径即命中
  8. Tests —— 模块内的 test 文件；模块内没有时退到包级 `test/` 下同名目录
     （本仓惯例 `src/session ↔ test/session`）
- 模块定位：从入参目录向上找第一个带 package.json 的目录作为包根，模块 = 包内子路径
  （包自身则为 `.`）；workspace 包表从根 package.json 的 `workspaces.packages` globs 构建。
- 路径输出统一成正斜杠（Windows 下 `path.relative` 给反斜杠，粘进对话会失效）；
  notes 匹配前把 `moduleRel` 也转成正斜杠，否则 Windows 上命中率恒为 0。

## 备选与否决理由

- **复用 jcodemunch 索引**：否决——索引要额外构建与更新（见全局记忆 #156），且它答的是
  「符号在哪」而不是「这个模块的边界与契约是什么」；本脚本答后者，两者互补不互斥。
- **做成 architecture-check 的子命令**：否决——RedCode 没有 architecture-policy.yaml，
  挂过去会让脚本依赖一个不存在的门禁体系；独立脚本 + package.json 别名足够。
- **输出 JSON**：否决——消费方是人（ agent 读），固定分段的文本比 JSON 更省 token 也更好读。

## 后果

- 进场成本从「几十次工具调用」降到一次命令 + 一次阅读。
- 只反映 package.json / 文件系统 / docs/notes 的静态事实，不解析 import 图：
  `Consumed by` 是包级粒度，子路径级的真实反向依赖仍要靠 grep 或 jcodemunch。
  这是已知边界，不是漏做——它决定「该读哪些文件」，不决定「能不能改」。
- `largest files` 只列前 8 个；模块内若无代码文件则 Source map 为空段，不报错。

## 回链

- `script/module-context.ts`
- `package.json`（`module:context` 脚本别名）
