# 测试临时目录泄漏：三层修复（堵源头 / 留痕 / 启动期清扫）

日期：2026-08-28 · 状态：implemented · 来源：现场事故（C 盘写满）；启动期清扫的形态对应 deepseek-harness `implemented/architecture/2026-07-17-local-spill-startup-cleanup.md`

## 问题

`%TEMP%` 里累积了 **1565 个 `redcode-test-*` 目录、40.3 GB**，从 2026-08-12 长到 08-28 无人知晓，最终把 200GB 的 C 盘写到只剩 0.1 GB —— 当时正在跑的测试开始以 `1 fail → 9 fail → 31 fail` 的曲线崩塌，而失败信息与磁盘毫无关系，排查时先被误判成代码回归。

追下去是**三个独立成因**，只修其中任何一个都不够：

### 成因 1（大头）：npm install 比创建它的作用域活得长

`config.ts` 在加载配置时会把 `@opencode-ai/plugin` 装进项目的 `.redcode/node_modules`，走的是 `Effect.forkDetach` —— **分离 fiber，不受作用域约束**。

测试里的时序：临时目录的 finalizer 先跑，此时目录还基本是空的，`clean()` **删得掉、不报错**；npm 随后把 `.redcode/node_modules` 重新写出来。于是留下一个约 38MB 的目录，而且**没有任何告警**——因为删除当时确实成功了。

实测：一轮工作会话攒出 **177 个这样的目录、6.5 GB**，单个平均 38 MB。这是 40GB 里的主要部分。

### 成因 2：清理失败被静默吞掉

```ts
yield* Effect.addFinalizer(() =>
  Effect.promise(async () => {
    if (options?.git) await stop(dir).catch(() => undefined)
    await clean(dir).catch(() => undefined)      // ← 失败静默
  }),
)
```

`clean()` 自带 `maxRetries: 5`，但 Windows 上 `rm -r` 撞到未释放的句柄（SQLite WAL、git 子进程、node_modules 链接）会 EBUSY/EPERM，重试跑完仍可能失败 —— 而 `.catch(() => undefined)` 把结果整个吞掉。**漏了多少年都不会有人知道。**

### 成因 3：进程被杀时 finalizer 根本不跑

超时被杀、崩溃、Ctrl-C —— 这几种情况下 finalizer 一行都不会执行。有多少测试跑超时，就有多少目录必漏，且无论前两条修得多好都兜不住。

## 决策

三层，各治一条，缺一不可。

### 1. 堵源头：`REDCODE_DISABLE_PLUGIN_DEP_INSTALL`

新增 `Flag.REDCODE_DISABLE_PLUGIN_DEP_INSTALL`，`config.ts` 命中时跳过那次后台安装；`test/preload.ts` 默认打开。

**不是测试专用开关**：离线/受限网络的部署同样需要它。它不影响插件**加载**，只跳过"为用户插件预装 SDK 包"这一步 —— 而那步本来就是分离 fiber，调用方从来无法依赖它已完成，所以跳过不会让任何原本可靠的行为变得不可靠。

### 2. 留痕：清理失败不再静默

`clean()` 失败改走 `cleanReporting()`：即时一条带路径与 errno 的 warn，进程退出时一条汇总。**不抛** —— 在 finalizer 里抛会带塌与它无关的用例。

### 3. 兜底：启动期清扫 `test/lib/sweep-temp.ts`

`test/preload.ts` 启动时删掉 `%TEMP%` 下所有 `redcode-test*` 前缀、mtime 早于 2 小时的目录。

**按 mtime 年龄过滤而不是按 pid 判活**：并发跑的另一个测试进程的目录一定是新的，不会被误删；而 Windows 上 pid 会被回收，判活不可靠。`REDCODE_TEST_TMP_TTL_HOURS=0` 可整个关掉。

清扫是尽力而为：删不掉的（别人还占着、权限不足）计入 `skipped` 留到下一轮，**绝不抛** —— 清扫失败不该让测试跑不起来。

## 备选与否决理由

- **只加启动期清扫**：否决。成因 1 每轮会话产出 6.5GB，两小时的 TTL 窗口内照样能把盘写满；而且它掩盖问题而不是修问题。
- **只把 `.catch(() => undefined)` 改成抛出**：否决。finalizer 抛会带塌无关用例；而且成因 1 那条路径**删除本来就成功了**，抛不出任何东西。
- **在 `clean()` 里等 npm install 结束**：否决。要给分离 fiber 加作用域约束，是 `Config.load` 的结构性改动，且会让每个用例的拆解等一次网络安装。
- **把 `REDCODE_PURE` 用作开关**（它已经会让 `plugin_origins` 变空）：否决。语义过宽 —— 那是"不加载用户插件"，打开它会改变 `test/plugin/` 的行为面。新开关只关掉安装这一步。

## 验证

`test/lib/sweep-temp.test.ts`（7 例）：删陈旧留新鲜；**不碰任何比 TTL 新的目录**（并发进程的保护，也是不按 pid 判活的理由）；只匹配 `redcode-test` 前缀（`redcode-live-session`、`some-other-tool` 必须留下）；正确报告回收字节数；`ttlHours <= 0` 整个关闭；根目录不存在不算错；同名**文件**不被当成目录删掉。

端到端：修改前跑一轮 `bun test test/config/` 会新增 1 个带 `.redcode/node_modules` 的目录且**零告警**；修改后同一条命令 **delta = 0**。

回归：`test/plugin/` 基线 3 fail（`plugin.xai` 三条，既有），带改动同样 3 fail；`test/config/` 31 fail 与本轮早先建立的基线一致；`test/lib/` 7 pass、`test/sync/` 23 pass。`bun run typecheck` exit 0。

## 记账

- 遗留的 258 个目录（含事故后用户手动清理的剩余）会在下一次跑测试、且它们超过 2 小时后被自动扫掉，不需要人工干预。
- `test/file/ripgrep.test.ts` 自己 `mkdtemp` 了一个同前缀目录，用 `Effect.acquireRelease` 清理，失败同样静默 —— 它在清扫的覆盖范围内，本轮未单独改。
- `test/preload.ts` 的 `redcode-test-data-<pid>` 有一段 30 次重试的 EBUSY 处理，比 fixture 侧更强；两者可以合并成一个共用的 `removeWithRetry`，本轮未做。
