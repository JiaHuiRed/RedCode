#!/usr/bin/env bun

import { $ } from "bun"

await $`bun ./packages/sdk/js/script/build.ts`

// 260819 cc: 原来是 .cwd("packages/redcode") —— 这个目录不存在（包名是 packages/opencode），
// 这条生成路径已经死了，packages/sdk/openapi.json 一直靠手改维护、长期落后于源 schema。
// 260821 cc: 已补上闸门 —— script/check-openapi-drift.ts 在 CI 里重新生成一遍并逐字节比对，
// 忘记重跑生成会红。只想更新 openapi.json 用 `bun run gen:openapi`，别跑整个脚本。
// 注意最后一步 format.ts 是 prettier --write 全仓（当前 179 个文件不合规），只想更新
// openapi.json 时别跑整脚本，单独执行下面这一条。
await $`bun dev generate > ../sdk/openapi.json`.cwd("packages/opencode")

await $`./script/format.ts`
