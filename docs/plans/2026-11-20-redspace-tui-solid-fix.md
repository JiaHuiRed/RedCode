# RedSpace · Windows TUI 启动闪字修复建议

**建议改 3 个文件。** 让 TUI 桌宠使用 TUI 自己的 Solid 运行时，桌面端和 TUI 继续共用同一份桌宠状态规则。目标是消除首页出现前左上角的英文闪字，并确保工作区、会话切换时桌宠仍跟对状态。

基线为 RedSpace 0.19.5，[`master@44d13d7`](https://github.com/JiaHuiRed/RedSpace/commit/44d13d78f96c6f2056d73f8bdf2c05ff521778ce)。本文是实施建议。源码对照实验已完成，Windows 可执行文件待实机验收。

## 1. 闪过的是哪句话

> You appear to have multiple instances of Solid. This can lead to unexpected behavior.

TUI 加载 `pet-source.tsx` 时，顶层导入了桌面端的 `@redcode-ai/ui/pet-store`。TUI 先加载 Solid **1.9.14**，共享 store 又从 UI 包加载 **1.9.17**。第二份运行时初始化时向控制台发出警告，此时 TUI 尚未绘制首页。组件内的 Windows 平台判断发生在导入之后。[TUI 桌宠入口](https://github.com/JiaHuiRed/RedSpace/blob/44d13d78f96c6f2056d73f8bdf2c05ff521778ce/packages/redspace/src/cli/cmd/tui/pet-source.tsx) · [共享 store](https://github.com/JiaHuiRed/RedSpace/blob/44d13d78f96c6f2056d73f8bdf2c05ff521778ce/packages/ui/src/pet/pet-store.ts)

在 Linux 上用 Bun 1.3.14、`browser + development` 条件导入真实的 TUI 入口，两组都成功完成导入。唯一的实验变量是桌宠 store 从哪里加载 Solid。

| 对照 | 实际加载的 Solid | 该警告次数 |
| --- | --- | ---: |
| 当前基线 | 1.9.14 → 1.9.17 | 1 |
| 临时让桌宠 store 使用 TUI 的 Solid | 仅 1.9.14 | 0 |

## 2. 开发改动

| 文件 | 建议修改 |
| --- | --- |
| [packages/ui/src/pet/pet-state.ts](https://github.com/JiaHuiRed/RedSpace/blob/44d13d78f96c6f2056d73f8bdf2c05ff521778ce/packages/ui/src/pet/pet-state.ts) | 新增纯函数 `applyDirectoryPetEvent(state, event, directory, now)`。把现有 `feedPetEvent` 中 `produce` 回调的完整内容移入，保持这个模块独立于 Solid。 |
| [packages/ui/src/pet/pet-store.ts](https://github.com/JiaHuiRed/RedSpace/blob/44d13d78f96c6f2056d73f8bdf2c05ff521778ce/packages/ui/src/pet/pet-store.ts) | 桌面端沿用现有模块级 store。让 `feedPetEvent` 取一次 `Date.now()`，在 `produce` 中调用新函数。保留现有导出，桌面端的事件订阅、启动快照和回放继续走原入口。 |
| [packages/redspace/src/cli/cmd/tui/pet-source.tsx](https://github.com/JiaHuiRed/RedSpace/blob/44d13d78f96c6f2056d73f8bdf2c05ff521778ce/packages/redspace/src/cli/cmd/tui/pet-source.tsx) | 移除对 `@redcode-ai/ui/pet-store` 的导入。在本文件从 `solid-js/store` 导入 `createStore`、`produce`，用 `createPetState()` 创建模块级 store。收到 SDK 事件时调用同一纯函数。`resolvePet`、`resolveSessionPet`、`outfitFor` 都读取这份 store。 |

**容易漏掉的两个细节**

- 共享函数要依次更新桌宠状态、记录启动期间的事件、处理瞬时表情和会话的目录归属。会话 ID 同时支持 `properties.sessionID` 和 `properties.part.sessionID`。同一事件只取一次时间，否则瞬时表情的时间匹配可能失效。
- TUI store 放在组件外。切换工作区时组件会重新挂载，事件订阅和宿主客户端随组件更新，已收到的会话状态则应保留。继续沿用现有的 1 秒过期检查和快照去重。

## 3. Windows 验收

在已安装仓库依赖的工作树中，从根目录打开 PowerShell。先验证源码，再运行本次构建的 EXE。构建输出写入新的临时目录，避免覆盖日常使用的版本。

```powershell
Push-Location .\packages\redspace
bun --conditions=browser --conditions=development -e "await import('./src/cli/cmd/tui/app.tsx'); console.log('TUI import OK')"

$previousBuildDir = $env:REDCODE_BUILD_DIR
$env:REDCODE_BUILD_DIR = Join-Path $env:TEMP ("redspace-pet-" + [guid]::NewGuid())
try {
    bun run script/build.ts --skip-embed-web-ui
    if ($LASTEXITCODE -ne 0) { throw 'Windows build failed' }
    & (Join-Path $env:REDCODE_BUILD_DIR 'redcode-windows-x64\bin\redcode.exe')
} finally {
    $env:REDCODE_BUILD_DIR = $previousBuildDir
    Pop-Location
}
```

| 场景 | 通过标准 |
| --- | --- |
| 源码入口与 EXE 冷启动 | 源码输出 `TUI import OK`，重复实例警告为 0 次。启动新 EXE 时左上角无该行，首页可正常输入。 |
| 持续观察同一会话 | 分别触发运行、等待授权和任务结束。桌宠随状态变化，授权后解除等待，结束后回到空闲。 |
| 切会话、切工作区 | 在 A 留一个待授权请求，切到空闲的 B。B 显示自己的状态，切回 A 仍显示待授权。 |
| 桌面端回归 | 桌面端重连后，启动快照回放仍保留待授权或待回答状态。桌宠宿主不可用时，TUI 仍能启动、输入和退出。 |

自动回归建议增加一条**独立 Bun 子进程**的入口测试，同时断言导入成功和警告出现 0 次。状态逻辑继续跑现有的[桌宠状态测试](https://github.com/JiaHuiRed/RedSpace/blob/44d13d78f96c6f2056d73f8bdf2c05ff521778ce/packages/ui/src/pet/pet-state.test.ts)和[启动事件回放测试](https://github.com/JiaHuiRed/RedSpace/blob/44d13d78f96c6f2056d73f8bdf2c05ff521778ce/packages/app/src/pet/pet-journal-reducer.test.ts)。
