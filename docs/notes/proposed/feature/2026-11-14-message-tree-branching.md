# 消息树分支：parentId + selectedChildId 单指针树

状态:proposed(Phase 1 已于 2026-11-14 实现并落地,实现记录与两处形态
修正见文末;Phase 2-4 未动工)

## 问题

RedCode 的会话历史是线性表:消息按 MessageID 升序一条线,`revert.ts` 的回退是
**截断式**——revert 到某条消息后,其后所有消息/部件被打上 reverted 标记并配合
Snapshot patch 恢复文件状态;unrevert 只能整体回到唯一的旧路径。代价:

- **编辑重发是破坏性的**:想改一条提问重新问,旧问答对被打入冷宫,且切回的
  手段只有一层 unrevert;旧路径不能与新路径并存浏览。
- **重新生成没有"多个候选"语义**:对同一提问再生成一次,只能先截断再生成,
  上一次的回答从此不可达。
- 截断 + Snapshot patch 的组合让 revert 成为本仓事故高发区(260722、261007
  两次审计都在这一段),线性模型下"截断再补"的实现复杂度已经接近树模型的
  下限,却拿不到树的好处。

参照 DeepSeek chat-demo(`D:\AI\KLX\Qiu\chat-demo\src\services\chat\branches.ts`,
117 行纯函数)的数据模型:`parentId` 指向父消息,`selectedChildId` 是唯一的
"当前分支"指针,会话级 `rootMessageId` 定根;`getVisibleMessages` 从根沿
selectedChildId 走出当前路径,**展示与请求上下文共用这一条路径**。兄弟版本
通过 parentId 反查得到,不需要每节点存兄弟列表。

## 决策

消息表加两个可空列:`parent_id`、`selected_child_id`,会话表加
`root_message_id`。分四期落地,每期独立可验证、独立可停:

**Phase 1 — 纯增量 schema,零行为变化**

> 2026-11-14 落地修正:分支字段进 data JSON 而非 SQL 列;读路径不做
> 惰性规范化,改为「线性原序返回 + 物化是写入契约」,理由见文末
> 实现记录。本节保留原文以记录提案时的思路。
- MessageV2.Message 类型 + MessageTable 加列(SQLite ADD COLUMN,可空,无回填)。
- 读路径惰性规范化(对应 demo 的 `normalizeSession`):首次读取会话消息时,
  对没有 parent_id 的旧消息按 MessageID 顺序推导 `parentId = 前一条`、
  `selectedChildId = 后一条`,推导结果不写回,仅在内存投影层生效。老会话
  行为与今天完全一致。
- `sessions.messages()` 改为返回"从 root 沿 selectedChildId 的可见路径"。
  对规范化后的线性会话,这条路径就是原线性表——Phase 1 结束时全仓行为不变,
  但从此所有下游(prompt 拼接、compaction、revert)自动只看得到当前分支。

**Phase 2 — 写路径树化**
- 编辑重发 / 重新生成改为"在目标父节点下 appendBranch":新消息链挂到同一
  父消息,父消息的 selectedChildId 指向新分支;旧分支原样保留、随时可切回。
- revert 语义收敛为 branch 切换 + Snapshot patch 恢复文件状态(文件恢复仍走
  现有 Snapshot,不重做);unrevert 变成"切回旧分支 + 重放该分支缺失的
  Snapshot patch"。reverted 标记机制整体退役。
- compaction boundary 本来就是消息/部件,天然只存在于其所在分支;分支切换
  后压缩状态随路径自动隔离,无需额外处理(需在 Phase 2 用测试钉死:
  A 分支压缩过的会话切到 B 分支,prompt 不应再带 A 的 boundary)。

**Phase 3 — 客户端切换器**
- TUI/GUI 消息轨上对"有兄弟版本的消息"显示 ‹2/3› 切换(对应 demo 的
  BranchSwitcher);切换走服务端 route,服务端改写父消息的 selectedChildId
  并发布 sync 事件。
- 切换分支时的文件状态恢复策略:沿用了 Phase 2 的 Snapshot patch 路径;
  若目标分支之后用户改过工作区文件,只恢复消息对应的 patch,不做 git 级
  工作区回滚——与今天 revert 的保守程度一致。

**Phase 4 — 清理**
- 移除 reverted 标记与 unrevert 的双轨实现,`session.revert` 列只保留
  兼容读取。

## 备选与否决理由

