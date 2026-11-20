# 依赖升级与旧文件清理交接（261022）

> 交接文档：本批工作的进度快照，供跨机器接力。私有工作副本在 `.redcode/docs/dependency-upgrade-261022.md`（本机），内容同源。

状态：收口中（261022 晚更新）；16GB 工作站内存护栏已记入项目 MEMORY

## 已完成且有验证证据

- 工具输入流保护：`experimental.toolInputGuard` 默认 `maxPendingCalls=64`、`idleMs=120000`；按未完成输入独立计数、同 ID 去重、超预算同步失败，idle/budget 错误不自动重试。5 个 session/config/instance/retry 测试文件合计 64 pass，覆盖 1000 个 start 在预算点停止下传。
- 实例释放计时器：`disposeInstance` 的 `Promise.race` finally 清除 timer；专属与 instance 集成测试 10 pass，真实空 disposer 进程退出从 5.08 秒降到 0.07 秒。
- Markdown / UI：`markdown-it 14.3.3`、`dompurify 3.4.17`、`solid-js 1.9.17`；UI typecheck 与 markdown-stream 21 项通过。app typecheck 与两个定向测试文件 23 项通过。
- Storybook：核心及插件 10.6.3，Solid adapter 保留 10.1.1，docgen 单独使用 TypeScript 5.9.3。Build exit 0；静态站 Markdown story 在浏览器实际渲染正常。10.7.2 adapter 曾在 4GB 堆 OOM、6GB 配置下反复回收 TypeScript program；不得重新升回该组合或加堆硬顶。
- 安全依赖：`http-cache-semantics 4.3.0`、`seroval 1.6.12`、`tar 7.5.22` override；Drizzle ORM/kit rc.2 → rc.5。audit 从 234 条降至 188 条（2 critical / 93 high / 93 moderate）；Astro/proxy-addr 等残余没有在本批升级。
- 旧文件：退役失修 Nix 配方与 16 个 SST 生成声明，移除未引用乌克兰语截图；`install` 修复 Windows `redcode.exe` 路径。安装器离线回归 5 pass，`bash -n install` 通过；app typecheck 通过。
- 已添加 16GB 内存护栏和依赖/Nix 决策 note；`git diff --check` 通过。

## Effect 4.0.5 迁移收口记录（261022 晚）

- `packages/opencode` 全量 typecheck（含测试）**exit 0**。src 126 → 36 → 0，测试层 32 个随后清零。
- 收口补丁清单（API 映射，续作者可直接复用）：
  - socket：`runRaw` 移除 → `Effect.gen` 内 `const { pull } = yield* socket.reader` + `while (true)` 循环消费 `batch`；`yield* socket.writer` 得到 `Writer { write, writeAll }`，调用改 `writer.write(x)`。涉及 `handlers/pty.ts`、`middleware/proxy.ts`、3 个 server 测试文件。
  - `makeWebSocket` options 的 `closeCodeIsError` 不存在了，直接删（外层 `Effect.catch` 已兜底）。
  - `Config.string/number` → `Config.String/Number`（`test/effect/config-service.test.ts`）。
  - **`Effect.partition` v4 返回序反转**：`[passes, fails]`（v3 是 `[fails, passes]`）——`help-snapshots.test.ts` 解构交换。
  - HttpServer address `_tag`：`"TcpAddress"` → `"InetAddressV4" | "InetAddressV6"`（无 port 的分支是 `"UnixPathAddress"`）。
  - `Scope.close` 要求 `Closeable`：`ListenerState.scope` 类型升 `Scope.Closeable`。
  - 解码选项：`propertyOrder: "original"` 与 `onExcessProperty: "preserve"` 不存在，删参（默认行为等价）。
  - `Base64.decodeBase64String` → `Base64.decodeString`。
  - OTLP：`Observability.layer` 需 pipe `Layer.provideMerge(OtlpExporter.layerFlusher)` 供 `Exporter.Flusher`。
- 64 项保护基线（llm-idle-guard / tool-input-guard / instance-registry / instance / retry）迁移后复跑 64 pass / 127 expects / 29.3s。
- SDK 双命令已跑：`bun ./packages/sdk/js/script/build.ts` exit 0；`bun dev generate > ../sdk/openapi.json` 完成（`toolInputGuard` 出现 5 处）。

## 未完成 / 已知问题

- **`packages/effect-drizzle-sqlite` 在 Drizzle rc.5 下 3/6 测试失败（未修）**：`selects rows…` / `commits successful transactions` / `supports returning…`。根因已探针实证：
  1. rc.5 `buildInsertQuery`（`sqlite-core/dialect.js`）对缺省列的填充顺序是 `defaultFn` → `default` → `onUpdateFn` → **显式 `null`**（rc.2 对 autoIncrement 主键省略列）；单行 insert 生成 `insert into "users" ("id", "name") values (null, ?)`。
  2. 该 SQL 本身合法（null 触发自增），真正炸点是 **params 数组里留的是 Param 对象未解包**（日志 `params: [object Object]`）→ `NOT NULL constraint failed: users.name`。
  3. 修复方向：对齐 vendored `sqlite-core/effect/*`（`applyEffectWrapper` 来自 `drizzle-orm/effect-core/query-effect`）与 rc.5 内部协议，或在 executor 层解包 Param。**修复前不要把 drizzle rc.5 当稳定可用**。
- 残余 audit（另批，未授权不做）：web/astro 链 2 critical（Astro <5.13.2 AVIF RCE、proxy-addr <2.0.8；`astro.config.mjs` 的 imageService passthrough 缓解后者不可达）、`@hono/node-server` Windows serve-static 等。
- `.redcode/temp/install-win-repro` 本机残留（hook 需确认语，保留）。
- 工作区已分批提交（见 git log）；**未 push**。

## 内存安全边界（16GB 工作站）

重型 build/typecheck/test 一次只跑一个，启动前查可用内存；不提高 Node 堆硬顶。此前 4.4GB 可用时跑 6GB 堆 Storybook + 并行 typecheck 导致整机崩溃（已立规）。全量 opencode typecheck 用 tsgo（Go 实现）无 JS 堆问题；node TS5.9 直跑需 ≥2.5GB 堆余量，2GB 上限会 OOM（src-only 可以）。
