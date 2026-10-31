# 桌宠 V0.2：本地台词与单 tick 闲时调度

状态：implemented

## 问题

GUI 中的赤已有真实事件归一化和静态姿态，权限、提问、成功、失败各只有一句固定气泡。闲置期间没有小动作，已有的 `02-idle-coffee.png` 尚未接入。

初稿用 `on(() => display().kind, ...)` 选词，实际依赖仍是整个 display memo：两个时钟更新、姿态保持 permission 的探针得到三次 effect 执行。因此仅包 `on()` 不能保证台词在同姿态心跳期间稳定。

## 决策

- `pet-lines.ts` 提供本地台词池和纯表现层 reducer；`pet-state.ts`、真实事件订阅与优先级保持不动。权限、提问和终态必说，工作台词在姿态边沿按概率与冷却选取，不在心跳上反复抽词。
- `PetPresentation` 保存上次姿态、开关、气泡及动作期限。沿用 PetLayer 已有的一个 1s tick；期限在 reducer 内推进，不增加动作 interval 或 timeout。动作中出现工作/交互状态时立即取消，旧期限不会清除新提醒。
- 连续进入 idle 后计时，达到间隔时概率选择咖啡帧或纯文字碎碎念。关闭清理 Pet 的 tick 和展示，重开重新计算 idle 期限；权限仍存在时恢复常驻提醒。
- 可调参数归 `settings.v3` 的 `general.petBehavior`，由设置拥有方显式调用 `resolvePetBehavior()` 补齐旧配置缺项；读取与 setter 写入前均校验。没有新增设置页参数控件，也不属于 `redcode.jsonc`。

| 字段 | 默认值 |
| --- | --- |
| `activityChatterChance` | 0.3 |
| `chatterCooldownMs` | 45000 |
| `chatterMs` | 6000 |
| `idleIntervalMs` | 25000 |
| `idleActionChance` | 0.4 |
| `idleActionMs` | 5000 |
| `coffeeChance` | 0.5 |

概率限制在 [0,1]，时长须为有限数且在 [1000,86400000] 毫秒内；非对象、未知字段和非法数值显式报错。红测证实原先对象 spread 会把 `null` 等非法输入掩盖成默认值，新增形状与字段名校验后通过。

## 备选与否决理由

- **额外 interval + 动作 timeout**：否决。期限可以由现有 tick 处理，增加定时器会扩大关闭、打断和迟到回调的清理面。
- **每个心跳重新选词**：否决。高频更新只续命展示状态，不能成为每秒换台词或重试概率的机会。
- **复制 crosspet 的文件轮询/外部 hook**：否决。RedCode 已有真实事件流，只复用本地展示思路。
- **非法参数静默回退**：否决。拼错字段不能看似保存成功却不生效；读取非法持久配置会抛出设置异常，需要修正配置。

## 后果与范围

- 赤仍挂在 GUI 的 PetLayer 内；未实现独立透明窗口、桌面拖拽或全局置顶。
- 复用现有图片，本批无需新增素材；planning/reviewing 未接线，也没有连续帧动画。
- 时钟使用 `Date.now()`，气泡和动作在下一个 tick 收回；正常前台约有 1s 颗粒度，后台节流会延后，不宣称硬实时截止。
- 本批没有模型可见改动：不发送引擎事件、不生成会话消息，固定前缀与 KV cache 均不变，无新增模型注入项。

## 验证

- `bun test --conditions=browser --preload ./happydom.ts ./src/pet/pet-lines.test.ts ./src/pet/pet-state.test.ts ./src/context/settings-media.test.ts --timeout 30000`：48 pass，0 fail。
- `bun run typecheck`（packages/app）：通过。
- 实际 PetLayer + SettingsProvider 的隔离 Vite 浏览器预览：咖啡素材加载；权限和工具立即打断；权限台词跨 6.5s 保持稳定；关闭/重开与卸载清理 Pet interval；设置持久化；375px 窄屏无溢出；未捕获运行时错误。未连接真实会话后端或验证 Electron 独立窗口。
- 前置状态契约：`docs/notes/implemented/bug-fix/2026-10-01-pet-stream-heartbeat-winner.md`。

## 2026-10-21：V0.3 抚摸、挪位与漫画心声气泡

用户希望赤像常见桌宠一样能回应抚摸、拖动换位置，并解决宠物和台词太小、不容易注意的问题；气泡轮廓以用户提供的漫画参考图为准：大椭圆、大字和两个思考圈，不沿用提示卡片样式。配色按用户最终反馈匹配赤的红黑形象，使用暖白底、酒红粗描边和深红文字，不照搬参考图的蓝白配色。

### 决策

- **分开识别抚摸与拖动**：鼠标无按键移动时，按现有贴图的归一化几何区域识别额头和腹部；只有真实位移才触发，不把静止悬停当连续抚摸。主键按下并越过小幅位移门槛后才进入拖动，指针捕获保留抓取偏移，不把宠物中心吸到光标上。触摸反应与原图呼吸分层，动作不改变命中区域或位置。
- **本地回应、不打扰工作**：头部与腹部使用不同台词，冷却和显示期限归 `settings.v3.general.petBehavior` 的 `touchCooldownMs` / `touchResponseMs`，默认 1800 / 4500 毫秒，读取旧配置时由现有 resolver 补齐并校验。重要的权限、提问与终态台词不被抚摸覆盖；仍使用现有 tick 收回过期展示，不增加另一组动作定时器。
- **位置属于用户设置**：`general.petPosition` 保存视口归一化坐标，缺字段保留原默认位置；拖动过程中只更新展示，完成时才落盘，不随每个 pointermove 写设置。缩放窗口、图片尺寸变化后重新夹边。方向键可以挪动、Shift 加速、Home 归位，Enter/空格提供非鼠标回应入口。
- **视口坐标有同一基准**：PetLayer 仍由 GUI 布局创建，但通过 Portal 挂在 body。原 main 的 `contain-strict` 会建立固定定位包含块并裁剪子层，不能一边用 window 坐标拖动，一边按 main 的坐标定位。
- **漫画气泡与宠物尺寸解耦**：图片宽度由 127 调到 160 CSS px，气泡宽 280、最小高 156 CSS px，正文使用现有字号标度 `--font-size-x-large`（默认 20px），不随小图一起缩小。气泡绝对定位，不参与图片包围盒；根据实测尺寸换到宠物上方或下方、横向收回视口。缩小动效模式保留静态触摸标记、取消形变。