- **维持线性 + 多份完整会话拷贝**(每次重发 fork 整个 session,像
  session.parent_id 子代理会话那样):否决——成本随重发次数线性膨胀,跨
  fork 的消息无法共享,compaction 状态每个拷贝各一份;且"同会话内切分支"
  的 UX 变成"在会话列表里多出一堆相似会话"。
- **每节点存兄弟数组**:否决——写入路径要同时改多个节点,demo 的单指针
  模型证明 selectedChildId 一个字段就够,兄弟反查成本可忽略。
- **在 Phase 1 同时做写路径**:否决——schema 与行为变化必须分开验证;纯
  增量期出问题可以无损回滚列。

## 后果

- 消息表每行多两列(空值为主),存储成本可忽略;OpenAPI/SDK 会暴露新字段,
  落地时按"进 OpenAPI 的 schema 出口"纪律跑 drift 检查并重新生成 SDK。
- 下游所有"遍历消息"的代码从 Phase 1 起语义变为"遍历当前分支"——这是
  本决策最大的风险面:任何依赖"messages() 返回全量消息"的地方(统计、
  清理、debug 工具)都会静默变成只看当前分支。Phase 1 落地时必须逐个核对
  `sessions.messages()` 的调用方,统计类调用方改走显式的全量查询。
- 惰性规范化意味着"老会话与新会话"在读路径上多一个分支判断;若未来做
  写回迁移,必须保证幂等。
- 立项来源:DeepSeek chat-demo 调研(2026-11-14)。Phase 2 落地时在本文
  追加实现记录并回链 CHANGELOG,整体移入 `implemented/feature/`。

## 实现记录(2026-11-14,Phase 1)

### 形态修正一:分支字段进 data JSON,不是 SQL 列

原文写「MessageTable 加列」。落地发现消息行本就是 JSON blob
(`MessageTable.data` 是 `mode:"json"` 的整包 Info,列上只有 id/session_id/
Timestamps + json_extract 投影索引)——SQL 列等于双份存储还要保持同步。
分支字段进 Info schema(可选):`User.parentID`、双侧 `selectedChildID`;
`Assistant.parentID` **已存在且语义正好是树父**(触发的 user 消息),
无需新字段。存量行缺省 = 零迁移。会话级 root_message_id 同样不需要:
root = 时序上第一条无树父的 user,Phase 2 的重根问题(编辑首条消息)
到时再议。

### 形态修正二:读侧零变更,物化是写入契约(否决读时派生)

原文的「读路径惰性规范化(demo 的 normalizeSession)」实现后否决:派生
字段泄漏进「规范读 vs 原始读」的对比(compaction 套件 6 例实测撞上
`ContextCompaction.getRaw` vs `messages()` 的 toEqual),并存在随 info
回写落库、把线性会话误判成树模式的隐患。改为:

- **线性历史**(无任何显式树字段,存量数据全如此):`visiblePath` 原序
  返回**同一数组引用**,零分配、零派生、零变更——全仓行为逐字节不变。
- **树模式**(任一显式树字段):沿 selectedChildID 严格走链,悬空指针与
  环按「步数上界=消息数」自然终止,不需要防环结构。
- **物化义务在写入方**:首次落分支前,把当前可见路径整条链的指针补成
  显式字段(一次性),此后该会话所有消息必须带全双字段,不允许半物化。
  判定入口 `hasExplicitBranches()` 已在 message-tree.ts 导出。
- demo 需要读时规范化是因为它的数据全在内存、无「读出即写回」边界;
  RedCode 的消息要进 SQLite 与 OpenAPI,派生与存储的边界必须干净。

### 落地面

- `src/session/message-tree.ts`(新):`hasExplicitBranches()` +
  `visiblePath()` 纯函数,模块独立缘由同 summary-complete.ts。
- `src/session/session.ts`:`Session.messages` 全量路径接入
  `visiblePath`——这是 Phase 2「读当前分支」的主咽喉点。limit 路径
  不投影(可见路径的尾段要从 root 走链才知道,limit 恰恰为不读全库;
  Phase 1 无分支故线性尾=可见尾,Phase 2 需重新定义 limit 语义)。
- Schema:`message-v2.ts` User/Assistant 加三个可选字段;SDK 重生成
  (两条命令),openapi.json +305 字节。
- **调用方审计结论**(messages() 语义 = 可见路径后):全量消费方 14 处,
  Phase 1 下行为不变。Phase 2 需复核的:统计类(`cli/cmd/stats.ts`、
  cost 记账)应显式走全量而非可见路径;`share-next.ts`/`cli/cmd/export.ts`
  导出按可见路径是合理语义(导出「当前分支」)但要在 Phase 2 拍板;
  ACP(`acp/agent.ts`/`usage.ts`)与 HTTP handlers 消费可见路径。
