# 重复调用防护分软硬双层:软层递进提醒贴 tool output 尾部

状态:implemented

## 问题

既有 doom_loop 硬层(`processor.ts` tool-call case)触发条件窄:同工具同参连续 3 次,还要求「至少一次报错」或「输出也全同」(260725/260806 两次收窄,防误伤轮询类)。代价是纯空转但「每次成功、输出微变」的重复完全无防线,只剩 deepseek.md 里一条提示词规则兜着——而提示词规则占**每个请求**的固定前缀,机制只在真重复时花 token。V4-Pro-0813 上线后实测第三方反馈「长程 agentic 任务倾向早停/空转」,官方 harness(deepseek-harness)的对策是 `guard/repeat-tool-reminder` 纯建议层,不动提示词。

## 决策

叠一个软层(`session/repeat-tool-reminder.ts` + processor tool-result case 接线,89e85f3):

- **宽条件**:同工具+同参即计数,不要求报错/同输出——轮询类只会走到这层。
- **递进阈值 3/5/8**(DSH 默认):3 次轻提醒;5/8 次详细版(点名工具/次数/参数预览,预览头截断 500 字符防大载荷灌进下一请求)。超过 8 沉默——持续轮询是合法行为,真空转有硬层弹窗。
- **注入贴该次 tool output 尾部**:`[System notice]` 前缀(与 text-loop-detection 的 RECOVERY_PROMPTS 同体例)。
- **todowrite/todoread 对链透明**:既不计数也不断链——记账工具插在循环中间不该洗掉计数。
- 参数键与硬层同口径(原序 `JSON.stringify`);pending/running 分片跳过防并行双计;error 调用也计数;user 插话不重置链(插话后参数几乎必变,链自然断)。

机制落地后删除 deepseek.md 的 "A result you already have is not worth re-fetching" 条——规则搬进 harness,前缀净减。

## 备选与否决理由

- **注入独立 user 消息**(DSH 原形态是 synthetic user message):否决——DCP user 角色注入的教训(260810 根治,「取最后一条 user 消息」防御规则在案),不再引入任何伪装 user 角色的注入通道;tool output 尾部语义上就是「这次调用的系统注记」,且 append-only 不破前缀缓存。
- **放宽硬层触发条件代替加软层**:否决——硬层弹权限窗是强干预,宽条件会把轮询类也弹给用户;260725/260806 的收窄理由依然成立。
- **DSH 的 deep key-sort 参数规范化**:否决——两层判据口径不一致会出现「软层报了硬层不报」的边界困惑,跟硬层保持原序 stringify。
- **超过 8 次后周期性再提醒**:否决——提醒堆进历史吃缓存,收益存疑,先跟 DSH 同款「精确阈值命中、过后沉默」。

## 后果

- 1~2 次重复无任何防线(原提示词规则在 1 次后即生效)——接受:规则占所有请求前缀 vs 机制只在重复时花 token,数学上机制赢。
- 软层在 tool-result 时机、硬层在 tool-call 时机,同轮真空转会先弹硬层权限窗、下一结果再贴软层文案——冗余但无害。
- 会话恢复后链从消息历史重算(取样 `recentToolParts`,无内存态),天然 resume 安全,这点比 DSH 的 WeakMap 内存链更稳。
