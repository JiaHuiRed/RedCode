import { defineConfig } from "drizzle-kit"
import path from "node:path"

// 261009 Red 开发工具不默认连接运行库；generate 无需目标库，连库须显式给绝对路径。
const url = process.env.REDCODE_DRIZZLE_DB
if (url !== undefined && (!path.isAbsolute(url) || url.includes("\0"))) {
  throw new Error("REDCODE_DRIZZLE_DB must be an absolute filesystem path")
}

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/**/*.sql.ts",
  out: "./migration",
  dbCredentials: url === undefined ? undefined : { url },
})
