# 跳过迁移不记完成，drizzle-kit 连接目标必须显式选择

状态：implemented

## 问题

数据库审计中的两条安全问题由源码与隔离回归共同确认：

- `Database.Client` 原先把每条迁移的 SQL 原地替换为 `select 1;`，再交给 Drizzle 执行。Drizzle 会将名字写入 `__drizzle_migrations`，后续正常启动按名字跳过这些迁移，实际 DDL 没有执行。打包 journal 数组也被污染；冻结数组的回归在旧实现上抛出 readonly property 的 TypeError。
- `drizzle.config.ts` 将开发工具连接目标硬编码为本机用户目录下的真实 `redcode.db`。运行时不读取该文件，但 `drizzle-kit push` 等连库命令存在误操作真实库的默认路径。

旧实现上的定向测试为 1 pass / 5 fail，失败分别指向跳过仍建 journal、修改打包条目、默认连接真实库、忽略专用开发目标以及未验证非法目标。

## 决策

### 迁移开关

`REDCODE_SKIP_MIGRATIONS=true` 时完全不读取或执行迁移，也不创建或追加迁移 journal；记录跳过日志，不改任何迁移 SQL。数据库连接和原有 PRAGMA 仍照常初始化。

关闭开关并重新打开连接后，正常迁移器按已有 journal 执行未完成项。已加载的单例连接仍沿用原有生命周期，不因中途改环境变量自动重开。跳过空库并不会得到可供正常业务使用的 schema，这个开关不是建库快捷方式。

### 开发工具目标

drizzle-kit 仅从专用环境变量 `REDCODE_DRIZZLE_DB` 获取连接目标，要求非空绝对文件路径且不能含 NUL，不接受相对路径、`:memory:` 或 `~` 展开。运行时 `REDCODE_DB` 不参与解析。

未设置时不提供 `dbCredentials`：生成迁移不需要连库，继续可用；需要连接的命令由 drizzle-kit 拒绝执行。显式设置后可连接任何指定文件，因此它是防止默认误连的边界，不是禁止操作者选择真实库的沙箱。

在 `packages/opencode` 内使用独立开发库，例如：

```powershell
# 按实际绝对路径设置到独立的开发数据库，不要选择运行中的 redcode.db。
$env:REDCODE_DRIZZLE_DB = Join-Path $PWD.Path "development.db"
```

## 备选与否决理由

- **拷贝 journal 后改成空 SQL**：只消除数组污染，仍会伪造完成记录，不解决根因。
- **整体换用 v2 bootstrap 与自建 journal**：本次没有 schema 或迁移格式改动需求，引入整套系统会扩大兼容与回滚面。
- **开发工具默认继承 `REDCODE_DB`**：进程可能继承 GUI/测试环境，仍会默认选中运行库。
- **自动删除可疑 journal 并重放 DDL**：无法仅凭 journal 判断真实 schema 与数据状态，重复执行 DDL 可能失败或损坏数据，不做自动修复。

## 验证与后果

`packages/opencode/test/storage/db.test.ts` 使用有超时、有输出上限的隔离子进程，DB 路径与测试 home 明确指向临时目录，没有操作真实库。覆盖：

- 同一文件经历跳过启动和正常启动，后者成功创建真实 schema。
- 正常建库后写入 Soul、分币种费用与权限样本，经历跳过及再次正常打开，数据与迁移条数不变。
- 冻结的打包 journal 跳过后保持原样，后续真实 SQL 执行并记账。
- 开发配置默认没有连接目标，显式目标独立于运行库，空路径和相对路径报错。

在 `packages/opencode` 执行 `bun test --timeout 30000 ./test/storage/db.test.ts`：6 pass / 0 fail；`bun run typecheck` 通过。另以实际 drizzle-kit 验证：未配置目标的 `push` 在连接前因 `url: undefined` 拒绝；`generate` 在工作区临时输出目录成功生成迁移，未改正式 migration 目录。

本次没有新 migration、schema 变更、真实库读写或既有数据库修复。已被旧开关写入伪完成记录的数据库不会因本修复自动恢复，需要另行核验 schema，并在一致性备份和明确授权后处理。同步事件、父外键、索引、token 存储与备份机制不在此次实现范围。

模型可见输入不变，没有新增提示词、工具描述或注入项；固定前缀 token 与 KV cache 不变。
