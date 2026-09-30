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
- 参数键与硬层同口径(共用深层 key-sort 的 `inputKey`，数组顺序保持);pending/running 分片跳过防并行双计;error 调用也计数;取样按当前 assistant 的 parentID 限定，用户新消息重置链。

机制落地后删除 deepseek.md 的 "A result you already have is not worth re-fetching" 条——规则搬进 harness,前缀净减。

## 备选与否决理由

- **注入独立 user 消息**(DSH 原形态是 synthetic user message):否决——DCP user 角色注入的教训(260810 根治,「取最后一条 user 消息」防御规则在案),不再引入任何伪装 user 角色的注入通道;tool output 尾部语义上就是「这次调用的系统注记」,且 append-only 不破前缀缓存。
- **放宽硬层触发条件代替加软层**:否决——硬层弹权限窗是强干预,宽条件会把轮询类也弹给用户;260725/260806 的收窄理由依然成立。
- **只给软层做 deep key-sort**:否决——两层判据口径不一致会出现「软层报了硬层不报」的边界困惑。当前软层、exactLoop 和 cycleLoop 一起使用同一个规范化函数。
- **超过 8 次后周期性再提醒**:否决——提醒堆进历史吃缓存,收益存疑,先跟 DSH 同款「精确阈值命中、过后沉默」。

## 后果

- 1~2 次重复无任何防线(原提示词规则在 1 次后即生效)——接受:规则占所有请求前缀 vs 机制只在重复时花 token,数学上机制赢。
- 软层在 tool-result 时机、硬层在 tool-call 时机,同轮真空转会先弹硬层权限窗、下一结果再贴软层文案——冗余但无害。
- 会话恢复后链从消息历史重算(取样 `recentToolParts`,无内存态),天然 resume 安全,这点比 DSH 的 WeakMap 内存链更稳。

## 判据修复与验证

对照 DSH 后复核本仓，发现成功同输出的硬层并未生效：查询时当前调用已是 running，`outputKey` 返回 null，旧“连续三个输出都相同”条件永远不成立。硬层改为在下一次派发前比较此前三次完成结果；错误 exactLoop 与错误循环的已有收窄条件保留。仅比较原始结果，软提醒以 `repeatReminder` 元数据标记，比较时只移除匹配的注记后缀，避免第三次调用附带的提醒本身洗掉相同输出判据。

两个取样调用都传当前 parentID，防止用户明确要求重试时继承上一轮计数。排序使用 message.time_created，ID 仅作并列 tie-break。参数键重排在软硬两层统一处理，数组顺序仍有意义。外部工具名与参数预览都最多 500 字符，每条提醒保持在 4KiB 内；普通工具的原文案不变。

回归使用真实 processor、真实权限事件与回复：此前相同成功结果不触发权限的用例先红，修改后通过；变化中的轮询不触发，用户新消息后的同参重试不带上一轮提醒。纯函数测试覆盖嵌套键重排、数组顺序、错误计数、长工具名/CJK 载荷硬上限。

`recentToolParts` 在 SQL 中按 `json_extract(part.data, '$.type') = 'tool'` 过滤后直接 `LIMIT limit`，再用 `part(row.part)` 解码并确认 `ToolPart`；时间、message ID、part ID 的倒序和最终 reverse、parentID 边界不变，也不增加索引或迁移。隔离 DB 回归覆盖 `limit*8` 个以上更新的非工具分片、跨 assistant 消息与新 user 边界、limit 0、时间排序与回绕 ID 的相反顺序。

性能核对仅代表以下合成 SQLite 场景，不外推为全仓加速：`:memory:` 数据库复刻现有三个 message/part 索引；512 个 message / 6,144 个 part，同一个 session 与 parentID，当前轮 1,200 个 part（24 tool、1,176 non-tool），part JSON 各约 16.4KB（non-tool 16,409 字节、tool 16,411 字节，合计约 96.1 MiB）。旧/新 SQL 都保留 `JOIN message` 与 `time_created DESC, message.id DESC, part.id DESC`。6 次预热后交错采集 21 个样本；limit 6 的旧/新中位数为 17.576/22.015 ms（样本范围 16.003–27.908/19.921–28.593 ms），limit 24 为 84.472/28.396 ms（70.656–119.925/23.462–44.125 ms）。limit 6 的合成密集文本场景反而更慢，说明 JSON 类型过滤成本受 payload 和 limit 影响；结果不是普遍性能结论。

两个 limit 的 `EXPLAIN QUERY PLAN` 对新旧 SQL 相同：`SEARCH part USING INDEX part_session_id_id_idx (session_id=?)`、`SEARCH message USING INDEX sqlite_autoindex_message_1 (id=?)`、`USE TEMP B-TREE FOR ORDER BY`。主工作区复核同一合成数据与采样方式，limit 6 旧/新中位数 18.844/26.707 ms，limit 24 为 69.339/25.247 ms；旧查询分别读回 48/192 条非工具分片后返回零条工具，新查询准确返回 6/24 条工具，因此较小窗口的额外过滤开销换取的是正确结果，不能视作等价工作的提速对比。

回归测试源在 `packages/opencode/test/session/recent-tool-parts.test.ts`。依赖完整的主工作区中，高密度用例在旧实现下先失败（期望六条工具、实际为空），SQL 修复后四条 DB 回归通过；与真实 processor、提醒测试合跑为 37 条通过。只修取样漏项，沿用既有动态提醒与拦截阈值；固定提示词、工具 schema 与历史消息不变，既有每条提醒的 4KiB 硬限不增加。

模型可见四问：

1. 无新增固定提示词。按修正后的判据触发原有 tool-output 注记；详细版参数预览改为稳定键序，超过 500 字符的工具名带省略号。
2. 固定前缀增量 0；每次触发的注记小于 4KiB，是有界的动态上下文。
3. 不改既有消息或移动固定段落；首次受影响的新工具结果起追加不同后缀，历史前缀不改。
4. 工具名和参数预览都硬限 500 字符，阈值仍是 3/5/8；不新增独立 user 消息。
