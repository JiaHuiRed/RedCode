# REDCODE_AUTH_CONTENT：合法 JSON 不等于合法凭据（审计 A07）

状态:implemented

## 问题

`auth/index.ts` 的 `parseEnvAuthContent()` 此前是：

```ts
try {
  return JSON.parse(content) as Record<string, Info>
} catch {
  /* warn */
}
```

`as` 断言把「语法合法」当成了「结构合法」。以下输入都会被当成 `Record<string, Info>` 返回
（实测对照见 `.redcode/temp/a07-red-evidence.mjs`，脚本直调现实现、旧实现一行复刻）：

| 环境变量值 | 旧返回 | 后果 |
| --- | --- | --- |
| `null` | `null` | 调用方 `(yield* all())[providerID]` 对 null 取下标 → 当场抛 |
| `[]` / `0` / `"str"` / `true` | 原值 | 同上（不是对象） |
| `{"openai": 1}` | 原对象 | 非法「凭据」冒充合法凭据流进 provider 鉴权 |
| `{"openai": {…合法…}, "bad": 1}` | 原对象 | 一项坏、其余照用 |

磁盘路径本来就走 `decode(value)`（`Schema.decodeUnknownOption(Info)`）逐项校验，**只有环境覆盖
这条捷径跳过了** —— 同一个 `all()` 的两条来源口径不一致。

## 决策

- **与磁盘路径共用同一个解码**：新增 `decodeAuthRecord = Schema.decodeUnknownOption(
  Schema.Record(Schema.String, Info))`；顶层先显式要求普通对象（不指望 `Schema.Record` 一定拒
  数组），再按项解 `Info`。
- **任一项不合法 → 整体忽略这次覆盖**：凭据不做半套应用，回落到磁盘凭据。
- **反馈可诊断但不泄露秘密**：两条 warn 分别对应「顶层不是对象」与「有项解不出凭据」，
  只带顶层**键名**（最多 10 个）；值一律不进日志（可能含密钥）。
- helper 导出（`export function parseEnvAuthContent`）只为让测试以纯函数 + 参数方式驱动，
  不动进程环境 —— env 变更属进程绑定，会牵连测试 lane 隔离（`lane-inventory`）。

## 备选与否决理由

- **结构非法直接抛配置错误**：否决 —— `Auth.all()` 在大量路径上被调用，抛错会把「环境变量写错」
  放大成整条会话不可用；「大声 warn + 回落磁盘」既不静默、也不连坐。
- **保留合法项、只丢非法项**：否决 —— 凭据半套生效比整体忽略更难排查（部分 provider 生效、
  部分走磁盘凭据，且没有线索说明为什么）。
- **用 `Effect.try` 在 Effect.gen 内解析**：否决 —— 会改变 `all()` 的推断成功类型，连带打崩
  `set` / `remove` 里的索引访问（261015 当天已实测返工一次）。

## 后果

- 合法覆盖值行为不变（`api` / `wellknown` / `oauth` 三类都解得出，且与旧实现返回同形）；
  `{}` 仍旧合法（等于不提供凭据）。
- 非法值不再冒充凭据；`null` / `[]` / `0` 这类此前会让调用方抛的输入现在被挡在解析层。
- `test/auth/auth.test.ts` 9 pass / 0 fail（4 条既有 + 5 条新增），opencode `typecheck` EXIT=0。
  新增用例里「合法 JSON 但不是普通对象」「取值类型非法」两组在旧实现下必红。
- 模型可见四问：①–④ 全为零 —— 只影响凭据来源选择与两行 warn 文本，不进提示词 / 工具 schema /
  注入项，不改 Token 与前缀。
