# 退役配置键的迁移链路（RC21-01）

状态:implemented

审计原文：`docs/2026-10-21-third-party-audit.md` 的 RC21-01。前一批 RC21-02/03/04/05 见
`2026-10-21-audit-rc21-batch.md`。

## 问题

配置退役一直是「代码删字段 + 让用户自己删键」。0.12.17 移除生图工具时，本机
`~/.redcode/redcode.local.jsonc` 仍留着 `image` 块，实际故障链是：

1. `ConfigParse.schema` 的 `topLevelExtraKeys` 拒绝 schema 不认识的顶层键
   （`parse.ts:91`），抛 `ConfigInvalidError: Unrecognized key: image`。
2. 同一个启动阶段的 `config.providers`、`provider.list`、`app.agents`、`config.get`
   四个请求一起失败。
3. `TUI 启动链` 在阻塞请求失败后走致命退出。

`parse.ts:41` 那段注释（260821）只解决了「报错要说人话」，没解决「旧配置能不能启动」。
`merge-home-config.ts` 以用户配置为基底、只补模板缺失键，也不会删退役键。

## 决策

新增 `config/retire.ts`，一个**显式登记表** + 两种剥离方式：

- `RETIRED`：每项 `{ key, since, reason }`。加一项的前提是该键已从 `Config.Info` 移除、
  且没有任何代码再读它。目前只有 `image`。
- **内存剥离**（`strip`）：在 `loadConfig` 里、schema 校验之前执行。远程配置与
  `REDCODE_CONFIG_CONTENT` 没有文件可改，只能走这条；写盘失败的本地文件也靠它保住启动。
- **落盘迁移**（`migrateText` + `loadFile`）：用 `jsonc-parser` 的 `modify` 精确删键，
  **不重新 print** —— 注释与其余格式原样保留。迁移前把原文备份成 `<file>.bak-retired`，
  只在备份不存在时写，保留最早那一份。
- 覆盖范围就是 `loadFile` 的所有调用点：`config.json` / `redcode.json(c)` / `redcode.local.json(c)`、
  `REDCODE_CONFIG` 指定的文件、项目 `redcode.json(c)`、以及 `.redcode` 目录循环里的四份文件
  （含家目录与项目级 `redcode.local.*`）。
- `doctor` 增加 `config-retired` 检查：只报文件名与键名（不碰配置值），兜「写盘失败」与
  「迁移后被写回」的残留。

未登记的未知键**继续明确报错**。不把迁移泛化成静默丢弃，这条是建表与
schemas 检查的分界线。

## 备选与否决理由

- **在 `parse.ts` 里统一忽略未知键**：否决 —— 那会把「新版加了键、旧版客户端读到」这类
  真实不兼容也一起吞掉，用户再也看不到线索。`parse.ts:51` 那段注释正是为这种情况写的。
- **只改 `loadGlobal`**：否决 —— 260805 的本地覆盖层时序坑（`config.ts:769` 注释）说明
  同一个文件会被读两遍，只在一个入口删会留下另一条路径上的残留；`.redcode` 目录循环
  也要经过同一个 `loadFile` 才安全。
- **parse 后重新 print 整份配置**：否决 —— 注释与键序全丢，用户没法核对迁移改了什么。
- **迁移失败就让启动失败**：否决 —— 迁移是修复动作，不是前置条件；反过来让磁盘只读把
  引擎挡在门外，代价远大于收益。失败时内存剥离仍然生效。
- **在 `merge-home-config.ts` 里做退役**：否决 —— 那个脚本只处理全局层，而且不是每次
  启动都跑；引擎加载才是所有层的唯一必经路径。

## 后果

- 含 `image` 的旧配置能直接启动：键在内存里被剔除，文件被改写，原文件留在
  `<file>.bak-retired`；再次执行 `migrateText` 返回原文本（幂等）。
- 未登记的键仍然抛 `unrecognized_keys`，消息里带键名（`parse.ts:48`）。
- 诊断：`redcode doctor --json` 的 config 组多一条 `config-retired`；本机实测 `ok`。
- 验证：`test/config/config.test.ts` 新增三条（迁移并保留注释与备份、幂等、未登记键仍报错），
  `-t retired` 4 pass；`packages/opencode typecheck` 通过。
- **未做**：把「上一版配置启动新版」接进发布脚本。目前它是一条回归测试，不是发布门禁 ——
  要让发布流程真的拦住这类问题，需要在打包前跑一次带旧配置的启动冒烟，这属于 CI 改动，另行评估。
