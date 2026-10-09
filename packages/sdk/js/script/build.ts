#!/usr/bin/env bun
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

import { $ } from "bun"
import path from "path"

import { generateSdk } from "./codegen"

// 260728 Karina 目录名仍是 opencode，只有 package.json 里的 name 改成了 redcode。
// 这里原本写 "../../redcode"，解析出 packages/redcode —— 该目录不存在，
// $.cwd() 直接抛 "No such file or directory"，SDK 构建必然失败。
// 因为它是 test 任务的前置依赖，CI 上 unit 作业还没跑到测试就整体中止（只跑了 6 个）。
const redcode = path.resolve(dir, "../../opencode")

await $`bun dev generate > ${dir}/openapi.json`.cwd(redcode)

await generateSdk("./openapi.json", "./src/v2/gen")

await $`bun prettier --write src/gen`
await $`bun prettier --write src/v2`
await $`rm -rf dist`
await $`bun tsc`
await $`rm openapi.json`