- **不经过 messages() 的旁路**(Phase 2 清单):prompt 主循环走
  `MessageV2.filterCompactedEffect`——其输出是模型消费序(压缩重排,
  非时序),规范化/投影必须发生在重排之前的规范序上;GUI 分页路由
  (handlers/session.ts 直连 `MessageV2.page`)与
  `latestCompactionCursor`、`findMessage` 同理,树模式下都要按可见
  路径重新推敲。

### 验证

message-tree 纯函数 10 例 + messages-pagination(DB 级:无分支逐字节
等价 + 显式指针选中链)+ compaction 101 + session/schema-decoding/
revert-compact/processor-effect 76 + prompt 123,全绿;typecheck 0;
check:openapi-drift 一致(SDK 已重生成)。

### Phase 2 开工清单(下会话)

1. ~~`appendBranch`/`selectVersion` 写入侧~~ ✅ 2026-11-14(1fa319d1)。
2. ~~读侧:prompt 咽喉点/叶指针/链式过滤~~ ✅ 2026-11-14(见下 2c 实现记录)。
3. 写入方接线(2b):prompt/compaction 的消息创建点改 appendBranch 语义
   (新消息 parentID=当前叶、旧叶 selectedChildID 改指、会话叶指针推进),
   首写先 materialize;edit-resend/regenerate 改落分支而非截断。
4. revert 收敛(2d):分支切换 + Snapshot patch 文件恢复;unrevert 双轨退役。
5. 客户端切换器(Phase 3):TUI/GUI ‹2/3› 切换、sync 事件、GUI 分页语义
   (handlers/messages 直连 page 与 limit 路径树化)。

### Phase 2 实现记录(2026-11-14,2c 读侧)

**会话级叶指针,不是 root 指针。** prompt 咽喉点的压缩 early-stop 是
newest-first 流式读:从叶沿 parentID 反向收集与分页天然组合,链碰到压缩
边界即停;root 指针的正向走链要全量读,会杀掉 261017 那次读下推的优化
(实测 53 页→14 页)。叶指针也不可从消息行推导:切走后废弃分支的内部
选中指针原样保留(demo 的「恢复该版本已选后续」语义),「最新合格消息」
会是废弃叶——`leaf_message_id` 列 + 迁移 backfill(存量线性会话取时序
最新一条),写入方 2b 起维护。

**链走与压缩边界共享一趟扫描。** 不做独立 chainFilter 生成器(它会绕过
filterCompactedOrdered 的边界 break,把折叠区以下全部读完,early-stop
失效),而是给 `filterCompactedOrdered` 加可选 `ChainWalk` 状态:wanted
从叶出发,命中即沿 parentID 下降,边界 break 天然终止;扫描耗尽没到 root
也没碰边界 = 链上有缺失,onStall 响一声(静默吞引用违反本仓红线),上下文
按已收集前缀继续用——可用性优先、缺口必须可见。

**DCP 覆盖段改道。** native 路径的 covered 下推让覆盖段成员在 stream 层
就不出现,wanted 落进覆盖段会永远等不到匹配。`ChainWalk.skip` 改道表把
覆盖段成员直接指到该块的 anchor——anchor = 范围最旧一条
(`commit` 的 `selected[0]`),被流过滤器豁免、必须在输出里承载块摘要。
legacy 路径无覆盖段,不传 skip。

**物化门。** `Session.visibleChain`:叶指针缺失(新会话)或叶消息未带
显式树指针(升级 backfill 后还没写入过的存量会话)→ undefined → 调用方
退回线性全量,逐字节旧行为。这是安全阀:链走只认显式指针,半物化数据
会让上下文静默截断。写入方 2b 的「首写先 materialize」契约保证活跃
会话在第一次写后就完整物化。

接入点:`prompt.ts` 主循环(legacy + native 两路)、
`compaction.ts` 压缩后校验(RC-P2-07 路径,与 prompt 同视图);
`Session.messages` 全量路径走 visibleChain 反向走链。
GUI messages 路由的分页与 limit 语义留给 Phase 3(与切换器一起设计)。

验证:message-tree 27 例(链走 5:线性等价/分支排除/边界+tail/stall/
detour);compaction+prompt 224、native/context/session/processor/
pagination 139 全绿;typecheck 0。模型可见四问:无注入变化(链走只改
「读哪些消息」,不新增内容;无分支数据链走=线性,出站序列逐字节不变);
token/KV cache/上限均无影响。
