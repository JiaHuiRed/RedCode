# 会话补拉后续工作清单（261009）

前置：功能主体已随 `b729cc3b` 落地（dev，未 push）。设计决策、成本数据与验证边界见
[implemented note](../../implemented/feature/2026-10-09-session-change-catchup.md)（下称「note」），
本文件只列**没做完的事**和怎么接着做；条目完成后挪进 note 或删除。

## 1. 浏览器漏广播 E2E（最优先，进行到一半）

场景：GUI 打开夹具会话 → 服务端 `publish:false` 改 part（无 SSE 广播）→ GUI 应仍显示旧文本
→ 发 `server.connected` → 补拉后 UI 显示新文本、费用不变、changes 游标推进。

**中断点**：服务端已落库（`edited browser probe text`），GUI 停在旧文本，重连触发未执行。
本机已验证到：夹具会话页能加载种子消息（`original browser probe text` 可见）、
`/__probe/modify` 返回 `modified:true`、GUI 无运行时错误。

步骤（脚本已入仓 `script/session-change-fixture-server.ts`，路径自适应仓库根）：

1. 起夹具（仓库根执行）：

   ```powershell
   $env:REDCODE_SESSION_CHANGE_PROBE='1'
   $env:REDCODE_TEST_HOME="$PWD\.redcode\temp\session-change-home"
   $env:REDCODE_DB="$PWD\.redcode\temp\session-change-browser.db"
   $env:REDCODE_TEST_PROJECT="$PWD\.redcode\temp\session-change-project"
   bun script/session-change-fixture-server.ts
   ```

   stdout 输出 JSON：`baseURL`、`sessionIDs`、`probeToken`（固定 `session-change-fixture`）。
   三个路径必须都在 `.redcode/temp` 内，脚本强制校验。

2. 起隔离前端（`packages/app` 下）：

   ```powershell
   $env:VITE_REDCODE_SERVER_HOST='127.0.0.1'
   $env:VITE_REDCODE_SERVER_PORT='<夹具端口>'
   bun run dev:web --host 127.0.0.1 --port 0 --strictPort
   ```

3. 浏览器开 vite 地址，从首页点进 `Session change fixture A`（URL 是 base64(directory) 前缀）。
4. `POST {baseURL}/__probe/modify`，header `x-session-change-probe: session-change-fixture`
   → 确认 UI **仍是旧文本**（没有 SSE）。
5. `POST {baseURL}/__probe/reconnect` → 确认 UI 变新文本；`GET /__probe/state` 对账
   changes 游标、消息内容与费用（夹具费用为 0，重点看 token/成本字段无重复入账）。
6. 顺带项：旧服务端 404 回退可用反代把 `/changes` 打 404 验证；UI 层已有单测覆盖
   （真实 SDK 包装 404），浏览器层可后置。

注意：夹具只绑 127.0.0.1，验证完杀掉夹具与 vite 两个进程。

## 2. 独立审查确认的 minor（可同批修）

- **快照回退覆盖深层分页游标**：`packages/app/src/context/directory-sync.ts` 的
  `refreshSnapshot` 无条件 `setMeta("cursor", key, loaded.cursor)`；对比同文件 `loadMessages`
  refresh 路径的 keepCursor 语义（260829 注释：只在新窗口更深时前进）。用户停在深层历史时
  触发回退会丢尾部窗口。修法：保留更深 cursor 或合并窗口。
- **apply 的 `client.session.get` 没包 retry**（同文件其他网络调用都有 retry 包装）；
  一次瞬时失败会作废整轮补拉，等下次触发重试。补 `retry()` 即可。

## 3. 独立已知问题（别混进本功能的 commit）

- **首页会话列表 false-empty**：`server-sync.tsx:413-422` queryFn `.catch` 吞掉失败 +
  `.then(() => null)` 永不 reject，`home.tsx:378` 只判 `isLoading` → 加载失败渲染成
  「未找到会话」，与真空态不可区分（261009 08:58 现场所见；renderer.log 三波
  instance-dispose 失败 + bootstrap DOMException 与之相关但根因未定）。修法两半：
  错误态可视化 + 保持 261002 已加的重试自愈（refetchOnMount 已生效，所以能自己恢复）。
- **GUI 内存**：renderer ~2.4GiB + sidecar ~1GiB（261009 实测，TaskManager 聚合峰值 4.3GB
  含验证子进程），无泄漏实证，需要 heap 快照取证。诊断入口：renderer.log 高频行、
  `instance-dispose.ts:20` 的 `[object Object]`（需序列化 payload 再查状态码）。
  属独立优化项，已有 render-audit P0 背包。

## 4. opencode v2 大更新调研（261009 最初议题，只做了初勘）

`D:\AI\KLX\opencode`（v2 @ `3884062`）：packages 从十来个拆到 30+（新增
`core`/`server`/`protocol`/`schema`/`effect-drizzle-sqlite`/`effect-sqlite-node` 等），
`packages/opencode/src/storage/` 只剩 `storage.ts`+`schema.ts`——存储层大概率整体搬进独立包，
**未深入**。若本机没有该仓库需先 clone。

数据库静态审计（261008 附件）结论仍有效：不换底座，按波次 A→C 处理 DB-01~09；
其中 DB-01（skipMigrations 伪造完成）与 DB-02（drizzle 硬编码个人路径）已修
（CHANGELOG Unreleased 已记），DB-03（token 明文）起仍待验证。

## 5. 状态与验证命令

- `b729cc3b` 未 push（推送前需人工确认）；live DB 未动；打包客户端（07:16 版）不含新代码。
- 后端定向回归（`packages/opencode`）：

  ```bash
  bun run typecheck && bun test --timeout 30000 \
    ./test/storage/session-changes-migration.test.ts \
    ./test/session/changes-config.test.ts ./test/session/changes.test.ts \
    ./test/sync/invariants.test.ts ./test/sync/index.test.ts \
    ./test/server/httpapi-public-openapi.test.ts
  ```

  （当前基线 49 pass。）

- GUI 定向回归（`packages/app`）：

  ```bash
  bun run typecheck && bun test --preload ./happydom.ts --timeout 30000 \
    ./src/context/session-changes.test.ts ./src/context/reconnect.test.ts \
    ./src/context/global-sync/event-reducer.test.ts ./src/context/message-window.test.ts
  ```

  （当前基线 46 pass。）

- HTTP 场景（`packages/opencode`）：
  `bun run script/httpapi-exercise.ts --mode effect --include session.changes`（auth 同理）。
  既有缺场景 `GET /session/usage`、`GET /session/{id}/outline` 是旧账，别顺手修。
