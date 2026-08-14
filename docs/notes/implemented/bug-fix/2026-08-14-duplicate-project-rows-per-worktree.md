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

`cli/project-selector.ts` 的 `loadProjects()` 按规范化路径（resolve + 正斜杠 + 去尾分隔符 + 小写）去重，保留首次出现的行。

安全性来自选择器的返回值语义：`selectProjectInteractive()` 返回的是 **worktree 路径**而非 project id，选中后由正常流程重新解析当前 id，所以同组保留哪一行完全等价。

## 备选与否决理由

- **改 upsert 按 worktree 归并**（数据层根治）：否决——id 是 `session.project_id` 的外键，归并要迁移会话（RedClaw 那对就是 1 + 0 会话），跨行迁移的失败模式比这个显示问题严重得多；且 `path-` → 根提交的跃迁本身是正确行为（git 仓就该用根提交做身份），要动的是"旧行怎么退休"而不是"id 怎么算"。
- **清库删掉旧行**：否决为独立动作——三个待删行当前都是 0 会话（`path-234ba6ac`、`path-93b370cd`、`f6dd362d`），删了确实干净，但删库不可逆且不防复发（RedClaw 下次打开还会长新行）。去重是幂等的，先上去重；清库作为可选的一次性整理，需用户单独点头。
- **API 层 `Project.list` 去重**（GUI 侧同源问题）：否决为本次范围——GUI 工作区列表按 id 导航，去重要选"留哪行"（应留有会话的那行），是另一个决策；用户本次报的是 TUI。GUI 侧重复仍存在，已知。

## 后果

- TUI 选择器不再显示同名重复项；DB 里的多余行仍在，只是不展示。
- GUI 的工作区列表未修，仍会显示重复。
- 复发路径未堵：目录的 git 状态变化仍会插新行，只是不再可见。真要根治得设计"同 worktree 旧行退休 + 会话迁移"，见上方否决理由。
