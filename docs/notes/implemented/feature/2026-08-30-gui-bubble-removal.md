# GUI 消息流去气泡：从对话气泡转向文档流

日期：2026-08-30
状态：已实现（哥哥拍板）

## 背景

哥哥在 zcode 里对比 UI 形态：zcode 用户消息有气泡、agent 消息无气泡，纯文本流；RedCode GUI 则是 user 和 assistant 都有气泡（user 粉色、assistant 淡蓝紫 `rgba(168,180,240,0.12)` + 边框圆角）。他追问气泡对渲染性能的影响——核实结论：气泡本身不贵（静态背景层 + GPU 合成；壁纸模式的 `backdrop-filter` 磨砂才是唯一增量成本，仅挂在 user 气泡/输入框），流式更新的节流/diff 才是性能大头，与气泡形态无关。真正的问题不是性能，是**形态**：深色主题下 assistant 气泡显成紫胶囊，工具调用被包成一个个胶囊，视觉又重又乱。

## 决策

1. **去掉 assistant 消息气泡**：`session-turn.css` 里 `[data-slot="session-turn-assistant-content"]` 的底色/边框/圆角/阴影全删（保留 `padding: 10px 14px` 的对齐呼吸）。assistant 侧（文本、工具、思考链）一律通栏文本流，对齐 zcode 形态。user 消息气泡保留（用户侧有气泡是 zcode 同款，且粉色气泡有产品辨识）。
   - 注意：那个淡蓝紫底色**与壁纸无关**——壁纸模式只是再叠一层 `backdrop-filter`。浅色主题下 12% 蓝紫被洗白，曾据此误判"assistant 无气泡"；深色主题下自然显紫，两个主题的截图一对比才暴露。
2. **思考链默认折叠可见**（对齐 TUI hide 模式）：GUI 此前 `showReasoningSummaries` 默认 `false`（隐藏，流式期只显示"思考中"动画行，结束什么都不留），开启后是全文展开不可折叠。改为默认 `true` 且 reasoning part 自身可折叠：默认收起一行（icon + 标题 + 时长 + chevron），点击展开 markdown 全文、再点收起。设置开关保留，语义变为"彻底隐藏"。
3. **用户长消息舒展**：`user-message-body` 从 `width: fit-content; max-width: min(82%, 64ch)` 改为 `100%`——长文本铺满可用宽（avatar 之外），短文本靠 flex 收缩仍为窄胶囊，纯 CSS 无需 JS 阈值。

## 备选

- **只对工具 call 去气泡、保留文本气泡**：否决——半吊子。文本消息本身也是 zcode 里被去掉的那个，留着反而两套形态混用（例：文本一段、工具一排，视觉不齐）。
- **把 assistant 气泡颜色调淡/调窄（减负不删）**：否决——"窄胶囊+淡底色"正是哥哥截图里抱怨的形态，减负不如删除。
- **TUI 侧同步去气泡**：TUI 消息本来就没有气泡，无需改动；只做了工具行图标生动化（🧠 思考/✎ Edit 补位/展开态 icon 前缀对齐折叠态），见同一批 commit。
