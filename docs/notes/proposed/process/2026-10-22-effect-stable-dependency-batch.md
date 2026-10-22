# Effect 稳定版批次：4.0.5 与 Drizzle RC5、Storybook 组合钉版

状态：proposed

## 问题

全家 Effect 停在 `4.0.0-beta.66`，`bun audit` 长期累计 234 条公告。升级不是单包换版本：

- `drizzle-orm@1.0.0-rc.2` 的运行时 `effect-core/errors.js` 直接调用 beta 独有的 `Schema.TaggedErrorClass`——Effect 升到 4.0.5 后 SQLite 链路在模块加载即崩。经 unpkg 核对 rc.5 已改用稳定 `Schema.TaggedError`，peer 声明 `>=4.0.0-beta.58 || >=4.0.0`。
- Storybook 核心 10.4.1 命中 origin validation 公告（`<10.6.2` critical），但 Solid 适配器 `storybook-solidjs-vite@10.7.2` 的 TypeScript docgen 在默认 4GB 堆 OOM；提到 6GB 后进入「回收 TS 程序→重建」循环，4 分钟未完成构建。
- 旧适配器（10.1.1）的 docgen 走 `@joshwooding/vite-plugin-react-docgen-typescript`，需要 JS Compiler API；仓库 catalog 的 `typescript@7.0.2` 没有这套 API，构建在 `sys.fileExists` undefined 处崩。

## 决策

- `effect` / `@effect/opentelemetry` / `@effect/platform-node` / `@effect/sql-sqlite-bun` / `@effect/platform-node-shared` 全部 4.0.5；API 迁移对照已安装源（`effect/http|process|sql` 稳定路径、`Schema.TaggedError`、`Schema.Defect()`、`Config.Boolean`、`@effect/opentelemetry/OtelTracer`）。
- `drizzle-orm` / `drizzle-kit` rc.2 → rc.5，取「effect-core 运行时已适配稳定 API」的最早 RC，不跳到 0.x latest（回退线不同）。
- Storybook：核心与全部官方 addon 10.6.3；Solid 适配器**保持 10.1.1**；`packages/storybook` 单独钉 `typescript@5.9.3` 仅供 docgen（不动 catalog）。10.7.2 的 TS LanguageService docgen 与本项目体量的组合当前不可用，待上游修堆行为再评估。

## 备选与否决理由

- **给 10.7.2 继续加堆**：否决——6GB 仍循环回收，问题不是堆大小而是全量 LanguageService 提取的成本。
- **关闭 docgen 换 10.7.2**：否决——为升级放弃 Controls/Docs 数据，功能净损失。
- **pin 旧 Effect 等上游**：否决——审计缺口持续存在，且 rc.5 已证明可组合。

## 后果

- 识别签名：若 Storybook 构建再报 `Cannot read properties of undefined (reading 'fileExists')`，是有人把 `packages/storybook` 的 typescript 指回 catalog（TS7）；报 docgen OOM/recycled 循环，是有人把适配器升回 10.7.x。
- `bun audit` 234 → 188（2 critical 均在 `packages/web` 的 Astro 链：AVIF RCE 与 proxy-addr；`astro.config.mjs` 的 `imageService: "passthrough"` 缓解 AVIF 路径，Astro 升级是独立批次，未混入本批）。
- SQLite 迁移文件未动：本次是依赖升级，不改任何 schema/migration。
