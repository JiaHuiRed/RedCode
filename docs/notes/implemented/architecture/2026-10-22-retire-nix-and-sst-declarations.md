# 退役失修 Nix 构建链与 SST 历史资源声明

状态：implemented

## 问题

仓库 2026-05-25 初始导入后，以下文件从未随 Windows-only 转型更新：

- `flake.nix` / `nix/*`：仍引 `nodejs_20`、`electron_41`，安装配方找 `bin/opencode`，而 `script/build.ts` 实际产物是 `bin/redcode`（`redcode.exe`）；`nix/node_modules.nix` 还引用已不存在的 `../.github/TEAM_MEMBERS`。本机无 Nix，无法验证，表面「支持」实为断链。
- 16 个 `sst-env.d.ts`：声明的 SaaS Console/AuthApi/Zen 等资源已在 `sst.config.ts` 清理（260930、261006 两批），全仓无 `Resource.*` 业务消费；本机 `sst` 生成器不可用，无法重生成，历史快照只会误导。
- `screenshot-uk.png`：上游 OpenCode 乌克兰语截图，全仓文本零引用。
- `install`：Windows 分支把 zip 里的 `redcode.exe` 当 `redcode` 移动并 `chmod`，文件名不匹配；文档链接指向上游 opencode.ai。

## 决策

- 删除 `flake.nix`、`flake.lock`、`nix/**`、`screenshot-uk.png`；删除全部 16 个 `sst-env.d.ts`。`packages/app/src/env.d.ts` 补 `/// <reference types="vite/client" />` 承接原 `src/sst-env.d.ts` 的 Vite 类型入口；`.gitignore` 增 `sst-env.d.ts` 防止本机生成物再入库。
- `install`：Windows（MINGW/MSYS/CYGWIN）目标名改 `redcode.exe`（zip 解压与 `--binary` 分支都覆盖），其他平台仍 `redcode`；信息链接改仓库 GitHub 地址；安装行为无其他改动。
- `sst.config.ts`、`infra/*` 与 `sst` devDependency 保留：监控配置仍是活资源，退役的只是类型快照与断链构建入口。

## 备选与否决理由

- **修复 Nix 配方到 redcode 命名**：否决——无 Nix 环境验证，修了也是不可测试的承诺。
- **保留 sst-env.d.ts 只删旧条目**：否决——文件是自动生成物，手改会与下次生成冲突；当前资源声明极少且无消费者，整组删除更诚实。

## 后果

- 若恢复 Nix 支持，从零重写 flake 并以 `bin/redcode` 为起点，不要找回旧文件。
- SST 若重新 deploy，本机 `sst generate` 会重新产出 `sst-env.d.ts`（已被 gitignore，不进仓）。
- LSP 把 `flake.nix` 当项目根标记的代码未动（超出本次授权范围）；仓库已无该文件，该探测自然返回否。
