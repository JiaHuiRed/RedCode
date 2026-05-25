# 贡献指南

欢迎为 RedCode 做出贡献！以下是最常见的可合并更改类型：

- Bug 修复
- 新增 LSP / 格式化器支持
- LLM 性能优化
- 新的 Provider 支持
- 环境特定问题修复
- 缺失的标准行为补充
- 文档改进

但是，任何 UI 或核心产品功能的更改必须经过核心团队的设计审查。

## 开发环境

```bash
# 克隆仓库
git clone https://github.com/JiaHuiRed/RedCode.git
cd RedCode

# 安装依赖
bun install

# 启动开发服务器
bun dev
```

## 代码规范

- 使用 TypeScript
- 遵循现有代码风格
- 提交前运行 `bun typecheck`
- 使用 Conventional Commits 格式：`feat(scope): summary`

## 提交规范

| 类型 | 说明 |
|------|------|
| `feat` | 新功能 |
| `fix` | Bug 修复 |
| `docs` | 文档更新 |
| `chore` | 构建/工具变更 |
| `refactor` | 重构 |
| `test` | 测试相关 |
