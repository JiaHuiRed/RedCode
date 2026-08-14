# 同一 worktree 在 project 表里堆多行：选择器按路径去重

状态:implemented

## 问题

TUI 启动的工作区选择器里出现重复条目（用户 2026-08-14 报，截图含 attendance ×2、financialcost ×2、RedClaw ×2）。

查 `redcode.db` 的 project 表（28 行）确认不是渲染问题，是**数据层真有多行**，三对的 worktree 字符串完全相同：

| 项目 | 旧行 | 新行 | 触发 |
|---|---|---|---|
| attendance | `path-234ba6aca6b16360`（0 会话，07-27） | `176d6f2c…`（2 会话，08-08） | 先在无 git 时打开，后 git init + 首提交 |
| financialcost | `path-93b370cd4ae0f9cc`（0 会话，08-13 07:58） | `0e7db745…`（15 会话，08-13 09:00） | 同上，间隔 1 小时 |
| RedClaw | `9965e80f…`（1 会话，05-29） | `f6dd362d…`（0 会话，08-08） | `.git` 被删过重建，根提交变了 |

根因在 `project/project.ts`：id 的来源有三档优先级——`<gitdir>/redcode` 缓存文件 → `git rev-list --max-parents=0 HEAD` 根提交哈希（并写入缓存）→ `pathFallbackId()` 的 `path-<sha256[:16]>`。而 upsert 按 **id** 查（`where(eq(ProjectTable.id, data.id))`），所以同一个 worktree 一旦换了 id 就**新插一行**，旧行没人清。

回落档不写缓存文件（写缓存只在拿到根提交那一支），所以 `path-` 阶段每次都重新派生，一旦 git 能答就切换到根提交 id —— 这个跃迁是必然发生的，不是偶发。

实测确认它还会继续长：`D:\AI\RedClaw` 当前 `.git` 已不存在，下次打开会走 path 回落再插第三行。

## 决策

两个读取入口都按规范化路径（resolve + 正斜杠 + 去尾分隔符 + 小写）去重，另做一次性清库。

- **TUI 选择器**（`cli/project-selector.ts` 的 `loadProjects()`）：保留首次出现的行即可。安全性来自返回值语义——`selectProjectInteractive()` 返回 **worktree 路径**而非 project id，选中后由正常流程重新解析当前 id，所以同组留哪一行等价。
- **API `Project.list`**（`project/project.ts`，GUI 工作区列表的数据源）：客户端**按 id 导航**，留错行等于把用户的历史会话藏起来，所以判据是**保留会话最多的那行**（`session.project_id` 分组计数），并列时留 `time_created` 较新的。判据抽成纯函数 `dedupeByWorktree` 并单测（6 用例覆盖两种真实形态、并列判据、路径规范化、缺 `time_created`）。
- **清库**：删掉三个 0 会话的多余行（`path-234ba6ac`、`path-93b370cd`、`f6dd362d`），28 → 25 行。删前整库备份，删时按 id 复验会话数为 0 才动手，任何一行有会话则整体中止。

## 备选与否决理由

- **改 upsert 按 worktree 归并**（数据层根治）：否决——id 是 `session.project_id` 的外键，归并要迁移会话（RedClaw 那对就是 1 + 0 会话），跨行迁移的失败模式比这个显示问题严重得多；且 `path-` → 根提交的跃迁本身是正确行为（git 仓就该用根提交做身份），要动的是"旧行怎么退休"而不是"id 怎么算"。
- **只清库不改代码**：否决——清库不防复发，`.git` 状态一变就长新行；去重是幂等的，两者一起上才既干净又不反弹。
- **API 层也保留首次出现的行**（与 TUI 同策略）：否决——TUI 返回路径、API 返回 id，语义不同，同策略会让 GUI 打开到空会话的那行。

## 后果

- TUI 选择器与 GUI 工作区列表都不再显示同名重复项，库里也无重复 worktree。
- **复发路径未堵**：目录的 git 状态变化仍会插新行（`D:\AI\RedClaw` 当前无 `.git`，下次打开必长一行），只是不再可见、且新行因 0 会话不会顶掉有历史的那行。真要根治得设计"同 worktree 旧行退休 + 会话迁移"，见上方否决理由。
- 备份留在 `E:\AI\redcode.db.bak-20260814-dupclean`（625 MB），确认无碍后可删。
