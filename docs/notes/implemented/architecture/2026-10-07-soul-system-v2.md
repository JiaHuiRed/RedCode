# Soul System V2：Soul 成为身份唯一事实源

状态:implemented

## 问题

Soul 的实际实现是「client→身份」硬绑定：`session/instruction.ts:254` 按 `client === "desktop"` 选 Gsoul/Tsoul 注入；`session/prompt/shared.ts:17` 的 `sessionSourceLabel(client)` 读文件第一行喂标题前缀与 commit 身份，fallback 是「TUI/GUI」——把 UI 当身份；TUI `local.tsx` 写死读 `Tsoul.md`；`project/bootstrap.ts:58` 只播种两个旧文件；`doctor --prefix` 的源清单也按 client 列。

TUI/GUI 是客户端类型，柳智敏/宋雨琦/赤 是身份——两者不在一个维度。加第三人格（赤）时现有二选一模型无法表达「TUI + Chi」「GUI + Karina」等组合。驱动：设计文档已入仓——`docs/notes/implemented/architecture/2026-10-07-soul-system-v2-design.md`（2026-10-07）。

## 决策

三条不变量：

1. **Soul 是身份唯一事实源**——注入正文、显示名、commit 前缀全部从 `session.soul → Soul Registry` 取；禁止 client→身份推导（"Client type may choose a default Soul, but must never be used to infer identity"）。
2. **Client 只负责默认选择**——`tui.lastSoul` / `desktop.lastSoul` 是「下次新会话用谁」的偏好，不是身份归属。
3. **Session 创建时 pin Soul**——`session.soul` 创建后不变；改默认不影响旧会话；fork 继承原会话、child 继承父会话、resume 用存储值。

实现进度（随各 phase 同 commit 更新）：

- **Phase 1（已落地）**：`src/soul/` Registry——发现 `~/.redcode/souls/*.md`、解析 frontmatter（`id`/`name`/`display_name`/`commit_prefix`/`avatar`）、stable filename sort；坏文件记 issue 不崩整个 Registry（invalid id / duplicate id / 超 16 KiB / 空正文）；无 frontmatter 旧文件按「文件名 id + 首标题名」兼容，不猜测身份归属；`defaultForClient` 迁移期映射 tui→karina / desktop→yuqi（只作缺省偏好，不是推理）。
- Phase 2+（待落地）：session.soul 列（Drizzle migration + data-migration 按 client 回填）、prompt 解耦（Soul 独立注入与预算）、TUI `/soul`、GUI 设置面板、旧文件迁移与旧命令退役、第三人格验收。

## 备选与否决理由

- **同一会话热切 Soul**：否决——身份中途漂移摧毁 prefix cache 与 commit attribution（设计 §3）。
- **Soul frontmatter 扩成「默认模型/推理档/权限/主题」**：否决——那是模型与执行策略的 owner，混入会造出「用了 Karina 就必须 Sol」式的新错误绑定（设计 §7）。
- **Registry 缓存正文 / hot reload 机制**：否决——第一版不做；souls 文件数量小，按需读盘，用户改文件对新会话自然生效（设计 §44）。
- **产品层 mid-session Soul 修改 API（PUT /session/:id/soul）**：否决——避免无意中重新支持热切（设计 §33）。

## 后果

- 身份缺失不静默切换：`session.soul` 指向已删除的 soul 时保留 pin + minimal no-soul fallback 加 warning，禁止偷偷切 Karina/Yuqi（Phase 3 落地时验证）。
- commit 前缀来源改为 `commitPrefix → displayName → name → AI`，永不 fallback 到 TUI/GUI（Phase 3 落地时验证）。
- 「加新 Soul 不改核心」是硬验收：Phase 7 加 chi.md 必须零核心改动，核心中禁止出现 `if soul === "chi"`。
