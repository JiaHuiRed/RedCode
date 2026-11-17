#!/usr/bin/env bun
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

import { $ } from "bun"
import path from "path"

import { generateSdk } from "./codegen"

// 261117 Red 共享引擎目录已从 packages/opencode 迁到 packages/redspace（0.19.1）。
// 这里必须指向真实存在的目录，否则 $.cwd() 抛 "No such file or directory"，SDK 构建失败；
// 它是 test 任务的前置依赖，CI 上 unit 作业会在跑测试前整体中止。
const redcode = path.resolve(dir, "../../redspace")

await $`bun dev generate > ${dir}/openapi.json`.cwd(redcode)

await generateSdk("./openapi.json", "./src/v2/gen")

await $`bun prettier --write src/gen`
await $`bun prettier --write src/v2`
await $`rm -rf dist`
await $`bun tsc`
await $`rm openapi.json`
