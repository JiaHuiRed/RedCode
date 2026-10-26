# 入口静态依赖预算与隔离启动基准

状态:implemented

## 问题

当前安装的 TypeScript 7.0.2 将 `typescript` 的 `.` export 指向 `lib/version.cjs`，运行时不暴露旧 `ts.ModuleKind`、`ts.createSourceFile` 与 `ts.resolveModuleName`。直接导入后 `ts.ModuleKind.Preserve` 为 `undefined`，旧检查器在业务用例前失败。与此同时，CLI 的 Windows job-runner guard 必须早于运行时代码；静态 ESM import 即使写在 guard 后也会被提升，单看源码位置不能保护启动路径。

## 决策

- 用 `Bun.Transpiler.scanImports` 获取 value import、value re-export、require 与 dynamic import；按 `.ts` / `.tsx` / `.js` / `.jsx` 选择 loader，type-only 引用由 transpiler 擦除。每条本地边按 importer 目录调用 `Bun.resolveSync`，realpath 后只计仓库源码；本地 alias/路径无法解析时明确失败。外部边界独立登记，dynamic import 目标单独统计，不并入静态闭包。
- 用 TypeScript 7 `typescript/unstable/ast` 的词法 scanner 检查 `index.ts`：擦除类型并跳过静态 import 声明后，首个运行时代码必须是 Windows runner guard。guard 后的动态 import 保持合法；静态依赖即使写在 guard 后也由 ESM 提升，因此由 CLI 的外部依赖 allowlist 和源码文件预算拦截。
- 预算只覆盖三条轻量入口：CLI index 初始静态图 1 个源码文件、41 个 dynamic target（允许静态外部依赖 `os`、`path`）；Windows job-runner 2 个源码文件（允许 `bun:ffi`、`cross-spawn`、`node:fs`）；record utility 1 个源码文件（无外部依赖）。各入口的 `maxFiles`、`forbid` 与外部依赖 allowlist 均由预算 JSON 显式配置，project bootstrap 重图不纳入本批。
- 启动基准从隔离 scratch cwd 以绝对源码路径启动，隔离 HOME/USERPROFILE/XDG/RedCode 配置与数据库，并启用 pure、禁模型抓取及插件依赖安装。CLI 仅以退出码 0 且输出非空有限数字 marker 判成功；server 仅以 loopback 健康端点返回 `{ healthy: true, version }` 判 ready。超时/取消只强杀并等待本工具创建的 child，不等待不合作 action 或其 pipe drain。
- health probe timeout 与 poll interval 属于外部预算配置，经边界校验后显式传入启动选项。

## 备选与否决理由

- **继续调用 TypeScript compiler API**：否决——TypeScript 7 的 package export 不再暴露这些旧 API。
- **用正则或自写通用 TS parser 扫 import**：否决——容易漏掉类型擦除、重导出和 require 形状；Bun.Transpiler 已提供实际导入扫描。
- **从 opencode package cwd 启动基准**：否决——项目 cwd 会发现仓库级配置，`--pure` 只控制外部插件，不代表禁用项目配置。

## 后果

pre-commit 在既有 OpenAPI 检查之外，按触及范围运行入口图预算；动态 import 不纳入静态文件数，因此 guard 顺序和外部静态依赖分别有独立断言。隔离 `runs=1, warmup=0` 实测 CLI debug-startup 为 5566.16ms，server 返回健康对象（`healthy=true` 且含版本字符串）为 4831.10ms。这是单次 smoke 样本，不代表提速或稳定性能基线；基准不读取 live 配置、数据库或 provider.