### 参考与取舍

只读参考 `E:\AI\dsh-pet`（HEAD `2c5146adb519b3389e42d19a9b88f019c9cce6b1`，258 个提交）：其网页路径已使用 pointer capture、抓取偏移和点击/拖动门槛，气泡独立于宠物内容；没有现成的额头/腹部悬停抚摸分区。仅借鉴这些交互原则，不复制视频播放、原生透明窗、抛掷、字体或素材。

不增加独立桌面窗口、成长系统、模型调用或引擎事件；不因互动伪造工作成功、权限批准或会话消息。此次模型可见四问均为零：提示词、工具定义与输出、固定前缀和 KV cache 不变，没有新增模型注入项。

### 验证

- `bun run test:one ./src/pet/pet-lines.test.ts ./src/pet/pet-state.test.ts --timeout 30000`：52 pass / 0 fail；`bun run typecheck` 通过。
- 隔离浏览器挂载生产 PetLayer、SettingsProvider 和 PlatformProvider，用真实鼠标移动、按下、拖动和键盘操作验证：头/腹反馈不同，离开与静止到期复位；跨越 1 秒 tick 的拖动不取消，拖动中 resize 不回到旧记位；松手保存、重新挂载恢复、Home 归位；权限台词不被覆盖且键盘触摸反馈会到期；375px 窄窗口和顶部翻边不溢出；关闭重开及 reduced motion 正常，浏览器运行时错误为零。
- 浏览器暴露的边界已修正：几何 observer 只随开关建立，不随每秒 display 对象重建；测量拖动中的当前位置而非旧记位。气泡入场会缩放，边界计算使用 `offsetWidth/offsetHeight`，不能把动画中的 `getBoundingClientRect()` 尺寸当作最终布局宽度；圆形轮廓显式设 `corner-shape: round`，不继承全局方圆角。
- 验证没有启动真实模型任务，也没有重启当前 Electron 应用；独立桌面窗口与原生多屏拖动不属于本次范围。交互回归脚本和截图留在本机 `.redcode/temp/pet-v3-qa.mjs`、`pet-v3-final.png`，未加入仓库级浏览器测试门禁。

## 2026-10-31：事件详情与订阅额度

赤复用现有事件展示正在使用的工具名、权限类型和问题短标题；同一会话的等待请求按请求 ID 分开保留，权限和提问始终优先于普通工作状态。工具输入、输出与权限匹配路径不进入气泡。问题标题仍是模型提供的自由文本，展示前仅做长度和常见敏感形状过滤，不宣称可以识别全部敏感内容。

额度入口只消费 `server-sync` 已有的订阅额度快照，不新增请求或轮询。每个快照独立展示窗口占用、重置时间、采集时间及已有 Credits，不推断币种或当前会话账号，也不把订阅占用当账户余额。权限或提问出现时关闭额度面板，让重要提醒优先显示。

首次挂载时不读取尚未接入 DOM 或尺寸为零的根节点；等待图片及布局完成再测量，避免把左上角零坐标保存为默认位置。

参考 `E:\AI\DeepSeek-Balance-Whale-Widget` 的数据气泡和等待提醒，未复制其图片、音效或余额账本。该仓美术素材未授权再分发；此批沿用赤的现有素材。无模型可见改动。


## 2026-10-31（第二批）：当前会话动态状态

赤的固定「额度」按钮改为当前会话状态徽标；额度查看移到悬停入口，保持独立可用。会话路由存在时（`layout.tsx` 传入 sessionID 与目录），赤只投影该会话：目录 child store 的 `session_status`、`permission`、`question` 快照负责恢复页面打开前已在运行的状态，实时事件流提供工具细节与回合收尾；无会话路由时保留原全局聚合视角。

关键边界：`session_status_ready` 由真实 status 请求成功驱动，未加载完成的目录显示「状态未知」而不是猜测 idle——status 接口只列非 idle 会话，快照缺键才是 idle。事件 blocker 永远优先于快照条目。

快照与事件流的乱序竞态（HTTP 往返间隙事件穿过）用 bootstrap journal 仲裁：`beginPetBootstrap` 开启按目录的 journal，在途事件记录其中；快照写入 batch 内通过 `onSnapshot(kind)` 按分区清算（`settlePetBootstrap`）并把 journal 事件按序重放回 child reducer——asked/replied/status 的 child 处理都是幂等确定性操作，重放净效果等于事件流最终态，不复活已回复请求、不倒退状态。残余 journal 在 bootstrap 收尾丢弃（失败轮快照未写入，无需修正）。journal 生命周期等于单轮 bootstrap，无跨轮 tombstone。

已知限制：status 残留最多活到该会话下一个 status 事件（回合结束必有 idle，自愈）；问题标题的敏感形状过滤同上一批，不宣称完整。