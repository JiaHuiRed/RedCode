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

本条改动把 153/31 带到 **179 pass / 5 fail**；剩下 5 条是两个 src 真 bug，另行修掉后为 184/0。

## 备选与否决理由

- **对 `opencode.json` 做全局 sed**：否决——会一并改掉 MCP 兼容路径与 mock URL，把仍在生效的兼容行为改没。
- **把复数 `agents/` 测试直接删掉**：否决——那样"复数被忽略"这个刻意决定就没有任何测试钉着，后来者容易把它加回来。
- **改测试让剩下 5 条转绿**：否决——那 5 条测试写得对、src 错，是两个真 bug（见
  [2026-09-02-tui-config-layer-leak-and-precedence](../bug-fix/2026-09-02-tui-config-layer-leak-and-precedence.md)）。
  改测试就是把 bug 盖住。两个 bug 已另行修掉，`test/config/` 现为 **184 pass / 0 fail**。

## 后果

- 结果 153/31 → **179 pass / 5 fail**（本次改动本身），typecheck 干净。剩余 5 条不是测试欠账，
  是两个 src 真 bug；单独修掉后 `test/config/` 为 **184 pass / 0 fail**。根因、实证与修法见
  [2026-09-02-tui-config-layer-leak-and-precedence](../bug-fix/2026-09-02-tui-config-layer-leak-and-precedence.md)。
- **别再对 `opencode` 字样做无差别替换**。仓里仍有四类合法出现，一个都不是文件名欠账：
  项目级 `opencode.json(c)`（MCP 兼容，`config.ts:687` 显式再扫一遍）、供应商 id
  `provider.opencode`、npm 包名 `oh-my-opencode`、主题名 `DEFAULT_THEMES.opencode`，
  外加 `config.example.com/opencode.json` 这类纯 mock URL。
  安全的匹配形式是**带引号的字面量** `"opencode.json"`，它天然避开 URL（URL 里前一个字符是 `/`）。
- 全仓扫过，`packages/opencode/test/` 下其余测试文件零重命名欠账。
  `inline-tool-wrap-snapshot` 里的 `OPENCODE_DB|OPENCODE_DEV` 是**折行用的展示字符串**、
  不是环境变量消费点，改它只会白洗快照。
- 识别签名（下次再遇到同类）：报错落在 `NotFound: FileSystem.readFile (...\opencode.jsonc)` 的
  只是少数；**大头是环境变量名不匹配**，症状五花八门（`path.join(undefined, ...)` 直接抛、
  flag 读不到导致走错分支），从签名反推根因会漏掉一大半。先按"env 名 / 目录名 / 文件名"三类分桶再动手。
