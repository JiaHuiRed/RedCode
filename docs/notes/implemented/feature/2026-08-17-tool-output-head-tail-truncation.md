# 工具输出截断升级 head+tail 双端预览(默认 both,4:1)

状态:implemented

## 问题

`tool/truncate.ts` 的工具输出截断只保留单端(`direction: "head" | "tail"`,默认 head),尾部被整体裁掉——而**尾部往往才是结论**:命令错误栈、测试结果、构建失败原因都在末尾。模型看到的是"开头完整、结尾被切"的半截输出,常常被迫再调一次工具重看尾部,浪费一轮请求。

对标 deepseek-harness(spill 机制 + compaction-tool-result-pruner)确认差距:DSH 的 pruner 是 head 4096 + tail 1024(4:1)双端保留。RedCode 压缩摘要已在 17a7304a(0.8.17)落地 4:1 双端(`message-v2.ts` `truncateToolOutput`),但**同一教训没有同步到工具输出截断**——`truncate.ts` 仍是单端。DSH 采纳路线图(`docs/dsh-adoption-plan.md`)"已落地"表也记了压缩摘要侧,工具输出侧漏了。

顺带核实:RedCode 的 truncate 本身就是 DSH spill 的等价实现(保存全量到 `tool_*` 文件 + head 预览 + 路径提示 + read/grep 取回 + 7 天 retention + task 委派提示),且覆盖比 DSH 更彻底(define 包装层 `tool/tool.ts:156` + MCP 层 `session/tools.ts:227` 双重全局),**无需引入新的 spill 子系统**。

## 决策

`truncate.ts` 的 `Options.direction` 扩为 `"head" | "tail" | "both"`,默认值改为 **`both`**:

- 预算按 4:1 拆分(head 80% / tail 20%),行数与字节数各自切分,对齐压缩摘要的既有比例。
- 收集逻辑抽为 `collectPreview()` helper:head 从前往后、tail 从后往前(`skip` 参数防与 head 重叠)。
- 输出格式:`headPreview` → `...N truncated...` → `tailPreview` → hint(现有 hint 文案不变,含 task 委派提示)。
- 显式传 `head`/`tail` 的调用方语义不变;`both` 时 head 预览、tail 预览、省略标记、hint 四段顺序固定。
- 超限判定不变(行数 + UTF-8 字节双条件),`removed` 单位沿用现有逻辑(hitBytes → bytes,否则 lines)。

## 备选与否决理由

- **只给 shell 工具传 `direction: "tail"`**:否决——治标不治本,read/grep/webfetch/MCP 工具的大输出同样丢尾部;且"哪个工具该保尾"是部署判断,不该散落各调用点。
- **引入 DSH 的 spill-policy 事件钩子替代 truncate**:否决——RedCode 已有等价物且更全局,重复造轮子;Effect 事件总线与 Cordis waterfall 语义不同,迁移成本远大于收益。
- **默认保持 head、让工具显式 opt-in both**:否决——大多数调用点不会记得传参,双端应成为默认行为而非例外。

## 后果

- 所有工具输出截断(define 注册工具 + MCP/自定义工具)默认双端预览,**预览总体积不变**(预算只做 4:1 切分,不扩容),token 成本不增。
- 对前缀缓存无影响:截断发生在工具结果落地时(每轮新产生的消息),不改变既有历史消息的字节内容。
- 单行超长文件的场景(bytes 主导)下 tail 可能为空——head 预算 80% 被单行耗尽时 tail 只保留 0 行,输出格式退化为 head + 省略标记 + hint,行为等价旧 head 模式,不引入新问题。
- 后续如有人问"为什么默认 both",引用本 note;识别签名:truncate.ts 的 `direction ?? "both"` 与 `Math.floor(maxLines * 0.8)`。
