/**
 * 美元→人民币折算汇率的**唯一**来源。
 *
 * 260904 cc 此前这个常量有四份逐字相同的拷贝，两份在 GUI（`app/components/session/session-context-format.ts`、
 * `app/pages/home-stats.tsx`）、两份在 TUI（`tui/feature-plugins/home/footer.tsx`、
 * `tui/feature-plugins/sidebar/context.tsx`），全靠注释互相提醒「四处必须同步改」。
 * 改过两轮（260731 6.76→6.75、260827 6.75→6.72）都是手工同步四处，漏一处就会出现
 * 同一笔花费在首页和侧栏显示不同金额，而且不会有任何东西报错。
 *
 * **改汇率只改这里一处。** app 与 opencode 都依赖 `@redcode-ai/core`，两边直接 import。
 *
 * 注意与「币种判定」分开：某个模型的价格本来就是人民币标价时（`model.cost.currency === "CNY"`），
 * 不该再乘这个汇率。判定读 `model.cost.currency`，260827 起已退役 `CNY_PROVIDERS` 那张硬编码名单。
 * 这里只负责「无标记按美元，折算成人民币展示」的那一步。
 */
export const USD_TO_CNY = 6.72
