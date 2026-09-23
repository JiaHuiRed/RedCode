# 会话胶囊统一五项导航与内容视口

状态:implemented

## 问题

右侧会话胶囊已经有固定系统 tab、动态文件 tab、Context 摘要与标题栏状态入口，但它们分属不同层：compact 态单独显示 Context HUD，expanded 态才显示 tab 内容，服务器/MCP/LSP/插件状态则留在标题栏 popover。结果是同一个胶囊在两种尺寸下有不同内容语义，Status 也不是会话工作区的一部分。

## 决策

一个 Capsule 由固定的 Review、Context、Outline、Plan、Status 五项导航与当前 active tab 的内容 viewport 组成。compact 与 expanded 共用同一条导航和当前内容；compact 隐藏动态文件 tab，但保留打开文件入口。宽桌面 compact 态点击其他固定 tab 只切换内容、不展开胶囊；点击当前 tab 才切换开合。中桌面选 tab 仍会打开参与布局的面板。Kobalte `Tabs.Trigger` 保留 tab/tabpanel 关联和方向键导航。

Context tab 承载原来独立显示的摘要行，并保留完整会话统计、quota、真实构成与估算 fallback、system prompt 和原始消息。compact 态默认收起六组明细，只露关键摘要；点行仍可展开详情。摘要数据与详情共用同一份 `useSessionContextSummaries()` 结果；固定顺序的 `<Index>` 让摘要行在流式数据更新时保持展开状态。切换到其他 tab 时，compact 胶囊展示该 tab 自己的内容，不固定显示 Context。

Status 成为第五个固定 tab，Server、MCP、LSP、Plugins 各自可折叠；服务器与 MCP 操作保留在 session directory 对应的 SDKProvider 内。标题栏只保留健康/SSE 指示器，在会话页点击后选择 Status 并展开胶囊。

## 备选与否决理由

- **保留独立 Context HUD 与 popover**：否决——同一功能继续分裂在导航、compact 内容和标题栏入口，compact 与 expanded 仍无法表达同一 active tab。
- **compact 态保留动态文件 tab**：否决——文件数量会挤压五个固定入口；文件操作仍可在 expanded 态完成。
- **用普通按钮重做固定入口**：否决——会丢失 Kobalte tab/tabpanel 语义与键盘方向导航。

## 后果

- compact 态五项固定导航仍可点击，打开文件入口仍可用；Context 以摘要模式显示，其他固定 tab 显示各自内容。Status 数据轮询仅在 Status 可见时运行。
- 当前不在会话页时健康指示器没有可跳转的 Capsule，按钮禁用；健康状态本身仍可见。
- 未启动或重启应用；本次没有运行中的 UI 可供人工视觉验收，行为验证以定向测试和 typecheck 为准。
