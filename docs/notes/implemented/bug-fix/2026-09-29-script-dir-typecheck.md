# 根目录 script/ 从不过类型检查，补 tsconfig 后立刻抓出两条真错

状态:implemented

## 问题

`script/` 整个目录不在任何 tsconfig 的覆盖范围内：

- 根 `tsconfig.json` 没有 `include` / `files` 字段，默认会把**整个仓库连同 packages
  一起**拖进来——所以没人用它跑过 `tsc`，它实际上是死的。
- `bun typecheck` = `bun turbo typecheck`，只覆盖 workspace 包（`packages/*`、
  `packages/sdk/js`、`packages/slack`），而 `script/` 不是 workspace 成员。
- CI 的 `typecheck.yml` 和 husky 的 `pre-push` 都只跑 `bun typecheck`。

于是这批根脚本（module-context、check-openapi-drift、fix-keymap-junction、
check-version-consistency……）从来没进过类型检查。这不是理论风险：上一个 commit
`9ee7b91d` 修的 `readJson` 返回 `any`、读错字段编译器一声不响、运行时拿 undefined
走 `?? []` 兜底、输出恒为 `(none)`——那个 bug 就是在这个盲区里活下来的。

## 修法

新增 `script/tsconfig.json`（`include: ["**/*.ts"]`），并把根 `package.json` 的
`typecheck` 从 `bun turbo typecheck` 改成
`bun turbo typecheck && bun run typecheck:scripts`——CI 与 pre-push 都跑根
`typecheck`，一处接线两边生效。

`typecheck:scripts` 走 `script/typecheck.ts -p script/tsconfig.json`，即复用仓库
既有的 tsgo → TypeScript 5.x 崩溃回退包装（packages/opencode 的 typecheck 也是它），
不新造一条编译路径。

根 `node_modules/@types` 原先只有 `mime-types`，`script/` 取不到 bun / node 类型，
故根 `devDependencies` 补 `@types/bun` 与 `@types/node`（均 `catalog:`，与各包同源；
根 `overrides` 本就钉着 `@types/node: catalog:`）。

## 门禁一装上就抓出两条真错

### 1. `module-context.ts` 的 `ReturnType<typeof readdirSync>` 注解（4 条错误）

```ts
let entries: ReturnType<typeof readdirSync>
entries = readdirSync(dir, { withFileTypes: true })
```

`readdirSync` 是重载函数，`ReturnType<typeof fn>` 取的是重载表里**最后一个**签名
（`Dirent<NonSharedBuffer>[]`），而 `withFileTypes` 这次调用实际返回
`Dirent<string>[]`——两者不相交，于是 `Dirent<string>` 不 assignable 给
`NonSharedBuffer`，连带 `entry.name.startsWith` / `join(dir, entry.name)` 一起报。

改成抽出 `listDir(dir)`，**返回类型从调用点推断**，不手工指名。同时把 try/catch
收进 helper，`walk` 主循环只读 happy path。

### 2. `fix-keymap-junction.ts` 的 `TARGET_INSTANCE` 收窄丢失（1 条错误）

```ts
const TARGET_INSTANCE = detectTargetInstance()
if (TARGET_INSTANCE === undefined) process.exit(0)
// …下面是函数声明 isJunctionToTarget()，内部 resolve(TARGET_INSTANCE) 报 TS2345
```

不是 `process.exit` 不返回 `never`——单独探针验证过它能正常收窄。真因是
**函数声明提升**：`isJunctionToTarget` 是 `function` 声明，TS 视它为在模块顶部就
已声明，于是它体内看不到第 110 行那次 undefined 收窄。改成先落到局部
`detected`、显式收窄后再赋给带 `string` 标注的 `TARGET_INSTANCE`，运行时行为不变
（上一行已经退出）。

## 顺带清掉一条新暴露的既有 warning

`fix-keymap-junction.ts:58` 的 `.split("+")[0]!`：`noUncheckedIndexedAccess` 是
`false`，这个断言本来就是多余的，此前没有 tsconfig 覆盖、类型感知规则看不见它。
去掉 `!`，warning 数回到与 HEAD 基线一致（3 条）。

## 验证

- `bun run typecheck:scripts`：0 error。
- 两个脚本实跑对照：`module-context.ts packages/ui` 输出与改动前一致；
  `fix-keymap-junction.ts` 三条 `ok` 不变。
- oxlint：`module-context.ts` 2 条 warning（与 HEAD 同型同数，仅行号位移）、
  `fix-keymap-junction.ts` 3 条（与 HEAD 一致）。
- `bun install` 已跑，lockfile 同步。

## 备选否决

- **把 `script/` 加进根 tsconfig 的 include**：根 tsconfig 没有 include 是有原因的——
  一填就会把 packages 全拖进来，且没人那么用它。单独一份 tsconfig 才是可跑的。
- **直接写 `tsc -p script/tsconfig.json` 而不过 wrapper**：丢掉 tsgo 崩溃回退，
  与 packages/opencode 的做法不一致。
- **把 `script/` 改成 workspace 包**：会让 turbo 把它当构建目标，且这批脚本互相
  引用根路径，改动面远超收益。

## 后果

`script/` 现在有类型检查兜底，但**只有跑 `bun typecheck` 时才生效**——单独
`bun run script/xxx.ts` 不过类型关。新增根脚本时仍要记得跑一次根 typecheck。
