# 消息树分支：parentId + selectedChildId 单指针树

状态:proposed

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
- 立项来源:DeepSeek chat-demo 调研(2026-11-14)。实现后本 note 移入
  `implemented/feature/`,Phase 2 落地时在本文追加实现记录并回链
  CHANGELOG。
