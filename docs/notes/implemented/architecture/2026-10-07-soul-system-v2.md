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

- **正文冻结已落地**：`soul_version` 内容寻址版本表 + `session.soul_body_hash` 已实现并验证（机制与决策见下方「持久版本决策」）；官方迁移文件已生成并**已在 live home/DB 执行**（261008：`session_soul_from_client` 与 `session_soul_body_from_registry` 完成，262 个绑 Soul 会话 100% 有冻结版本）。旧行回填只能按迁移时点可见文件近似，不宣称恢复历史原貌。同日部署四人格精简修订包（karina/yuqi/wonyoung 正文精简 + 新增 zhiwei），旧版本已备份 `souls/archive/`；替换文件只影响新会话，已有会话冷读继续走冻结版本，doctor 确认 4 valid / 0 issue。
- **验收仍需补齐**：live 模型人格回复、Electron 打包验收；没有重启现有 GUI/sidecar。浏览器 smoke 依赖 mock API 与桌面标题栏挂载点，不能等同 Electron 打包验收。本地 provider 出站体断言通过 `test/session/prompt.test.ts --test-name-pattern 'actual provider request'` 复验，使用相同的 `REDCODE_SOUL_ACCEPTANCE_FILE`。独立复核已完成：外部报告的两项迁移疑点（已 pin 根无 hash、子会话异 Soul 继承）经反例测试证伪为不可达，实现无误；复核期间另以失败测试暴露并修复一个真实边界——缓存回收后调用方省略 Soul ID 时冷读会误判未绑定，现冷读以持久会话归属为准。
- **本批验证结果**：核心定向八文件（后端 5 + TUI 3）34 pass / 0 fail / 197 expects；修复后元英出站体 1 pass / 4 expects；核心 typecheck 与 SDK typecheck EXIT 0，SDK/OpenAPI 由官方生成器产出（新增只读 `soulBodyHash`）；版本一致性通过。未跑全量套件，也未进行 Electron 打包验收。
- **测试入口**：核心定向文件为 `test/soul/{soul,acceptance}.test.ts`、`test/data-migration/session-soul.test.ts`、`test/session/{session,soul,soul-restart,instruction,prompt-caches}.test.ts`、`test/cli/{doctor,cmd/tui/soul}.test.ts`、`test/cli/tui/{dialog-soul,prompt-soul-submit}.test.tsx`；其中 `soul-restart.test.ts` 借 `test/fixture/soul-restart.ts` 探针验证真实跨进程冻结（三个真子进程），`prompt-soul-submit.test.tsx` 挂真实 Prompt/keymap 验证 `/soul` 入口不被提交清理。均从 `packages/opencode` 跑，路径过滤加 `--timeout 30000`。实际 MD 可通过 `REDCODE_SOUL_ACCEPTANCE_FILE` 指定；默认通用夹具不依赖本机附件。GUI 从 `packages/app` 分别跑 submit/i18n parity，带 `--preload ./happydom.ts`。HTTP exerciser 的 Soul 六场景通过，usage/outline 两个既有 missing 非本次范围。
- **跨机配置**：本机 home 下 AGENTS 与旧 persona 命令已同步修改，但它们属于私有配置仓，不包含在本仓提交里；另一台机器需同步该配置，不能只拉本仓就假定所有全局旧规则消失。

## 持久版本决策

采用内容寻址版本表，而不是为每个 Session 复制全文：`soul_version` 保存正文与创建时的身份元数据，`session.soul_body_hash` 固定版本引用。哈希必须覆盖 Soul ID、身份元数据与正文；仅正文相同而显示名或署名前缀不同的两个版本不能相互覆盖。源路径不参与版本身份，description 仍只供 UI 使用。

- 根会话在创建时固定版本，不能延迟到第一次发消息；版本先持久化，再发布带固定引用的会话。fork/child 继承来源版本，不重新选择 Registry 的当前正文。
- `PromptCaches.souls` 仅是热缓存，缓存回收或进程重启不能改变冷读的版本来源。compaction 不更改版本引用。
- 旧行只能按迁移时可见的文件补版本，不能恢复未曾保存的历史原文；保留已有引用，优先继承父会话，缺失文件保留 ID 并明确告警，回填不算会话活动。
- 固定版本丢失或损坏时，明确告警后回退同 ID 的当前文件；这是异常恢复，不是严格冻结保证。禁止默切其他人格或覆盖原版本引用。
- 不引入版本热切、Registry 正文缓存或自动删除共享版本的机制。本批只生成迁移文件并验证隔离库，不在运行中的 home 数据库执行迁移。

