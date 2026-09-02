# 配置测试清掉 opencode→redcode 重命名欠账，并分离出两个 TUI 配置层真 bug

状态：implemented

## 问题

`bun test test/config/`（在 `packages/opencode` 下跑）长期 153 pass / 31 fail。31 条最显眼的签名是：

```
error: NotFound: FileSystem.readFile (C:\Users\...\Temp\redcode-test-xxxx\opencode.jsonc)
```

看上去像"测试写 `opencode.jsonc`、代码读 `redcode.jsonc`"一条根因。**实际不是**：31 条里只有 4 条是这个签名，其余 27 条另有来源。逐条验完，31 条分成四类：

| 类 | 条数 | 真实根因 |
|---|---|---|
| A 环境变量名 | 大头 | 测试设 `OPENCODE_*`，代码只认 `REDCODE_*`，**无回退** |
| B 目录名 | 若干 | 测试造 `.opencode/`，加载器只扫 `.redcode/` |
| C 全局/托管层文件名 | 4 | 全局配置目录只认 `redcode.*`，测试写 `opencode.jsonc` |
| D 非重命名欠账 | 6 | 见下，两个是 src 真 bug |

关键分辨点：**项目级 `opencode.json(c)` 至今仍被加载**（`src/config/config.ts:687` 为 MCP 兼容显式再扫一遍 `opencode` 前缀），所以不能对 `opencode.json` 做无差别全局替换——只有**全局配置目录**和**托管目录**没有 `opencode.*` 回退。同理 `provider.opencode`（供应商 id）、`oh-my-opencode`（npm 包名）、`DEFAULT_THEMES.opencode`（主题名）、`https://config.example.com/opencode.json`（纯 mock URL）都不是文件名欠账，一个都不能动。

## 决策

只改 `test/config/config.test.ts`（全仓扫过，其余测试文件零欠账）：

1. `OPENCODE_*` → `REDCODE_*`（含 `TEST_MANAGED_CONFIG_DIR`／`CONSOLE_TOKEN`／`CONFIG_DIR`／`DISABLE_PROJECT_CONFIG`／`CONFIG_CONTENT`／`PERMISSION`／`DB`）。其中 `OPENCODE_TEST_MANAGED_CONFIG_DIR` 尤其隐蔽：`test/preload.ts` 设的是 `REDCODE_TEST_MANAGED_CONFIG_DIR`，测试读到 `undefined` 后 `path.join(undefined, ...)` 直接抛，托管设置那几条全挂在这上面。
2. `.opencode/` → `.redcode/`（agent／command／plugin 自动发现的目录）。
3. 引号包裹的字面量 `"opencode.json(c)"` → `"redcode.json(c)"`。用带引号的形式匹配，天然避开 `https://config.example.com/opencode.json` 这类 mock URL（其前面是 `/` 不是 `"`）。
4. `$schema` 断言 `https://opencode.ai/config.json` → `https://redcode.dev/config.json`（src 现写后者）。
5. 复数 `agents/` 那条改成钉住"复数被忽略、单数照常"。它不是重命名欠账，是 `43be65f0` 刻意收口的**已删功能**：`src/config/agent.ts:123` 扫到复数目录只发一条 warning 就丢弃。注意命令侧不同，`{command,commands}` 两种都仍支持，别顺手一起收。

结果 153/31 → **179 pass / 5 fail**。typecheck 干净。

## 备选与否决理由

- **对 `opencode.json` 做全局 sed**：否决——会一并改掉 MCP 兼容路径与 mock URL，把仍在生效的兼容行为改没。
- **把复数 `agents/` 测试直接删掉**：否决——那样"复数被忽略"这个刻意决定就没有任何测试钉着，后来者容易把它加回来。
- **改 src 让 5 条剩余失败转绿**：否决（本次不做）——它们是真 bug，改的是用户可见的配置优先级语义，得单独决策，见下。

## 后果

剩余 5 条**全部不是测试欠账，是 src 真 bug**，测试写得对、代码错。故意留红，不要靠改测试掩盖。

### bug 1：全局 `.redcode` 会反压项目级 TUI 配置（4 条）

`src/cli/cmd/tui/config/tui.ts` 第 4 步按 `dir.endsWith(".redcode")` 过滤"项目级 `.redcode` 目录"再合一次。但 `Global.Path.config` 本身就是 `<home>/.redcode`，**也 endsWith `.redcode`**，于是全局层在项目层之后被重新合入、拿到最高优先级——跟同文件第 1 步注释写的"Global tui config (lowest precedence)"正好相反。

开关式对照（同一份配置，只改全局目录名）：

```
全局目录名 ".redcode"   -> demo = true   （全局赢，错）
全局目录名 "globalcfg"  -> demo = false  （项目赢，对）
```

生产环境 `Global.Path.config` 就是 `~/.redcode`，**真实用户受影响**：`~/.redcode/tui.json` 会盖掉项目的 `tui.json`。识别签名：项目里改 theme／plugin_enabled 不生效，删掉全局同名键才生效。

### bug 2：测试会读到维护者的真实 `~/.redcode`（1 条）

`ConfigPaths.directories(directory, worktree)` 的项目级上溯设计上由 `worktree` 收口，`config.ts` 传了，`tui.ts:195` **没传**（同文件 `:63` 还留着一行注释掉的 `ctx.worktree`——该层拿不到 worktree）。`worktree` 为 undefined 时上溯一路走到盘根。Windows 上临时目录在 `C:\Users\<user>\AppData\Local\Temp` 底下，上溯必然经过真实家目录，于是扫到真实的 `C:\Users\<user>\.redcode`。

实测探针从临时目录出发拿到：

```
- <testhome>\.redcode          （测试全局，对）
- C:\Users\ADMINI~1\.redcode   （维护者 live 配置，泄漏）
- C:\.redcode
```

`resolves attention config defaults and overrides` 收到的 `{enabled:true, notifications:false, sound:false}` 与 `~/.redcode/tui.jsonc` 逐字节一致，即为实锤。

**读泄漏已发生，写泄漏是悬着的**：`tui-migrate.ts` 的 `redcodeFiles()` 把这批 directories 也当迁移源，命中就会剥掉 `theme`／`keybinds`／`tui` 三个键并落一个 `.tui-migration.bak`。本次没触发，只因维护者的 `~/.redcode/redcode.jsonc` 恰好不含这三个键（顶层只有 agent／compaction／default_agent／disabled_providers／instructions／mcp／shell／tools）。已核对 mtime 与 `git -C ~/.redcode status`，live 配置未被改动。这条与"测试洗 live 配置"是同一族危险，`packages/core/src/global.ts:9` 那段注释记的就是上一次同族事故。

两条都未修：修法要么把 worktree 穿进 TUI 配置层，要么把 `Global.Path.config` 与家目录 `.redcode` 排除出第 4 步——都改用户可见语义，留给维护者决策。
