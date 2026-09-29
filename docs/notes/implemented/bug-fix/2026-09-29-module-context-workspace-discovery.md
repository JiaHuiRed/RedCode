# module-context：workspace 发现读错包，SKIP_DIR 没作用于源码地图

状态:implemented

## 问题

第三方审计（`E:\dwonload\REDCODE_AUDIT_2026-09-29_ROUND2.md`）对 `0b531e6b`
（module:context 模块阅读包）提了两条，都是我的 bug，都坐实。

### A3 workspace globs 读错 package.json

```ts
const pkg = readJson(join(pkgRoot, "package.json"))   // 目标包自己的
...
const globs: string[] = pkg.workspaces?.packages ?? [] // ← 却在这里找 workspaces
```

workspace 包自己不定义 `workspaces` 字段 → `globs` 恒为 `[]` → `byName` 是空 Map →
`internalDeps` 与 `internalConsumers` **恒为空**。实测 `packages/app` 输出
`## Internal dependencies / (none)` 与 `## Consumed by / (no workspace package depends
on it)`，而它明明依赖 `@redcode-ai/core` / `sdk` / `ui`，且被 `@redcode-ai/desktop` 消费。

### A4 SKIP_DIR 没作用于源码地图

`SKIP_DIR` 定义在源码地图那一节的紧后面，只有 notes 遍历用它；`walk()` 自己另写了
一份 `entry.name === "node_modules" || entry.name.startsWith(".")` —— `dist` / `coverage`
不进集合。实测 `packages/app` 的 Source map 里出现
`packages/app/dist/assets/ 698 files · 4008 lines`，app/desktop/opencode/web 四个包都有。

## 做法

### 1. globs 取根 package.json

```ts
const rootPkg = readJson(join(root, "package.json"))
const globs: string[] = Array.isArray(rootPkg?.workspaces)
  ? rootPkg.workspaces
  : (rootPkg?.workspaces?.packages ?? [])
```

根 package.json 用的是对象形式（`workspaces.packages`），但 pnpm 也允许数组形式，两种都接。
`rootPkg` 读不到时退化成空表——脚本仍可跑，只是没有依赖分析，不静默崩。

### 2. SKIP_DIR 上移，walk 接收它

`SKIP_DIR` 移到 `walk` 之前，`walk(dir, depth, out, skip = SKIP_DIR)`；点开头的目录
（`.artifacts` / `.git` / `.vscode`）统一在 walk 里判，不再依赖每个调用方各自记得。
notes 遍历改成同一套规则——它原先漏判点开头目录，产物里的 md 会混进 spec 清单。

### 3. readJson 从 any 收成 PackageJson

**A3 之所以静默，根因是 `readJson` 返回 `any`**：读错字段编译器一声不响，运行时拿到
`undefined` 就走 `?? []` 兜底，输出恒为「(none)」而没有任何东西报错。这是本仓
「无法解释的不对称通常意味着漏了一次抽取」的同型病——不是漏抽取，是漏类型。

收成 `PackageJson` 接口后立刻抓出一条真错：`for (const field of ["main","module","types"])`
里的 `pkg[field]` 撞 TS7053（接口没有索引签名）。改成 `as const` 让 field 收窄成字面量联合。
那条错在 any 时代同样被吞着。

## 验证

- `packages/app`：Internal dependencies = core / sdk / ui；Consumed by = desktop；
  Source map 里 dist / coverage / node_modules 命中数为 **0**
- `packages/ui`：Internal dependencies = core / sdk；Consumed by = app / desktop
- `packages/opencode/src/session`：Internal dependencies = core / http-recorder / llm /
  plugin / script / sdk / ui；Consumed by = web
- oxlint → 0 warning（`Cannot find type definition file for 'bun'` 是 root 脚本既有现象，
  `script/check-openapi-drift.ts` 同样报）

## 顺带发现（未修）

**`script/` 整个目录不在任何 tsconfig 的 include 里**——根 tsconfig 没有它，
`script/tsconfig.json` 不存在，各 package 的 tsconfig 也只覆盖自己的 src。也就是说
根目录下的脚本从不过类型检查。

我这次是手动补验的：

```
bunx tsc --noEmit --ignoreConfig --strict --skipLibCheck \
  --typeRoots node_modules/.bun/bun-types@1.3.13/node_modules/bun-types --types bun \
  script/module-context.ts
```

对账结果：HEAD 版本报 5 条（`import.meta.dir` 不在 bun-types 声明里 + `Dirent<string>`
vs `Dirent<NonSharedBuffer>` 的 bun/node 类型错配 + 一条 TS2367），改动后剩 5 条同型、
TS2367 因条件合并而消失。即**没有新增类型错误**，但整个 `script/` 的无类型检查状态是
既有缺口——本仓「改动后自动验证」的规矩在这里是空的。要不要给 `script/` 加一个
tsconfig 是独立决定，不属于本次修复范围。

## 回链

- `script/module-context.ts` — `PackageJson` / `SKIP_DIR` / `walk` / workspace 包表