模型可见四问：① 正常路径仍使用原 `render()` 包装，仅正文及身份标签的来源改为固定版本；② 不增加固定前缀段，正文未改时 token 增量为零；③ 正常请求的段落顺序与字节不变，文件编辑不再让旧会话的冷读前缀漂移，旧行回填只能保证迁移之后的稳定；④ 继续使用正文 16 KiB、标签各 256 UTF-8 字节及完整注入 17,462 字节的上限，最终 system 仍走现有持久请求日志链。数据库版本引用不注入模型。

## GUI V1A：管理与会话头像

- 个性化页展示默认 Soul、可搜索阵容、当前会话绑定标记、按需只读详情、字段来源与结构化 issues。详情经只读 `GET /soul/{id}` 按 Registry ID 查询；未知 ID 返回声明的 404，不将 ID 拼接成文件路径。正文沿用 Registry 的 16 KiB 上限，来源分为 `frontmatter`、`fallback`、`absent`。
- 设置默认仍只更新本机 `desktop.lastSoul`；不添加会话热切、创建/编辑/删除 Soul 文件的写 API。当前会话标记来自路由对应 Session，而非默认偏好。
- 人格没有产品预设：任意合法 Soul ID 均可独立选择本地头像，存在既有 `RedCode.media.dat` 的 `soulAvatars` 映射，不猜测原全局图片属于谁、不改用户 MD。元数据 `avatar` 只可作为受控本地媒体逻辑 key，未知 URL/路径不直接加载。
- 聊天完成态与等待态均读取会话绑定 ID；缺失 Registry 条目仍保留 ID 与本地图，否则回退身份文字，不借用另一个人格的全局头像。确实无 Soul 的旧会话保留原全局头像。头像是可更新的本机表现层，同 ID 的旧会话会同步换图；不将头像纳入正文版本、数据库迁移或模型输入。
- 输入限制：PNG/JPEG/WebP，文件最大 5 MiB、单边 4096 px、1600 万像素，真实头部检查先于浏览器解码；解码后复核尺寸，允许 EXIF 方向交换宽高。居中裁为 256×256 PNG，完整 data URL 最大 256 KiB，坏图保留旧图并显示错误，解码资源在完成后释放。
- 浏览器验收中发现并修复两个真实缺陷：`readSoulAvatar` 只在键存在时读取，Solid 对新增键不建订阅，第二个 Soul 上传后已有消费者不更新（修为无条件读取键再判存在）；`lastSoul` 原为初始化期 memo，切换默认后发起的新会话仍可能拿到旧值（修为按调用时读取，会话 pin 语义不变）。
- 定向验证：app typecheck、头像解析/选择/媒体迁移/i18n 四文件 24 pass；核心 Registry 30 pass、Session Soul 9 pass，核心与 SDK typecheck 通过；Soul HTTP exerciser 7 pass。
- 浏览器验收（真实 app 源码 + 隔离 fixture，见 `.redcode/temp/soul-gui-fixture.ts`，不触 live home/DB/源 MD/照片，无模型调用）：默认卡/可搜索阵容/详情 sources/路径复制/正文预览、默认与会话双徽章、切换默认即时生效且当前会话不变；头像上传 PNG/WebP 成功、坏图拒绝且保留旧图、移除后时间线同 ID 同步换图；issues 结构化列表、空列表引导、registry 500 与详情 404 均可重试恢复；800px 窄窗口无横向溢出；页面错误监听为空（一次 ResizeObserver loop 提示，复载未复现，不判缺陷）。Electron 打包与 live 模型人格回复仍不在本批范围。

本批模型可见四问：① 没有改人格正文、提示词包装、工具 schema 或工具输出；只增加 GUI 只读 HTTP 数据与本地媒体。② 固定前缀 token 增量为零。③ 模型前缀逐字节不变，无 KV cache 失效。④ 没有新增模型注入项，原人格预算与持久日志链不变。
