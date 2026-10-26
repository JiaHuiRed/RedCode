# search_tools gated 工具模型侧激活（dsh-ops discovery 的最小等价）

状态:implemented

## 问题

`GATED_TOOLS`（`tool/registry.ts`）把零调用低频工具默认从模型工具表剔除，省固定前缀 token；但恢复只有一条路——用户改配置 `provider.<id>.models.<id>.tools.<id>=true`。模型在会话中无法自助：常驻的 `search_tools` 能搜到 gated 工具的名字，却调不了，只会诱导模型走弯路。

外部参照：dsh-ops（`E:\AI\dsh-ops`，DeepSeek Harness 插件）的 discovery 组件用 `ops_discover_tools` 做渐进式工具披露——常驻只留 read/discover 两个入口（242 tokens），15 个高级工具 schema 按需激活、下一供应商请求生效。其宿主 API（`ctx.tools.register`、pre-step 提示重组）与 RedCode 的 Effect registry 不同，整包不可移植。

## 决策

**不加新工具，给常驻 `search_tools` 补激活出口**：

- `search_tools` 新增可选参数 `enable`：值必须是 `GATED_TOOLS` 成员且在 `all()` 中注册。命中则加入实例级 `state.activated` 集合，返回单行确认；`tools()` 的 gated 剔除分支改为 `GATED_TOOLS.has(id) && !activated.has(id)`，激活的工具下一请求进工具表。
- 搜索结果的 gated 未激活工具追加 `[gated — call again with {"enable": "<id>"} to activate]` 标注，模型一次搜索即可发现激活路径。
- 优先级不变：配置 explicit 布尔（`modelTools`）先于激活集合判定；`Permission.disabled` 的 deny 剔除先于两者——激活不能越权。
- 激活集合是实例级（per-directory），激活后保持可用，语义等同用户开了一次配置布尔。

## 备选与否决

- **独立 `discover_tools` 工具**：否决——与 `search_tools` 职责重叠，多占一份常驻 schema token。
- **插件实现**：否决——RedCode 插件 `tool.definition` hook 只能改 description/parameters，不能增删工具表成员；渐进披露必须动 registry。
- **每次请求后失效激活（dsh-ops 的 per-session 语义）**：暂缓——RedCode `tools()` 无 sessionID 入参，改签名动静大；实例级残留等价于显式配置，无害。

## 后果

- 模型可见四问：
  1. `search_tools` description 追加激活语义一句、参数表新增 `enable` 字段、gated 结果追加标注一行；GATED 工具默认仍不可见，激活后下一请求出现。
  2. 固定前缀增量约 40–60 token（description 一句 + enable schema）；GATED 工具平时仍 0。
  3. 新会话前缀从工具表段起变化；已缓存会话不热替换。激活动作使下一请求前缀从工具表段失效一次——这正是「买进 schema」的功能语义。
  4. `search_tools` 输出有界（全工具 id 列表 / 120 字符截断摘要 / enable 单行确认），无新增无界注入。
- 已知边界：`external-directory`、`lsp` 等成员在部分 flag 组合下不注册，搜索自然搜不到；激活只对在册工具生效。

## 验证

`test/tool/registry.test.ts` 三例：搜索列出 gated 标注并激活后 `tools()` 可见；unknown/非 gated id 拒绝激活；permission deny 的 gated 工具激活后仍被剔除。34 pass / 0 fail；opencode typecheck 通过。

回链：`tool/registry.ts` GATED_TOOLS 注释（261026 Red）。
