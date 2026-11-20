*REDCODE · EXPERIENCE FIRST REVIEW*
# 把每天的操作变得顺手

**0.18.4 / 0.18.5 体验、布局、性能与工程改动清单**

**0.18.4：**常用选择就近完成，设置和编辑空间由用户控制。<br>**0.18.5：**找回历史、连续审阅、查看成果和返回工作现场形成完整流程。

本次重排以用户给出的三个例子为准：设置窗口可调大小、新建 Soul 可折叠、GUI 新会话快速选 Soul。它们属于日常产品主路径，应先于大量低频边界修复。前三项明确记为用户建议，其余主线来自本轮继续核查。

| 0.18.4 体验改动包 | 0.18.5 工作流改动包 | 附录工程证据候选项 | 用户明确提出的首要项 |
| --- | --- | --- | --- |
| 12 | 8 | 34 | 3 |
审查日期：2026-11-14 · JiaHuiRed/RedCode · 分支 dev · 当前标记版本 0.18.3<br>固定提交：[0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f](https://github.com/JiaHuiRed/RedCode/commit/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f)<br>性质：仓库审查与改动建议；未修改产品代码，未提交、推送或发布。

---

## 01 · 这轮审查如何判断“有价值”

优先考虑正常工作中反复发生的成本：是否必须离开当前任务才能选一个选项；低频表单是否占据高频列表；点击后是否马上知道发生了什么；看完一段证据能否回到原处；任务变多、文件变大后，输入和导航是否仍持续响应。每个改动包都给出操作场景和具体终态，便于直接拆任务。

> **证据边界** 用户上传的截图用于观察当前视觉层级；源码固定在本报告 SHA。部分提交、快捷键、分片更新、刷新和工作树派生逻辑已做真实函数的隔离执行复核。Vite 启动成功，但本环境 Chromium 因 socket 权限限制未能启动，未完成浏览器逐项交互或 Windows Electron 成品验收。下面的窗口、数据规模与响应目标均为建议验收条件，未冒充实测成绩。
范围 S / M / L 分别表示单视图或单入口、跨状态与多个组件、需要接口或跨端流程的相对实现范围，不能换算为已承诺工期。主线与附录存在吸收关系，不把 20 个体验包和 34 个候选项简单相加。

## 02 · 从这三个例子推导实际布局

以下均为用户提供的截图，未经本次工具运行生成；用于说明当前使用阻力。

![设置当前可见区域：默认 Soul 与展开创建区占据上方，阵容需要继续下翻。](/docs/assets/experience-review-2026-11-14/settings-window.png)

*设置当前可见区域：默认 Soul 与展开创建区占据上方，阵容需要继续下翻。*

![Soul 阵容当前状态：列表已经存在，但未选中时右侧详情为空，创建表单仍在上方。](/docs/assets/experience-review-2026-11-14/soul-roster.png)

*Soul 阵容当前状态：列表已经存在，但未选中时右侧详情为空，创建表单仍在上方。*

![GUI 新会话：工作树、Agent、模型和后台入口可见，Soul 缺少同等就近的选择入口。](/docs/assets/experience-review-2026-11-14/new-session.png)

*GUI 新会话：工作树、Agent、模型和后台入口可见，Soul 缺少同等就近的选择入口。*

| 区域 | 建议的信息顺序 | 操作方式 |
| --- | --- | --- |
| 设置窗口壳 | 标题与搜索 → 当前分区；固定可达的关闭/最大化 | 拖动调整尺寸；重开恢复；窄容器重排内容 |
| Soul 管理 | 紧凑默认摘要 → 搜索/新建入口 → 阵容与可读详情 | 新建默认收起；点卡立刻见详情；原文/来源折叠到高级信息 |
| 新会话 | 明确工作位置 + Soul + Agent + 模型/强度 + 主输入 | 常用选择在当前页完成；提交快照与显示一致；不继续堆成拥挤一行 |

## 03 · 0.18.4：每天都能感觉到的改善

建议先交付窗口与 Soul 三项，再一起整理模型、编辑、设置与任务切换。后半部分将已有状态信息与终端能力接到更顺手的动作。

| 编号 | 体验改动 | 用户得到什么 | 范围 |
| --- | --- | --- | --- |
| [UX-01](#ux-01) | **设置窗口可调大小、最大化与还原**（用户提出） | 大屏真正多显示内容，小屏也能完成操作；不用靠反复滚动适应固定窗口。 | M |
| [UX-02](#ux-02) | **新建 Soul 默认收起，阵容回到首屏**（用户提出） | 打开个性化直接看到已有 Soul；新增操作仍容易发现，但不占据每次浏览的主要空间。 | S–M |
| [UX-03](#ux-03) | **GUI 新会话直接快选 Soul**（用户提出） | 无需绕到设置修改默认，也无需记住隐形偏好；每次开始前能确认正在和谁工作。 | M |
| [UX-04](#ux-04) | **Soul 阵容成为可浏览、可阅读的详情工作区**（主动发现） | 点选立即看到人物内容，阅读不被工程字段打断，浏览多个 Soul 不必不断上下找位置。 | M |
| [UX-05](#ux-05) | **模型名直接选模型，最近与收藏放前面**（主动发现） | 频繁在常用模型之间切换时少经过一层界面，也不用每次重新搜索。 | M |
| [UX-06](#ux-06) | **长提示可展开编辑**（主动发现） | 写多段需求、审阅长提示和调整约束时有足够空间，不用先在其他工具写完再粘贴。 | M |
| [UX-07](#ux-07) | **输入工具栏按实际空间排布，字号真正跟随设置**（主动发现） | 缩窗、开双侧栏或调大字号时，主要操作仍完整；模型和人物名称无需靠猜。 | M |
| [UX-08](#ux-08) | **设置找得到，编辑完能留在原列表**（主动发现） | 不用记住设置藏在哪，也不用每改一个 MCP 就重新打开设置。 | M |
| [UX-09](#ux-09) | **多会话随时找回，返回首页保留工作位置**（主动发现） | 同时处理多个任务时，不需要记住每个标题或来回翻首页。 | M |
| [UX-10](#ux-10) | **开始任务前，看清并真正选对工作位置**（主动发现） | 新任务确实在用户选中的工作树开始，避免选择器看似可选却不起作用。 | S–M |
| [UX-11](#ux-11) | **状态栏能直接带我去看正在做什么**（主动发现） | 看见状态即可行动，不用在长对话里找工具卡和失败原因。 | M |
| [UX-12](#ux-12) | **终端一键专注阅读，再恢复原工作台**（主动发现） | 读长错误和测试输出时一次展开，结束后一次回到原聊天布局。 | S–M |

## 04 · 0.18.5：完整的连续工作体验

在基础交互顺手之后，补上内容创作、历史检索、审阅与成果回收。全文查找和 Soul 编辑涉及接口与持久化；其余多项可复用当前已有能力。

| 编号 | 体验改动 | 用户得到什么 | 范围 |
| --- | --- | --- | --- |
| [UX-13](#ux-13) | **Soul 从创建到编辑、试用和复用形成完整流程**（主动发现） | 管理自己的 Soul 不必跳出工具编辑文件，创建完成即可开始使用，也能知道这场对话采用哪版设定。 | L |
| [UX-14](#ux-14) | **Agent 选择说清用途，也说清模型会怎样变化**（主动发现） | 选 Agent 时能判断它适合做什么，避免只凭名字猜测和切完再回头调模型。 | M |
| [UX-15](#ux-15) | **能搜索旧对话正文、错误和工具结果**（主动发现） | 只记得一个报错、路径或承诺时，也能找回原文；不必逐轮翻大纲。 | L |
| [UX-16](#ux-16) | **Diff 可以连续审完一批改动**（主动发现） | 一批改动顺着看完，减少重复点选和漏看；不需要靠记忆辨认哪些文件已经看过。 | M |
| [UX-17](#ux-17) | **后台工作结束后，结果能看、能引用、能继续**（主动发现） | 后台任务完成后可以顺手收回成果，用在当前工作里，不止看到一个完成状态。 | M–L |
| [UX-18](#ux-18) | **看一眼文件后，能回到刚才那条证据**（主动发现） | 查证源码之后继续原阅读位置，连看多个文件也不会留下大量必须关闭的标签。 | M |
| [UX-19](#ux-19) | **大仓库里先看到能用的界面，再按需加载重内容**（主动发现） | 输入、选择文件、停止任务持续响应；大批改动可以先浏览，不必等整批正文。 | L |
| [UX-20](#ux-20) | **外观设置里直接看清消息、代码和终端效果**（主动发现） | 不用反复关闭设置去看效果，能当场判断中文、代码、终端与壁纸的可读性。 | M |

## 05 · 0.18.4 详细改动与验收

### UX-01 · 设置窗口可调大小、最大化与还原

*0.18.4 · 用户提出 · 范围 M*

- **当前阻力**：当前设置是应用内 Dialog。x-large 的尺寸上限为 980×600 CSS px，通用接口没有 resize；设置未传 title/action，显式关闭按钮也没有出现，Esc 与遮罩关闭仍可用。用户截图显示长内容被迫在这一容器里滚动。
- **具体改动**：给设置增加调整大小手柄、最大化/还原和明确的关闭入口；记住用户尺寸，主窗口变小时约束到可视区。表单、Soul 阵容与导航依据设置容器宽度切换布局；窄时用单列或抽屉。
- **使用收益**：大屏真正多显示内容，小屏也能完成操作；不用靠反复滚动适应固定窗口。

#### 验收场景

- 在 1366×768、1920×1080 下可拖大、还原；关闭后重开恢复尺寸。
- 主窗口缩小时关闭/保存按钮不越界；125%/150% 缩放和 20px 字号下仍可操作。
- 增加尺寸能力只用于设置等管理面板，保留确认框和选择器的简洁。

> 尺寸与布局依据源码、用户截图；调整后的效果尚未做真机验收。

<details>
<summary>固定提交的源码定位</summary>

- [packages/ui/src/components/dialog.css · 127–135](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/ui/src/components/dialog.css#L127-L135)
- [packages/ui/src/components/dialog.tsx · 6–61](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/ui/src/components/dialog.tsx#L6-L61)
- [packages/app/src/components/dialog-settings.tsx · 67–76](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/components/dialog-settings.tsx#L67-L76)

</details>

### UX-02 · 新建 Soul 默认收起，阵容回到首屏

*0.18.4 · 用户提出 · 范围 S–M*

- **当前阻力**：个性化页按默认 Soul 大卡片→始终展开的新建表单→阵容排列。截图中创建区域挡在阵容上方；用户要查看已有伙伴也必须经过低频创建表单。
- **具体改动**：将“新建 Soul”改为默认收起的区块或阵容工具栏按钮；默认 Soul 压成紧凑摘要，保留“只影响之后新会话”的说明。展开创建时保持用户输入，收起不清稿；创建完成后收起并定位新条目。
- **使用收益**：打开个性化直接看到已有 Soul；新增操作仍容易发现，但不占据每次浏览的主要空间。

#### 验收场景

- 有 5 个 Soul 时，打开个性化的首屏可见阵容搜索和多张卡片。
- 展开→输入→收起→展开，文本与字段不丢；失败仍保留输入。
- 创建成功后选中新 Soul，默认与当前会话绑定按既有语义保持明确。

<details>
<summary>固定提交的源码定位</summary>

- [packages/app/src/components/settings-personalization.tsx · 163–249](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/components/settings-personalization.tsx#L163-L249)
- [packages/app/src/components/settings-personalization.tsx · 430–474](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/components/settings-personalization.tsx#L430-L474)

</details>

### UX-03 · GUI 新会话直接快选 Soul

*0.18.4 · 用户提出 · 范围 M*

- **当前阻力**：TUI 首页已有可点击 Soul 入口；GUI 新会话输入区只有工作树、Agent、模型等控件。GUI 提交时已能把 lastSoul/服务端默认传给 session.create，缺口在开始任务前的可见选择。
- **具体改动**：在新会话输入区附近显示头像、Soul 名称与选择入口；弹层显示常用/最近、可搜索阵容和“管理 Soul”。选择后回输入框。本次选择与“以后默认”明确区分，提交快照携带选中的 Soul。
- **使用收益**：无需绕到设置修改默认，也无需记住隐形偏好；每次开始前能确认正在和谁工作。

#### 验收场景

- 在新建页用鼠标或键盘选 Soul 后发送首条消息，实际 session.soul 与选择一致。
- 切换 Soul 不清空提示、附件、模型或工作位置；只有明确选择“以后默认”才改相应偏好。
- 已有会话不因更改新会话默认而换人；Soul 不可用时给可操作提示。

> 新选择器必须接真实会话创建参数，不能仅改变头像。当前消息区域已有 SoulAvatar 与姓名 title。

<details>
<summary>固定提交的源码定位</summary>

- [packages/opencode/src/cli/cmd/tui/routes/home.tsx · 54–56](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/opencode/src/cli/cmd/tui/routes/home.tsx#L54-L56)
- [packages/opencode/src/cli/cmd/tui/routes/home.tsx · 133–141](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/opencode/src/cli/cmd/tui/routes/home.tsx#L133-L141)
- [packages/app/src/components/prompt-input/submit.ts · 462–472](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/components/prompt-input/submit.ts#L462-L472)
- [packages/app/src/components/prompt-input.tsx · 1713–1807](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/components/prompt-input.tsx#L1713-L1807)

</details>

### UX-04 · Soul 阵容成为可浏览、可阅读的详情工作区

*0.18.4 · 主动发现 · 范围 M*

- **当前阻力**：selectedId 初始为空，右侧显示“选择一个 Soul”；选卡只更新 ID，整页共享滚动。窄布局详情排在完整阵容后。详情先列 id、来源字段、路径，正文用原始 Markdown 的 pre 展示。
- **具体改动**：首次进入优先选默认或上次所看 Soul；宽布局保持阵容和详情各自可浏览，搜索栏常驻；窄布局点卡进入可返回的详情页/抽屉。主区域先展示头像、简介、可读 Markdown 正文和“以此 Soul 新建”；路径、来源、原文收进高级信息。
- **使用收益**：点选立即看到人物内容，阅读不被工程字段打断，浏览多个 Soul 不必不断上下找位置。

#### 验收场景

- 连续选择 5 个 Soul，当前详情始终在可见区域，阵容滚动位置保持。
- 窄窗口进入详情后可一次返回刚才的卡片；默认 Soul 详情不再留下无意义空白。
- 保留已有搜索、头像上传、字段来源、打开源文件能力，改的是信息优先级。

<details>
<summary>固定提交的源码定位</summary>

- [packages/app/src/components/settings-personalization.tsx · 57–108](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/components/settings-personalization.tsx#L57-L108)
- [packages/app/src/components/settings-personalization.tsx · 249–382](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/components/settings-personalization.tsx#L249-L382)

</details>

### UX-05 · 模型名直接选模型，最近与收藏放前面

*0.18.4 · 主动发现 · 范围 M*

- **当前阻力**：鼠标点击模型先进入推理概览，再点模型名才进列表，选完又回概览。GUI 已持久化最近 5 个模型，但 ModelList 仍按供应商和字母排序；TUI 已有收藏和最近分组。
- **具体改动**：模型名称直接打开模型列表，推理强度保留独立点击区；选择后回输入。列表顶部放“固定/最近”，复用最近记录并按 provider+model 去重；同时保留已有搜索、虚拟化、模型详情 tooltip 与供应商入口。
- **使用收益**：频繁在常用模型之间切换时少经过一层界面，也不用每次重新搜索。

#### 验收场景

- 已有有效推理档或默认档时，两次鼠标点击完成换模型并回到输入。
- 最近使用立即进入前排，重启后仍在；固定项不会重复出现，失效模型说明原因。
- 只调推理档时无需经过完整模型列表；键盘选择后焦点返回输入。

<details>
<summary>固定提交的源码定位</summary>

- [packages/app/src/components/dialog-select-model.tsx · 52–76](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/components/dialog-select-model.tsx#L52-L76)
- [packages/app/src/components/dialog-select-model.tsx · 141–149](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/components/dialog-select-model.tsx#L141-L149)
- [packages/app/src/components/dialog-select-model.tsx · 253–262](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/components/dialog-select-model.tsx#L253-L262)
- [packages/app/src/context/models.tsx · 132–159](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/context/models.tsx#L132-L159)
- [packages/opencode/src/cli/cmd/tui/component/dialog-model.tsx · 23–60](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/opencode/src/cli/cmd/tui/component/dialog-model.tsx#L23-L60)

</details>

### UX-06 · 长提示可展开编辑

*0.18.4 · 主动发现 · 范围 M*

- **当前阻力**：GUI 输入区固定 max-h-[180px]，长需求在小框里滚动；没有展开编辑入口。TUI 已提供 /editor，可把长文本交给外部编辑器。
- **具体改动**：给 GUI 输入框提供拖高和展开编辑；展开态可占工作区主要区域，收起回原位置。两种视图共享同一草稿与附件状态，不另复制一份编辑内容；保留 @引用、选区和撤销栈。
- **使用收益**：写多段需求、审阅长提示和调整约束时有足够空间，不用先在其他工具写完再粘贴。

#### 验收场景

- 30 行提示、多个 @引用及图片在展开/收起后内容、顺序、选区不变。
- 展开状态的换行、发送规则清晰，中文输入法组合期不会意外提交。
- 切换会话再返回仍能继续草稿；窗口缩小时编辑与发送入口可达。

<details>
<summary>固定提交的源码定位</summary>

- [packages/app/src/components/prompt-input.tsx · 1664–1711](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/components/prompt-input.tsx#L1664-L1711)
- [packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx · 659–678](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx#L659-L678)

</details>

### UX-07 · 输入工具栏按实际空间排布，字号真正跟随设置

*0.18.4 · 主动发现 · 范围 M*

- **当前阻力**：工具栏固定 46px 单行，包含附件、工作树、Agent、模型、上下文、后台与发送等；输入正文仍固定 14px/21px。新增 Soul 后更需要整体布局，而不是继续挤进同一行。
- **具体改动**：按聊天列容器宽度分层：发送/停止始终可见，Soul/Agent/模型保持可识别，低频动作进入带标签的更多菜单；必要时两行显示。输入与关键标签使用现有字号 token 和相对行高。
- **使用收益**：缩窗、开双侧栏或调大字号时，主要操作仍完整；模型和人物名称无需靠猜。

#### 验收场景

- 1366px 宽、双侧栏、20px 字号、长中文 Agent/模型名同时出现时可完成全部主要动作。
- 新增 Soul 控件不挤掉发送或停止；菜单项有名称与快捷键。
- 按设置容器/聊天列宽度响应，而非仅按整窗视口断点判断。

> 当前容量问题由布局约束推断；未声称已在某一具体屏幕实测裁剪。

<details>
<summary>固定提交的源码定位</summary>

- [packages/app/src/components/prompt-input.tsx · 1698–1807](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/components/prompt-input.tsx#L1698-L1807)
- [packages/app/src/context/settings.tsx · 280–293](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/context/settings.tsx#L280-L293)

</details>

### UX-08 · 设置找得到，编辑完能留在原列表

*0.18.4 · 主动发现 · 范围 M*

- **当前阻力**：设置已有九分区记忆和按需加载，但无全局设置项搜索。initialTab 已提供却未被入口使用；常规页堆放多组内容。MCP/自定义服务商编辑用 dialog.show 替换设置，保存后失去原列表上下文，现有系统其实支持 push。
- **具体改动**：建立轻量设置索引：搜索“壁纸/字体/通知/MCP”直接定位具体项；常规页补分组锚点并恢复阅读位置。从设置发起的编辑使用已有弹窗栈或子页，保存/取消回原列表，保留搜索、滚动和焦点。场景入口可带 tab+settingId+entityId。
- **使用收益**：不用记住设置藏在哪，也不用每改一个 MCP 就重新打开设置。

#### 验收场景

- 在诊断分区关闭后，从“管理 Soul”进入必须直达个性化；显式目标优先于上次分区。
- 编辑第 15 个 MCP 后仍回到该条目附近，可继续改第 16 个；Esc 只关闭当前子层。
- 从常规声音区切到快捷键再返回，仍在声音区；保留现有 lazy，不强制挂载全部页。

> 模型、Soul、快捷键的列表内部搜索已经存在；新增的是跨分区设置项搜索与连续管理。

<details>
<summary>固定提交的源码定位</summary>

- [packages/app/src/components/dialog-settings.tsx · 39–48](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/components/dialog-settings.tsx#L39-L48)
- [packages/app/src/components/settings-general.tsx · 1161–1187](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/components/settings-general.tsx#L1161-L1187)
- [packages/app/src/components/settings-mcp.tsx · 308–310](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/components/settings-mcp.tsx#L308-L310)
- [packages/app/src/components/settings-providers.tsx · 175–182](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/components/settings-providers.tsx#L175-L182)
- [packages/ui/src/context/dialog.tsx · 130–147](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/ui/src/context/dialog.tsx#L130-L147)

</details>

### UX-09 · 多会话随时找回，返回首页保留工作位置

*0.18.4 · 主动发现 · 范围 M*

- **当前阻力**：顶栏已有标签和位置快捷切换，但 tab 容器双层 overflow-hidden，没有全部已开列表；空查询的通用选择器不列最近会话。首页 view/project/search 是局部初始状态。关闭非当前标签还会触发邻居导航。
- **具体改动**：顶栏增加“全部已开”搜索列表与最近使用顺序，活动标签确保可见；空查询补最近会话。回首页保留项目、列表/看板、当前检索与位置；关闭后台标签保持当前会话。长期任务置顶可以后排。
- **使用收益**：同时处理多个任务时，不需要记住每个标题或来回翻首页。

#### 验收场景

- 打开 12/20 个会话后，每个都可通过展开列表+选择到达。
- A→B→A 直接回最近；关闭 C 不离开正在编辑的 A。
- 在项目 B 的列表搜索中进入会话再返回，仍保留筛选和位置；已有项目恢复最后会话继续有效。

<details>
<summary>固定提交的源码定位</summary>

- [packages/app/src/components/titlebar.tsx · 209–219](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/components/titlebar.tsx#L209-L219)
- [packages/app/src/components/titlebar.tsx · 370–388](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/components/titlebar.tsx#L370-L388)
- [packages/app/src/components/titlebar.tsx · 450–497](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/components/titlebar.tsx#L450-L497)
- [packages/app/src/components/dialog-select-file.tsx · 340–350](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/components/dialog-select-file.tsx#L340-L350)
- [packages/app/src/pages/home.tsx · 75–99](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/pages/home.tsx#L75-L99)

</details>

### UX-10 · 开始任务前，看清并真正选对工作位置

*0.18.4 · 主动发现 · 范围 S–M*

- **当前阻力**：newSessionWorktree 派生值只识别 store 的 create，其余重新按当前 SDK 目录推导。选择已有 worktree 会回 main；在 worktree 内选 main 仍回当前 worktree。提交函数本来支持具体已有目录。
- **具体改动**：尊重用户选择的 main/已有 worktree/create；main 显式解析成项目主目录，不能继续沿用当前 SDK 工作树目录。统一新会话的目标项目、工作目录和分支说明。选择与提交共用同一状态快照，无法得知目标分支时明确等待或未知，不展示当前目录分支冒充目标。
- **使用收益**：新任务确实在用户选中的工作树开始，避免选择器看似可选却不起作用。

#### 验收场景

- 根项目→已有 worktree、已有 worktree→main、创建新 worktree 三条路径，显示目标与实际创建目录一致。
- 改变工作位置保留草稿、Soul、Agent 和模型；提交后会话路由进入实际目录。
- 错误说明落在工作位置控件附近，可重新选择。

> 已抽取并执行真实派生回调：root→既有目录返回 main；既有 worktree→main 返回原目录；create 正常。属于函数级复核，非浏览器实测。

<details>
<summary>固定提交的源码定位</summary>

- [packages/app/src/pages/session.tsx · 461–466](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/pages/session.tsx#L461-L466)
- [packages/app/src/pages/session.tsx · 1817–1819](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/pages/session.tsx#L1817-L1819)
- [packages/app/src/components/prompt-input/submit.ts · 354–400](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/components/prompt-input/submit.ts#L354-L400)
- [packages/app/src/components/prompt-input/submit.ts · 441–471](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/components/prompt-input/submit.ts#L441-L471)

</details>

### UX-11 · 状态栏能直接带我去看正在做什么

*0.18.4 · 主动发现 · 范围 M*

- **当前阻力**：本轮 HUD 已统计工具、失败、权限与子任务，但显示为无动作 span；会话空闲且无待授权、无运行子任务时隐藏。用户看到数字后还需要自行寻找对应内容。
- **具体改动**：当前工具可点击定位并展开输出；失败数跳到失败记录；待授权聚焦授权表单；子任务打开小列表。完成后留一行可收起的真实结果入口，便于查看文件与待处理项。
- **使用收益**：看见状态即可行动，不用在长对话里找工具卡和失败原因。

#### 验收场景

- 很长对话里，从失败计数最多两次操作到对应工具；跨虚拟窗口沿用已有历史加载。
- 授权入口聚焦正确表单，子任务归属正确；键盘和读屏可操作。
- 结束摘要不冒充仍在运行；新轮次开始后统计归属明确。

> 沿用真实事件与当前轮次口径，不新增模型猜测的百分比进度。

<details>
<summary>固定提交的源码定位</summary>

- [packages/app/src/pages/session/composer/session-activity-hud.tsx · 50–90](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/pages/session/composer/session-activity-hud.tsx#L50-L90)

</details>

### UX-12 · 终端一键专注阅读，再恢复原工作台

*0.18.4 · 主动发现 · 范围 S–M*

- **当前阻力**：终端已能拖拽调高、排序、改名，但高度上限为视口 60%；标题栏没有最大化/恢复入口。长日志仍只能在有限高度中浏览。
- **具体改动**：增加最大化/恢复按钮与快捷键，临时占满工作区可用高度；恢复用户原高度、活动 PTY 与焦点。后台中心点击运行终端时直接聚焦现有 PTY。并排终端作为后续增强。
- **使用收益**：读长错误和测试输出时一次展开，结束后一次回到原聊天布局。

#### 验收场景

- 最大化与还原不新建 PTY、不重跑命令；恢复原 tab、高度和输入状态。
- 正在聊天时非用户触发的后台变化不抢焦点。
- 现有拖拽 resize、重命名和排序保留。

<details>
<summary>固定提交的源码定位</summary>

- [packages/app/src/pages/session/terminal-panel.tsx · 38–46](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/pages/session/terminal-panel.tsx#L38-L46)
- [packages/app/src/pages/session/terminal-panel.tsx · 227–239](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/pages/session/terminal-panel.tsx#L227-L239)
- [packages/app/src/pages/session/terminal-panel.tsx · 278–319](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/pages/session/terminal-panel.tsx#L278-L319)
- [packages/app/src/components/background-activity.tsx · 175–181](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/components/background-activity.tsx#L175-L181)

</details>

## 06 · 0.18.5 详细改动与验收

### UX-13 · Soul 从创建到编辑、试用和复用形成完整流程

*0.18.5 · 主动发现 · 范围 L*

- **当前阻力**：GUI 已有创建、搜索、头像编辑与设置默认，但正文只读，改正文依赖本地打开源文件；创建表单是局部 store，关闭时不保草稿。当前头像可显示姓名，却没有资料与复用入口。后端已有以 soul_body_hash 固定正文的版本机制，旧会话或失效快照仍有回退路径。
- **具体改动**：补创建草稿恢复、从现有 Soul 复制、字段/Markdown 编辑与预览，保存后可“立即用它新建”。当前会话头像打开资料，区分本会话绑定版本和阵容最新版，提供“以此 Soul 开始另一任务”。修改保存供新会话使用，现有会话版本语义保持明确。
- **使用收益**：管理自己的 Soul 不必跳出工具编辑文件，创建完成即可开始使用，也能知道这场对话采用哪版设定。

#### 验收场景

- 写到一半关设置再打开可恢复；保存失败保留草稿，成功选中新条目。
- 复制生成独立 ID，原 Soul 不被覆盖；正文编辑与头像偏好区分。
- 有有效快照的会话保持旧版正文，编辑后新会话使用新版；旧会话无快照时明确展示内容来源，不把注册表最新版冒充历史绑定内容。

> 正文编辑需要补写入接口与版本处理，不能仅加前端保存按钮；分阶段先交付草稿/复制/创建后开始。

<details>
<summary>固定提交的源码定位</summary>

- [packages/app/src/components/settings-personalization.tsx · 144–151](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/components/settings-personalization.tsx#L144-L151)
- [packages/app/src/components/settings-personalization.tsx · 357–382](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/components/settings-personalization.tsx#L357-L382)
- [packages/app/src/components/settings-personalization.tsx · 430–474](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/components/settings-personalization.tsx#L430-L474)
- [packages/app/src/components/soul-avatar.tsx · 7–42](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/components/soul-avatar.tsx#L7-L42)
- [packages/opencode/src/session/soul.ts · 82–138](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/opencode/src/session/soul.ts#L82-L138)

</details>

### UX-14 · Agent 选择说清用途，也说清模型会怎样变化

*0.18.5 · 主动发现 · 范围 M*

- **当前阻力**：GUI Agent 选择器主要显示名字。local.agent.set 会把 Agent 配置中的 model/variant 一并应用，用户可能只想换工作方式，却同时改变模型和推理强度。
- **具体改动**：选择行展示简短用途、权限/工具范围摘要和绑定模型/推理档；选择前可看见将发生的联动，提供明确的“跟随 Agent 配置 / 保留当前模型”选择。使用已有配置与能力信息生成说明，不硬编码承诺。
- **使用收益**：选 Agent 时能判断它适合做什么，避免只凭名字猜测和切完再回头调模型。

#### 验收场景

- 从 A 切到带绑定模型的 B，变化提前可见，选定行为与实际提交一致。
- 保留当前模型时推理档的适配规则清楚；没有兼容档时展示默认而不是留下旧标签。
- GUI/TUI 的同一 Agent、模型、强度组合语义一致。

<details>
<summary>固定提交的源码定位</summary>

- [packages/app/src/components/prompt-input.tsx · 1396–1433](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/components/prompt-input.tsx#L1396-L1433)
- [packages/app/src/context/local.tsx · 209–240](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/context/local.tsx#L209-L240)

</details>

### UX-15 · 能搜索旧对话正文、错误和工具结果

*0.18.5 · 主动发现 · 范围 L*

- **当前阻力**：已有全日志轮次大纲、标题搜索和旧轮次跳转；缺面向用户的正文查找入口。后端 session_query 已能有界扫描历史正文与已结束工具输入/输出/错误，但尚未接成已检查的 GUI/HTTP 搜索流程，也不是已建好的索引式搜索引擎。
- **具体改动**：提供“查找本会话”，按需扩至本项目；结果带命中片段、轮次/时间、正文或工具类型。点击加载对应旧消息、展开工具并高亮命中，返回结果保留位置。抽取现有证据读取逻辑并补只读接口、取消和游标。
- **使用收益**：只记得一个报错、路径或承诺时，也能找回原文；不必逐轮翻大纲。

#### 验收场景

- 800 轮样本中第 20 轮工具错误的唯一字符串能被找到并定位到具体 part。
- 扫描预算未覆盖全范围时提示继续搜索，不把空一页说成全部无结果。
- 搜索只覆盖已保存内容；切查询/取消停止旧工作，不把全部历史灌进 renderer。

> 这是可独立构成升版亮点的功能；800 轮是建议验收数据，不是本次性能实测。

<details>
<summary>固定提交的源码定位</summary>

- [packages/app/src/pages/session/turn-outline.tsx · 101–177](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/pages/session/turn-outline.tsx#L101-L177)
- [packages/opencode/src/session/session.ts · 1588–1596](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/opencode/src/session/session.ts#L1588-L1596)
- [packages/opencode/src/tool/session-query.ts · 55–110](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/opencode/src/tool/session-query.ts#L55-L110)
- [packages/opencode/src/tool/session-query.ts · 112–208](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/opencode/src/tool/session-query.ts#L112-L208)

</details>

### UX-16 · Diff 可以连续审完一批改动

*0.18.5 · 主动发现 · 范围 M*

- **当前阻力**：现有 Diff 已支持已审标记、内容指纹、进度、前后文件、评论和滚动记忆；下一文件仍遍历全部文件，标记已审与前往下一项分开。
- **具体改动**：增加“全部/未审阅”“标记并下一个”及快捷键；跳到下一待审文件并展开。末项完成后给出本批完成状态，文件再次变化时按已有指纹重新进入待审。
- **使用收益**：一批改动顺着看完，减少重复点选和漏看；不需要靠记忆辨认哪些文件已经看过。

#### 验收场景

- 20 文件中 18 个已审，筛选后直接看到余下 2 个；一次操作完成标记和下一项定位。
- 最后一项完成后可回全部；新修改重新出现为待审。
- 评论和当前 hunk 不因更新无故跳位；“已审”只代表人工阅读，不冒充测试通过或已暂存。

<details>
<summary>固定提交的源码定位</summary>

- [packages/ui/src/components/session-review.tsx · 217–229](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/ui/src/components/session-review.tsx#L217-L229)
- [packages/ui/src/components/session-review.tsx · 369–417](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/ui/src/components/session-review.tsx#L369-L417)
- [packages/ui/src/components/session-review.tsx · 560–580](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/ui/src/components/session-review.tsx#L560-L580)
- [packages/app/src/pages/session/review-progress.ts · 1–36](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/pages/session/review-progress.ts#L1-L36)

</details>

### UX-17 · 后台工作结束后，结果能看、能引用、能继续

*0.18.5 · 主动发现 · 范围 M–L*

- **当前阻力**：后台中心已有列表、搜索、停止和任务跳转，也已有完成通知；缺专门的待查看结果分组与按需结果详情。task_status 走通用 Markdown 卡，缺整份任务结果复制、引用回当前草稿与清楚的父子入口。后台列表有意只返回元数据。
- **具体改动**：增加“运行中/待查看结果”，任务点开结构化摘要和可展开结果；提供复制、引用到当前草稿、子会话、父任务入口。引用保留来源但不自动发送；结果正文按需加载，保留列表轻量轮询。
- **使用收益**：后台任务完成后可以顺手收回成果，用在当前工作里，不止看到一个完成状态。

#### 验收场景

- 3 个后台任务结束，入口显示未看结果；看过或手动标记后数量减少。
- 最多两步把选定结果引用到当前草稿，保留任务来源和原草稿内容，不自动提交。
- 长输出标明分页/截断与完整来源；列表刷新不反复下载多 MB 输出。

> 不能写成“后台没有反馈”或“结果只用 pre”：现有任务跳转、通知和 Markdown 展示都应复用。

<details>
<summary>固定提交的源码定位</summary>

- [packages/app/src/components/background-activity.tsx · 76–115](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/components/background-activity.tsx#L76-L115)
- [packages/app/src/components/background-activity.tsx · 171–219](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/components/background-activity.tsx#L171-L219)
- [packages/ui/src/components/basic-tool.tsx · 324–400](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/ui/src/components/basic-tool.tsx#L324-L400)
- [packages/ui/src/components/message-part.tsx · 2158–2237](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/ui/src/components/message-part.tsx#L2158-L2237)
- [packages/opencode/src/tool/task_status.ts · 40–55](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/opencode/src/tool/task_status.ts#L40-L55)

</details>

### UX-18 · 看一眼文件后，能回到刚才那条证据

*0.18.5 · 主动发现 · 范围 M*

- **当前阻力**：从 Diff 或工具打开文件的路径先加载，再开 tab；只传文件路径，没有来源 message/part/hunk。现有后退历史只记 route，同会话内的文件跳转不在其中；每个文件本身的滚动记忆已经存在。
- **具体改动**：点文件立即出现目标标签与读取状态；一次性浏览使用可替换预览 tab，固定后常驻。提供“返回刚才的修改/工具输出”，保留来源与焦点；普通打开方式继续可用。
- **使用收益**：查证源码之后继续原阅读位置，连看多个文件也不会留下大量必须关闭的标签。

#### 验收场景

- 人为延迟读取 1 秒，点击后下一次绘制即可看到目标与读取状态；这验证反馈时机，不宣称读取提速。
- 从第 4 个 Diff 的某 hunk 看源码，一次返回同一处；工具输出来源同样成立。
- 连看 5 文件只替换预览位，被固定的文件不会覆盖。

<details>
<summary>固定提交的源码定位</summary>

- [packages/app/src/pages/session/helpers.ts · 10–49](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/pages/session/helpers.ts#L10-L49)
- [packages/app/src/pages/session.tsx · 897–915](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/pages/session.tsx#L897-L915)
- [packages/app/src/components/titlebar-history.ts · 11–25](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/components/titlebar-history.ts#L11-L25)
- [packages/app/src/pages/session/file-tabs.tsx · 57–160](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/pages/session/file-tabs.tsx#L57-L160)

</details>

### UX-19 · 大仓库里先看到能用的界面，再按需加载重内容

*0.18.5 · 主动发现 · 范围 L*

- **当前阻力**：本地命令/@候选已立即显示，但远程文件查询仍随输入驱动扫描且无取消信号；Diff 获取仍批量拉较完整 patch。后台任务有完成项回收，但缺统一排队/并发与输出字节预算。
- **具体改动**：远程文件搜索合并短间隔输入、取消过期查询，保留本地即时结果和新文件可发现性。先出改动文件清单，patch 按选中/可见文件加载并用指纹缓存。后台任务按工作区和全局配额排队，前台交互优先，长输出按需获取。
- **使用收益**：输入、选择文件、停止任务持续响应；大批改动可以先浏览，不必等整批正文。

#### 验收场景

- 固定机器上使用 10 万路径、500 变更文件、30 后台任务等样本，分别记录输入到候选、列表首现、打开首个 patch 和取消完成时间。
- 同一录制脚本比较冷/热缓存的中位数与 p95；无基线前不承诺提升比例。
- 新文件能及时搜到，取消的排队任务不启动，失败/部分加载/无改动明确区分。

> 远程查询 120–180ms 的尾随窗口只适合作为待调试起点；不是当前实测，也不能用于延迟已有本地候选。

<details>
<summary>固定提交的源码定位</summary>

- [packages/app/src/components/prompt-input.tsx · 700–726](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/components/prompt-input.tsx#L700-L726)
- [packages/app/src/context/file.tsx · 254–258](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/context/file.tsx#L254-L258)
- [packages/opencode/src/file/index.ts · 398–432](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/opencode/src/file/index.ts#L398-L432)
- [packages/app/src/pages/session.tsx · 420–458](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/pages/session.tsx#L420-L458)
- [packages/opencode/src/project/vcs.ts · 98–153](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/opencode/src/project/vcs.ts#L98-L153)
- [packages/opencode/src/background/job.ts · 183–224](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/opencode/src/background/job.ts#L183-L224)

</details>

### UX-20 · 外观设置里直接看清消息、代码和终端效果

*0.18.5 · 主动发现 · 范围 M*

- **当前阻力**：当前已有主题/颜色悬停预览、声音试听、字体名预览和壁纸缩略图；但调整字体、字号和遮罩时，设置内缺完整的真实内容阅读样例。
- **具体改动**：在外观区提供消息/代码/终端三种紧凑样例，使用与主界面相同的 token、行高和背景规则；调整即时反映，并能局部撤销本次外观变更。窄窗口样例置于控件下方，宽时并排。
- **使用收益**：不用反复关闭设置去看效果，能当场判断中文、代码、终端与壁纸的可读性。

#### 验收场景

- 14px/18px 的中文消息与代码差异可当场比较；终端字体只影响对应样例。
- 壁纸遮罩改变后能立即判断对比度；撤销不影响其他分区配置。
- 样例与实际页面用同一套样式来源，保留已有 hover 预览和试听。

<details>
<summary>固定提交的源码定位</summary>

- [packages/app/src/components/settings-general.tsx · 496–538](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/components/settings-general.tsx#L496-L538)
- [packages/app/src/components/settings-general.tsx · 545–715](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/components/settings-general.tsx#L545-L715)
- [packages/app/src/context/settings.tsx · 280–293](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/context/settings.tsx#L280-L293)

</details>

## 07 · 工程规范服务于这些体验

“工厂规范”在这里落到创建入口、配置操作、共享状态和发行产物。优先把相同业务含义放在一个明确位置，再让 GUI/TUI 各自呈现；不要求全仓引入新的 Factory 类或并行运行时。

| 规范 | 具体改动 | 用户得到的结果 |
| --- | --- | --- |
| 统一会话开始参数 | Soul、目标目录、Agent、模型、推理档在提交前解析成同一份创建快照；客户端默认、本次覆盖、服务端默认有明确定义。 | 首页选了什么，会话实际用什么；GUI/TUI 不再出现入口与能力脱节。 |
| 统一设置描述与生效语义 | 设置项有稳定 ID、分区、搜索词、作用域和重置语义；set/reset/inherit 先形成操作，再序列化到 json/jsonc；保存后读回实际生效值与来源。 | 设置搜得到、跳得准、清空确实能清空；不会提示保存后仍用旧值。 |
| 统一 UI 基础约定 | 设置尺寸、容器断点、字体 token、子页返回、焦点恢复、展开编辑使用少量共享原语；小选择器与确认框保持原形态。 | 字号、窗口大小与返回方式一致；新增入口不会挤坏布局。 |
| 共享状态投影 | 任务进度、待授权、MCP deferred、更新失败等以明确类型传到界面；GUI/TUI 共用纯业务投影，展示层保留各自交互。 | 失败不会被翻译成成功；相同任务在两端的数量和状态相同。 |
| 性能与资源所有者 | 缓存键包含 server/workspace/file；异步操作能取消或补读；前台操作优先，后台任务有配额与输出预算；沿用现有 Effect Service/Layer 生命周期。 | 多项目同名文件不会互相删账，后台负载不持续挤占输入与停止操作。 |
| 发行与内置资源 | 渠道/appId/协议/更新源来自同一发行定义；Windows 安装形式与更新机制匹配；seed 资源带版本清单，更新先暂存校验再切换，保留用户修改。 | 新机能直接使用默认资源；老用户升级不丢自定义配置和脚本。 |

现有问题与源码证据见附录 ENG-01～ENG-11、PF-04/PF-10。工程项按体验包依赖带入，避免用单纯的抽象重构或新增 CI 数量作为升版卖点。

## 08 · 随主线交付的可靠性修复

下面几组直接保护用户输入、授权和已看到的数据，应并入相应体验包。完整证据保留在附录，其余风险按触达频率与真实复现排期。

| 配套修复 | 已核实的行为 | 交付结果 |
| --- | --- | --- |
| 提交与快捷键 | 真实提交函数复核：发送 A、编辑 B、A 晚失败后，重试实际发送 B。提问/权限快捷键的真实处理函数还存在一次事件触发两处动作。 | 重试绑定失败操作并保留 B；键盘作用域只执行当前意图。参见 RX-01、UI-02。 |
| 流式显示 | 真实排序入口与 reducer 复核：reasoning 优先排序破坏按 ID 二分查找前提，导致 delta 未追加、updated 重复、removed 未移除。 | 唯一存储顺序与展示顺序分离；更新、删除、增量三条都正确。参见 PF-01。 |
| 工作区实时变化 | tree-store 在请求未完成时收到 force 只合并原 Promise，旧结果回来后无尾随重读；缓存同名 key 的所有权也不够明确。 | 修改后能看到最终状态，失败与旧内容明确；释放只针对自己的缓存。参见 PF-03/04/06。 |
| 设置与更新反馈 | 配置写入目标和读取层、清空字段的 merge 语义有不一致；更新失败字段未传到 UI，可能显示最新版。 | 保存有实际效果，错误有恢复路径；检查更新失败与没有新版分开。参见 ENG-01～04。 |
| 会话找回 | 归档在限量后过滤可漏掉旧归档；仅时间戳游标在同时间多条记录时漏页，隔离 SQLite 已复核。 | 服务端先筛选再限量，完整(time,id)游标；首页交互扩展时一起接正确分页。参见 PF-05/09。 |

## 09 · 用任务完成情况验收版本

以下是建议的实际体验验收计划，不是本次已执行结果。每条保存一段可复看的操作录屏，并记录版本、窗口、缩放和数据量；针对问题补最小自动化回归，自动化为这些路径服务。

| 实际任务 | 样本条件 | 通过时应看到什么 |
| --- | --- | --- |
| 选伙伴开始工作 | 5/30 个 Soul；新会话已有多段草稿与附件 | 首页选 Soul 后直接发送，绑定与选择一致；无需进设置；输入不丢。 |
| 管理 Soul 阵容 | 1366×768、1920×1080；14/18/20px 字号 | 打开先见阵容，创建默认收起；窗口可调；卡片到详情无需再寻找。 |
| 连续修改设置 | 20 个 MCP 或多服务商；列表中间位置 | 保存一个回原列表继续下一个；搜索直接定位；焦点和位置保持。 |
| 写长需求并换模型 | 30 行中文/代码混合提示，多个附件和 @引用 | 展开编辑清晰；模型常用项在前；切换和收起保住草稿、光标与附件。 |
| 多任务并行 | 12/20 会话、不同项目、后台任务运行 | 任意会话可找回，后台标签关闭不抢当前；首页返回仍是原筛选。 |
| 选择工作树 | 主目录与两个已有 worktree，再创建一个新目录 | 显示目标、session.create 的目录与最终路由一致。 |
| 追一条旧错误 | 800 轮，其中窗口外旧工具含唯一文本 | 全文搜索能跳到具体工具片段，高亮命中，回结果列表不丢位置。 |
| 完成审阅 | 20 文件，18 已审，评论中间 hunk，期间有新增修改 | 直接审剩余两项，标记并下一项；重新改动回待审，来源跳转可返回。 |
| 回收后台成果 | 3 个任务完成，另有现存 PTY | 未看结果可找到，引用进当前草稿且不自动发送；点击终端聚焦原 PTY。 |
| 大数据与低速响应 | 10 万路径、500 文件改动、30 后台任务；人为注入文件响应延迟 | 先可导航与可输入；逐项加载；取消能终止过期工作，错误不冒充空数据。 |
| 安装与升级 | 干净 Windows 用户目录；旧版配置有自定义修改 | 内置资源齐全，更新状态真实，用户修改保留，失败可回到可用状态。 |

性能记录分开看输入到候选、清单首现、首个 patch、取消完成、稳态内存；分别记录冷/热缓存中位数和 p95。客户端读取、布局与网络/模型耗时分开，避免把模型速度当成 UI 性能。

## 10 · 先收编 dev 已有工作，不重复立项

从 0.18.3 bump [eb336e5](https://github.com/JiaHuiRed/RedCode/commit/eb336e5) 到本次固定 HEAD，已核对 **26 个提交、60 个文件变更（+3404/−130）**。当前版本仍为 0.18.3，这段范围未改 CHANGELOG。发布说明应把既有未发布改动与本报告待实施项分开。

- 已落地：朱印主题与阅读样式、TUI 侧栏上下文/额度、重连状态/授权快照、可用压缩摘要约束、frontmatter YAML 边界、继续执行资格与换日注入、保守的套话展示过滤。

- 消息树 Phase 1–2 已保存并读取旧分支基础数据；用户可切换的版本选择器属于后续 Phase 3，不能说已完整交付。

- 继续复用：时间线/模型列表虚拟化、设置懒加载与分区记忆、文件预览上限、工作区缓存、Diff 已审指纹、轮次大纲、后台任务持久化和回收、终端拖拽/改名、主题预览与声音试听。

版本核对来源：本地固定提交 git log / git diff；既有实现另见固定 SHA 的各项源码及附录。没有执行全仓测试或用测试数量衡量升版价值。

## 11 · 可选扩展，独立评估范围

以下两项已有底座，可以在需要更鲜明功能亮点时考虑，但不应挤掉上述每天都会触达的体验工作。终端并排、长期任务置顶也可放在此级别。

#### EX-01 · 消息树Phase3：用户可切换旧回答与旧分支

*P2 · 工作量 L · 已有底座上的产品补完*

- **当前状态**：Phase1–2已保留旧分支数据，编辑重发/再生成后不再物理丢掉整段旧问答，但用户版本切换器尚未落地，旧分支暂不可达。
- **建议改动**：GUI/TUI提供版本数量、前后切换、返回当前分支和清晰的分支入口；区分切换对话视图与恢复工作区文件，说明当前会话的文件状态策略。压缩边界、分页、导出范围随分支一致。
- **数据口径**：当前projector对detached不删行，但仍回冲该分支cost/tokens。界面应区分当前分支用量与累计实际消耗，避免把隐藏分支理解成没有发生费用；逐个核对消费界面后再定显示方式。
- **体验验收**：同一问题生成3版、编辑首条问题、分支A压缩后切B、切回旧分支与用户另改文件的场景，消息/分页/文件策略一致，累计消耗口径清楚。

**固定SHA依据**
- [docs/notes/proposed/feature/2026-11-14-message-tree-branching.md:297-330](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/docs/notes/proposed/feature/2026-11-14-message-tree-branching.md#L297-L330)
- [packages/opencode/src/session/projectors.ts:162-183](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/opencode/src/session/projectors.ts#L162-L183)
- [packages/opencode/src/session/message-tree.ts:1-175](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/opencode/src/session/message-tree.ts#L1-L175)

#### EX-02 · 将已有CLI导入导出升级为可携带归档

*P2 · 工作量 L · 产品补完*

- **当前状态**：仓库已有CLI export/import；新增归档提案不能被转述成“完全没有导入导出”。缺口是GUI入口、附件、manifest版本、分支选择与完整恢复报告。
- **建议改动**：会话选择与导出范围预览，带版本manifest和文件清单；导入先校验再事务提交，ID重映射、缺失附件明示；保留既有权限配置边界，不把原机器凭据和审批状态带入新环境。
- **体验验收**：跨机器选择若干会话导出→导入→重新打开；含图片、已被回收附件、压缩长会话和多分支。损坏/不兼容包给明确报告，不污染现有会话。

**固定SHA依据**
- [packages/opencode/src/cli/cmd/export.ts](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/opencode/src/cli/cmd/export.ts)
- [packages/opencode/src/cli/cmd/import.ts](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/opencode/src/cli/cmd/import.ts)
- [docs/notes/proposed/feature/2026-11-14-session-archive-export-import.md](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/docs/notes/proposed/feature/2026-11-14-session-archive-export-import.md)

## 12 · 工程证据附录：34 条候选项

这些保留前轮查出的交互、数据链和交付证据。多项已被 UX 主线吸收；附录移除了旧版 18/16 的分配标签，避免继续用旧排序盖过体验优先级。点击条目可查看场景、修复范围、验收和固定源码链接。

<details>
<summary>UI-01 · 关闭后台标签时保持当前工作现场</summary>

#### UI-01 · 关闭后台标签时保持当前工作现场

*P1 · 工作量 S · 源码确认*

- **用户场景**：打开 A/B/C，当前在 A 阅读或编辑，关闭后台 C，却跳到相邻标签。整理后台会话会打断当前工作。
- **当前证据**：removeTab 删除任意 href 后都会 navigate 到邻项，没有先判断被关闭项是否为活动标签；两组关闭按钮共用这个入口。
- **建议改动**：后台标签只移除；活动标签关闭才选择邻项。当前项目、焦点、输入草稿、选区和滚动位置保持不变。
- **体验验收**：当前 A 时分别关闭 B/C，URL与草稿/滚动不变；关闭活动标签落到合理邻项；最后一页关闭后回首页。

**固定 SHA 源码依据**
- [packages/app/src/components/titlebar.tsx:209-219](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/components/titlebar.tsx#L209-L219)
- [packages/app/src/components/titlebar.tsx:370-382](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/components/titlebar.tsx#L370-L382)
- [packages/app/src/components/titlebar.tsx:461-497](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/components/titlebar.tsx#L461-L497)

</details>

<details>
<summary>UI-02 · 提问、权限与输入快捷键只触发一个预期动作</summary>

#### UI-02 · 提问、权限与输入快捷键只触发一个预期动作

*P1 · 工作量 M · 函数级复核*

- **用户场景**：不同子代理同时在等答案和权限；用户在答案框按 Ctrl+Enter，或在输入框按 Ctrl+Shift+Enter。当前同一次按键可能同时提交答案与批准权限，或者批准权限并向草稿插入换行。
- **当前证据**：提问与权限可同时挂载；提问处理只 preventDefault，权限 window 监听不核对事件来源/已消费状态。真实源处理函数隔离执行确认三例：question Ctrl+Enter 同时 next+permission.once；Escape 同时两个 reject；prompt Ctrl+Shift+Enter 同时换行+permission.always。
- **建议改动**：建立焦点与请求作用域的消费顺序。普通换行排除 Ctrl/Meta；保留输入框 Ctrl+Enter 有意交给权限的行为，不能粗暴地给权限加一个 defaultPrevented 早退。
- **体验验收**：双请求共存、编辑器聚焦、中文输入法组合态逐一验：每个动作仅作用于明确目标；Ctrl+Shift+Enter 不改草稿；允许一次快捷键仍可用。

**固定 SHA 源码依据**
- [packages/app/src/pages/session/composer/session-composer-region.tsx:176-197](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/pages/session/composer/session-composer-region.tsx#L176-L197)
- [packages/app/src/pages/session/composer/session-request-tree.ts:36-51](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/pages/session/composer/session-request-tree.ts#L36-L51)
- [packages/app/src/pages/session/composer/session-question-dock.tsx:317-334](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/pages/session/composer/session-question-dock.tsx#L317-L334)
- [packages/app/src/pages/session/composer/session-permission-dock.tsx:26-43](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/pages/session/composer/session-permission-dock.tsx#L26-L43)
- [packages/app/src/components/prompt-input.tsx:1262-1277](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/components/prompt-input.tsx#L1262-L1277)

</details>

<details>
<summary>UI-03 · 布局预设高亮与实际面板状态一致</summary>

#### UI-03 · 布局预设高亮与实际面板状态一致

*P1 · 工作量 M · 源码确认*

- **用户场景**：A会话选专注，再切先前选过开发的B，高亮可能显示开发，面板却沿用A；手动开关面板后仍宣称原预设。
- **当前证据**：文件树/审查开关是全局状态，applyPreset又写会话级名称；按钮按会话名称高亮，没有手动调整后的custom状态。11月10日审查A3已记录，目前仍存在。
- **建议改动**：本版至少让高亮由实际布局推导，手动调整进入自定义。完整方向是会话级可见性/工作台模式，新会话继承默认；完整会话恢复随体验主线另排，不重复增加主线计数。
- **体验验收**：专注→开发→审查跨会话往返、重启及手动调整后，名称与面板一致；现有宽度、滚动和浮窗约束不回退。

**固定 SHA 源码依据**
- [packages/app/src/context/layout.tsx:724-856](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/context/layout.tsx#L724-L856)
- [packages/app/src/components/session-layout-preset.tsx:41-46](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/components/session-layout-preset.tsx#L41-L46)
- [docs/2026-11-10-audit-remediation-progress.md:81-105](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/docs/2026-11-10-audit-remediation-progress.md#L81-L105)

</details>

<details>
<summary>UI-04 · 子代理停止动作有进行中与失败反馈</summary>

#### UI-04 · 子代理停止动作有进行中与失败反馈

*P1 · 工作量 S · 源码确认*

- **用户场景**：断连或服务端失败时点击子代理停止，没有可见结果，用户不知道是否生效并反复点击。
- **当前证据**：stopChild 的 abort 调用 catch 空吞；停止按钮没有 pending、disabled或错误反馈。
- **建议改动**：增加停止中、失败摘要与就地重试；只有服务端状态确认后显示停止，保留子会话现场。
- **体验验收**：正常停止、HTTP失败、断连、快速连点都有明确状态；同一任务不产生重复停止请求，不伪造“已停止”。

**固定 SHA 源码依据**
- [packages/app/src/pages/session/composer/session-composer-region.tsx:147-153](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/pages/session/composer/session-composer-region.tsx#L147-L153)
- [packages/app/src/pages/session/composer/session-composer-region.tsx:308-315](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/pages/session/composer/session-composer-region.tsx#L308-L315)

</details>

<details>
<summary>UI-05 · 字号设置覆盖输入框与高频控件</summary>

#### UI-05 · 字号设置覆盖输入框与高频控件

*P2 · 工作量 M · 源码确认*

- **用户场景**：用户把字体14调到20，消息正文变大，输入、placeholder与标签仍小，阅读与操作比例失衡。
- **当前证据**：设置只更新font-size变量；输入正文/placeholder固定14px、21px行高，工作树14px，部分标题栏按钮11px、标签13px和壁纸数字11px。
- **建议改动**：接入现有字号token，行高/控件高度随内容变化；优先输入、标签、模型与发送周边，不引入第二套字号体系。
- **体验验收**：12/14/18/20四档，中英文与中文长模型名均可读；输入/placeholder/标签一起缩放，无裁切、重叠。

**固定 SHA 源码依据**
- [packages/app/src/context/settings.tsx:283-293](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/context/settings.tsx#L283-L293)
- [packages/app/src/components/prompt-input.tsx:1698-1749](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/components/prompt-input.tsx#L1698-L1749)
- [packages/app/src/components/titlebar.tsx:435-525](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/components/titlebar.tsx#L435-L525)
- [packages/app/src/components/settings-general.tsx:713](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/components/settings-general.tsx#L713)

</details>

<details>
<summary>UI-06 · 会话标签溢出后仍可找到并操作</summary>

#### UI-06 · 会话标签溢出后仍可找到并操作

*P2 · 工作量 M · 布局风险待实测*

- **用户场景**：1280/1366窗口打开10个以上标签，后面的会话可能被裁切；快捷键切过去后，当前标签不可见。
- **当前证据**：标签无限追加；外层overflow-hidden，每个tab min-w-24；未见滚动、溢出菜单或活动标签自动露出的对应逻辑。实际碰撞范围未在浏览器测量。
- **建议改动**：水平滚动、活动标签ensure-visible和全部会话菜单；固定操作区保留；关闭后稳定可见锚点。
- **体验验收**：6/12/20标签，1366/1920窗口与125%系统缩放：活动项始终可见，所有标签可切换/关闭，菜单键盘可操作。

**固定 SHA 源码依据**
- [packages/app/src/components/titlebar.tsx:195-205](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/components/titlebar.tsx#L195-L205)
- [packages/app/src/components/titlebar.tsx:370-371](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/components/titlebar.tsx#L370-L371)
- [packages/app/src/components/titlebar.tsx:450-497](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/components/titlebar.tsx#L450-L497)

</details>

<details>
<summary>UI-07 · 输入工具栏按实际聊天列宽度分层</summary>

#### UI-07 · 输入工具栏按实际聊天列宽度分层

*P2 · 工作量 M · 布局风险待实测*

- **用户场景**：开发布局打开两侧面板，长模型/agent名称加运行中的排队、打断等按钮，聊天列可用宽度被挤压。
- **当前证据**：46px单行同时摆放附件、工作树、agent/model、context、background、投递方式、打断和发送；不同项虽有最大宽度，未按容器建立断点/溢出层。是否重叠须测实际矩形。
- **建议改动**：以容器宽度安排主/次操作。发送、停止保持固定空间；模型可缩略，低频项进更多菜单，同时保留当前状态和键盘入口。
- **体验验收**：1366×768双侧面板、字号20、长名称、运行/排队/打断全态，发送/停止始终可见可点，工具栏不遮输入。

**固定 SHA 源码依据**
- [packages/app/src/components/prompt-input.tsx:1713-1807](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/components/prompt-input.tsx#L1713-L1807)

</details>

<details>
<summary>UI-08 · 文件树加载失败可以原位重试</summary>

#### UI-08 · 文件树加载失败可以原位重试

*P2 · 工作量 S · 源码确认*

- **用户场景**：首次读取目录失败后，用户缺少明确恢复入口；已有目录刷新失败时也可能失去原现场。
- **当前证据**：treeFailure只显示通用“读取目录失败”，没有重试按钮；文件上下文已经提供refresh接口。
- **建议改动**：接入现有file.tree.refresh，显示短原因、可展开详情和重试中。已有内容时保留内容并标过期。
- **体验验收**：断网失败→恢复网络→原位重试成功；已加载的树刷新失败时仍可查看，不必关闭窗口或重开项目。

**固定 SHA 源码依据**
- [packages/app/src/pages/session/file-tree-panel.tsx:160-164](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/pages/session/file-tree-panel.tsx#L160-L164)
- [packages/app/src/pages/session/file-tree-panel.tsx:225-245](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/pages/session/file-tree-panel.tsx#L225-L245)
- [packages/app/src/context/file.tsx:315-316](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/context/file.tsx#L315-L316)

</details>

<details>
<summary>UI-09 · 长错误可展开、复制，并引向有效恢复</summary>

#### UI-09 · 长错误可展开、复制，并引向有效恢复

*P2 · 工作量 S · 源码确认*

- **用户场景**：供应商返回较长错误，关键原因在第四行以后；用户只能反复重试，却看不全配置或额度原因。
- **当前证据**：PromptErrorBanner对唯一错误文本line-clamp-3，只提供重试和关闭，无完整详情和复制。
- **建议改动**：短摘要+详情+复制，沿用已有诊断脱敏；网络错误提供重试，配置错误能直达模型设置。重试对象绑定由RX-01先解决。
- **体验验收**：长错误关键信息可查看和复制；复制内容完整；恢复不丢草稿/附件，配置错误不只引导无效重试。

**固定 SHA 源码依据**
- [packages/app/src/components/prompt-input.tsx:1816-1844](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/components/prompt-input.tsx#L1816-L1844)

</details>

<details>
<summary>UI-10 · 状态台从计数连到具体操作</summary>

#### UI-10 · 状态台从计数连到具体操作

*P2 · 工作量 M · 产品补完*

- **用户场景**：看见失败数或当前工具名后，用户仍需在长会话里手找源头；任务完成后状态台消失，缺少收尾入口。
- **当前证据**：状态台idle后隐藏，目标、失败数、子代理数为纯展示span。当前回合真实计数已经实现，应沿用。
- **建议改动**：失败跳对应调用，文件打开内容或diff，子代理数开任务列表；完成后保留可关闭的短摘要。虚拟卸载目标应先加载再定位。
- **体验验收**：从失败计数一次操作到源头；父子归属正确；目标在已卸载区域仍可定位；完成摘要可关闭，不长期占屏。

**固定 SHA 源码依据**
- [packages/app/src/pages/session/composer/session-activity-hud.tsx:50-89](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/pages/session/composer/session-activity-hud.tsx#L50-L89)

</details>

<details>
<summary>UI-11 · Diff审查有未审筛选与收尾汇总</summary>

#### UI-11 · Diff审查有未审筛选与收尾汇总

*P2 · 工作量 M · 产品补完*

- **用户场景**：20个变更已审18个，用户仍要逐个找剩余两个；看完后没有明确的本轮审查收尾。
- **当前证据**：已有patch指纹、已审标记、计数与前后导航；尚缺仅未审筛选、下一未审和完成汇总。
- **建议改动**：复用指纹，新增未审筛选/下一未审/修改后需重审提醒与汇总；“看过”只表示阅读确认，不代表通过验证或已暂存。
- **体验验收**：20项标18项后直接定位剩余两项；已审内容改动后重回未审；筛选、折叠、连续导航不丢定位。

**固定 SHA 源码依据**
- [packages/ui/src/components/session-review.tsx:119-124](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/ui/src/components/session-review.tsx#L119-L124)
- [packages/ui/src/components/session-review.tsx:217-228](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/ui/src/components/session-review.tsx#L217-L228)
- [packages/ui/src/components/session-review.tsx:373-417](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/ui/src/components/session-review.tsx#L373-L417)

</details>

<details>
<summary>UI-12 · 标签显示完成未读、失败与待确认</summary>

#### UI-12 · 标签显示完成未读、失败与待确认

*P2 · 工作量 M · 产品补完*

- **用户场景**：前台A工作时，后台B完成、失败或等授权，顶栏缺少足够的状态帮助用户决定何时切回。
- **当前证据**：标签目前主要读session_status并显示busy/retry；通知上下文已有按session/project索引的unseenCount/unseenHasError。
- **建议改动**：复用事件与未读索引，加完成未读、失败未读、待权限/回答标记和文字提示；不新增轮询，明确子代理事件归属。
- **体验验收**：A前台/B后台分别完成、失败、等授权，一眼能区分并跳转；读过清未读，子代理不误标无关会话。

**固定 SHA 源码依据**
- [packages/app/src/components/titlebar-tabs.ts:6-28](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/components/titlebar-tabs.ts#L6-L28)
- [packages/app/src/components/titlebar.tsx:450-475](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/components/titlebar.tsx#L450-L475)
- [packages/app/src/context/notification.tsx:39-100](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/context/notification.tsx#L39-L100)

</details>

<details>
<summary>PF-01 · 分片排序与流式定位遵守同一契约</summary>

#### PF-01 · 分片排序与流式定位遵守同一契约

*P1 · 工作量 M · 函数级复核*

- **用户场景**：工具分片先到、reasoning后到，重连/补拉后继续流式更新，可能漏字、重复卡片或删除残留。
- **当前证据**：directory-sync把reasoning优先的语义序写入store；event-reducer仍按ID二分。真实入口与reducer执行得到：应为ab的raw仍a；更新后ID序列[01,02,01]；删除后仍保留两项。
- **建议改动**：store明确唯一排序契约，优先按ID存储、展示层单独排序；同时修updated、removed、delta整个家族。
- **体验验收**：工具先到/推理后到→HTTP补拉→delta→快照→删除、断线恢复，各ID唯一，内容与服务端完全一致。

**固定 SHA 源码依据**
- [packages/app/src/context/directory-sync.ts:39-43](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/context/directory-sync.ts#L39-L43)
- [packages/app/src/context/directory-sync.ts:453-456](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/context/directory-sync.ts#L453-L456)
- [packages/app/src/context/global-sync/event-reducer.ts:446-488](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/context/global-sync/event-reducer.ts#L446-L488)

</details>

<details>
<summary>PF-02 · 未跟踪文件统计跨运行时一致且有界</summary>

#### PF-02 · 未跟踪文件统计跨运行时一致且有界

*P1 · 工作量 M · 源码确认·运行时待测*

- **用户场景**：Electron中新增文件的行数可能显示0；Bun路径仅为了统计大文件角标也会先把完整字节读进内存。
- **当前证据**：Git.statUntracked直接Bun.file().arrayBuffer，错误被吞成undefined并在VCS变成0；Node sidecar构建target为node且入口无Bun shim。32MiB检查在完整读取之后。旧File.status也有全文读取计数，但未确认当前主GUI消费它。
- **建议改动**：共享Node/Bun兼容的有界流计数；读取前判大文件/二进制，返回未统计而非0；统一同族统计实现。
- **体验验收**：相同3行新文件GUI/TUI同值；64MiB与二进制新文件不为角标全量读正文；刚删除文件显示未知而非虚假零改动。

*注：实际Node sidecar验证因隔离依赖解析受阻；不把源码推导写成Windows实测。*

**固定 SHA 源码依据**
- [packages/opencode/src/git/index.ts:351-368](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/opencode/src/git/index.ts#L351-L368)
- [packages/opencode/src/project/vcs.ts:169-189](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/opencode/src/project/vcs.ts#L169-L189)
- [packages/opencode/script/build-node.ts:45-70](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/opencode/script/build-node.ts#L45-L70)
- [packages/opencode/src/node.ts:1-14](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/opencode/src/node.ts#L1-L14)
- [packages/opencode/src/file/index.ts:481-493](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/opencode/src/file/index.ts#L481-L493)

</details>

<details>
<summary>PF-03 · 在途刷新遇新变化，落地后补一次重读</summary>

#### PF-03 · 在途刷新遇新变化，落地后补一次重读

*P1 · 工作量 M · 函数级复核*

- **用户场景**：请求已经读到A但响应在途，磁盘又变B；第二次force刷新被合并进旧请求，最后界面停在A。
- **当前证据**：tree-store遇inflight直接join，结束只删除inflight，不记录dirty再刷；文件内容路径同形。真实tree-store复核：两次force共用Promise，requests=1，最终旧children。
- **建议改动**：按路径记录dirty generation，一波在途失效合并成一笔尾随重读；销毁后禁止旧响应回写，避免无谓取消昂贵diff。
- **体验验收**：网络节流下快速A→B、新建→删除，最终视图与磁盘一致；同波变化只补必要请求，不造成刷新风暴。

**固定 SHA 源码依据**
- [packages/app/src/context/file/tree-store.ts:47-55](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/context/file/tree-store.ts#L47-L55)
- [packages/app/src/context/file/tree-store.ts:127-132](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/context/file/tree-store.ts#L127-L132)
- [packages/app/src/context/file.tsx:215-248](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/context/file.tsx#L215-L248)
- [packages/app/src/context/file/watcher.ts:42-64](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/context/file/watcher.ts#L42-L64)

</details>

<details>
<summary>PF-04 · 跨工作区同名缓存按所有者记账</summary>

#### PF-04 · 跨工作区同名缓存按所有者记账

*P1 · 工作量 M · 函数级复核*

- **用户场景**：A和B项目都有src/index.ts。回收A后台快照时，会把当前B同名文件的LRU记账也删除。
- **当前证据**：相对路径作为模块级LRU key，snapshot回收同样按裸path删账。真实content-cache函数复核：当前9,000,000字节记账被旧snapshot移除降到0。
- **建议改动**：key包含server/workspace/canonical-path；前台LRU与后台snapshot各自预算或明确统一，但释放必须对应实际所有者。
- **体验验收**：五个同名文件项目往返，回收某项目不动另一项目；计账与持有对象对应，稳态内存另行测量。

*注：仅确认同名key误删另一工作区记账。前台与后台原本有独立预算，不能把8MB快照+9MB前台而LRU显示9MB说成内存超限；本次没有测Electron heap。*

**固定 SHA 源码依据**
- [packages/app/src/context/file/path.ts:121-154](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/context/file/path.ts#L121-L154)
- [packages/app/src/context/file.tsx:239](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/context/file.tsx#L239)
- [packages/app/src/context/file/content-cache.ts:6-24](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/context/file/content-cache.ts#L6-L24)
- [packages/app/src/context/file/workspace-cache.ts:20-24](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/context/file/workspace-cache.ts#L20-L24)
- [packages/app/src/context/file/workspace-cache.ts:53-58](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/context/file/workspace-cache.ts#L53-L58)

</details>

<details>
<summary>PF-05 · 归档列表服务端先筛选再限量</summary>

#### PF-05 · 归档列表服务端先筛选再限量

*P1 · 工作量 M · 源码确认*

- **用户场景**：最近64条都是活跃会话，更旧归档存在，点击归档列表却空白，让人误以为记录丢了。
- **当前证据**：首页请求archived:true、limit:64后在客户端过滤；后端archived:true表示包含归档，并不是只返回归档，因此限量已先截掉旧归档。
- **建议改动**：明确only/include/exclude语义，归档where先于limit；补分页和服务端查询，搜索不能只看已加载64条。
- **体验验收**：80活跃+20旧归档样本，归档首屏有记录，能搜到旧记录；归档/恢复后即时正确。

**固定 SHA 源码依据**
- [packages/app/src/pages/home.tsx:40](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/pages/home.tsx#L40)
- [packages/app/src/pages/home.tsx:139-145](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/pages/home.tsx#L139-L145)
- [packages/opencode/src/session/session.ts:1588-1608](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/opencode/src/session/session.ts#L1588-L1608)

</details>

<details>
<summary>PF-06 · Diff失败、部分加载和无改动明确区分</summary>

#### PF-06 · Diff失败、部分加载和无改动明确区分

*P1 · 工作量 L · 源码确认*

- **用户场景**：Git/HTTP失败、大patch预算截断或未跟踪文件过多时，审查区可能显示空白或+0/-0，用户不知道结果其实没加载完整。
- **当前证据**：session.tsx失败返回[]；VCS超限产emptyPatch，未跟踪超过60个的剩余项为空patch与0计数；FileDiff没有truncated/skippedReason/statKnown。部分Git失败转成空stdout。
- **建议改动**：协议提供error/partial/empty及原因；保留上次成功列表标过期，大文件明确按需加载，未知计数不冒充0，未加载patch不能算审完。
- **体验验收**：HTTP断线/Git失败/61个新文件/超过10MB总patch均可识别、重试或按需加载；真正空仓才显示无改动。

**固定 SHA 源码依据**
- [packages/app/src/pages/session.tsx:420-458](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/pages/session.tsx#L420-L458)
- [packages/opencode/src/project/vcs.ts:118-189](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/opencode/src/project/vcs.ts#L118-L189)
- [packages/opencode/src/project/vcs.ts:236-245](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/opencode/src/project/vcs.ts#L236-L245)
- [packages/opencode/src/git/index.ts:31-42](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/opencode/src/git/index.ts#L31-L42)
- [packages/opencode/src/git/index.ts:261-307](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/opencode/src/git/index.ts#L261-L307)

</details>

<details>
<summary>PF-07 · 远程文件搜索取消过期工作</summary>

#### PF-07 · 远程文件搜索取消过期工作

*P1 · 工作量 M · 性能风险待测*

- **用户场景**：大仓库快速输入文件名，每次按键都可能触发新的全仓rg扫描，过期搜索仍占IO；本地候选本已即时可选。
- **当前证据**：两个query直驱resource，过滤器直接set filter，请求未带AbortSignal；后端每次search做rg --files并重建目录数组。实时扫描原为新文件立即可@，不能简单TTL化破坏它。
- **建议改动**：本地命令/最近文件保持同步；远程搜索约120–180ms尾随调度与latest-only取消，再评估watcher epoch增量索引和漏事件全扫兜底。
- **体验验收**：10万路径仓库连输20字符，本地Enter仍可立即选，后端扫描不逐键累加；新建/重命名后马上@仍找得到。

*注：120–180ms为建议调度参数，不是现有实测延迟；Windows耗时须建立基线。*

**固定 SHA 源码依据**
- [packages/app/src/components/prompt-input.tsx:700-720](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/components/prompt-input.tsx#L700-L720)
- [packages/app/src/components/dialog-select-file.tsx:322-331](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/components/dialog-select-file.tsx#L322-L331)
- [packages/ui/src/hooks/use-filtered-list.tsx:128-130](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/ui/src/hooks/use-filtered-list.tsx#L128-L130)
- [packages/app/src/context/file.tsx:254-258](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/context/file.tsx#L254-L258)
- [packages/opencode/src/file/index.ts:398-432](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/opencode/src/file/index.ts#L398-L432)

</details>

<details>
<summary>PF-08 · 审查列表先到，patch按打开项加载</summary>

#### PF-08 · 审查列表先到，patch按打开项加载

*P1 · 工作量 L · 性能风险待测*

- **用户场景**：只想先看一个文件，也得等全仓patch生成与传输完成，改动越多等待越明显。
- **当前证据**：完整vcs.diff先生成batch patches，context接近整文件，总预算10MB，新文件还逐项补patch。已有1秒防抖/在途合并，不能再把“加防抖”当新方案。
- **建议改动**：轻量status/summary与per-file patch分开，按ref/版本指纹缓存；可见/选中优先，邻近少量预取，完整上下文按需展开，继承审查指纹失效规则。
- **体验验收**：500改动文件时列表先可点、第一项patch独立返回；只开少数文件不传全仓patch；记录列表可用时间、首patch时间、字节数与long task。

**固定 SHA 源码依据**
- [packages/app/src/pages/session.tsx:420-447](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/pages/session.tsx#L420-L447)
- [packages/opencode/src/project/vcs.ts:11](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/opencode/src/project/vcs.ts#L11)
- [packages/opencode/src/project/vcs.ts:98-115](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/opencode/src/project/vcs.ts#L98-L115)
- [packages/opencode/src/project/vcs.ts:196-210](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/opencode/src/project/vcs.ts#L196-L210)

</details>

<details>
<summary>PF-09 · 会话分页使用完整(time,id)游标与匹配索引</summary>

#### PF-09 · 会话分页使用完整(time,id)游标与匹配索引

*P1 · 工作量 M · SQL最小复核*

- **用户场景**：同毫秒更新的多条会话跨页时可能漏记录；会话增长后列表排序还会增加扫描工作。
- **当前证据**：排序time_updated desc,id desc，where却只有time_updated&lt;cursor，端点只返timestamp。SQLite复核三条同时间、limit2，下一页为空漏第三条；相关单列索引计划出现临时排序。首页当前不读下一页，不能称首页翻页已复现丢失。
- **建议改动**：复用v2已有(time,id)keyset；按真实root/directory/archive查询建少量复合/partial索引。验证计划，不盲加每列索引；普通title索引不会自动加速LIKE子串。
- **体验验收**：同时间100条、归档恢复、分页期间更新/插入不丢不重；1万/10万会话样本测首屏/搜索/计划。

*注：这是分页API逻辑和SQLite查询计划复核，不是用户真实数据库速度测量。*

**固定 SHA 源码依据**
- [packages/opencode/src/session/session.ts:1588-1608](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/opencode/src/session/session.ts#L1588-L1608)
- [packages/opencode/src/server/routes/instance/httpapi/handlers/experimental.ts:137-155](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/opencode/src/server/routes/instance/httpapi/handlers/experimental.ts#L137-L155)
- [packages/opencode/src/session/session.sql.ts:70-74](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/opencode/src/session/session.sql.ts#L70-L74)
- [packages/opencode/src/v2/session.ts:219-224](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/opencode/src/v2/session.ts#L219-L224)

</details>

<details>
<summary>PF-10 · 后台任务有配额、排队态与输出字节预算</summary>

#### PF-10 · 后台任务有配额、排队态与输出字节预算

*P1 · 工作量 L · 能力缺口·收益待测*

- **用户场景**：多会话并行构建/检索互相挤CPU与IO，用户无法知道哪些在排队，也无法保证大输出长期运行后的内存边界。
- **当前证据**：start直接forkIn(startImmediately:true)，状态没有queued、没有并发配额；已完成50条/30分钟回收已存在，但运行中不裁，completed仍保留完整output，落盘仅元数据。
- **建议改动**：全局+工作区可配置并发，前台优先、排队可取消；内存留尾部+完整日志文件引用，按需读。沿用取消树和重启恢复。
- **体验验收**：提交30任务时活跃数不超配置；取消排队不spawn，取消运行能结束进程；前台输入/停止/权限响应，输出保留受字节预算约束。

**固定 SHA 源码依据**
- [packages/opencode/src/background/job.ts:6](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/opencode/src/background/job.ts#L6)
- [packages/opencode/src/background/job.ts:79-104](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/opencode/src/background/job.ts#L79-L104)
- [packages/opencode/src/background/job.ts:149-224](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/opencode/src/background/job.ts#L149-L224)
- [packages/opencode/src/background/store.ts:9-11](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/opencode/src/background/store.ts#L9-L11)

</details>

<details>
<summary>ENG-01 · 忙时投递设置保存、读回与单条覆盖一致</summary>

#### ENG-01 · 忙时投递设置保存、读回与单条覆盖一致

*P1 · 工作量 M · 源码链确认*

- **用户场景**：GUI/TUI执行/busy-enter提示已切排队，但普通忙时输入仍可能插话，项目还产生无用config.json。
- **当前证据**：两端调用sdk.client.config.update，handler进入Config.update写项目根config.json；项目加载只扫redcode/opencode系列。另TUI忙时delivery硬编码steer，GUI初始/重置也steer，显式单条策略压过默认。
- **建议改动**：定清全局/项目默认与本条覆盖；写入真正被读取的出口，成功后读回生效值；未显式选择时沿用默认，选择仅覆盖本条。不能只改文件名或toast。
- **体验验收**：两端切queue后忙时发送确实排队，重启保留；本条steer仍能覆盖；项目不产生无用config.json。

**固定 SHA 源码依据**
- [packages/app/src/pages/session/use-session-commands.tsx:398-410](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/pages/session/use-session-commands.tsx#L398-L410)
- [packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:995-1017](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/opencode/src/cli/cmd/tui/routes/session/index.tsx#L995-L1017)
- [packages/opencode/src/server/routes/instance/httpapi/handlers/config.ts:18-21](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/opencode/src/server/routes/instance/httpapi/handlers/config.ts#L18-L21)
- [packages/opencode/src/config/config.ts:883-913](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/opencode/src/config/config.ts#L883-L913)
- [packages/opencode/src/config/config.ts:1122-1128](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/opencode/src/config/config.ts#L1122-L1128)
- [packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx:1418-1424](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx#L1418-L1424)
- [packages/app/src/components/prompt-input.tsx:295-303](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/components/prompt-input.tsx#L295-L303)

</details>

<details>
<summary>ENG-02 · 设置说明来源与生效层，避免保存回弹</summary>

#### ENG-02 · 设置说明来源与生效层，避免保存回弹

*P1 · 工作量 M · 源码确认*

- **用户场景**：MCP命令/timeout、模型或shell位于本地覆盖层，GUI改同字段并保存成功，重载却又显示旧值。
- **当前证据**：updateGlobal只写主层，loadGlobal后加载redcode.local.*；GUI统一走global.config.update。删除MCP已有逐层处理，编辑没有来源和目标层信息。
- **建议改动**：先显示来源、保存后生效值和被覆盖原因，提供打开源文件；随后完善本机/共享/项目目标选择，实际排期随主线。不能强制全部写本地层破坏同步策略。
- **体验验收**：同键置于主层/本地层/项目层，来源可见，保存或清除后读回与界面一致，用户知道改动作用范围。

*注：附录工程候选，由相关体验包吸收或另排实施任务，不单独增加主线计数；完整目标层编辑可另拆实施任务。*

**固定 SHA 源码依据**
- [packages/opencode/src/config/config.ts:514-519](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/opencode/src/config/config.ts#L514-L519)
- [packages/opencode/src/config/config.ts:709-718](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/opencode/src/config/config.ts#L709-L718)
- [packages/opencode/src/config/config.ts:1135-1198](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/opencode/src/config/config.ts#L1135-L1198)
- [packages/app/src/context/server-sync.tsx:732-744](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/context/server-sync.tsx#L732-L744)

</details>

<details>
<summary>ENG-03 · 统一配置set/reset/inherit语义</summary>

#### ENG-03 · 统一配置set/reset/inherit语义

*P1 · 工作量 M · 源码确认*

- **用户场景**：清空MCP工作目录或timeout保存后旧值回来；.json用户选全部工具，旧白名单仍然限制。
- **当前证据**：表单清空仅省略字段，深patch保留旧键；tools省略删除翻译只有jsonc分支，json分支直接mergeDeep。现有白名单回归只使用jsonc。
- **建议改动**：序列化前统一计算set/reset/inherit；继续保留表单没显示的environment/headers/disabledTools，不能整条覆写条目。
- **体验验收**：json/jsonc各验证cwd/timeout清空、tools all/list/none；未显示字段保留，重新打开和实际启动参数一致。

**固定 SHA 源码依据**
- [packages/app/src/components/settings-mcp.tsx:100-116](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/components/settings-mcp.tsx#L100-L116)
- [packages/opencode/src/config/config.ts:522-533](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/opencode/src/config/config.ts#L522-L533)
- [packages/opencode/src/config/config.ts:1142-1167](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/opencode/src/config/config.ts#L1142-L1167)
- [packages/opencode/test/config/config.test.ts:487-505](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/opencode/test/config/config.test.ts#L487-L505)

</details>

<details>
<summary>ENG-04 · 更新错误不再冒充最新版</summary>

#### ENG-04 · 更新错误不再冒充最新版

*P1 · 工作量 M · 源码确认*

- **用户场景**：离线检查更新显示已是最新版；下载失败无操作反馈；开发版禁用更新但设置仍提供可点按钮。
- **当前证据**：main返回updateAvailable:false,failed:true，设置只检查前者；Platform/preload/IPC类型遗漏failed。下载失败只日志return，layout还吞reject。
- **建议改动**：先补disabled/upToDate/available/error结果契约与重试、日志入口；随后完善下载进度、下载完成与安装分离、现有i18n接线，实际排期随主线。
- **体验验收**：离线、404、下载中断、dev禁用不显示“最新版”；重试状态可见；下载期间工作可继续。

*注：跨版本延续项，只计一次；Windows实际下载和安装未运行。*

**固定 SHA 源码依据**
- [packages/desktop/src/main/updater.ts:67-105](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/desktop/src/main/updater.ts#L67-L105)
- [packages/app/src/components/settings-general.tsx:139-153](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/components/settings-general.tsx#L139-L153)
- [packages/app/src/context/platform.tsx:11](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/context/platform.tsx#L11)
- [packages/desktop/src/preload/types.ts:115-117](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/desktop/src/preload/types.ts#L115-L117)
- [packages/app/src/pages/layout/update.ts:1-11](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/pages/layout/update.ts#L1-L11)
- [packages/desktop/src/renderer/index.tsx:221-230](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/desktop/src/renderer/index.tsx#L221-L230)

</details>

<details>
<summary>ENG-05 · 把MCP惰性启动接到设置与状态</summary>

#### ENG-05 · 把MCP惰性启动接到设置与状态

*P2 · 工作量 M · 源码确认*

- **用户场景**：已配置lazy的服务在GUI没有明确“待首次使用”状态，开关像关闭；用户无法在界面直接选择lazy。
- **当前证据**：后端startup=eager/lazy已实现，GUI字段表缺startup，statusLabels缺deferred，Switch仅connected为开。
- **建议改动**：本地MCP提供启动策略，区分配置enabled与连接状态，deferred显示“待首次使用”，操作后跟随真实状态刷新。
- **体验验收**：有缓存lazy首启不spawn、首次调用连接；无缓存退eager有说明；切策略和启停后的显示与实际一致。

**固定 SHA 源码依据**
- [packages/opencode/src/config/mcp.ts:4-49](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/opencode/src/config/mcp.ts#L4-L49)
- [packages/app/src/components/settings-mcp.tsx:19-58](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/components/settings-mcp.tsx#L19-L58)
- [packages/app/src/components/settings-mcp.tsx:264-282](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/components/settings-mcp.tsx#L264-L282)
- [packages/app/src/components/settings-mcp.tsx:339-355](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/components/settings-mcp.tsx#L339-L355)

</details>

<details>
<summary>ENG-06 · Windows发行形式与更新承诺匹配</summary>

#### ENG-06 · Windows发行形式与更新承诺匹配

*P1 · 工作量 L · 发行链待实测*

- **用户场景**：用户拿到便携目录产物，却在beta/prod看到自动更新能力，发布流程必须能给出与此匹配的升级路径。
- **当前证据**：Windows target只有dir；beta/prod声明publish latest，packaged非dev启用更新。已检查构建链未找到NSIS/相应更新元数据产物路径。
- **建议改动**：明确便携版与安装版：便携版提供下载迁移入口；自动更新版产出实际可升级安装包与元数据。与ENG-10统一渠道定义。
- **体验验收**：在干净Windows用户环境从0.18.3升级，配置/会话保留；下载或安装失败旧版仍可打开；渠道与升级目标匹配。

*注：尚未验证真实发布附件，不能据此宣称所有安装版本都无法更新。*

**固定 SHA 源码依据**
- [packages/desktop/electron-builder.config.ts:101-107](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/desktop/electron-builder.config.ts#L101-L107)
- [packages/desktop/electron-builder.config.ts:128-145](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/desktop/electron-builder.config.ts#L128-L145)
- [packages/desktop/src/main/constants.ts:1-12](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/desktop/src/main/constants.ts#L1-L12)
- [packages/desktop/package.json:16-27](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/desktop/package.json#L16-L27)

</details>

<details>
<summary>ENG-07 · 新机安装包完整携带内置资源</summary>

#### ENG-07 · 新机安装包完整携带内置资源

*P1 · 工作量 M · 源码确认·新机待测*

- **用户场景**：开发机已经sync-home，看似技能齐全；另一台没有源码的新机器启动时找不到seed，内置能力不完整。
- **当前证据**：bootstrap只尝试项目seed和exec父目录seed；CLI构建和desktop files/extraResources不含seed。源码注释已明确长期打包修法未完成。
- **建议改动**：发布资源清单带版本/哈希，首启从安装资源路径播种；区分内置与用户资源，初次结果可见，不再依赖启动项目恰好是源码仓库。
- **体验验收**：没有源码、没有~/.redcode的新Windows用户环境，技能/命令/所需脚本齐全；启动目录无关，首启失败有明确恢复入口。

**固定 SHA 源码依据**
- [packages/opencode/src/project/bootstrap.ts:91-111](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/opencode/src/project/bootstrap.ts#L91-L111)
- [packages/opencode/script/build.ts:109-174](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/opencode/script/build.ts#L109-L174)
- [packages/desktop/electron-builder.config.ts:72-83](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/desktop/electron-builder.config.ts#L72-L83)

</details>

<details>
<summary>ENG-08 · 脚本同步先暂存再切换，失败可回退</summary>

#### ENG-08 · 脚本同步先暂存再切换，失败可回退

*P2 · 工作量 M · 失败窗口待复现*

- **用户场景**：同步过程中复制失败或文件占用，旧scripts目录已删除，命令可能只剩半套。
- **当前证据**：sync-home-scripts仍rd旧目录后xcopy；已有孤儿检查和errorlevel，解决了盲删与静默成功，但没有目录事务回退。
- **建议改动**：同卷暂存复制、核对清单后切换；失败恢复旧目录，保留现有孤儿策略。不要重写已经具备的配置文件原子写。
- **体验验收**：注入复制失败/目标占用，旧recall等脚本仍能运行，重试不留混合版本或半套目录。

**固定 SHA 源码依据**
- [script/sync-home-scripts.bat:21-37](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/script/sync-home-scripts.bat#L21-L37)
- [script/check-home-scripts-orphans.ts:34-58](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/script/check-home-scripts-orphans.ts#L34-L58)

</details>

<details>
<summary>ENG-09 · 内置技能和命令升级不覆盖用户修改</summary>

#### ENG-09 · 内置技能和命令升级不覆盖用户修改

*P2 · 工作量 L · 产品补完*

- **用户场景**：仓库修复了技能或命令，但老用户的同名seed副本永远不更新；粗暴覆盖又会丢个人修改。
- **当前证据**：sync-home与bootstrap以“存在即跳过”保护个人资源，尚无已安装版本/哈希与升级比较。
- **建议改动**：内置/覆盖双来源及安装哈希：未修改副本可升级，修改过的显示比较与保留；资源版本、退役状态和回退入口可查看。
- **体验验收**：未改副本升级生效，已改副本保留且可比较，退役资源状态清楚，回退恢复原版本。

**固定 SHA 源码依据**
- [script/sync-home.bat:19-36](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/script/sync-home.bat#L19-L36)
- [packages/opencode/src/project/bootstrap.ts:118-129](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/opencode/src/project/bootstrap.ts#L118-L129)

</details>

<details>
<summary>ENG-10 · 一个发行定义产出渠道、标识与更新源</summary>

#### ENG-10 · 一个发行定义产出渠道、标识与更新源

*P2 · 工作量 M · 源码确认*

- **用户场景**：构建环境使用latest时，运行时代码可能按prod，图标与打包元信息却按dev；并存渠道的深链接和更新源也需明确。
- **当前证据**：electron-vite接受latest→prod；scripts/utils和builder只认dev/beta/prod，否则dev。beta/prod共用latest和redcode协议。
- **建议改动**：共享纯解析工厂/发行manifest产出channel/appID/名称/图标/更新源/协议；未知值显式失败，兼容别名一致。
- **体验验收**：dev/beta/prod每个产物的窗口名、关于页、资源与更新源一致；并存时深链接目标可预测。

**固定 SHA 源码依据**
- [packages/desktop/electron.vite.config.ts:14-19](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/desktop/electron.vite.config.ts#L14-L19)
- [packages/desktop/scripts/utils.ts:3-9](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/desktop/scripts/utils.ts#L3-L9)
- [packages/desktop/electron-builder.config.ts:42-46](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/desktop/electron-builder.config.ts#L42-L46)
- [packages/desktop/electron-builder.config.ts:119-145](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/desktop/electron-builder.config.ts#L119-L145)

</details>

<details>
<summary>ENG-11 · 共享业务投影，平台仅分叉呈现</summary>

#### ENG-11 · 共享业务投影，平台仅分叉呈现

*P2 · 工作量 M · 架构改进*

- **用户场景**：新增一个状态或修改活动统计时，GUI/TUI分别补一遍，后续一端容易落下。
- **当前证据**：两份deriveActivity算法与类型几乎同构；MCP漏deferred、更新接口漏failed已经展示了手写状态子集漂移。
- **建议改动**：将纯状态/计数/事件投影放共享领域模块，GUI/TUI保留宽度裁剪、布局与输入手势；外部资源服务沿现有Effect Service/Layer管理，不全仓加工厂。
- **体验验收**：同一事件回放两端计数、失败/等待/完成语义相同；新增状态不在某端隐形；启动依赖图不被共享UI实现反向拖重。

**固定 SHA 源码依据**
- [packages/app/src/pages/session/composer/activity.ts:9-69](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/pages/session/composer/activity.ts#L9-L69)
- [packages/opencode/src/cli/cmd/tui/routes/session/activity.ts:7-65](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/opencode/src/cli/cmd/tui/routes/session/activity.ts#L7-L65)
- [packages/core/src/effect/runtime.ts:5-20](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/core/src/effect/runtime.ts#L5-L20)

</details>

<details>
<summary>RX-01 · 重试失败消息绑定原提交，不发送当前新草稿</summary>

#### RX-01 · 重试失败消息绑定原提交，不发送当前新草稿

*P1 · 工作量 M · 函数级复核*

- **用户场景**：先提交A，等待时继续写B；A失败后草稿B被正确保留，但错误条点“重试”会发送B并清空编辑器，而不是重试A。
- **当前证据**：restoreInput在dirty时不恢复A；失败仍设置错误条。横幅onRetry直接绑定handleSubmit，后者读当前draft。真实createPromptSubmit隔离执行得到发送记录[A(messageID1),B(messageID2)]。
- **建议改动**：失败操作保存scope/draft/delivery/intent/messageID/error句柄；重试该操作，不读取或清空B。消息ID遵循现有幂等/去重协议；支持查看/恢复失败稿和取消重试。
- **体验验收**：A在途写B→A失败→重试，只再次发A，B内容/附件/选区完整；跨会话返回仍指向原scope；连续点重试不会重复发送。

*注：已做真实提交函数的隔离执行复核，未启动浏览器或请求真实模型/后端。*

**固定 SHA 源码依据**
- [packages/app/src/components/prompt-input/submit.ts:552-561](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/components/prompt-input/submit.ts#L552-L561)
- [packages/app/src/components/prompt-input/submit.ts:712-728](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/components/prompt-input/submit.ts#L712-L728)
- [packages/app/src/components/prompt-input.tsx:1810-1833](https://github.com/JiaHuiRed/RedCode/blob/0d8c5d56c7a3982ab7fe8b2a62ca2a1e17e2bf8f/packages/app/src/components/prompt-input.tsx#L1810-L1833)

</details>

## 13 · 本次复核记录

### 已核实

- 仓库固定提交、版本、26 个后续提交与干净工作区。

- 用户截图与设置/Soul/新建页源码互相核对。

- 真实提交函数：A 晚失败后 Retry 发送 B。

- 真实键盘处理函数：一次事件可能执行问题与授权两处动作。

- 真实排序入口与 reducer：增量丢失、重复条目和删除遗漏。

- 真实 tree-store：在途 force 后无尾随重读；缓存函数确认同名所有权问题。

- 真实 worktree 派生回调忽略已有目录与 main 的显式选择。

- 隔离 SQLite 复核时间戳游标漏掉同时间条目。

### 仍需成品验收

- 本环境浏览器受 socket 权限阻止，未产生当前 GUI 交互实测截图。

- Windows Electron、发行安装包、自动更新和干净新机未实测。

- 没有当前整机 CPU/内存/帧率基线；不宣称已实现提速。

- Node sidecar 的 Bun API 兼容风险是源码链判断，运行探针因依赖解析未完成。

- 未发真实模型请求；用户截图与源码复核不等于全部手工路径已通过。

---

*此文件为审查交付物，内容包括完整主线、范围、逐项验收与证据附录。建议按 UX 编号拆开发任务，将相应可靠性与工程项一起带入。所有建议均未在本次审查中改动产品代码。*
