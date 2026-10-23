# TUI keymap context 改 TUI 侧自建，solid-js 双实例不再炸启动

状态:implemented

## 问题

261022 依赖批次（`0edd8e54`）把 catalog 的 solid-js 升到 1.9.17 后，`bun run dev` 起 TUI 即崩：

```
Error: Keymap not found. Wrap the tree in <KeymapProvider>.
  at useKeymap (@opentui/keymap src/solid/index.js)
  at useOpencodeModeStack (keymap.tsx)
  at init (ui/dialog.tsx)  ← DialogProvider 挂载链
```

测试同样挂：`dialog-soul.test.tsx` 崩同一条错误，`keymap-enabled-lazy.test.tsx` 的 `useBindings` 只注册 1 次（期望 6）。修复前实测 5 个用例 4 挂。

根因是**同一进程里有两份 solid-js 实例**：

- `packages/opencode` 走 catalog `solid-js@1.9.17`（TUI 源码的 JSX / createEffect / render 全在这一份上）；
- bun.lock 给 `@opentui/keymap` 与 `@opentui/solid` 单独解析了 `solid-js@1.9.14`（lock 键 `@opentui/keymap/solid-js`、`@opentui/solid/solid-js`）——这两个包的 peer 钉 `solid-js 1.9.12`，与 catalog 版本不符，bun 的 isolated linker 给它们各装了一份。

solid 的 context 是模块级全局栈，两份实例各一套：keymap 的 `KeymapProvider` 在 1.9.14 实例的栈上压值，TUI 源码里的 `useKeymap` 去 1.9.14 的栈里读——渲染流程是 1.9.17 驱动的，读到的是空栈，于是 undefined → throw。

为什么以前不炸：`@opentui/keymap 0.5.7` 是 6 月 `0f1344af` 引入的，当时 catalog 还是 1.9.10（且带 patch），双实例的两个版本恰好是同一份；261022 升 1.9.17 后才裂开。而那一批的验证面只覆盖了 app 包（SolidJS Web UI，不 import @opentui，天然不受影响），**TUI 的 dev 与单测没有人跑**，断裂带病过了 CI。

## 决策

`packages/opencode/src/cli/cmd/tui/keymap.tsx` 在 TUI 侧自建 solid context，把原先从 `@opentui/keymap/solid` 直接 re-export 的三个 hook（`useOpencodeKeymap` / `useKeymapSelector` / `useBindings`）按 keymap 0.5.7 `src/solid/index.ts` 的行为复刻，只把「取 keymap」那一步换成本 context：

- `OpencodeKeymapProvider` 用 TUI 的 `createContext().Provider` 包 keymap 实例；
- `useKeymapSelector` 复刻「订阅 `keymap.on("state")` 版本号 + createMemo 跑 selector」，保留 host destroyed 时回退上一个值的容错；
- `useBindings` 复刻「createEffect 里注册 layer + onCleanup 回收」，保留 `target` / `targetMode` 的解析与两种分支。

导出签名与类型不变（`OpenTuiKeymap` 改为 `Keymap<Renderable, KeyEvent>`，与旧 `ReturnType<typeof useKeymap>` 等价），所有调用方零改动。类型 `UseBindingsLayer` 仍从 keymap 包 `import type`（类型擦除，不引入运行时实例）。

## 备选与否决理由

- **根 package.json overrides 强制全树 solid-js 1.9.17**：否决（本轮）——`@opentui/solid 0.5.7` 深度集成 solid 的渲染机制，它自己的解析结果是 1.9.14；强拉到 1.9.17 是上游未验证过的组合，跨 7 个 minor，风险不可控。若将来 @opentui 官方声明支持新版，这是第一候选。
- **锁版本后 revert 成 re-export**：否决——根因在依赖树里，代码层面看不见；任何一次 catalog 变动都会再炸一次，且复现成本是一轮 dev + 一套测试。
- **等上游修**：否决——阻塞日常使用，且上游大概率不会为这种 peer 错配发版。

## 后果

- 复刻代码与上游 `src/solid/index.ts` 存在漂移风险：**升级 @opentui/keymap 时必须对一遍那两个文件**，行为有变就同步复刻。代码注释里已写明来源与回退条件。
- 依赖层已统一（261023 同批落地）：`packages/opencode` 的 solid-js 从 catalog 摘出钉 1.9.14，与 `@opentui/keymap` / `@opentui/solid` 包内解析对齐，TUI 源码与两个 @opentui 包现在是同一实例（`.bun/solid-js@1.9.14` 单一路径）；app / ui 仍走 catalog 1.9.17，独立构建目标、运行时不共享。代价：TUI 用的 solid 停在 1.9.14（seroval ~1.5.4），拿不到 1.9.15–1.9.17 的修复；@opentui 官方声明支持新版 solid 后可改走根 overrides 拉 1.9.17。安装时因 bunfig `minimumReleaseAge=259200` 拦截 261022 批次的新发布版本（drizzle rc.5 / electron 44.9.3 / storybook 10.6.3），本次用 `bun install --minimum-release-age=0` 临时覆盖，未改 bunfig——这些版本已被 lock 钉死且经上批验证。
- 插件生态同类风险：直接 import `@opentui/keymap/solid` 的 useBindings / useKeymapSelector 的插件，渲染在 TUI 树里时踩同一个坑。seed 示例 `tui-smoke.tsx` 已改为走 `api.keymap.registerLayer`（enabled 函数形式）+ 渲染期计算 shortcuts。
- 识别签名（复发时对指纹）：`Keymap not found. Wrap the tree in <KeymapProvider>.`；`useBindings` 注册次数远低于期望；`node_modules/.bun` 下同时存在多个 solid-js@ 目录且 opencode 与 @opentui 包内链的不是同一份。另注意 bun 的堆栈对预编译包路径/sourcemap 拼接会失真（报 `src/src/solid/index.ts`、源码行号偏移），定位以复现为准，别信堆栈行号。
