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

- **Phase 1（已落地）**：`src/soul/` Registry——发现 `~/.redcode/souls/*.md`、解析 frontmatter（`id`/`name`/`display_name`/`commit_prefix`/`avatar`/可选 `description`）、stable filename sort；description 最多 256 UTF-8 字节，仅供选择器展示/搜索，不进人格正文或模型上下文；坏文件记 issue 不崩整个 Registry（invalid id / duplicate id / 超 16 KiB / 空正文 / 无效或超限 description）；无 frontmatter 旧文件按「文件名 id + 首标题名」兼容，不猜测身份归属；`defaultForClient` 迁移期映射 tui→karina / desktop→yuqi（只作缺省偏好，不是推理）。
- **Phase 2–6（实现与定向验证完成）**：Session 的 Info/CreateInput/DB/plugin 事件贯通；root 显式 ID 在服务边界校验，fork/child 继承存储 pin（包括来源已删除的 ID）；GET `/soul` 仅返回 summaries，另有 issues/default 端点，SDK/OpenAPI 两份均重生成。TUI `/soul` 与 GUI 个性化设置仅改未来默认；两端显式解析各自客户端默认并传创建请求，不能把共享服务端的客户端类型当来访客户端。旧文件独占复制、正文保留、冲突可见；历史回填保留已有 pin，优先继承 parent，未知 client 不猜。无旧文件时只在迁移边界恢复旧内嵌默认。
- **Phase 7（部分验收，仍有接力项）**：用户提供的 `wonyoung` 原 MD 通过真实临时 Registry/Session/DB 测试，源文件不变，没有加入正式 seed。真实 app 源码浏览器冒烟通过：元英可选且偏好持久化，已有雨琦会话不变，新会话显示元英，pageErrors 为零。另以真实 SessionPrompt 走本地 provider HTTP fixture，捕获出站体并验证元英原正文、显示名与 `[Wonyoung]` 署名。浏览器 API 与模型回复使用隔离 fixture，不代表 live sidecar 或真实模型人格回复。子代理多次空返回/截断，不能算独立审查通过。

## 备选与否决理由

- **同一会话热切 Soul**：否决——身份中途漂移摧毁 prefix cache 与 commit attribution（设计 §3）。
- **Soul frontmatter 扩成「默认模型/推理档/权限/主题」**：否决——那是模型与执行策略的 owner，混入会造出「用了 Karina 就必须 Sol」式的新错误绑定（设计 §7）。
- **Registry 缓存正文 / hot reload 机制**：否决——第一版不做；souls 文件数量小，按需读盘，用户改文件对新会话自然生效（设计 §44）。
- **产品层 mid-session Soul 修改 API（PUT /session/:id/soul）**：否决——避免无意中重新支持热切（设计 §33）。

## 后果

- 身份缺失不静默切换：冷读时保留 pin + 有界 minimal no-soul fallback 加 warning；已有缓存正文时保留原快照并告警，禁止偷偷切 Karina/Yuqi。
- commit 前缀来源为 `commitPrefix → displayName → name → AI`，永不 fallback 到 TUI/GUI。
- TUI `/soul` 复用 DialogSelect 展示可选说明并可按名称/ID/说明搜索；旧文件无 description 时保留名称/ID fallback。摘要 API 与 SDK 可选透传该字段，但 prompt/session 注入不变。
- 「加新 Soul 不改核心」是硬验收：Phase 7 加 chi.md 必须零核心改动，核心中禁止出现 `if soul === "chi"`。

## 模型可见改动四问

1. **看到什么变了**：旧段是 `Instructions from: <Tsoul/Gsoul 路径>\n<正文>`；新段是 `# <displayName> [<commitPrefix>]\n\n<正文>\n\nIdentity: <displayName>. Commit attribution owner: [<commitPrefix>].`。缺失时明确说明 pinned Soul 不可用，不推断客户端身份。全局身份/署名指令与旧 persona 命令同步改为 session owner；包级 AGENTS 不再指定 TUI 人格。
2. **token 影响**：人格正文不因客户端选择而额外复制；包装增减取决于原路径与新标签，四个标签合计最多 1,024 UTF-8 字节，完整包装最多 1,078 字节，保守上界约 270 个 `Token.estimate` tokens（不是 tokenizer 实测）。旧路径包装被移除；无固定的“全模型净增 N tokens”结论。
3. **KV cache 影响**：Soul 从旧 instruction 发现位置移到 AGENTS/MEMORY/config 后、MCP/skills 前；升级时从原 Soul 段起的后缀失效一次，全局/包级指令内容修改也从对应段起失效。修改默认不会改变已有 session 的 pin 或热缓存正文。
4. **硬上限与记录**：Soul 文件 16 KiB，标签各 256 UTF-8 字节，独立注入合计最多 17,462 字节（`MAX_SOUL_PROMPT_BYTES`），超过 1K token 的项是已有的人格正文，不是本次新增的大包装。迁移 sidecar 最多 1,024 字节；不向模型注入。最终 system prompt 沿现有请求记录链持久化，不另造无界正文缓存。

## 接力边界

- **严格正文冻结尚有缺口**：Session 只持久化 Soul ID，正文快照位于进程内 `PromptCaches.souls`，接入已有数量/TTL 回收；compaction 保留快照，但进程重启或会话被回收后会重新读取同 ID 的文件。因此 §44 的“只对新 Session 生效”目前只覆盖热快照，不覆盖跨重启/回收。后续需要明确版本化/快照持久化方案，不能用“已有 session pin 不变”冒充“正文永不变”。
- **验收仍需补齐**：live 模型人格回复、完整独立审查；没有重启现有 GUI/sidecar，也未在 live home/DB 执行迁移。浏览器 smoke 依赖 mock API 与桌面标题栏挂载点，不能等同 Electron 打包验收。本地 provider 出站体断言通过 `test/session/prompt.test.ts --test-name-pattern 'actual provider request'` 复验，使用相同的 `REDCODE_SOUL_ACCEPTANCE_FILE`。
- **本批验证结果**：核心八个定向文件 83 pass / 0 fail / 1 既有 todo，实际 MD Registry/DB 验收 1 pass，本地 provider 出站体 1 pass；GUI submit 11 pass、i18n parity 4 pass；HTTP Soul 六场景与浏览器 1 场景通过；核心/app typecheck、版本一致性通过。未跑全量套件，也未进行 Electron 打包验收。
- **测试入口**：核心定向文件为 `test/soul/{soul,acceptance}.test.ts`、`test/data-migration/session-soul.test.ts`、`test/session/{session,soul,instruction,prompt-caches}.test.ts`、`test/cli/{doctor,cmd/tui/soul}.test.ts`；均从 `packages/opencode` 跑，路径过滤加 `--timeout 30000`。实际 MD 可通过 `REDCODE_SOUL_ACCEPTANCE_FILE` 指定；默认通用夹具不依赖本机附件。GUI 从 `packages/app` 分别跑 submit/i18n parity，带 `--preload ./happydom.ts`。HTTP exerciser 的 Soul 六场景通过，usage/outline 两个既有 missing 非本次范围。
- **跨机配置**：本机 home 下 AGENTS 与旧 persona 命令已同步修改，但它们属于私有配置仓，不包含在本仓提交里；另一台机器需同步该配置，不能只拉本仓就假定所有全局旧规则消失。
