# 贡献指南

RedCode 是 [opencode](https://github.com/anomalyco/opencode) 的个人 fork，由一个人维护，**只面向 Windows 10/11 开发和测试**——其他平台既不构建也不验证。

仓库公开是为了透明和备份，不是在招贡献者。Issue 和 PR 没有自动化 triage，回应看维护者的时间。如果你想在此基础上做自己的东西，直接 fork 更省事。

## 开发环境

要求：Windows 10/11、[Bun](https://bun.sh)、Node 24。

```bash
git clone https://github.com/JiaHuiRed/RedCode.git
cd RedCode
bun install
```

常用命令：

```bash
bun dev                                  # 启动 TUI（在 packages/opencode 下）
bun turbo typecheck                      # 全仓类型检查
bun run script/check-version-consistency.ts   # 版本号一致性自检
```

单个 package 的类型检查在对应目录下跑 `bun run typecheck`。**不要在仓库根目录直接跑 `tsc`**——这是个 monorepo，根目录没有可用的 tsconfig 入口。

编译产物：`packages/opencode/dist/redcode-windows-x64/bin/redcode.exe`。

更完整的配置、MCP、Skill 说明见 [MANUAL.md](MANUAL.md)；给 AI 代理看的工作约定见 [AGENTS.md](AGENTS.md)。

## 代码规范

- TypeScript，Effect v4（beta 线，API 会动，以 `node_modules` 里装的版本为准）
- 遵循现有代码风格，不引入新的抽象层除非确有必要
- 提交前跑类型检查
- 注释写"为什么"，尤其是绕过某个坑的地方——这个仓库里的注释带日期和署名前缀，照此办理

## 提交规范

Conventional Commits：`type(scope): summary`

| 类型 | 说明 |
|------|------|
| `feat` | 新功能 |
| `fix` | Bug 修复 |
| `docs` | 文档更新 |
| `chore` | 构建/工具变更 |
| `refactor` | 重构 |
| `test` | 测试相关 |

scope 常用：`core` `redcode` `tui` `app` `desktop` `sdk` `plugin`

AI 代理执行的 commit 在常规格式前加 `[Karina] ` 或 `[YuQi] ` 前缀标识执行人；人类自己的 commit 不加。

## CI

只跑三个 workflow，全部只在 Windows 上：`test`（unit + e2e）、`typecheck`、`audit`（每日依赖漏洞扫描）。上游 opencode 那套发行渠道、文档站和社区机器人已全部移除。
