# 摘除会话事件系统双写：退回单写

状态:implemented

## 问题

`experimentalEventSystem`（默认关）门控着 23 处双写分支，散在 `processor.ts`、`prompt.ts`、`compaction.ts`、`prompt/shell.ts`、TUI `internal.ts`、`runtime-flags.ts`——前两个是全仓改动最频繁的文件。每次改会话链路都要判断「双写那边跟不跟」，而绕过是零成本的（260819 加 `contextLevel` 时就绕过了），两边必然渐行渐远。这是上游 opencode 的迁移工程（fork 点 `d6d579c4` 就带着），不是本仓起的头；上游的 v2 provider 插件体系从未采摘进来——`provider-parity-checklist.md` 指向的 `src/v2/plugin/provider/` 目录根本不存在，剩下的 20 个未勾项全是主体功能（配置合并、variant 生成、鉴权派生）。

## 决策

摘掉双写，退回单写。哥哥拍板于 2026-08-19。

**摘**：23 处 flag 分支（19 个 `if` 块脚本化摘除——花括号配平 + 「块内必须是 `events.publish(SessionEvent`」断言 + 「后随 else 即中止」护栏；1 处三元改直返；TUI 注册行 + Pick 收窄；flag 本体）；`SessionV2Debug` 调试插件（1186 行，唯一入口是被摘的注册行）；`context/sync-v2.tsx`（307 行——它订阅的 24 种 `session.next.*` 事件的发布者全部被摘，且唯一读者就是上述调试插件）；`preload.ts` 给全套件开 flag 的 env 行；指向空目录的 checklist。净 -400 余行。

**留**：`specs/v2/`（设计底本）；`src/v2/session.ts` 与 `projectors-next.ts`、`event-v2-bridge`（活的 import 图 + 两个非门控事件的投影链）；`prompt.ts` 的 `AgentSwitched`/`ModelSwitched` 非门控发布（有活消费者：projectors-next 经 EventV2Bridge 桥回 SyncEvent 投影入库）。

## 执行中修正的判断（比结论更值钱的部分）

1. **「事件全死」不成立**：`prompt.ts:625/636` 与 `v2/session.ts` 有非门控发布，projectors-next 在投影它们——摘除脚本靠「只认 flag 门控形状」天然避开了这些。
2. **「没有测试断言双写」不成立**：grep `SessionEvent|session.next|EventV2` 三个符号都没命中，但 `compaction.test` 经 **`SessionV2.messages`** 断言双写产物（session_message 表里的 compaction 记录）——搜消费者要按「读端服务」搜，不能只按事件符号搜。该断言随双写退役，用例前半段（真实 message/part）保留。
3. **「/v2 路由组是活的」要打折**：它在 import 图里活着，但不在 openapi 里——SDK 无对应方法，客户端无法调用，生产零流量。`SessionV2.messages` 读的表在生产里从无写入者。
4. **基线纪律再次生效，三连**：`snapshot-tool-race` 的 diff 用例与 `prompt.test` 的「unknown command」30s 挂起都在 HEAD 基线上复现（既有，另行处理）；只有 compaction 那条断言真是本次引起。
5. **脚本回扫踩了一次块头假设**：退役用例的块头是 `noLLMServer.instance(` 而回扫正则只认 `it.`，多删了前一条活用例（`loop calls LLM…`），靠测试失败排查抓回、从 HEAD 取回原文。教训：结构化删除的锚点要认「当前块的真实开头」，不能拿常见形状去猜。

## 代价（判决时已声明）

- 上游采摘摩擦增大：上游这条迁移线还在演进，将来 pick 碰到这些位置冲突面变大。缓冲：本仓采摘本就逐条手工甄别。
- 将来真要做事件溯源，23 个发布点位要对着新代码重找（git 历史可考，revert 窗口随 processor/prompt 的高频改动几周内关闭）。
