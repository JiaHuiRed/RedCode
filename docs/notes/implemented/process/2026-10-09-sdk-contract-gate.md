# API、OpenAPI 与生成 SDK：补齐字段级漂移门禁

状态:implemented

## 问题

`script/check-openapi-drift.ts` 已在 CI 和 pre-push 比较真实 CLI 输出与
`packages/sdk/openapi.json`，第一段链路并不缺门禁。缺口在第二段：
更新 committed OpenAPI 后忘记重生成 SDK，原有检查仍能全绿。
只比较端点、operationId 和 schema 名称也不够：字段由 number 改成 string，
名字完全不变。

## 决策

- `test/server/openapi-contract.test.ts` 调真实 CLI `generate`，结构比较 committed
  OpenAPI；子进程有 25 秒上限。既有脚本继续负责逐字节检查，不改 CI、hook 或测试 lane。
- 同一测试把 committed spec 经实际 `@hey-api/openapi-ts` 生成到隔离临时目录，
  应用正式构建同款 SSE 补丁，再按 SDK 包的 Prettier 版本和仓库配置格式化。
  全部生成 TypeScript 文件按路径与内容比较，缺失、多余、字段、端点与 transport
  变化都能报错；测试不改 committed 文件。
- 正式构建和测试共享 `packages/sdk/js/script/codegen.ts` 的生成选项及 SSE 补丁，
  不在测试里复刻一套配置。正式构建的后续 scoped Prettier、tsc 和临时 spec 清理不变。
- 每轮都跑正负对照：真实产物应一致；字段类型漂移、端点 URL 漂移、缺失/多余文件、
  SSE iterator return 泛型回退应分别被识别。

## 备选与否决理由

- **只抽端点/schema 名单**：漏掉同名字段的类型与描述变化。
- **测试内再抄一套 codegen 配置**：生成器升级时测试与构建可能一起失配。
- **进程内直接导入 PublicApi 作为完整 CLI 的替身**：首轮实测失败。
  `groups/global.ts` 构建 schema 时快照 `BusEvent.effectPayloads()`，
  导入顺序影响事件 union 的成员和顺序；真实 CLI 字节门禁同时通过。
  改用实际入口，而不是删除差异或放宽字段比较。本次不改事件注册机制。
- **整体拆 Protocol/Client 包或跑全仓生成脚本**：收益只是补一个契约门禁，
  不需要包迁移，更不能顺带触发全仓格式化。

## 验证与边界

- 契约与既有 PublicApi 定向测试 15 pass / 0 fail；最终负对照单文件 5 pass / 0 fail。
- 核心 typecheck 通过（tsgo 崩溃后由现有包装器回退 TypeScript 5.9.3）。
- 正式 SDK 构建成功，生成物无 diff；既有 OpenAPI 字节检查通过。
- 沿用既有 generator `instance` 弃用提示，不顺手升级依赖。
- 不验证服务端每个 handler 的运行时行为，也不改变 HTTP 契约、数据库、配置或模型前缀。
- 后续改 API 仍需两条正式生成命令；只更新 spec 或只重编 SDK，门禁都会拒绝。
