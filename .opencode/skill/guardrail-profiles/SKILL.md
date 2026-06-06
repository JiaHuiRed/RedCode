---
name: guardrail-profiles
description: 三档 guardrail（`minimal`/`standard`/`strict`），通过环境变量 `ECC_PROFILE` 控制。minimal = 少确认快干活，strict = 每步都问。
---

# Guardrail Profiles

通过 `ECC_PROFILE` 环境变量控制严格程度，不改配置文件。

## 三档对比

| 行为 | minimal | standard | strict |
|------|---------|----------|--------|
| Read/搜索 | ✅ 直接做 | ✅ 直接做 | ✅ 直接做 |
| 单文件小编辑 | ✅ 直接做 | ✅ 直接做 | ❓ 先确认 |
| 跨文件编辑 | ✅ 直接做 | ❓ 先出方案 | ❓ 先出方案 |
| 不可逆操作 | ❌ 问用户 | ❌ 问用户 | ❌ 问用户 |
| 首次编辑不熟的文件 | ✅ 直接做 | ❓ 先调查引用 | ❓ 先调查引用+依赖 |
| 新文件创建 | ✅ 直接做 | ❓ 先确认 | ❓ 先确认 |
| Shell 命令 | ✅ 直接跑 | ❓ 只允许白名单 | ❓ 每个命令都问 |
| 连续失败 | 3 次停 | 2 次停 | 1 次停 |

## 设置方式

```bash
# Windows (PowerShell)
$env:ECC_PROFILE="strict"

# macOS / Linux
export ECC_PROFILE=minimal
```

默认 `standard`。不设环境变量 = standard。

## 执行逻辑

每次 `permission.ask` 前检查 `ECC_PROFILE`：

```
if (ECC_PROFILE === "minimal") → 尽可能 allow，不可逆操作才问
if (ECC_PROFILE === "standard") → 白名单 allow，其余确认
if (ECC_PROFILE === "strict") → 几乎每个操作都 ask
```

## 对应关系

- **minimal** → "相信我，让我做"
- **standard** → "你看着，我干"
- **strict** → "每一步我都报告"

自己选哪一档。不设就是 standard。
