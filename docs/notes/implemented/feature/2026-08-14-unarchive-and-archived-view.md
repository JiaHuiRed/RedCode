# 归档补全：可见性与撤销（附 OpenAPI 生成器压平联合类型的绕行）

状态:implemented

## 问题

归档功能只做了一半。机制上它是"给会话打 `time_archived` 时间戳 + 列表查询默认 `WHERE time_archived IS NULL` 过滤"，数据一个字节都不删——但 GUI 只提供了"归档"这一个动作：

- **看不见**：已归档会话在 `global-sync` 拉取时就被滤掉，根本不进客户端 store，界面上没有任何入口能列出它们。
- **撤不回**：整条链都不支持清除时间戳——`SetArchivedInput.time` 是 `Schema.optional(ArchivedTimestamp)`（可缺省但不可空）、服务层签名 `time?: number`、HTTP payload 同样不可空。存储层其实支持（`projectors.ts` 写入只过滤 `undefined`，`null` 会照常落库），缺口纯在 schema。

结果是归档等于单向消失。实测用户 432 个会话里只归档过 1 个——大概率试了一次发现找不回来就再没用过。

## 决策

**服务端**：`SetArchivedInput.time` 与 `Session.setArchived` 签名放宽到 `number | null`，`null` = 清掉时间戳。HTTP `UpdatePayload` 新增独立布尔字段 `unarchive`，handler 里 `unarchive` 优先于 `time.archived`（两者同时传属调用方矛盾，取"取消"更安全：撤销可再归档，反之会让用户以为没生效）。

**GUI**：首页工具栏加"显示已归档"开关（archive 图标，与列表/看板切换并列）。打开时用 `experimental.session.list({ archived: true })` 单独取——注意该参数语义是"**包含**归档"而非"只看归档"，所以客户端再筛出真正带 `time.archived` 的；关闭时不产生任何额外请求。列表与看板的右键菜单按会话状态给"归档"或"取消归档"，取消后刷新归档列表。归档视图为空时不再提示"新建会话"。

## 备选与否决理由

- **`time.archived: null` 表达取消**（最直观）：否决——**OpenAPI 生成器会把 payload 位置的联合类型压平**。`Schema.optional(Schema.NullOr(ArchivedTimestamp))` 与显式 `Schema.Union([ArchivedTimestamp, Schema.Null])` 实测都只生成 `{"type":"number"}`，SDK 类型因此不接受 `null`、GUI 编译不过。同一构造在 component schema 里却正常输出 `anyOf:[number,null]`（`SyncEventSessionUpdated.data.info.time.archived` 可验证），所以这是 payload 位置特有的行为，不是写法问题。独立布尔字段能干净穿过 codegen。
- **用 `0` 当"取消"的哨兵值**：否决——`ArchivedTimestamp` 是 `Schema.Finite`，0 和负数都是合法值，用它当哨兵是隐式约定；独立字段同样能穿过 codegen 且语义自明。
- **在 GUI 侧把 `null` 强转过去**（服务端运行时确实收 null，Effect 校验的是真 Schema 而非 OpenAPI 投影）：否决——类型撒谎，下一个人读到 SDK 签名会以为传不了。
- **归档视图做成独立对话框**：否决——首页已有搜索框与视图切换，加一个开关比新开一个对话框更少代码、更易发现。

## 后果

- 归档从单向变成可逆，功能闭环；`docs/notes` 与 MANUAL 同步说明入口。
- `unarchive` 是 payload 上的第二种表达"改归档状态"的方式，与 `time.archived` 并存。handler 的优先级是明确的，但**如果将来 codegen 修好了联合类型，这个字段应该退役、回到 `time.archived: null` 的单一表达**。
- 已归档会话仍不进 sync store（只在开关打开时单独请求），所以归档视图里的会话没有实时状态（工作中/权限待批等徽标）——归档会话本来就不该在跑，接受。
- TUI 没有归档功能（入口只在 GUI），本次未改变这一点。
