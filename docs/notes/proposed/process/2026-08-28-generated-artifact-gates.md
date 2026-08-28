# 生成物闸门：openapi.json 已进 pre-push，types.gen.ts 仍无人看守

日期：2026-08-28 · 状态：proposed（第一半已落地，第二半待定）

## 起因

260828 一上午两次改 config schema（`webfetch.allow_private_hosts`、image 的 `max_pixels`/`max_dimension`），两次都忘了重跑 SDK/OpenAPI 生成物，两次都是**别的会话合并时才发现**（`87bfdf97`、`472574d8`）。

结构性原因：`pre-push` 只跑全仓 typecheck，而生成物漂移的闸门只在 CI。所以"改了 schema 忘记重跑生成物"必然是**本地全绿、推上去才红**——最贵的那种反馈延迟。

## 已落地

`check:openapi-drift` 加进 `.husky/pre-push`，放在 `bun typecheck` 之前。约 6 秒，脚本无副作用（它自己的头注释就写着"可以放心进 CI 和 pre-push"，只是一直没接上）。

## 仍未覆盖：`packages/sdk/js/src/v2/gen/types.gen.ts`

`check-openapi-drift.ts` 只比 `packages/sdk/openapi.json` 一个文件。而 AGENTS.md 里写明重新生成 SDK 是**两条命令**，第一条产出的就是 `src/v2/gen/**`：

```bash
bun ./packages/sdk/js/script/build.ts                              # → packages/sdk/js/src/v2/gen/**
cd packages/opencode && bun dev generate > ../sdk/openapi.json     # → packages/sdk/openapi.json
```

`472574d8` 那次两个文件都要改，说明两边都会漂。现在的状态是：**openapi.json 有三道闸门（pre-push + CI + 那次事故的记忆），types.gen.ts 一道都没有**——它只在 `script/generate.ts`（末尾是全仓 prettier `--write`，所以没人跑）和 `script/publish.ts`（发布时）里被重新生成。

### 为什么不能照抄同一个做法

`packages/sdk/js/script/build.ts` 把输出写死成 `output.path: "./src/v2/gen"` 且 `clean: true` —— **原地删了重建**。要做漂移检查就得"备份 → 跑 → 比 → 还原"，中途失败会把开发者的生成目录留在半重建状态。那种爆炸半径不该进 pre-push。

### 建议的做法

给 `build.ts` 的输出路径加一个可选参数（环境变量或 argv 都行），漂移检查把它指到临时目录再逐字节比。改动落在一个发布路径上的脚本，所以单独立项而不是顺手做。

成本估计：`build.ts` 改 3~5 行 + 一个与 `check-openapi-drift.ts` 同形的脚本 + 接进 pre-push/CI。

### 备选

- **把 types.gen.ts 从仓库里去掉、改成构建期生成**：更彻底，但会改变 SDK 消费方的使用方式（现在可以直接 import 仓里的类型），是产品决策不是工程决策。
- **只在 CI 加 types.gen 闸门、不进 pre-push**：等于保留"本地全绿推上去才红"的形态，正是本条要消掉的东西。
