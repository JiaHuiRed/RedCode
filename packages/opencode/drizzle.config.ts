import { defineConfig } from "drizzle-kit"

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/**/*.sql.ts",
  out: "./migration",
  dbCredentials: {
    url: "C:/Users/Administrator/.redcode/data/redcode.db", // 260802 Red 修正：runtime 用 Global.Path.data；node:sqlite 驱动不展开 ~，必须绝对路径。旧路径 ~/.local/share 是 6/13 弃用库
  },
})
