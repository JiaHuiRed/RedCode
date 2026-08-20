# GUI 补上「输出被截断」标记

状态:implemented

## 背景

`finish === "length"` 是模型撞到输出 token 上限被砍断。TUI 在 07-28（Karina）就把它标出来了：

```
▣ Build · deepseek-chat · 1m 12s · 输出被截断（达到 token 上限）
```

当时的注释写得很清楚——「此前它和 `stop` 走同一条路，界面上和正常说完的回复长得一模一样，
话说到一半就结束，用户无从判断是说完了还是被截了」。

**GUI 从来没读过 `message.finish`。** 全仓 grep 只有 `file.tsx` 里一个同名的无关变量。
所以这个在 TUI 上修好了快一个月的问题，GUI 用户一直在踩。

## 决策

复用既有的 `TurnDivider`，加第三个 label。GUI 的时间线里已经有两条同类分割线
（`compaction` / `interrupted`），都是「这一轮在此处非正常结束」的标记，截断是第三种，
没有理由另起一套渲染。

**取最后一条 assistant，不用 `some()`。** `prompt.ts` 的 `finished` 判定把 `"length"` 当作
终止原因（只有 `tool-calls` / `unknown` 会继续循环），所以被截断的那条必然是本轮最后一条
assistant 消息。分割线因此画在整段助手输出之后——位置就是话被切断的地方。用 `some()` 反而
会在「中间某条带 length」这种不该发生的形态下画出一条位置错误的线。

## 后果

- `TurnDivider` 的 label 联合类型加 `"truncated"`，`ui.message.truncated` 三语齐。
- 测试：`message-timeline.data.test.ts` 新增 4 例（画出且在助手输出之后 / stop 与 tool-calls
  与缺失都不画 / 只看最后一条 / 与压缩分割线共存时的顺序）。
- 未做：TUI 那条是带 warning 色的行内后缀，GUI 这条是中性色的分割线。要不要给它上警示色是
  设计问题（`MessageDivider` 目前不接受颜色），留着。
