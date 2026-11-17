# 贡献指南

RedSpace 是从 RedCode 演进而来的独立维护项目，历史源码包含 [OpenCode](https://github.com/anomalyco/opencode) 的开源成果，原有许可证和版权声明继续保留。当前由个人维护，**仅面向 Windows 10/11 开发和测试**——其他平台既不构建也不验证。

仓库公开是为了透明和备份，不是在招贡献者。Issue 和 PR 没有自动化 triage，回应看维护者的时间。如果你想在此基础上继续开发，可以在相应开源许可证允许的范围内创建自己的分支或衍生项目。

## 开发环境

要求：Windows 10/11、[Bun](https://bun.sh)、Node 24。

```bash
git clone https://github.com/JiaHuiRed/RedCode.git
cd RedCode
bun install
```

常用命令：

```bash
bun dev                                  # 启动 TUI（在 packages/redspace 下）
bun turbo typecheck                      # 全仓类型检查
bun run script/check-version-consistency.ts   # 版本号一致性自检
```

单个 package 的类型检查在对应目录下跑 `bun run typecheck`。**不要在仓库根目录直接跑 `tsc`**——这是个 monorepo，根目录没有可用的 tsconfig 入口。

编译产物：`packages/redspace/dist/redcode-windows-x64/bin/redcode.exe`。

更完整的配置、MCP、Skill 说明见 [MANUAL.md](MANUAL.md)；给 AI 代理看的工作约定见 [AGENTS.md](AGENTS.md)。

## 代码规范

- TypeScript，Effect v4（beta 线，API 会动，以 `node_modules` 里装的版本为准）
- 遵循现有代码风格，不引入新的抽象层除非确有必要
- 提交前跑类型检查
- 注释写"为什么"，尤其是绕过某个坑的地方——这个仓库里的注释带日期和署名前缀，照此办理

## 提交规范

Conventional Commits：`type(scope): summary`

| 类型       | 说明          |
| ---------- | ------------- |
| `feat`     | 新功能        |
| `fix`      | Bug 修复      |
| `docs`     | 文档更新      |
| `chore`    | 构建/工具变更 |
| `refactor` | 重构          |
| `test`     | 测试相关      |

scope 常用（非穷举，按改动所在的包或领域取）：`core` `redcode` `tui` `app` `desktop` `ui` `sdk` `plugin` `seed` `notes` `agent` `skill` `mcp` `config` `prompt` `session` `tool` `provider` `script` `ci` `changelog` `version`

AI 代理执行的 commit 在常规格式前加 active Soul 的 `[commit_prefix] `，依次回退到 `display_name`、`name`、`AI`，不由客户端决定署名；人类自己的 commit 不加。

## CI

只跑四个 workflow，全部只在 Windows 上：`test`（unit）、`e2e`（Playwright）、`typecheck`、`audit`（每日依赖漏洞扫描）。上游 opencode 那套发行渠道、文档站和社区机器人已全部移除。
