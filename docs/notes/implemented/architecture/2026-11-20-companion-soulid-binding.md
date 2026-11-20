# 伙伴档案允许绑定存量 Soul（soulID 不要求同名）

状态:implemented

## 问题

`Companion.list` 对档案做身份校验：`profile.id !== id || profile.soulID !== id` 即抛 "inconsistent profile identity" 并跳过。前半句（档案 id 必须等于目录名）正确；后半句把 `soulID === id` 也当契约，但这个契约只在引擎自己创建档案时成立——`createNative` 与 `importArchive` 都会创建与档案同名的 soul 并写 `soulID: targetID`。

秋秋的档案（`companion-10cf9da8b9c0`）在 2026-11-19 17:59 被手工指向存量 Soul `qiuqiu`（`souls/qiuqiu.md`，OpenClaw 迁移来的那份）——这正是行为契约 V2.0/V3.0 的产品要求："她从迁移过来的 Soul 和共同经历出发"。运行时没有任何路径会写出这种值（`update` 不改 soulID），说明是外部有意配置，但校验把它当坏档案，Chat 伙伴列表直接变空。Code 的 soul 列表读 `souls/` 目录、不经此校验，于是出现「Code 有秋秋、Chat 没有」的分裂。

时间线上白天未暴露的原因：白天做的是供应商直发实验（不建会话、不走 Chat 页面），`Companion.list` 第一次被调用是 18:44 sidecar 重启之后。

## 决策

- `manifest()` 只保留 `profile.id !== id` 校验；`soulID` 允许指向任意存量 soul。
- 档案指向缺失 soul 时由 `details()` 显式报 "The companion's Soul is unavailable"，不在 list 里静默跳过——误配置仍响。
- native create / import 的同名 soul 机制不变；companion 无删除操作，不存在「删档案连带删外部 soul」的路径。
- 不改数据副本（复制 qiuqiu.md 为同名 soul）——那会造成 Code 与 Chat 各持一份人格副本，将来必然漂移。

## 备选与否决理由

- **复制 soul 为档案同名**（改数据就校验）：否决——双份 Soul 正文漂移，改人格要同步两处。
- **校验放宽为「soul 存在即可」**（list 时查 soul）：否决——list 每次读全部 soul 文件，为一条本可在 details 报的错增加扫描面。

## 后果

- 外部手工配置 `soulID` 成为合法用法；该 soul 被删除时 Chat 侧 details/list 详情路径报错，列表项仍在（profile 本身合法）。
- 模型可见四问全部为零：校验不进模型上下文，提示词、token、缓存、注入上限均无变化。
- 验证：redspace typecheck；`test/companion/companion.test.ts`、`test/session/companion.test.ts`、`test/server/httpapi-companion.test.ts`。
- 回链：`packages/redspace/src/companion/companion.ts` manifest() 注释。
