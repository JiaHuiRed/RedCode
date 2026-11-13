# 会话归档导出/导入:manifest 先行的 ZIP 原子替换

状态:proposed

## 问题

RedCode 的会话数据只活在本地 SQLite 里,没有"带走"的能力:

- 换机器、重装、备份,只能整库拷 `data.db`——格式随版本漂移,不能只挑几
  个会话,也无法在版本间安全互通。
- 已有的 share(`share_url`)是云端链接,依赖服务、不可离线、不可选择范围。
- 用户对长会话(跨天 agent 任务)有归档/审计/在别的项目里续聊的真实诉求。

参照 DeepSeek chat-demo 的 history 模块(`src/services/chat/history/`,含
62 行但不变量密度极高的 README),它证明了这套设计在小体积内可以做到
崩溃安全、版本兼容、校验严格。

## 决策

新增 `session/archive/` 模块 + 两条 server route(export/import),格式
`redcode_archive_version: 1`,ZIP 布局抄 demo 的条目顺序约定:

```text
manifest.json                        格式版本 + 生成时间 + 会话数,必须是首个条目
sessions/{session_id}.json           单会话完整导出(info + 可见路径全量消息 + 部件)
sessions/{session_id}_files/...      附件原件(仅图片等本地仍在的原始字节,按引用清点)
session_index.json                   会话索引(id/title/时间/消息数/文件清单)
```

关键设计,逐条来自 demo 的已验证做法:

- **manifest 必须是首条目**:导入第一步只读首条目验格式与版本,不合格
  立即失败——不碰现有数据,不打断正在生成的回答。
- **暂存 + 单事务原子替换**:导入先解析全部条目写入临时表(或内存暂存),
  树结构校验(消息角色/顺序/部件归属)全过后,在一个事务里落库;任何一步
  失败保留原记录,中断残留的暂存键下次导入前清理。
- **串行队列**:导出、导入、清空共用一条 promise 链,防止归档读取期间
  数据被并发改写。
- **容器严格、内容宽松**:元数据(版本、ID、时间戳、消息归属)校验失败
  整体拒绝;单条无法映射的内容部件丢弃且**在导入报告里列明**,不静默。
  与 `context-import.ts` 的"显式拒绝,不静默跳过"红线同一纪律。
- **导出一致性快照**:导出开始时锁定会话列表快照;某会话在读取期间被删,
  整次导出失败而不是产出残缺归档。
- **ID 策略**:导入一律发新 SessionID(避免与现有会话冲突),消息/部件 ID
  同步重发;`share_url`、cost/tokens 累计值、权限审批状态不进归档。
  compaction boundary 与 DCP 状态**不导出**——它们绑定原会话的模型与前缀
  历史,在目标环境无意义,导入后的会话按未压缩处理。

入口:TUI 命令 + GUI 设置项,导出文件名 `redcode_sessions-YYYYMMDD.zip`。
ZIP 读写用现有依赖体系内的库(选型落地时定,demo 自写的 ZIP32 STORE/
DEFLATE 实现仅 400 行,可作兜底参考)。

## 备选与否决理由

- **直接导出 SQLite 文件/表 dump**:否决——与库 schema 强耦合,版本互通
  靠迁移链;且无法选择会话子集,也带进了 workspace/project 等环境绑定字段。
- **JSON 单文件(ZIP 之外)**:否决——附件原件是二进制,Base64 内联会让
  大图片场景膨胀 33% 且不可流式;ZIP 条目天然按会话切分,流式写入/校验。
- **导出 compaction boundary 以便导入后免重压**:否决——boundary 引用的
  消息 ID 与前缀形状绑定原会话的模型/提示词版本,跨环境恢复的 boundary
  是伪共享,宁可重压。

## 后果

- 归档 v1 只承诺"本版本写入的能被本版本读回";跨大版本的归档兼容按
  manifest 版本号显式拒绝并提示重新导出,不做多版本读取器。
- 非图片附件原件若已被 media eviction(2026-10-24)清掉,导出只带元数据,
  导入后该附件不可用——导入报告需列明。
- 归档不包含权限配置、agent 定义、seed 内容;会话恢复后首次运行按当前
  项目的配置走,与"克隆会话到别的项目"语义一致。
- 新增两条 route 会进 OpenAPI:走 drift 检查 + SDK 重生成纪律。
- 立项来源:DeepSeek chat-demo 调研(2026-11-14)。实现后移入
  `implemented/feature/` 并回链 CHANGELOG。
