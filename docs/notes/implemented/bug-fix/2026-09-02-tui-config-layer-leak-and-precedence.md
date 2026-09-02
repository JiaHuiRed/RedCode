# TUI 配置层两个 bug：全局层反压项目层、上溯没收口读到真实家目录

状态：implemented

## 问题

清理 `test/config/` 重命名欠账（见
[2026-09-02-config-test-rename-debt](../testing/2026-09-02-config-test-rename-debt.md)）之后仍有 5 条红的。
逐条验完，**测试写得对、src 错**，是 `src/cli/cmd/tui/config/tui.ts` 上的两个独立 bug。

### bug 1：全局 `.redcode` 在项目层之后被重新合入（4 条）

第 4 步按 `dir.endsWith(".redcode")` 挑"项目级 `.redcode` 目录"再合一遍。但
`Global.Path.config` 本身就是 `<home>/.redcode`、**也 endsWith `.redcode`**，于是全局层
在第 3 步的项目文件**之后**被重新合入、拿到最高优先级——跟同文件第 1 步注释写的
`Global tui config (lowest precedence)` 正好相反。

开关式对照（同一份配置，只改全局目录名）：

```
全局目录名 ".redcode"   -> demo = true    （全局赢，错）
全局目录名 "globalcfg"  -> demo = false   （项目赢，对）
```

生产环境 `Global.Path.config` 恒等于 `~/.redcode`，**真实用户可见**：
全局 `~/.redcode/tui.json` 会盖掉项目的 `tui.json`。
识别签名：项目里改 `theme`／`plugin_enabled` 不生效，删掉全局同名键才生效。

### bug 2：项目级上溯没收口，扫到跑测试的人的真实 `~/.redcode`（1 条）

`ConfigPaths.directories(directory, worktree)` 的项目级上溯设计上由 `worktree` 收口。
`config.ts` 一直传 `ctx.worktree`，**`tui.ts` 没传**（该层 `ctx` 只有 `{ directory }`，
同文件 `:63` 还留着一行注释掉的 `ctx.worktree`）。`worktree` 为 undefined 时
`afs.up` 的 `stop` 为空、一路走到盘根；Windows 的 `os.tmpdir()` 就在家目录底下
（`C:\Users\<user>\AppData\Local\Temp`），上溯必经真实家目录。

探针（从临时目录调 `ConfigPaths.directories`）实测返回：

```
- <testhome>\.redcode          （测试全局，对）
- C:\Users\ADMINI~1\.redcode   （维护者 live 配置，泄漏）
- C:\.redcode
```

`resolves attention config defaults and overrides` 收到的
`{enabled:true, notifications:false, sound:false}` 与真实 `~/.redcode/tui.jsonc` 逐字节一致。

这条与 2026-08-22 那次"配置污染测试"是同一族：那次的修法是在临时目录里钉一个空 `.git`
把 worktree 定住，**但只有把 worktree 传下去的消费方才吃得到这个修复**，`tui.ts` 没传，
所以那次没覆盖到这里。

**写的一面当时是悬着的**：`tui-migrate.ts` 的 `redcodeFiles()` 把这批 directories 也当迁移源，
命中就剥掉 `theme`/`keybinds`/`tui` 三键并落一个 `.tui-migration.bak`。当时没触发，
只因维护者的 `~/.redcode/redcode.jsonc` 恰好不含这三个键——不是因为有防线。

## 决策

两处都改在 `tui.ts`：

1. **传 worktree**：取最近的 `.git` 作边界（与 fixture 钉的标记同源）传给
   `ConfigPaths.directories`。找不到 `.git` 时维持不收口，跟 `project.fromDirectory`
   对非 git 目录回落成 `worktree="/"` 的语义保持一致——让 TUI 与 server 两条路一致，
   而不是让 TUI 单方面更严。
2. **合并时跳过 `Global.Path.config`**：第 1 步已经加载过它，第 4 步不再重复。

`test/config/` 184 pass / 0 fail，typecheck 干净。`test/cli/tui/` 132 pass / 3 fail，
3 条是快照类的既有失败——已用 `git show HEAD:<file>` 换回改前版本跑过对照，改前改后同样是 132/3。

## 备选与否决理由

- **把 `Global.Path.config` 从 `dirs` 里滤掉**（而不是只在合并循环里 `continue`）：否决——
  `dirs` 还要原样返回给上层给插件装依赖（`tui.ts:284` → `npm.install`），滤掉会让
  **全局插件的依赖不再被安装**。这是改这块最容易踩的坑，只跳过合并、不动 `dirs`。
- **在 `ConfigPaths.directories` 里把"无 worktree"默认收口到 git 根**：否决——
  那会改掉所有调用方的共享语义；本次只有 `tui.ts` 漏传，在调用点补更收敛。
  代价是"上溯无边界"这个陷阱对未来的新调用方仍然存在。
- **改测试让 5 条转绿**：否决——测试写得对，改测试就是把 bug 盖住。
- **用 `project.fromDirectory` 拿 worktree**：否决——它要跑 git 发现、偏重，
  而 TuiConfig 在 TUI 启动路径上；一次 `.git` 上溯就够。

## 后果

- 配置优先级语义变了（往正确方向）：**全局 `~/.redcode/tui.json` 不再盖掉项目 `tui.json`**。
  如果有人此前无意中依赖了"全局赢"的旧行为，升级后表现会变——这正是修复意图。
- 非 git 目录仍不收口（与 `config.ts` 一致），那种目录下的 TUI 配置发现仍会向上扫。
  要根治得连 `config.ts` 一起改 `worktree="/"` 的哨兵语义，是另一件事。
- 防复发：`packages/opencode/test/config/tui.test.ts` 里
  `resolves attention config defaults and overrides` 钉住 bug 2，
  `merges plugin_enabled flags across config layers` 等 4 条钉住 bug 1。
  这几条**在 Windows 上才有区分度**（temp 在家目录底下才会经过真实 `~/.redcode`），
  Linux CI 上即使回归也可能照样绿——别把它们在 CI 绿当作没问题。
- 诊断手法沿用 08-22 那条：在 `config/paths.ts` 的 `directories()` 末尾打印实际扫描列表，
  一眼看出真实家目录有没有混进去。
