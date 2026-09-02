# 配置写盘改成原子替换，并在 Windows 上重试被外部句柄顶掉的 rename

日期：2026-09-01 · 状态：implemented · 来源：deepseek-harness `.agents/notes/implemented/bug-fix/2026-08-29-windows-atomic-replace-retry.md`

## 问题

上游那篇讲的是「原子替换在 Windows 上会被瞬时拒绝，第一次失败不该当永久失败」——**前提是它已经有 `writeFileAtomic`**。照着回本仓核实，发现我们的缺口比它大一档：

`config/config.ts` 六处写盘全是 `fs.writeFileString` 直写，没有临时文件、没有 rename：

| 位置 | 写什么 |
|---|---|
| `loadFile` 的 `$schema` 回填 | 用户的配置文件本体 —— **而且这一步发生在「加载」配置的过程里** |
| 旧版 TOML 迁移 | 全局 `config.json` |
| `Config.update` | 项目 `config.json` |
| `updateGlobal` × 2 | 全局 `.json` / `.jsonc`（多机同步的那一份） |

直写被打断（关机、崩溃、磁盘满），留下的就是半截 JSON；下一次启动读不出来。`$schema` 回填那条尤其别扭：它不是用户主动保存，是**读配置的副作用**在改用户的文件。

全仓唯一一份 temp+rename 在 `cli/cmd/tui/context/kv.tsx`，只服务 TUI 的 kv.json，没有共享出去，也没有重试；临时文件名用 `Date.now()`，同一毫秒内连写会撞名。

`write-file-atomic` / `atomically` 确实在依赖树里，但只是 `conf`（electron-store）的传递依赖 —— 也就是说 **GUI 那条 persist 路径是原子的，配置文件这条不是**。

## 决策

原语放 `packages/core/src/filesystem.ts`（`AppFileSystem` 服务所在），两个面：

- `AppFileSystem.writeFileAtomic(path, content, mode?)` —— 普通 async，给 kv.tsx 和 `fsNode` 那类调用点
- `AppFileSystem.Interface.writeFileStringAtomic` —— Effect 面，给 `config.ts` 里 `yield* fs.…` 的调用点

**① 临时文件必须是同目录兄弟。** 跨卷 rename 直接 EXDEV。名字用 `pid + 进程内递增计数器`，不用 `Date.now()`。

**② Windows 上重试 rename，只对 `EACCES` / `EBUSY` / `EPERM`。** 这是上游那篇的核心：别的系统组件（杀软扫描、索引器、另一个读者）临时握着目标句柄时替换会被拒，而这是瞬时的。跨进程写锁（`Flock`）排的是我们自己人，管不到外部句柄。别的错误码、别的平台立刻失败。

延迟 20ms 起翻倍、封顶 200ms，8 次重试 = 9 次尝试 = 最多多等 1.1 秒。**这次没有跟上游参数的取舍问题**（对比 260822 那次 JPEG 质量梯子：官方不按人民币计费、本仓按，所以没跟 85/75/60）——配置写盘既不在模型热路径上、又罕见，偏宽容才是对的方向，而这台机器上 Defender 是活跃的。

**③ 失败时目标全程没被碰过。** 重试耗尽就删掉临时文件再抛出，读者看到的始终是完整的旧内容，而不是半截 JSON。这条是整个改动的意义所在，也是回归测试里单独钉住的一例。

`kv.tsx` 那份孤立实现并过来，顺带白拿重试和不撞名的临时文件。

## 刻意没做

- **fsync。** temp+rename 解决的是「读者看到半截文件」，这条已经够了；为掉电那个窄窗口给每次配置写盘加一次 fsync 不划算。
- **`ensureGitignore` 没换。** 它在 `!hasIgnore` 分支里创建一个**新**文件，没有「替换已有内容」这回事，套原子替换只是多一次临时文件往返。
- **没碰 `writeJson` / `writeWithDirs`。** 它们的调用点是缓存、快照、临时产物这类「写坏了重新生成即可」的文件。原子替换有成本（一次多余的写 + rename），只给「写坏了就毁掉用户数据」的文件付。

## 测试

`packages/core/test/filesystem/write-atomic.test.ts`，10 例。

重试那部分**不 mock `fs/promises`** —— 那个模块全仓都在用，`mock.module` 换掉它风险太大。改成把 rename 循环抽成 `renameWithRetry(from, to, deps)`，`deps` 里注入 `rename` / `sleep` / `platform`。测试因此能像上游描述的那样「观察 rename 尝试次数、推进假时钟」，不依赖墙钟睡眠，也不碰真实文件系统模块。注入点只为回归测试存在，真实调用一律走默认值。

覆盖：写新文件（含创建父目录）、替换已有文件不留临时兄弟、三个可重试码各自重试后成功并核对退避序列、非可重试码只尝试一次、非 Windows 不重试、重试预算耗尽（9 次 / 累计 1100ms）、**失败后目标保持旧内容且临时文件被清掉**、并发写不撞名。

## 记账

`packages/opencode` 的 `test/config/` 有 31 个既有失败（`opencode.jsonc` 找不到，RedCode→redcode 改名遗留的陈旧断言）。**已用对照确认与本改动无关**：还原到 dev 基线跑同一批，同样是 153 pass / 31 fail。这批断言的修复是单独一件事。
