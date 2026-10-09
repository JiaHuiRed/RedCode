# 会话补拉后续工作清单（261009）

前置：功能主体已随 `b729cc3b` 落地（dev，未 push）。设计决策、成本数据与验证边界见
[implemented note](../../implemented/feature/2026-10-09-session-change-catchup.md)（下称「note」），
本文件只列**没做完的事**和怎么接着做；条目完成后挪进 note 或删除。

~~浏览器漏广播 E2E、快照回退游标 minor、apply retry minor 均已于 261009 完成~~，
细节已挪进 note 的「验证」与「决策」段；剩余条目如下，均为**独立问题，别混进本功能的 commit**。

## 1. 独立已知问题

- **首页会话列表 false-empty**：`server-sync.tsx:413-422` queryFn `.catch` 吞掉失败 +
  `.then(() => null)` 永不 reject，`home.tsx:378` 只判 `isLoading` → 加载失败渲染成
  「未找到会话」，与真空态不可区分（261009 08:58 现场所见；renderer.log 三波
  instance-dispose 失败 + bootstrap DOMException 与之相关但根因未定）。修法两半：
  错误态可视化 + 保持 261002 已加的重试自愈（refetchOnMount 已生效，所以能自己恢复）。
- **GUI 内存**：第一批无界点已钉（261009：分页合并封顶 400、目录乘数 30→10、dispose 日志可读化，见
  `docs/notes/implemented/bug-fix/2026-10-09-gui-memory-unbounded.md`）。剩余：V8 长跑堆不归还
  （日常状态拍 snapshot 对照，不复刻 5GB 现场）、sidecar per-dir InstanceState 无上限
  （`instance-state.ts` capacity 默认 Infinity）、MCP server 跨目录共享化（进程树 ~800MB）、
  `/global/event` 每连接队列上限未证。

## 2. opencode v2 大更新调研（261009 最初议题，只做了初勘）

`D:\AI\KLX\opencode`（v2 @ `3884062`）：packages 从十来个拆到 30+（新增
`core`/`server`/`protocol`/`schema`/`effect-drizzle-sqlite`/`effect-sqlite-node` 等），
`packages/opencode/src/storage/` 只剩 `storage.ts`+`schema.ts`——存储层大概率整体搬进独立包，
**未深入**。若本机没有该仓库需先 clone。

数据库静态审计（261008 附件）结论仍有效：不换底座，按波次 A→C 处理 DB-01~09；
其中 DB-01（skipMigrations 伪造完成）与 DB-02（drizzle 硬编码个人路径）已修
（CHANGELOG Unreleased 已记），DB-03（token 明文）起仍待验证。

## 3. 状态与验证命令

- `b729cc3b` 未 push（推送前需人工确认）；live DB 未动；打包客户端（07:16 版）不含新代码。
- 后端定向回归（`packages/opencode`）：

  ```bash
  bun run typecheck && bun test --timeout 30000 \
    ./test/storage/session-changes-migration.test.ts \
    ./test/session/changes-config.test.ts ./test/session/changes.test.ts \
    ./test/sync/invariants.test.ts ./test/sync/index.test.ts \
    ./test/server/httpapi-public-openapi.test.ts
  ```

  （当前基线 49 pass，本批未动后端。）

- GUI 定向回归（`packages/app`）：

  ```bash
  bun run typecheck && bun test --preload ./happydom.ts --timeout 30000 \
    ./src/context/session-changes.test.ts ./src/context/reconnect.test.ts \
    ./src/context/global-sync/event-reducer.test.ts ./src/context/message-window.test.ts
  ```

  （当前基线 49 pass，含 `mergeSnapshotWindow` 三个新用例。）

- HTTP 场景（`packages/opencode`）：
  `bun run script/httpapi-exercise.ts --mode effect --include session.changes`（auth 同理）。
  既有缺场景 `GET /session/usage`、`GET /session/{id}/outline` 是旧账，别顺手修。
