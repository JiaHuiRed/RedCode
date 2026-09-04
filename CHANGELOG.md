# 更新日志

本文件记录 RedCode 的所有重要变更。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

版本线历史分三段：0.3.0 及之前 TUI 与 GUI 共同历史；0.3.0 起两线独立维护（TUI 至 0.8.16，GUI 至 0.7.20），分别记录在下方 `## TUI` 与 `## GUI` 两段；**2026-08-14 起两线重新合并**，单一版本号覆盖全部组件，从 TUI 的 0.8.16 继续递增，新条目直接记录在本说明之下、不再按组件分段。

---

### [未发布]

#### 新增

- **TUI 首页字标右侧落一枚朱印**（新增 `packages/opencode/src/cli/cmd/tui/component/seal.tsx`，`routes/home.tsx` 接入）：品牌标志 09-04 已经进了 GUI（favicon / PWA 图标 / 标题栏 / 等待行），终端这边一直没有。

  **GUI 那套 SVG 几何搬不进终端，这版是重刻的。** 先试的是栅格化：把 `redcode-mark.svg` 渲成位图再用半块字符 `▀▄█` 铺（一格装两个垂直像素，正好凑出方像素）。实测 10 到 24 列，`>` 的笔画在 16 列下只有 **1.7 个像素宽**、`_` 直接消失，要到 24 列 × 12 行才看得清——而首页字标本身才 7 行。改用**线条刻本**：印身用圆角框字符，`6 列 × 3 行` 在终端里就是视觉正方形（字符约 1:2）；印文直接写 `>_`,它本来就是终端提示符，用真字符比栅格成色块更本真。

  **右上角崩口有意舍弃**。试过用断笔 `╸` 开口，出来像画错了而不是手刻残缺——那个特征需要亚字符级精度，终端给不了。**静态不动也是有意的**：印是盖上去的落款，而字标那边已经有常驻扫光，再让印晃两边会打架。

  颜色不跟主题调色板走（那是标志不是 UI 元素），但深色底上 `#C8322B` 压不住，按背景亮度在 `#C8322B` / `#E4534A` 两档官方用色之间切一次，与 `redcode-mark.svg` 头部注释同源。组件放在 `home_logo` 这个插件 slot **内**——印是字标的落款，插件整块替换 logo 时该一起被替换，而不是孤零零留一个印在那儿。两条用例钉住形状：整帧快照，以及「6 列 × 3 行、印文含 `>_`」——尺寸单独断言是因为任何一边动了都不再是方印。

### [0.10.19] - 2026-09-04

> 朱印终于出现在界面上（此前只是文件），外加 sync-home 镜像的孤儿闸门。共同点是「写完了但没接上 / 会静默丢东西」。

#### 修复

- **会话等待行左边换上朱印，此前是 GitHub 的 `mona-loading.gif`**（`packages/app/src/pages/session/message-timeline.tsx`）：等待期最抢眼的位置一直摆着别家的吉祥物。更要紧的是——**朱印此前在任何界面里都不出现**：09-04 那次落地（`35f92412`）加了 `Seal` 组件与 `ChannelIndicator`，但后者**全仓无人引用**，写完从没挂上去；就算挂了也看不见，因为桌面端 `renderer/index.html` 用裸 DOM 注入了自己那条 `rc-ver` 版本徽标，还起了个定时器主动隐藏原生 badge。所以它此前只以文件形式存在（favicon / PWA 图标 / 文档站主题色）。这次先接上最显眼的一处。

  尺寸 20px 与右边仓鼠齐平，用**完整刻本**——拿 16/20/24/32/48 五档实物对照后选的。**刻意不加动效**：这一行右边已有 TextShimmer 与仓鼠两处运动，再加一处就是周期性闪动。顺带按实测更正 `Seal` 的注释：原写「≤24px 矢量崩口与细白边只会让边缘发毛」，那条判据只对**位图管线**成立，浏览器矢量抗锯齿下 20px 完全立得住，16px 才是真分界；不改的话下次谁读到又会绕开完整刻本。`ChannelIndicator` 与桌面端那个绿点这次没动。

#### 构建

- **sync-home 镜像加孤儿闸门，home 里的脚本不会再被静默抹掉**（新增 `script/check-home-scripts-orphans.ts`，改 `script/sync-home-scripts.bat`）：`sync-home-scripts.bat` 是**真镜像**——先 `rd /s /q ~/.redcode/scripts` 再从 `seed/scripts` 铺回来，而 `scripts/` 在私仓被 gitignore（260816 起权威移到公仓 seed）。两条叠起来的后果是：谁往 home 写个脚本却没同步进 seed，**下一次 build 就静默抹掉，git 也不留底**——260901 那次 `hooks/pre-commit` 被反复抹掉正是这个形态。

  现在 `rd` 之前先比对，发现孤儿就中止并逐条列出，给三条处理路径；`REDCODE_SYNC_SCRIPTS_FORCE=1` 是逃生口。四个场景实测：无孤儿静默放行 / 有孤儿（含子目录）中止 exit 1 / FORCE 降级为警告后放行 / 完整跑一遍 .bat 镜像结果与 seed 一致。`.bat` 新增注释仍是纯 ASCII——cmd 按 OEM 码页读，UTF-8 注释会毁掉解析。

### [0.10.18] - 2026-09-04

> 审计清单收口：三处「写了但从没生效」与一处四份拷贝。

#### 新增

- **`effect` skill 从没生效过，现在挪进真正会被播种的目录**（`seed/skills/effect/` → `seed/skill/effect/`）：`seed` 下**单数**的 `skill/` 才是活目录——`project/bootstrap.ts` 从它播种到 `~/.redcode/skill`，`script/sync-home.bat:21` 也拷它；而**复数**的 `skills/` 唯一一次提交是上游改名那回（`dda1a629`，无本仓前缀），本仓从没有任何代码或脚本读过它。里面躺着的 `effect` skill 因此从落地那天起一次都没被加载过。

  同批修好它内容里的过期引用。`.opencode/references/effect-smol` 在文件里出现三次，而 `.opencode` 早在 260805 就改名成 `seed`，并且 `seed/references/effect-smol` 也从来不存在——**正因为没人用这个 skill，路径烂掉了也没人发现**。改成指向实际在盘上的源码：Effect v4 的完整 TypeScript 源码随包分发，读 `packages/<pkg>/node_modules/effect/src/*.ts` 即可（**包级** node_modules，不是仓根），不需要克隆任何外部仓库。顺带补两条本仓踩过的坑：`Effect.either` 在这个 beta 里不存在（拿失败值用 `Effect.flip`）、碰数据库的测试要用 `it.instance` 而不是 `it.effect`（后者不起 `TestInstance`，`session.create` 会撞外键，报错看起来像被测代码的 bug）。

  **模型可见改动的四问**：① 看到什么变了——skill 列表多一条 `effect`（此前模型根本看不到它），description 一并改写，去掉 `effect-smol` 这个误导性的仓名（本仓用的是发布包不是那个开发仓），补上触发条件。② token——常驻部分只有 description，207 字节；全部 skill description 合计 2513 字节 ≈ 838 token，这条占 8.2%。正文 3683 字节**只在 skill 被 load 时**进上下文。③ KV cache——skill 列表在固定前缀里，新增一条会让**从 skill 段起往后的前缀作废一次**；一次性，不是每轮不稳定，之后内容恒定。④ 硬上限——单条正文 3683 字节、description 207 字节，都远低于任何阈值；skill 条目数本身没有硬上限，但那是既有结构且内容全部由本仓自己维护（不像 MCP instructions 那样来自第三方），不是本次引入的缺口。

  复数目录里另一个 `improve-codebase-architecture` 保持原样未动。

#### 修复

- **删掉 `infra/console.ts` 这条死链——`sst deploy` 此前必崩**（删除 `infra/console.ts`、`sst.config.ts`）：这 302 行是 SaaS 控制台那套的基础设施定义，五个 handler / directory 全部指向 `packages/console/*`，而那个包早在 `78e86454 chore: remove unused SaaS console package` 就被有意删掉了。`sst.config.ts` 的 `run()` 却仍**无条件** `await import("./infra/console.js")`，还把 `stat.url` 当部署输出返回——任何一次 `sst deploy` 都会在解析 handler 路径时崩。CI 不跑 sst，所以这条死链一直没人踩到。

  删之前确认过没有别的消费者：`infra/console.ts` 的四个导出（`database` / `auth` / `stripeWebhook` / `stat`）里只有 `stat` 被 `sst.config.ts` 用，`app.ts` / `enterprise.ts` / `monitoring.ts` 三个 infra 文件既不 import 它也不链接它的资源。要恢复就从 `78e86454` 之前取，连同 `packages/console` 一起。

#### 优化

- **美元汇率的四份拷贝合并成一处**（新增 `packages/core/src/currency.ts`，改 `app/components/session/session-context-format.ts`、`app/pages/home-stats.tsx`、`tui/feature-plugins/home/footer.tsx`、`tui/feature-plugins/sidebar/context.tsx`）：`USD_TO_CNY = 6.72` 此前有四份逐字相同的定义，两份在 GUI 两份在 TUI，全靠注释互相提醒「四处必须同步改」。改过两轮（260731 6.76→6.75、260827 6.75→6.72）都是手工同步四处——**漏一处就会出现同一笔花费在首页和侧栏显示不同金额，而且不会有任何东西报错**。两个包都依赖 `@redcode-ai/core`，常量挪进去，四处改成 import；`home-stats.tsx` 继续 re-export（`home-usage.tsx` 一直从它取，改成直连 core 属于无谓的连带改动）。注意这跟「币种判定」是两回事：某个模型本来就是人民币标价时不该再乘汇率，那一步读 `model.cost.currency`，260827 起已退役 `CNY_PROVIDERS` 硬编码名单。

#### 构建

- **构建产物移出格式检查，不合规文件数 730 → 281**（`.prettierignore`）：`prettier --list-different .` 此前报 730 个文件不合规，其中 **386 个是 `packages/desktop/out/` 里的打包 js**（electron-vite 输出，已被 git 忽略）。压过的代码当然不符合源码格式，它把这个指标的一半以上变成噪音，也让「给格式化加门禁」看上去比实际难得多。

  排掉产物后 281 个，构成：手写文档 117（md+mdx）、源码 125（ts+tsx）、json 16、css 12——真正在 `packages/*/src/` 下的源码只有 **59 个**。注意 **prettier 3 起不再自动读 `.gitignore`**，所以产物即使不进版本库也要在 `.prettierignore` 里再列一遍。

### [0.10.17] - 2026-09-04

> 黄档性能体检第二批，四条互不相干的热路径：SSE 序列化、用量聚合、TUI 键位层、设置文件写放大。

#### 优化

- **SSE 事件体按对象缓存，订阅者再多也只序列化一次**（新增 `packages/opencode/src/server/routes/instance/httpapi/handlers/sse-encode.ts`，`handlers/global.ts` 与 `handlers/event.ts` 改用它）：`/event` 与 `/global/event` 都是**每条连接建一条独立的 Stream**、各自 `Stream.map(eventData)`，于是同一个事件对象被 `JSON.stringify` N 遍，N = 当前订阅者数。而 GUI 一个窗口就固定开**两条**流——`context/global-sdk.tsx` 在 onMount 自启动，`context/server-sync.tsx` 在下一帧启动 `server-sdk`，两者都取自同一个 `useServer().current`，连的是同一个 server 的同一个端点。再算上 TUI、第二个窗口、分享服务，N 还会更大；会话 diff 那类事件能到 30MB 级，每多一个订阅者就多一遍全量序列化。

  改法：`eventData` 抽成共用模块并按事件对象 `WeakMap` 缓存。可以缓存的依据是派发路径不拷贝也不改写——`GlobalBus` 是 Node 的 `EventEmitter`，`super.emit` 把同一个对象引用同步派给所有 handler，instance 侧的 `bus.subscribeAll()`（Effect PubSub）同样不拷贝；各连接的 handler 只把它入队，而 `GlobalBus.emit` 里那次 `payload.id` 赋值发生在 `super.emit` **之前**，轮不到订阅者看见半成品。用 `WeakMap` 而不是带上限的 Map：事件对象只要还在某条队列里就活着、条目就在，两条队列都消费完就随对象一起回收，天然有界。心跳与 `server.connected` 每次都是新对象、不会命中，它们本来也不是要省的那部分。四条用例钉住：同对象只序列化一次、不同对象各自序列化、输出形状与 `Sse.Event` 一致、primitive 与 null 照常编码。

  **只做了服务端这一半**：黄档 A4 原本要「两条 SSE 流合一」，客户端那一半没做。那两个 provider 是近乎逐字复制的 724 行（文件里自己的注释就写着「两个文件各有一份几乎相同的重连循环」），各自带重连、心跳、合批、flush，而**整个目录只有一个 `sse-log.test.ts`**，重连与合批逻辑零测试覆盖。在没有测试保护、也无法在本机真跑 GUI 验证的前提下重构 GUI 的核心数据通路不划算。服务端这一半是纯缓存、不改语义，收益（stringify 次数从 N 降到 1）恰好覆盖了原方案里最贵的那部分。

- **用量看板的聚合按指纹短路**（`packages/opencode/src/session/usage.ts`）：`/session/usage` 的五个聚合查询 WHERE 完全相同，各自把同一批 message 行扫一遍，而**每一条都要读 `message.data`**。本机副本实测该列合计 171MB，光把它读出来就要 1462ms。逐项冷态：

  | 查询 | 冷态 |
  |---|---|
  | base | 1664 ms |
  | daily | 292 ms |
  | byModel | 296 ms |
  | dailyByModel | 310 ms |
  | peakHour | 204 ms |
  | 合计 | 2766 ms（热态 1307 ms） |

  瓶颈是读 blob，不是 `json_extract` 本身：同一批行不碰 data 只 count 是 **6ms**，一加 role 过滤就跳到 172ms。所以加索引救不了——`sum` 无论如何都要把行读出来。

  改法：加一道指纹，**不碰 data、不带 role 过滤、不带 range 过滤**，只数该项目的 message 行数与最大时间戳，热态中位 **5.55ms**。指纹没变就直接复用上次结果，等于用 5ms 决定那 1.3s 要不要做。任何新消息都会让行数或时间戳之一变化，宁可过度失效也不会漏。只缓存 `range="all"`——7d/30d 的窗口是相对当前时间**滑动**的，message 一行没变、时间往前走结果照样该变，指纹管不住这一维；而 "all" 正好是服务端默认值，也是最贵的那条。缓存有界，16 个项目按 LRU 淘汰。

  **走过但否掉的一条**：`session` 表本来就有 `cost` / `tokens_*` 六个汇总列，实测与 message 实算**逐项 0.00% 差异**、查询只要 2.5ms（快 91 倍）。但它替代不了这里：① 模块头部早写明按天归集不能走 session 表（会话跨天会把今天的量算进创建那天，日线失真）；② `sessions` 计数对不齐——本项目 277 个会话里有 6 个汇总列全 0，其中 **5 个其实有 1 条 assistant 消息**（token 为 0 的失败请求），无论 `count(*)`（277）还是"非零过滤"（271）都复现不了真值 276。所以只做缓存，不改数据来源。

  四条用例钉住：同指纹复用同一个对象引用、新消息后重算、带时间窗的档位不进缓存、`invalidate` 强制重算。

- **输入框按键不再重注册键位层**（`packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx`）：`useBindings` 是一个 `createEffect`，它同步调用 `createLayer()`——**在那里面读到的任何信号都成了这个 effect 的依赖**，一变就把整层 dispose 掉再 `registerLayer` 注册回来。输入框原先有个 `cursorVersion` 计数器（内容变化和光标移动各自增一次），四个 `useBindings` 把 `enabled` 写成立即求值的 IIFE 并在里面读它一下，用来强制那几层重算非响应式的 `input.visualCursor.offset`。于是**每一次按键都要重注册四层键位**，而 enabled 的值大多数时候根本没变（光标从第 5 列移到第 6 列，两次都是 false，照样重注册四遍）。

  改法：opentui 的 `enabled` 本来就收 `boolean | (() => boolean) | ReactiveMatcher`（`addons/universal/enabled.d.ts`），函数形式会被交给 `ctx.activeWhen`，在**按键判定时**才求值。四处从 IIFE 改成函数后 effect 不再依赖光标，`cursorVersion` 那个计数器连同两处自增一起删掉——惰性求值每次都读最新的 `visualCursor`，比原来靠计数器补触发还准。顺带一提，那四处里有两处的 enabled 压根没读 `visualCursor`，计数器对它们纯属多余。

  实测对照（新增 `test/cli/tui/keymap-enabled-lazy.test.tsx`，包一层 `registerLayer` 数调用次数）：同样 5 次信号变化，IIFE 写法从 1 次注册涨到 **6 次**，函数写法**稳定在 1 次**。两个用例是对照组，以后谁再写回 IIFE 会当场变红。**未做的**：没有在真实 TUI 里量过每键省下的绝对毫秒数，上面钉住的是机制与次数。

  **实测否决，别再排期**：同批想做的黄档 A8「TUI 流式尾块超阈值走纯文本」换了个更稳的思路试过——`<markdown streaming>` 和 reasoning 的 `<code streaming>` 都是**硬编码 `true` 从不设回 false**，而上游文档明说「流完要置 false 才会 finalize 尾部 token 解析」，所以改成按 part 的 `time.end` 绑定。整帧快照当场抓出问题：`streaming=false` 那一帧**正文全部消失**，只剩两个列表标记。把 harness 的等待从 25ms 加到 400ms 后正文完整出现——**不是上游坏了，是关掉 streaming 会触发一次全量重解析**，慢到 25ms 都不够。对刚生成完的消息，这等于在每条消息收尾的瞬间闪一下。收益（尾块不再 unstable）远小于代价，已整条回退，`streaming` 维持硬编码 true。

- **头像与壁纸搬出设置文件，改个字号不再重写 3.4MB**（`packages/app/src/context/settings.tsx`、`utils/persist.ts`，新增 `Persist.media`）：`persisted` 是**写穿**的——每次 setStore 都同步序列化整个 store 并走一条 IPC，主进程那边 electron-store 底下的 conf 对 get 和 set **都**要 readFileSync 整个文件 + JSON.parse（set 还要再 stringify + 原子写）。本机实测 `default.dat` 3.40MB，其中 `settings.v3` 占 3397.9KB，而这 3.4MB 全是四张 base64 JPEG：

  | 字段 | 大小 |
  |---|---|
  | `assistantProfile.avatar` | 1331.4 KB |
  | `appearance.homeBackground` | 754.4 KB |
  | `userProfile.avatar` | 695.7 KB |
  | `appearance.chatBackground` | 615.5 KB |

  于是改个字号、换个主题、切个开关，都要把这 3.4MB 在**主进程**上连读带写过一遍；主进程一卡，标题栏拖动、菜单、所有 IPC 一起卡——这也是为什么在渲染进程抓 CPU profile 只看得到 idle。

  改法：四张图挪进自己的 `RedCode.media.dat`（`Persist.media`），高频的小设置写的就只是几 KB。`Settings` 类型与设置页**一行都不用改**，变的只是这四个 accessor 从哪个 store 取值。存量搬家在两个 store 都就绪后跑一次，决策抽成纯函数 `planMediaMigration` 并单测：media 已有值就不覆盖（搬过了，旧值是陈的），但只要旧字段有值就一定清空——**清空这步才是 `default.dat` 真正瘦下来的地方，只搬不清等于留两份**。与 prompt-history 那条（0.10.x 的 `stripPromptHistoryImages`）是同一个病、不同的药：历史里的图是陈年草稿直接剔掉，这里是用户自己设的头像壁纸，必须原样留着。

  **实测否决，别再排期**：性能体检待办里的 A6「shiki 核心改动态 import，首屏 gzip 减约 15%（165KB/440KB）」**前提不成立**。改成动态 import 后重新构建对照，主 chunk 从 1,122.66 kB / gzip 387.46 kB 变成 1,130.50 kB / gzip **389.48 kB——反而大了 2 kB**。原因：`bundledLanguages` 只是一张 `{ 语言名: () => import(...) }` 的懒加载映射表，rollup 早就把每个语言 grammar 切成了独立 chunk（本次构建 406 个 chunk，`cpp-*.js` / `emacs-lisp-*.js` / `java-*.js` 各自成块），主 chunk 里根本没有语言表。动态化只是多包一层 promise。已回退。

### [0.10.16] - 2026-09-04

> 附件读取补上大小上限——PDF 此前原样透传进上下文，一道闸都没有。

#### 修复

- **附件分支补上大小上限——PDF 此前原样透传进上下文**（`packages/opencode/src/tool/read.ts`）：此前这里一道上限都没有——`fs.readFile` 读整个文件、base64 编码后直接挂进 attachments，文件多大就吃多大内存（base64 再涨 4/3，photon 解码还要再吃一份 宽×高×4）。

  **图片和 PDF 的下游待遇完全不同，所以两道线不同**。图片：`session/processor.ts` 的 tool-result 分支会对每个 `image/*` 附件跑 `Image.normalize`，那里有 5MB base64 硬上限、总像素预算、JPEG 质量阶梯自动降质，缩不下去就丢掉附件并告诉模型「omitted」——**进模型上下文这条路本来就有上限**，所以这里新加的 32MB 纯粹是内存闸门，超过它连读都不读。PDF：`processor.ts` 那个 `startsWith("image/")` 的条件把 PDF 排除在外，**它原样透传、不过任何缩减**，所以 PDF 的线必须画在 read 这里，且没有理由比图片的字节预算宽松——用同一条 5MB base64 线，反推回磁盘就是 3.75MB。图片能被缩放器救，PDF 只能直接拒。

  两者超限都不是报错：文件仍在磁盘上原封不动，只是不内联，output 说清楚是多大、超了哪条线，模型可以换别的方式取。三条用例钉住：超限 PDF 不内联且文件未被动过、预算内 PDF 照常内联、超限图片同样不内联。

### [0.10.15] - 2026-09-04

> A1 收口：`summary.diffs` 这条线的四步一次做完——先修好「打开老会话统计全归零」，再把每 step 的全量加载、重复重算、无上限增长、孤儿文件逐个拆掉。**不做 schema 迁移**（三份迁移方案的机制全拿 fatal，且 95% 历史快照已被 gc，存量不可重算），全部改在写入侧与读取侧。


#### 修复

- **快照 tree 缺失时 `diffFull` 显式失败，不再把会话统计抹成 0**（`packages/opencode/src/snapshot/index.ts`、`session/summary.ts`、`session/revert.ts`）：`diffFull` 里两次 `git diff`（`--name-status` / `--numstat`）此前**不查退出码**——同文件的 `diff()` 与 `diffCached()` 都查，唯独它漏了。快照是 `git write-tree` 出来的游离 tree（无 commit、无 ref），而 cleanup 每小时跑 `gc --prune=7.days`，本机实测 272 个带 step-start 的会话里 259 个首快照已 `missing`（95%）。此时 git 报 bad object、stdout 为空，`diffFull` 静默返回 `[]`，上游 `summarize()` 就把 session 的 additions/deletions/files 用空数组覆盖成 **0**——这就是「打开老会话，增删统计全归零」的根因。

  改法：新增 `Snapshot.DiffError`（tag `SnapshotDiffError`，带 from/to/exitCode/stderr），两处 git 调用退出码非 0 即 `log.warn` + 失败。`summarize()` 捕到它就**什么都不写**（统计保持上一次的真值，`session_diff` 文件、总线事件、消息行都不动）；`revert()` 捕到它按空数组处理（与改前行为一致——revert 已经把工作树改回去了，摘要只是附带产物，别让一次 gc 把整个 revert 打回）。`computeDiff` 的错误通道随之显式化；测试桩 `it.instance` / `withTrackedSnapshot` 对错误通道是泛型的，14 处既有 `diffFull` 测试调用不受影响。新增用例：用全零哈希当 `to`，断言拿到 `SnapshotDiffError` 且 exitCode ≠ 0。

  这一条同时是后面「`(from,to)` 指纹短路」的前置条件：不修它，短路会把一次 gc 后的 `[]` 当成真结果永久缓存。

#### 优化

- **`summarize()` 不再每 step 全量加载整个会话**（`packages/opencode/src/session/message-v2.ts` 新增 `snapshotParts`、`session/summary.ts`）：diff 端点只需要 step-start / step-finish 分片里的两个 snapshot 哈希，却一直靠 `Session.messages()` 把整个会话的 message 行 + part 行全量读出、逐行 `JSON.parse` 再扫出来。user 消息行里躺着 `summary.diffs`（本机最大单行 32.5MB），而 `summarize()` 每个 step-finish 跑一次——**每 step 都把历史所有轮次的 diffs 读回来解析一遍，O(步数 × 会话累计 diffs)**。这是 A1 调研定出的每 step 真正的大头，不是行重写。

  改法：`MessageV2.snapshotParts(sessionID)` 一条查询——只查 part 表、在 SQL 里 `json_extract` type/snapshot，JOIN message 拿 `time_created`（列，不读 data）与 `parentID`。**`parentID` 的 `json_extract` 只会落在有 step 分片的消息上，也就是 assistant 行，它们没有 diffs blob；user 行的 data 一个字节都不碰。** 本轮成员改由 `parentID === messageID` 切出（与原来 `Session.messages()` 后的过滤逐字同义：assistant 消息每 step 一条、`parentID` 指向本轮 user 消息）。目标 user 消息的整行只在真要重写它时才 `MessageV2.get` 一次；本轮指纹命中时连这一行都不加载。排序 `(message.time_created, message.id, part.id)`，与 `Session.messages()` + `hydrate` 一致，也守本仓「先后用 compareTime、ID 只做 identity」的约定。

  本机副本实测最大会话（36 条消息 / 32.6MB message.data / 151 个 part）：端点查询 **60 行 1.2ms**；对照原路径读全部 `message.data` 85ms + `JSON.parse` 106ms ≈ **190ms/step**，还没算 hydrate 全部 part。`revert()` 用的 `computeDiff` 保持原样（它本来就只对一段范围算）。新增 DB 夹具用例两条：只出带 snapshot 的 step 分片（无 snapshot 的与 text 分片被滤掉）、按消息时间序 + 分片序、`parentID` 能把本轮切出来；空会话给空表。

- **`summarize()` 按 `(from,to)` 指纹短路：工作树没变的 step 不再重算、不再重写**（`packages/opencode/src/session/summary.ts`、`session/revert.ts`）。`summarize()` 每个 step-finish 跑一次（`processor.ts`），此前每次都无条件做完整条尾巴：两次 `diffFull`（各起 3+ 个 git 子进程、串行排在同一把 gitdir 信号量后面）、`sessions.setSummary`、`session_diff` 文件 `JSON.stringify(x, null, 2)` 全量重写、user 消息行整行重写、两条大 payload 广播。本机副本实测那条 32.5MB 的消息行单次重写 **129ms**，`session_diff` 目录里最大一个文件 33MB——而一轮里多数 step 只读不写，这些活全是重复的。

  依据：git tree 是内容寻址的，工作树没变 `write-tree` 给同一个 hash；`diffFull(from,to)` 只读两棵 tree、不碰工作树，所以 `(from,to)` 不变 ⇒ 结果必然不变。会话级与本轮级各记一个 `(from,to)`，命中时：**会话级**跳过重算 / `setSummary` / 文件重写，但**照发 `Session.Event.Diff`**（TUI 的 Files 侧栏只靠这条事件填充，`tui/context/sync.tsx` 的 `"session.diff"` 分支没有 fetch 兜底，后接入的客户端等的就是它）；**本轮级**直接返回，跳过整行重写与 `message.updated` 大 payload（消息行有库可读，不依赖事件）。

  对抗审查点出的三个坑逐条避开：不 memo `sessionFrom`（每次从 parts 重扫，新会话不会被钉成 undefined）；只在 `diffFull` 成功后写 memo（配合上一条，快照被 gc 后的 `[]` 不会被固化）；有界——会话级条目挂着整份 diffs，LRU 只留 4 个，本轮级只存两个 hash、上限 256。`revert()` 改写 `session_diff` 文件后调用 `SessionSummary.invalidate(sessionID)` 让会话级 memo 失效，否则下一步若恰好命中旧条目会跳过文件重写、留下文件与事件不一致。

  验证：memo 语义（精确匹配 / LRU 淘汰 / 失效）4 条单测；`snapshot-tool-race` 走真实 summarize 路径 1 pass；opencode typecheck 干净。**未做的**：命中率没有在活会话里实测，上面那些是各组件的单项实测成本；`summarize()` 开头那次无 limit 的全会话消息加载（O(步数 × 会话累计 diffs) 的 JSON.parse）这次没动，是下一步。`Session.Event.Diff` 命中时照发意味着 SSE 上那份 30MB 级 stringify 仍在——要摘掉它得先给 TUI 补一个进会话时的 fetch，属于另一件事。

- **每轮 / 每会话的 patch 正文加总量上限；TUI 进会话只拉元数据；指纹命中不再广播；session_diff 孤儿文件跟着会话删**（A1 第 3/4/5 步，`packages/opencode/src/session/summary.ts`、`session/revert.ts`、`session/session.ts`、新增 `session/session-diff-gc.ts`、`server/routes/instance/httpapi/{groups,handlers}/session.ts` + `public.ts`、`cli/cmd/tui/context/sync.tsx`、`index.ts`、SDK 生成物）。

  **上限（第 3 步）**：副本实测 1,920 条带 diffs 的 user 行，本轮 patch 总量 p50 14KB / p90 158KB / p99 1.0MB / 最大 30.7MB；最大那条是 **6,526 个文件、单文件最大 377KB**——snapshot 里那道 256KB 的单文件上限管不住「文件多」，所以按总量管。`capPatches(diffs, limit)`：超限**不丢文件条目**，file/additions/deletions/status 全留，只把最大的几个 patch 清成 `""`（snapshot 对二进制 / 超大文件早就在用的「没有正文」记号，`app/utils/diffs.ts` 与 `ui/session-diff.ts` 两侧都认）。本轮 1MB（只碰 1.1% 的轮次、拿掉 28% 的字节），会话级 4MB；`revert()` 改写 session_diff 时走同一道。统计从完整结果算，增删数不受影响。**只对新写入生效，存量一行不动**——不做 schema 迁移是定案（三方案迁移机制全 fatal、95% 历史快照已 missing）。

  **TUI fetch 回来（第 4 步）**：diff 端点新增 `?patch=false`，只回元数据（OpenAPI 覆盖表登记为 boolean，SDK 侧 `patch?: boolean | "true" | "false"`，与 `roots` 同款）。260903 因为带正文的那份能到 33MB、TUI 卡 23s 把进会话的 fetch 删了，此后 Files 侧栏只靠 `session.diff` 事件填充，服务端不得不在指纹命中时也照发大 payload。现在 `sync()` 用 `patch: false` 拉一次填侧栏；`summarize()` 会话级命中时**不再广播**，事件只在 diff 真变时才发——SSE 上那份 30MB 级 stringify ×2/订阅者 随之消失。会话级 memo 不再挂整份 diffs，两级都只存两个 hash、LRU 各 256。

  **孤儿（第 5 步）**：`Session.remove` 此前只删库行不删 `storage/session_diff/<id>.json`，本机 615 个文件里 **178 个（21.7MB）** 是已删会话的孤儿。remove 现在跟着删；`SessionDiffGc.sweep()` 在 CLI 入口（JSON→DB 迁移之后）每次启动跑一遍补历史欠账，几毫秒、不阻塞命令。两道保险都冲着「测试洗掉 live 数据」那族事故：只挂在 CLI 入口不挂 Layer（测试构建 Session layer 碰不到它）；库里一个会话都没有就什么都不删（空库时「全是孤儿」大概率是目录指错了）。量过「美化重写」那条：前 40 个大文件 pretty 68.2MB vs compact 67.5MB，**空白只占 1%，不值得改**——真成本是重写本身，已被指纹短路挡掉。

  **顺带**：`from === to` 直接给空 diff，不再起 2 个 git 进程去证明恒等式。

  验证：`capPatches` 4 条（不超限原样返回 / 最大优先清空 / 连清多个 / 按字节不按码元）、`diff({patch:false})` 去正文留元数据、`Session.remove` 删文件、TUI sync 断言改成「只请求不带正文的那种」；summary-snapshot-parts / snapshot-tool-race / snapshot / httpapi-session 全过；`revert-compact` 那两条红是基线就红的存量（stash 对照过，`docs/agent-roles-plan.md` 也记着）；opencode + sdk typecheck 干净。live 上跑了一次 sweep：615 → 437 个文件。**未做的**：UI 对被清空的 patch 没有专门提示（展开就是空 diff，与超大文件今天的表现一致）；4MB 会话级上限会让「大会话 review 面板里最大的几个文件没正文」，要提示得动 `FileDiff` schema，本批不做。

### [0.10.14] - 2026-09-04

> gpt-5.6 三个变体一直只能选到 xhigh，codex 自己的滑块却有顶档「最高」。

#### 修复

- **gpt-5.6 补上 max 档**（`packages/opencode/src/provider/transform.ts`）：GUI 的推理强度滑块与 TUI 的变体列表里，`gpt-5.6-luna` 最高只到 xhigh。逐档打真请求测出来的（Codex 后端、ChatGPT Plus 账号）：三个变体 `none / low / xhigh / max` 全部 200；`gpt-5.5` 与 `gpt-5.4` 请求 max 直接 400（报文自陈「不支持」）。所以 max 只挂 5.6 及以上，不扩到整个 5.2+；`none` 保留——实测 200，且 400 报文自报的支持集里就有它。

  ⚠️ 一并记下一个陷阱：`GET /backend-api/codex/models` 返回的 `supported_reasoning_levels` 给 sol 和 terra 列了 `ultra`，但这三个模型实际请求 ultra **一律 400**，报文自报的集合里根本没有它。**那个字段不能当实情用**——要么是更高订阅档才开放，要么名单本身不准。加新档位前一律发一次真请求验，别读字段。新增四条用例钉住：三变体到 max、都不给 ultra、5.5/5.4 不给 max、更高版本自动跟上。

### [0.10.13] - 2026-09-04

> MCP 协议里服务器自己写的「这套工具整体是干什么的」，本仓从接入那天起就没读过。

#### 新增

- **读取并注入 MCP 服务器自报的用途说明**（`packages/opencode/src/mcp/index.ts`、`session/prompt.ts`、`session/prompt-caches.ts`）：MCP 的 initialize 响应里有 `instructions` 字段——服务器自己写的「这套工具整体是干什么的、什么时候该用」。本仓此前完全不读它，mcp 模块零引用。实测本机的 jcodemunch 提供 931 字符，从接入那天起就丢在地上；模型只能从逐条工具描述里拼凑整体意图，而那些描述还会被 `tool.definition` 钩子截断。

  三个实现约束都是冲着**前缀缓存稳定性**去的：磁盘缓存（`mcp-tools/<server>.json`）与工具定义同批写入 instructions，**断线期间和连上之后必须拿到同一段文本**，否则系统提示词随连接状态抖动、整个前缀缓存被打掉（与 `convertMcpToolCached` 那句「description 必须字节级一致」是同一条约束）；`MCP.instructions()` 走 cache-first 并按服务器名排序固定顺序（`Object.entries` 的顺序变化同样会废掉前缀）；不拼进工具描述而是单独成块——拼进去要在两条转换路径上同步维护同一段文本，稍有出入就在重连时炸缓存。代价写明：**会话开始后才连上的服务器要等下一个会话才带上说明**，这是为前缀稳定性主动选的。

  模型可见改动按 `AGENTS.md` 四问过了一遍。其中第 ③ 问：这条会让所有会话的固定前缀**作废一次**（新增一段落在 instructions 之后、skills 之前），一次性，不是每轮不稳定——块内容按会话缓存。

#### 修复

- **给 MCP 服务器说明加硬上限**（`packages/opencode/src/mcp/index.ts`）：上一条的四问第 ④ 问答的是「没有硬上限，已知缺口，留待补」。**这是把缺陷写成待办**——仓里的规矩是没有上限就当场加，不进待办池。文本长度由第三方 MCP 服务器决定、本仓无从约束，而它直接进模型上下文。`MAX_INSTRUCTION_CHARS = 2000`（本机唯一提供者 931 字符，给足余量又挡得住写长篇的服务器），两处捕获与磁盘缓存回落路径都过它；超限从尾部截断并标注截断字符数，别让模型以为自己看到的是全部。

### [0.10.12] - 2026-09-04

> 权限弹窗「点不动」定案（潜伏三个月、9-03 第一次被踩上），外加子代理超时不再烧掉已产出的结论。合并了此前 [未发布] 段的两条。

#### 修复

- **权限/提问弹窗点了没反应——真凶是回复找不到发出请求的那个实例**（`packages/opencode/src/permission/index.ts`、`question/index.ts`）：症状是隔离 worktree 里的子代理弹出授权框后，点 Allow once / Allow always / Reject 全无反应，键盘也一样；按 esc 甚至会穿透到全局绑定把主会话掐掉。服务端日志的签名是 `permission.asked` 之后**一条 `permission.replied` 都没有**。

  根因：`Permission` / `Question` 的 `pending` 表挂在 `InstanceState` 上，**按实例目录分**。子代理在隔离 worktree 实例里 `ask`，条目落在那个实例的表里；而 TUI/GUI 的回复按 **workspace** 路由，`runIsolated` 只 provide `InstanceRef` 不动 `WorkspaceRef`——worktree 与父目录**共享同一个 workspace，只有 directory 不同**。于是回复落到父实例，`pending.get` 拿不到，一律 `NotFoundError`。09-03 的 `e3dffe24`（回复原路发回 ask 的那个 workspace）修的是真缺陷，但堵的是「发错 workspace」那半边，对「同 workspace、不同目录」无效。

  改法：模块级 `owners` 登记 `requestID → 拥有它的那份实例状态`，`ask` 时登记，`reply`/`reject`、中断的 `ensuring`、实例销毁的 finalizer 三处注销。`reply` 在本实例找不到就按登记去拥有者那份状态里处理——**先从拥有者的表里删再 resolve**，否则拥有者那边的 `ensuring` 会补发一条假的 reject。「始终允许」也记进拥有者的 `approved`。走到跨实例路径记一条 `reply routed to owning instance`，下次现场一行日志定案。 三条路径的分诊顺序与各自的日志判据见 `docs/notes/implemented/bug-fix/2026-09-04-permission-popup-dead-cross-instance.md`。

  **这个缺陷自 26-06-10 worktree 隔离上线起就潜伏着**，直到 09-03 16:28 第一次真正被走到（`~/.redcode/data/worktree/` 下目录的创建时间是唯一可靠的「何时开始用」证据；08-11 有过一次但那轮没触发权限询问）。

- **子代理超时不再丢弃已经产出的结论**（`packages/opencode/src/tool/task.ts`）：`Effect.timeoutOption` 只回答「有没有按时完成」，中途产出一律丢弃。实祸：一次 explore 审计被掐断时，子会话里已有 **6 条助手消息、38 个 part** 的真实结论，父会话只收到一句 `Subagent timed out`，只能自己从头重做——主备各掐一次，六分钟白烧，而结论一直躺在库里（TUI 里 ctrl+x 就能翻）。

  改法：超时后先 `salvageOutput` 把已产出的助手文本读回来，捞得到就带「这是半截、自行判断覆盖够不够、不许当成完整调查转述」的告诫交给父会话，捞不到（真卡死、一个 token 都没吐）才按硬失败报。上限 `SALVAGE_MAX_CHARS = 24000`，超限**保留尾部**（结论累积在后面，开头多是复述任务与检索过程）并在截断处写明丢了多少字符。顺带补上兑底模型超时后缺的那次 `ops.cancel`（主模型那条早就有，兑底这条一直漏着，残留的进行中请求会继续占住子会话）。

- **空闲看门狗别把「本地在干活」当成网关停摆**（`packages/opencode/src/session/llm.ts`）：0.10.11 引入的回归。看门狗只看「两个事件之间隔多久」，而工具执行与等待用户授权这段时间里流本来就不该有新事件——于是一个正在等你点授权的回合会在 120 秒被判成网关停摆掐掉。改法是给它一个本地态：任何 `tool-input-*` / `tool-call` 事件进入本地态，`tool-result` / `tool-error` 退出，`text-*` / `reasoning-*` / `step-*` 这些只有网关才发得出的事件也顺带清掉；本地态期间不计时。不押上游 AI SDK 的 enqueue 顺序。

- **权限/提问的回复失败不再静默**（`packages/opencode/src/cli/cmd/tui/routes/session/{permission,question}.tsx`）：六处 `void sdk.client.permission.reply(...)` 不看返回、不 catch、不提示，服务端报什么错都一声不吭——上面那个跨实例缺陷之所以查了两天，一半原因在此。收进带 catch 的 `send()`，失败弹 toast。

- **权限弹窗期间点到输入框不再抢回焦点**（`packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx`）：弹窗期间输入框保持挂载（卸载会连正在打的字一起销毁），靠 `disabled` 触发一个 effect 让出焦点——textarea 在 disabled 时 `onKeyDown` 是 `preventDefault` 直接吞键，占着焦点会让弹窗收不到任何按键。缺的另一半是 `onMouseDown` 无条件 `r.target?.focus()`，而那个 effect **不订阅 `input.focused`**，焦点被鼠标抢回去之后它不会再跑；弹窗按钮那排紧贴输入框上沿，点偏一行即命中。判定抽成 `mustYieldFocus()` 两处共用，`onKeyDown` 的 disabled 分支加自愈（吞第一键时立刻 blur）并留一条 warn。

  ⚠️ **这条不是当天那次「点不动」的根因**——埋的 warn 一次都没打出来，真凶是上面的跨实例问题。它是同一症状的另一条真实路径，独立成立。

- **GUI 超过 100 条的会话不再静默丢历史**（`packages/app/src/context/global-sync/{types,event-reducer,session-cache,child-store}.ts`、`context/directory-sync.ts`）：`event-reducer` 的每会话 100 条上限会把最旧的消息连同 parts 从内存里 `shift` 掉，代码注释写着「历史可经 `loadMore` 随时回拉」——**这句话在修之前不成立**。

  分页层的 `meta.cursor` / `meta.complete` 记的是「服务端给过什么」，对内存里被自己扔掉的那些一无所知。一个已经拉全的会话（`complete === true`）在流式跑过 100 条之后，`history.more()` 第一行就 `if (meta.complete[key]) return false`，「加载更多」根本不出现，`loadMore()` 即使被调用也在同一处早退。结果是消息无声消失、且**没有任何途径拉回来**，除非整页重载。

  改法：state 加一个 `message_trimmed[sessionID]`，截断时标记；`history.more()` 见到标记就返回 true（绕过 `complete`），`loadMore()` 改用**内存里现存最旧的那条**当游标往回补，成功后清标记。`dropSessionCaches` 一并清理该标记，避免会话整体驱逐后留下假阳性。新增两条用例（跨过上限时标记置位 / 未跨过时不动）。⚠️ 已知局限：拉回来之后若会话仍在流式推进，下一条 `message.updated` 会再砍一次；彻底解法是让上限跟着「用户显式加载过的长度」走，未做。

  **同一条待办里的性能那一半（「`message.updated` 定位改 Map」，记为每 step 省约 12ms）经实测否决**：100 条消息的 Solid store 上 `findIndex` 全扫一次 **0.5 µs**，与普通数组同数量级（proxy 几乎不额外收费），要凑够 12ms 得每 step 两万四千次 `message.updated`。定位不是瓶颈，改 Map 属于纯 churn，没做。真要追那 12ms，下一个该量的是 `reconcile(info)` 的深比较与它触发的下游重算。

#### 新增

- **朱印落地**（`packages/ui/src/assets/brand/`、`script/brand/rasterize-mark.mjs`、两处 favicon 目录、`packages/app/src/components/titlebar.tsx`、`packages/docs/docs.json`）：09-03 设计完就没进过仓，这次补上。

  分工按当时拍板的来——**标志负责「认出来」，看板娘负责「有性格」**：朱印只吃小尺寸、陌生环境那一类（浏览器页签、PWA、GUI 标题栏署名、文档站），启动画面 Splash、「任务已接收」贴纸、README 头图仍是赤，**桌面端应用图标也保持赤**（`packages/desktop/resources/icons` 一个字节没碰）。

  `script/brand/rasterize-mark.mjs` 把几何直接栅格化成 PNG/ICO：仓里没有 SVG 栅格化依赖，而这标志只有四种图元（闭合贝塞尔填充、多边形填充、圆头折线描边、圆角矩形填充），自己画比引依赖划算；4 倍超采样 + 盒式下采样。**≤32px 自动走简化刻本**（去掉右上崩口与印边留白，那两处在 16px 下只会让边缘发毛），maskable 那两档留 10% 安全区。改标志先改 SVG 再同步几何，不一致以 SVG 为准。favicon 一套换代 v3 → v4，两份目录同步，v3 删除。文档站主题色从 Mintlify 模板绿 `#16A34A` 换成朱红 `#C8322B`（favicon 09-03 已是朱印，颜色一直没跟上）。

#### 工具链

- **新增 `script/sync-home-scripts.bat`：只做 `seed/scripts` → `~/.redcode/scripts` 的镜像**。`sync-home.bat` 里那两行原地拆出来，`sync-home.bat` 改为 `call` 它，行为不变。

  背景：260901 起 `seed/scripts` 是这批脚本的唯一权威、私仓不再跟踪它们（`RedCode-private` 的 `.gitignore` 加了 `scripts/`）。**于是 `git pull` 会把家目录里的工作副本删掉，而唯一能放回去的镜像只在 build 时跑**（全仓只有 `packages/opencode/build.bat:2` 和 `packages/desktop/build-and-package.bat:2` 调 `sync-home.bat`）——删得到、补不上。在一台只拉取不构建的机器上，这批脚本就此消失，`/recall` 静默失效（`~/.redcode/command/recall.md` 直接 `node "$HOME/.redcode/scripts/recall-memory.mjs"`）。本机实测确认过：拉完只剩 `export-memory-backup.mjs`，另外三个（`recall-memory.mjs`、`check-memory-dualwrite.mjs`、`hooks/pre-commit`）都不在。

  现在拉完直接跑 `script\sync-home-scripts.bat` 即可，不必为了几个脚本走整套构建（`sync-home.bat` 还会跑版本一致性检查与配置合并器）。⚠️ 仍未自动化的一步：`~/.redcode/.git/hooks/pre-commit` 是从 `scripts/hooks/pre-commit` **手工拷**过去的，镜像只负责把源放回 `~/.redcode/scripts/hooks/`。

#### 已知问题

- **`agent.explore.timeout_ms` 若在用户全局配置里写死会压过仓库定义**。本机那份写着 180000，压着 `explore.md` 的 600000（260828 提高的，理由是 explore 吸收出方案/做审查之后「读一圈再出结论」比纯搜索慢得多）。实祸：09-04 一次审计被 180 秒掐断，日志显示兑底模型首字 5–7 秒、一路在出结果，是**误杀不是卡死**；主备各掐一次共六分钟。已在本机删掉该覆盖改为跟随仓库定义。配置不在仓库里，代码改不掉，只能记在此处提醒：升级后若发现 explore 频繁三分钟超时并转兑底，先查自己的 `~/.redcode/redcode.jsonc`。

### [0.10.11] - 2026-09-03

> 性能体检落地第一批 + 一个长期潜伏的挂起缺陷。合并了此前 [未发布] 段的三条。

- **流中途静默不再无限挂起**（`packages/opencode/src/session/llm.ts`、`session/retry.ts`，新增 `test/session/llm-idle-guard.test.ts`）：症状是会话跑到一半彻底停住、界面只显示忙碌、一挂十分钟，库里的签名是 assistant 消息建了、`finish` 空、输出 0、`time.completed` 恒 null。

  根因两层。① **原有的 75 秒看门狗是一次性的，而且几乎立刻就被满足**——`Stream.tap` 对流里任何元素都兑现 firstEvent，协议层第一个事件转瞬即到，此后整条流再无保护。② **掐断之后不重试**：`FirstEventTimeoutError` 既不是 APIError、文案也不匹配 retry.ts 任何一条限流模式，`retryable()` 落到末尾 `return undefined` 直接 halt，用户等满 75 秒看到的是报错。

  取证是**两个不同模型的同一签名**（所以是传输层缺口，不是某家模型的毛病）：`hy4-preview` 一轮末条消息一个分片都没有却挂了 575 秒（首事件看门狗本该 75 秒开火）、另一轮分片有 step-start/reasoning/text/tool 而流中途断掉；`muse-spark-1.3` 合成任务一轮挂 9 分 40 秒。挂起率与任务重量强相关：7 步的任务 8 次挂 1 次，13–24 步的 4 次挂 3 次。

  改法：看门狗改成**每来一个事件就重置**，首事件仍给 75 秒（TTFT 本来就长），之后两个事件之间给 120 秒——它要挡的是「永远不再来」不是「来得慢」。新增 `StreamIdleTimeoutError` 带实际静默毫秒数。`retryable()` 按 `_tag` 认这两类可重试（走 tag 不走 instanceof：Err 已过 Cause 归一化，跨模块类实例判等不可靠）。仍不用 `Effect.race` 拼失败分支（v4 语义会挂住流，260816 踩过），也不用 `Stream.timeout`（掐总时长会误杀长回答，新测试有一条专门守这个区别）。测试用真时钟——`it.effect` 的 TestClock 下 `Effect.sleep` 永不推进会挂死进程。**做过反向对照**：把看门狗降级回一次性逻辑，「中途静默」判红且耗时 30010ms（一路等到 sleep 自然结束），修复后 400ms 掐断。

#### 优化

> 本批来自一次六维度全量性能体检（数据库 / 服务端热路径 / 单轮交互链 / GUI 渲染层 / Electron 外壳 / TUI）。共同结论：**渲染没问题，主线程在等自己**——最贵的几处都是本来不必做的重复工作。

- **step-finish 的两次 `git add` 合并成一次**（`packages/opencode/src/snapshot/index.ts`、`session/processor.ts`）：原先是 `snapshot.track()` 紧接着 `snapshot.patch()` 两次独立调用，而两者**各自都跑一遍 `add()`** —— 那是一个 step 里最贵的一段（sync + diff-files + ls-files + check-ignore + 逐文件 stat + git add，Windows 上每个 git 进程 30ms 起步）。两次调用之间只有内存记账与写会话库（会话库在 `~/.redcode/data`，不在被跟踪的工作树里），**工作树一个字节都没变**。

  新增 `Snapshot.finish(from)`：一个 locked 块里 add 一次，同时产出完成快照（write-tree）与相对起点的补丁（diff --cached）。顺带把重复片段抽成 `ensureRepo` / `writeTree` / `diffCached`。合进同一个锁还堵了一个隐患：原先两次调用之间锁是放开的，中间若有别的 fiber 动了索引，patch 算的就不是刚 write-tree 那棵树。⚠️ `patch()` 自己那个 `add()` **不能删**——`cleanup()`（流中断/出错的收尾路径）直接调它。

  实测（500 文件的临时工作树 + 临时 gitdir，不碰仓库自己的 `.git/index`）：6 个 step 的 hash 与文件列表逐条一致，232–244ms → 125–157ms，**每 step 省约 105ms**。刻意没做把完成快照直接当下一 step 起点——那在「用户两个 step 之间手动改了文件」时会把改动错算进下一个 step，是行为回归不是优化。

- **`filterCompacted` 边扫边停**（`packages/opencode/src/session/message-v2.ts`）：第一行 `[...msgs].sort(...)` 把 `stream()` 这个分页生成器**整个物化**，于是后面「扫到压缩边界就 break」一页 DB 读都没省。而 `stream()` 本就是逆序产出（`page()` 内部 desc 取、逐页回溯），排序对它是恒等变换。

  拆成两个入口：数组入参走 `filterCompacted`（先归一化，`compaction.ts` 传的是展示序，**这条排序不能删**）、逆序流走 `filterCompactedOrdered`（直接懒扫）。实测 2,612 条消息的会话：全量 53 页 33.7MB **202ms** → 按边界懒停 14 页 7.4MB **45ms**。新增三条用例，含「命中边界后不再从生成器取值」。

- **分片落库不再无条件回读整行**（`packages/opencode/src/session/projectors.ts`）；**bus 的 `publishing` 日志降到 debug**（`bus/index.ts`）：前者每次 `updatePart` 都先 `select *` 读旧行全部 `data`，只为判一下 `type === "step-finish"`；带 3MB base64 图的 tool part 单次 29ms 里有 6–7ms 花在这个预读加 JSON.parse 上。后者在每次 publish 上无条件记一行 INFO，流式期间约 90 行/秒。

#### 修复

- **权限弹窗不再变成点不动的幽灵**（`packages/opencode/src/permission/index.ts`）：症状是弹窗出来后 Allow once / Allow always / Reject 全无反应，键盘快捷键一样，日志里一条 `permission.replied` 都没有。

  链路是 explore 子代理的超时兑底：主模型（step-3.7-flash）跑到 `timeout_ms` 被 `Effect.timeoutOption` 掐断，提问方的 fiber 一起被打断，`ask` 的 `Effect.ensuring` 收尾**只做了 `pending.delete`、不发任何事件**。而 TUI/GUI 摘弹窗只认 `permission.replied` —— 屏幕上那个弹窗于是对应一个服务端早已不存在的 `requestID`，点它拿回 `NotFoundError`，调用点又是 `void` 不看返回，失败得一声不吭。随后 fallback 模型重跑、又问一次，用户看到的是"点了没反应还越点越多"。

  改法：收尾里 `delete` 返回 true（= 不是正常 reply 路径删的）时补发一条 `permission.replied(reject)`。正常 reply 已经删过并发过事件、返回 false，不重复发；实例关停的 finalizer 先 `clear` 再唤醒等待方，同样返回 false，不会刷事件。

  ⚠️ **触发它的那一半在用户配置里，代码改不掉**：`agent/definition/explore.md` 的 frontmatter 早在 260828 就把 `timeout_ms` 从 180000 提到 600000（原注释：「explore 吸收了 advise 的出方案/做审查之后，180s 会误杀真在干活的运行」），但 `~/.redcode/redcode.jsonc` 里仍留着一条 `agent.explore.timeout_ms: 180000`——配置层赢过 md，旧值一直生效。于是 explore 每次跑满 3 分钟就被掐、由 `fallback_model: opencode-go/glm-5.3-flash` 接手重跑，表现是「子代理明明配的 step，跑着跑着变成 GLM」，同时留下上面那个幽灵弹窗。DB 佐证：08-26 之后的 explore 子会话清一色 `step-3.7-flash`，只有 2026-09-03 16:28 这一条是 `glm-5.3-flash`。**待办：删掉全局配置里那行 `timeout_ms`，让 md 的 600000 生效。**

- **权限/提问的回复原路发回 ask 的那个 workspace**（`packages/opencode/src/cli/cmd/tui/`）。

- **补全面板展开时首页 logo 让位**（`packages/opencode/src/cli/cmd/tui/routes/home.tsx`）：绘制先后压不住，改为布局层让位。

- **后台任务续跑的等待加上限，超时不再静默挂着**（`packages/opencode/src/tool/task.ts`）：`resumeWhenIdle` 原本是**无上限**的 300ms 递归——后台子代理跑完后要等父会话空闲才自动续跑，而会话若因别的原因永不 idle，它就永远等下去，且**不超时、不报错、不记日志**，与本仓冻结族同一种气味。

  超时**不丢结果**：`inject()` 已经先把合成结果落进会话（`noReply: true`），这里等的只是"替用户按下继续"这一步。所以超时的正确行为是放弃续跑 + 弹 toast 告诉用户结果已就绪、发条消息即可接上——把静默挂起变成可见且可操作的状态，另记一条 `logWarning` 供排查。

  上限取 30 分钟：单轮跑这么久已属异常，而更短会误杀正当的长任务（压缩阈值 400K，一轮几十次工具调用是常态）。计时用 `Clock.currentTimeMillis` 而非 `Date.now()`，这样 TestClock 能拨动、这个上限才写得了测试——「存在但没人验过的开关」在本仓有过前车（`appProcess.run` 的 timeout），且与 `background/job.ts` 的用法一致。

  顺带澄清一个容易查反的地方：**后台任务跑完自动唤醒父会话这套机制是完整存在且默认开的**（`experimentalBackgroundSubagents` 是 `boolDefaultTrue`）。唤醒代码在 `tool/task.ts`（`inject` + `resumeWhenIdle` + toast + `ops.loop`），**不在** `background/job.ts`——后者的 `finish()` 只 resolve 一个 `Deferred` 供 `task_status(wait=true)` 消费，只看它必然误判成"没人被通知"。

- **补 `generation` 守卫，防两个重连循环并发开连接**（`packages/app/src/context/global-sdk.tsx`、`server-sdk.tsx`）：对照 opencode（已分叉两个多月）发现本仓缺一处它有的守卫。`started` 那个布尔只挡得住 start() 被连着调两次，**挡不住 stop() 之后再 start() 时旧循环还没退出来**——stop() 把 `started` 置 false，可旧循环正卡在 `await wait(...)` 或 `for await (...)` 上，要等它自己转到检查点才退，这中间新循环已经起来了，两个循环同时在开连接。

  本仓比上游更容易踩到：**两条 SSE 流**各有这个问题（上游只有一条，最坏 4 个循环 vs 2 个）；`server` 变化时（切目录／切服务器／sidecar 重生）就是一轮 stop→start；退避最长 2 秒意味着旧循环最久要 2 秒才醒来检查，窗口比上游固定 250ms 大八倍。叠上 Chromium 同 host 6 连接的上限，多余的循环会加速吃满槽位。

  连带抄了 opencode 的 `run !== current` 守卫：旧循环的 `finally` 不能把新 run 的引用清掉——同一族缺陷。顺带一提，前一条修的那处收尾不对称（`finally` 里不 abort）**是从上游继承的**，opencode 现在仍然如此，不是本仓写错的。

  这条与前一条同样**不依赖连接池假设成立**：「stop 之后旧循环可能还在跑」本身就是错的。两条合起来才完整——abort 管连接及时释放，generation 管不会有多余的循环去开连接。

- **SSE 流正常结束时补上 `abort()`**（`packages/app/src/context/global-sdk.tsx`、`server-sdk.tsx`）：两个文件的重连循环里，`finally` 只把 `attempt` 置 `undefined` 而不 `abort()` —— 同一文件其余五处（stop／心跳超时／onCleanup）**都 abort**，唯独"流正常结束"这条不。AbortController 是保证底层 fetch 被拆掉的唯一把手，置空只是让 GC 有机会回收，不保证 socket 立刻关。

  **旧结论解释不了一半症状**：09-02 按"重连被 SDK 架空"修掉（`65582cc9`）之后当晚又犯，症状逐条相同。而 SSE 是**入站**通道，"消息发得出但不落库""Esc 无效"是**出站** HTTP —— 两者一起死说明有共用资源被占死。

  假设（**未证**）是 renderer 连接池耗尽：sidecar 是 `node:http` 的 HTTP/1.1；本地场景 `eventFetch` 恒为 `undefined`（只有非 loopback 才走 `platform.fetch`），两条常驻 SSE 都占着 Chromium 的池，而同 host 只有 6 个槽；重连 `RECONNECT_BASE_MS = 256`。旧连接不释放 + 紧循环 ⇒ 槽位吃光 ⇒ 之后所有到该 origin 的请求无限排队，服务端毫发无伤所以任务照常推进。这也解释了 **TUI 为什么从不犯**（默认走 worker RPC，`createWorkerFetch` / `createEventSource`，根本不建 socket）、**为什么偏偏是配置更好那台**（紧循环与竞态，快机器更容易中招），以及**为什么 `65582cc9` 之后反而当晚就犯**（退避从 SDK 的 3 秒变成上层的 256ms）。

  本次只修已证的收尾不对称，**不依赖假设成立**。复发判据：renderer DevTools → Network，**Stalled/Queueing = 池满**，**Pending = 服务端不回**（另一回事）。note 见 `docs/notes/implemented/bug-fix/2026-09-03-sse-abort-on-stream-end.md`。

### [0.10.10] - 2026-09-03

> 一次覆盖数据库 / 服务端 / 单轮交互链 / GUI 渲染层 / Electron 外壳 / TUI 六个维度的性能体检，以及从中挑出的**收益÷改动量最高的四条**的落地。体检本身的完整结论、对照实验与「查过没问题」清单不在这里，四条落地的实证如下。
>
> 共同结论：慢的地方基本不是算力不够，是在做本来不必做的重复工作 —— 一个缺失的复合索引、一个从未落盘的编译缓存、一个每条 delta 重扫全文的检测、一组订阅了会话级信号的逐轮 memo。

#### 优化

- **part 表索引从 `(session_id)` 换成 `(session_id, id)`**（`session/session.sql.ts`、新增迁移 `20260903032902_part_session_id_index`）：`recentToolParts`（`message-v2.ts:1101-1120`）查的是 `where session_id=? order by id desc limit N*8`，单列索引让 `EXPLAIN` 明写 `USE TEMP B-TREE FOR ORDER BY` —— 每次把该会话全部分片扫一遍再排序。调用点两个（`processor.ts:544` 空转检测、`:658` 重复调用提醒），所以**每个工具调用跑两遍**。

  活库副本实测（10,299 分片的会话，与生产同 pragma）：**36.61ms → 0.138ms，266 倍**，即每工具调用 73ms → 0.28ms。小会话（129 分片）本来就只有 1.8ms，无感 —— 这条只在长会话上兑现。

  单列那个不保留：`(session_id, id)` 的前缀能服务原来所有 `where session_id=?` 的查询，多留一棵树只会给每次 part 写入多一份维护成本（流式期间每 step 写 8–12 条）。逐条核过其余 part 查询的计划没有退步，`count(*) where session_id=?` 反而升级成 COVERING INDEX。索引体积 10.7MB → 15.8MB。**用户下次启动会一次性付 429ms 建索引**，此后不再有。

- **泄漏锚点检测改成增量扫描**（`session/instruction-echo.ts` 新增 `LeakAnchorScanner`、`session/processor.ts`）：text-delta 路径每条 delta 都拿 `hasLeakAnchor(ctx.currentText.text)` 扫**已写出的全文**，O(n²)。整轮累计实测（delta 24 字符，「纯累积」是同一循环去掉检查的对照）：

  | 一轮写出 | delta 数 | 纯累积 | 改前 | 改后 |
  |---|---|---|---|---|
  | 20K | 834 | 0.1ms | 8.1ms | 0.4ms |
  | 60K | 2,500 | 0.1ms | 40.6ms | 0.6ms |
  | 120K | 5,000 | 0.1ms | 179ms | 1.0ms |
  | 240K | 10,000 | 0.2ms | 833ms | 1.9ms |

  用法与相邻的 `NgramDetector` 一致（`feed(delta)`），只留锚点长度那么长的尾巴、完全不碰累积串。**中途试过「只 slice 尾窗再 includes」，240K 那档只从 833ms 降到 451ms** —— 累积串在流式期间是 rope，对它 `includes` 或 `slice` 都要先摊平，省掉的是比较不是摊平；滚动尾巴才真正是 O(delta)。等价性：能整段落在旧文本里的锚点在它到达那条 delta 上就已命中（命中即 `leakTripped` + `shouldBreak`），所以每轮只需看结尾落在新 delta 里的那些。补 7 条用例（逐字符喂、锚点跨 delta 交界的每一种切法、reset 语义、五种切片粒度下与全文扫描比对首次命中位置）。

- **时间线轮次 memo 去掉会话级依赖**（`app/pages/session/message-timeline.tsx`）：`mapArray` 给每个轮次建了一个 memo，本意各转各的，但回调里直接读了 `sessionStatus().type` 与 `activeMessageID() === userMessage.id` —— 两个都是会话级信号，于是每次 idle↔busy、每次换轮，全部轮次一起重跑。2,600 条消息的会话实测 `constructMessageRows` 全量 43ms + reuse 5.9ms，而一轮里这两个信号各翻一次，即**每轮撞两次约 50ms**。单个活动轮只要 3.8µs，说明 `reuseTimelineRows` 的短路本来就有效，贵的是「一起跑」。

  改法：`activeMessageID` 换 `createSelector`；status 只在活动轮读，写成**短路三元** —— Solid 的依赖是动态登记的，没执行到就不是依赖，写成先取值再传参等于没改。复刻同一 memo 结构数重跑次数：1300 个轮次下，**status 翻转 1300 → 1 个，换活动轮 → 2 个**。非活动轮传 `"idle"` 的安全性有依据：status 四处用法里三处要求 `isActive`，第四处 `status === "idle" || !isActive` 在 `!isActive` 时已短路；补 6 条用例覆盖五种消息形状逐字节比对，外加一条对照证明活动轮确实敏感。

  遗留：`assistantMessagesByParent()` 仍是全部轮次共用的依赖，新 assistant 消息到达时仍会让所有轮次重跑一遍（靠 reuse 短路兜住），未动。

#### 修复

- **V8 编译缓存改成显式 flush —— 它从建立那天起就是 0 个文件**（`desktop/src/main/sidecar.ts`）：[0.10.0] 记的「省掉约 260ms」**一直没有生效**。取证（打包版 0.10.x，15 次启动）：`compile-cache/v24.16.0-x64-<hash>/` 目录 09-01 建出来后 0 个文件；`import virtual:redcode-server` p50 **1227ms**，而启用缓存之前的 0.9.x 同口径是 1222ms —— 一毫秒没省。目录被创建只说明 `enableCompileCache` 返回了 ENABLED。

  根因：Node 只在**退出路径**持久化编译缓存，而 sidecar 是 Electron 的 utilityProcess，`before-quit` 里是 `void killSidecar()` 既不 `preventDefault` 也不 await —— 主进程先走、Electron 直接 TerminateProcess，那一刻永远不会到来（48 次退出里 34 次是 `code 1 / reason: killed`）。0.10.0 当时的冷热对照没错，但那是在一个独立 Node 进程里做的，它跑完自然退出。

  改法：ready 之后 2 秒由一个 `unref` 定时器显式 flush，与退出路径解耦。排在 ready 之后是因为主进程收到 ready 就立刻发健康检查（`5568bce2` 把 ready→healthy 压到 16ms，不能在这里还回去）。同版本 Node（v24.16.0，与 Electron 42.4.1 内置一致）验过机制：不 flush 空转 1.5 秒仍是 0 个文件，`flushCompileCache()` **3ms** 就落盘，下个进程 import 103ms → 26ms，热态重复 flush 是 0ms。真实 bundle 的收益小于这个倍数 —— 那 1.3 秒里大部分是模块执行不是编译。

  **验收标准是缓存目录里出现文件，不是看日志有没有调用**；`[sidecar-timing] flushCompileCache: Nms` 会打进 `server.log`。端到端要一次真实打包版启动，本次只验了机制。刻意没做：`before-quit` 改 `preventDefault` + await —— 对缓存已无必要，但 sidecar 的 `listener.stop()`（DB 句柄、MCP 子进程）同样没机会跑，那是另一笔账。note：`docs/notes/implemented/bug-fix/2026-09-03-compile-cache-never-flushed.md`

#### 更正

- 体检初稿里「泄漏锚检测 20KB 26ms、100KB 407ms 一次」**差四个数量级**，真实单次是 0.005ms / 0.04ms。有意义的口径是整轮累计（见上表）。教训同 `feedback-verify-before-reporting-findings`：数字类结论比存在性结论更容易错，因为它不触发怀疑。

---

### [0.10.9] - 2026-09-03

> deepseek-harness 第五轮反哺（上游 08-31 后新增 341 提交）。扫完只有三条真缺口——其余候选全被本仓已有的东西挡掉，逐条核实的记录在 `docs/dsh-adoption-plan.md`。

- **工具读到的图片直接画在卡片里**（`packages/ui/src/components/message-part.tsx`）：`tool/read.ts` 读图时早就返回 `attachments: [{type:"file", mime, url:"data:..."}]`，`processor.ts` 写进 `part.state.attachments`，SDK 的 `ToolStateCompleted.attachments` 也一路带到了客户端——**生产者和管道一直都在，缺的只是渲染器**。客户端唯一消费 attachments 的地方是用户消息那条路，工具卡片只显示一行 "Image read successfully"：模型看得见图，用户看不见。查本机 live 库确认过，`part` 表里已有 14 条带 `image/png` 附件的记录。

  放在 `ToolPart` 这一层而不是 read 的 render 里，任何工具返回图片都能显示，子代理/嵌套调用同理。点开走既有的 `ImagePreview` 灯箱（多图带左右切换），与用户附件同一套交互；高度封顶 240px，不然一张竖图能把整条时间线顶开。

- **圆角改画超椭圆**（新增 `packages/ui/src/styles/corner-shape.css`）：`superellipse(1.5)` 落在 `round`（=1）与 `squircle`（=2）之间，**不改任何半径值**，只改角的曲率。用 `*, *::before, *::after` 铺是因为 `corner-shape` 不继承，没法在 `:root` 设一次；本仓半径同时来自 Tailwind 工具类、组件 CSS 与 v2 那套，没有一份能穷举的类名单。整条规则包在 `@supports` 里，不支持的引擎连声明都读不到，零回退代码——本仓 Electron 42 = Chromium 148，该属性从 139 起可用。

  全圆形逐条退回 `round`（超椭圆会把正圆压成 squircle，用 border 画的 spinner 转起来会晃；胶囊两头会被削方），Tailwind 的 `.rounded-full` 在 utilities 层一条盖掉。

- **浮层描边统一画进 box-shadow**（`packages/ui/src/styles/theme.css` 新增 `--shadow-md-border`；`dropdown-menu` / `popover` / `hover-card`）：本仓两种写法一直并存——`context-menu` / `dialog` / `select` / `dock-surface` 早就是描边画进阴影，这三个还是 `border: 1px solid` + 另一条 `box-shadow`。真 border 吃 1px 布局、在 `<button>` 上会顶掉 UA 默认值、描边与柔光层还得各改各的。描边色沿用原本那条 border 的值，只改承载方式不改观感。

  `toast` / `tooltip` / markdown 代码复制提示保留真 border：它们用 `--surface-float-base`（浅色深色两档都是 `#161616`，固定深色面），跟随主题的描边色画在上面没有意义。

  **刻意不跟上游的 0.5px 发丝**：上游 note 写「Chromium 把亚设备像素的 border 画成一个设备像素，1x 屏与原来完全一致」，在 Chromium 148 上这句是错的。offscreen 截图逐像素量（白底黑线读 R 通道）：`box-shadow 1px` = 0（纯黑）、`0.5px` = 127（淡一半）、`border 1px` = 0、**`border 0.5px` = 255（根本没画出来）**。本机两块显示器都是 100% 缩放，跟过去是变淡不是变锐。同理没跟他们同批的半径 1.25× 放大——本仓 260831 刚把圆角标度收归一处。

  两条扫描防回潮：`styles/corner-shape.test.ts`（全圆半径缺配对即失败）、`styles/elevation.test.ts`（真 border 与抬升阴影并排即失败，反色面豁免）。都故意插违例验过会报错。决策记录见 `docs/notes/implemented/feature/2026-09-03-superellipse-corners-and-elevation-strokes.md`。

- **会话快照的三条用例修好**（`packages/opencode/test/cli/tui/lib/transcript.tsx`、`conversation-snapshot.test.tsx`）：从 08-28 就挂着，同一个 `local.agent.label is not a function`。同一天两个提交撞车、隔三小时：`45cd187f`（14:31）落快照 harness，fake `local` 只有 `agent.color`；`c454e8c0`（17:25）把消息头从 `Locale.titlecase(message.mode)` 换成 `local.agent.label(message.agent)`，fake 没跟上。那个提交的 verify 跑的是 `transcript.test.ts`——会话记录**导出**的 util 测试，跟整帧快照不是一个文件，名字像而已。修完快照文件一个字节没改，5 条全部命中原快照。

---

### [0.10.8] - 2026-09-02

> 看板娘「赤」进产品：图标、TUI 首页、GUI 等待期三处。原则是**赤只做门面，不做嘴替**——soul 有独立人格，助手说话那块一个字不碰。

- **favicon 一整套换成赤**（`packages/ui/src/assets/favicon/**`、`packages/app/index.html`、`packages/desktop/src/renderer/{index,loading}.html`）：全部从 `packages/desktop/赤ico.png` 的右半张（887×887 真源）重出，不是从 256 放大。SVG 那一档直接去掉——一张写实立绘塞进矢量图没有意义，`<link rel="icon" type="image/svg+xml">` 三处一并删掉。

  同批修掉两处写死的 `https://redcode.dev/...`（`packages/app/src/entry.tsx`、`packages/app/src/pages/layout/helpers.ts`）：那个域名根本解析不了，社交卡片和 apple-touch-icon 一直指向空气。改成 `new URL(..., document.baseURI)`，跟着实际部署走。

- **TUI 首页输入框右侧加赤的半格字符画**（新增 `packages/opencode/src/cli/cmd/tui/component/chi-art.{tsx,ts}`）：22 列 × 11 行，一个单元格用 `▀` 的前景/背景各画一个像素，所以像素是方的。取的是脸部特写——整张立绘缩到这个尺寸五官会糊成一团。

  颜色两步走：数据里存的是**去饱和到 25% 的原色、没有压暗**，压暗要以主题背景为锚（`tint(theme.background, src, 0.7)`）。直接乘系数在深色主题下没问题，但 TUI 有二十多个主题、其中有浅色的，那样会在浅底上拍出一块黑洞；从背景往原色混合则在浅色主题里自动变成浅色版本，始终跟底色同族。

  挂在**输入框**右侧而不是 logo 右侧，且左边补一条等宽空列：输入框下方的提示行按 `promptMaxWidth` 自己居中（`component/prompt/width.ts` 里两处共用的那个值），把「输入框 + 赤」当整体居中会让输入框左移十几列、跟提示行错开。镜像留白让输入框保持原位不动。

  尺寸不够就不画：宽度要够 `promptMaxWidth + 2×(3+22)`（默认 148 列），高度 ≥30 行。窄窗口里硬画会把 logo 或提示行挤出屏幕，而那两块才是首页的主体。

- **GUI 会话首轮的等待期放赤的「任务已接收」立绘**（新增 `packages/ui/src/v2/components/chi-task-sticker.{tsx,css}`、`packages/app/src/pages/session/message-timeline.tsx`）：出现条件收得很窄——**会话第一轮、且一个 token 都还没回来**，复用 Thinking 行已有的 `awaiting`（那正是「等供应商首 token」的窗口）。每轮都放就成了周期性闪动。

  淡入延迟 600ms 是关键：快模型三百毫秒就吐首 token，那时 Thinking 行连同这张图已经卸载，立绘一次都不会露面。只有真的等起来了才补这块空白。图上的中文不裁——文字本身就是这张立绘的一部分。280px 展示，资产按 560px 两倍图出，q88 JPEG 121KB（源图 1254px 且无 alpha，PNG 那档 671KB 太重）。

---

### [0.10.7] - 2026-09-02

> 冻结类 bug 支线 C 定案：「界面像死了但任务还在跑」是客户端 SSE 重连被 SDK 架空，不是 sidecar 猝死。连带补上取证面与 sidecar 重生的第二道闸。

- **事件流断连收归一套重连策略**（`packages/app/src/context/{global-sdk,server-sdk}.tsx`、新增 `packages/app/src/utils/sse-log.{ts,test.ts}`）：生成的 SDK（`sdk/js/src/gen/core/serverSentEvents.gen.ts`）的 SSE 生成器**自带一圈重试**——不传 `sseMaxRetryAttempts` 就是无上限，退避 `3000 * 2 ** (attempt-1)`、上限 30 秒。而它只要还在重试就**永不返回**，于是 `global-sdk` / `server-sdk` 各自那套 256ms→2s 的重连**一行都执行不到**。

  证据不是读代码读出来的，是数出来的：47 个会话的 `renderer.log` 里 `event stream error` 出现几十次，而应用层重连路径上的 `stream ended, reconnecting` 一共只有 **2 行**。

  三个后果都指向同一个症状（文件树与上下文面板同时空白、消息发得出去但没进库、Esc 没反应、刷新无效，**但任务仍在推进**）：① `connection` 状态卡在 `"live"`，三态断连指示器根本不会亮；② 真实重连间隔涨到 30 秒，不是应用层以为的 2 秒；③ 唯一自救是 90 秒心跳 abort。

  修法是把重试权收回上层：`sseMaxRetryAttempts: 1`，SDK 失败即交回，退避 / 状态 / 日志全由应用层负责。**两套重连只留能把状态吐给界面的那套。** 连带把退避归零点从「请求成功」挪到「收到第一条事件」——失去 SDK 那 3 秒起始退避之后，「接了连接又立刻断」会退化成 256ms 紧循环，以「真的流出过数据」为准才不会。

  取证面同批修好：`console.error("[global-sdk] event stream error", { url, fetch, error })` 转发进 `renderer.log` 时被拍平成 `[global-sdk] event stream error [object Object]`，三个字段全丢——**这就是这条 bug 长期「根因未定」的直接原因**。新增 `sseErrorText`（展开 `Error` 的 name/message 与 **cause 链**，`Response` 这类对象挑 status/statusText，循环引用退到 toString）与 `sseLogLine`（把字段拍进消息字符串本身），六处日志全部改走它。测试 9 例，含「整行不含 `[object Object]`」这条断言。

- **sidecar 重生加时间窗闸门，退出日志带存活时长**（`packages/desktop/src/main/index.ts`）：原来只有 `respawnAttempts` 一个计数器，而它在**健康检查通过**时清零——「过了健康检查」不等于「稳住了」。实测过一次 70 秒内死三次、每次都健康起来活约 33 秒又死，于是计数器每轮清零、`attempt` 恒为 1，`giving up` 永远不触发，可以无限拉尸体。

  加一道与健康无关的闸：滑动窗口 10 分钟内重生超过 5 次就停手。孤立的偶发猝死照旧自愈（一次死亡只占一个名额、10 分钟后自然过期），只有「起来又死」的循环会撞上限。另外 `sidecar exited` 此前只有 `code`，「孤立猝死」与「起来又死」在日志里长得一模一样，现在一并写 `aliveMs`。

  **顺带排除一条假线索**：`renderer.log` 里那些相隔 1ms 的成对 `[global-sdk]` 错误不是双连接——`server-sdk.tsx` 的日志标签曾误写成 `[global-sdk]`（抄文件时漏改，已改对）。标签修好后看得很清楚：每次断连是 global + server 各一条，两条 SSE 流本来就是设计如此。

---

### [0.10.6] - 2026-09-02

> 界面批：ChatGPT/Codex 额度面板两端的可读性收口，推理强度从下拉换成弹窗里的滑杆。

- **推理强度：下拉 → 弹窗里的滑杆**（新增 `packages/ui/src/v2/components/effort-slider-v2.{tsx,css}`、`packages/app/src/components/prompt-input.tsx`、i18n 三语）：档位本来就是**有序的一条轴**（low→high），下拉把它呈现成无序候选。档位集合是每个模型自己的（openai 五档、deepseek 三档、hy4 两档、anthropic 系没有这一维），所以刻度数由 `steps.length` 决定，少于两档不渲染。

  形制走了三版才落地，每一版的翻车都指向同一件事——**滑杆的手感来自尺寸与跟手，不来自缓动**：① 第一版是细轨 + 大圆球 + 纯蓝填充直接嵌在输入框底栏，64px 宽根本滑不出行程，而且这排控件（模型选择器等）本来就都是弹窗，嵌个异类进去也不成体统；② 挪进弹窗后加了 140ms 的 `left` 缓动，仍然是「一闪而过」——`step=1` 时滑块只能落在档位上，档位之间隔着 40px，无论缓动多久，滑块都是**离开手指自己跑过去**的；③ 最终改成拖动阶段用 0.01 细步长严格跟手，松手（`onChangeEnd`）才 round 到最近一档提交，那一下吸附由 CSS 过渡收尾。拖动中必须关掉过渡（`data-dragging`），否则滑块拖在指针后面，比跳更难受。

  几处容易踩的实现细节：胶囊画在根元素、Track 内缩半个滑块宽（Kobalte 按 Track 宽定位滑块，不内缩的话滑到两端会探出胶囊外），因此**不能用 `Kobalte.Fill`**——它只能长在 Track 里，跟着内缩会在左端留一截填不到的空当，进度改由「点亮到第几个刻度」表达；横向居中交给 Kobalte 内联的 `translateX(-50%)`，自己只做纵向，两边都做会偏整整一个滑块宽；`restoreFocus` 挂 `pointerup` 而不是 `onChange`，挂后者的话键盘方向键每按一次焦点就被抢回输入框。细步长的代价是 Kobalte 的方向键按 `step` 走（一次只挪 1%），所以在根节点捕获阶段自己接管 `ArrowLeft/Right/Up/Down/Home/End`，按整档走。

  刻度点原先是 2px + `icon-muted` + 0.45 透明度，在 `rgb(92,92,92)` 的轨道上肉眼看不见——刻度是「有几档、现在第几档」的唯一线索，看不见等于没做。放大到 3px、换 `icon-base`（212 灰），已越过 0.9 / 未越过 0.4，**区分用明度不用色相**。

- **上下文页右侧留空 + 额度百分比显示保护**（`packages/app/src/components/session/session-context-tab.tsx`）：面板做窄之后，右对齐的值（账号 ID、`3%`、构成行的模型名）连同进度条全部停在同一条右边界上叠成一堵墙，读起来像被截断。外层容器 `px-6` → `pl-6 pr-10`（左 24 / 右 40），同时去掉额度块自己那条 `pr-2`——改容器而不是改单个区块，是为了让各区块共用同一条右边界，错开两条比贴边更难看。左右不等距是故意的：左边是「起始于此」的标签、参差不齐所以不成墙，右边是「结束在此」的值。

  百分比另加一道显示保护。实测（plus 账号连发四次请求）`x-codex-*-used-percent` 回的一直是整数 3 / 4，codex 侧同源的那条 JSON 路在 OpenAPI 里也直接声明成 `i32`，说明服务端自己就 round 过；**但本仓整条链路（响应头 → `Number()` → `Schema.Number` → openapi 的 `number`）没有任何一处取整**，服务端哪天不 round 了会原样渲染出 `33.333333333333336%`。用 `toLocaleString` 而不是 `toFixed`，整数不会被补成 `3.0`。

- **TUI 额度条上色，套餐名不再被账号 ID 挤掉末字**（`cli/cmd/tui/feature-plugins/sidebar/quota.tsx`）：原来整条进度条（含已用部分）都上 `textMuted`，画出来是条没颜色的灰带，3% 时完全看不出是进度条。拆成 filled / rest 两段，已用部分按 info/warning/error 分档上色——与 `context.tsx` 的 `bar()` 同形状；宽度保持 10 不复用那边的 24，因为这一行还要放 label、百分比、窗口长度、重置时刻，而侧栏只有约 38 列。

  套餐名那个 `text` 没写 `flexShrink`，在 `space-between` 里被 36 字符的账号 ID 压缩，实测 `plus` 显示成 `plu`、账号 ID 还得折两行。plan 补 `flexShrink={0}`，账号 ID 取 UUID 第一段（足够区分账号），一行放得下。顺带把裸的 `{q.accountID}` 收进 `Show`——它是可选字段。

---

### [0.10.5] - 2026-09-02

> 提示词批：语气从 17 份 model 提示词里收进 soul，删掉两份上上代旧档，记忆的写与剪合并成一个 skill 并摘出固定前缀。

- **两个记忆 skill 合并成一个，剪枝阈值挪到注入面**（`seed/skill/memory/`、`seed/redcode.home.jsonc`；配套改动在私仓 `~/.redcode`）：原先 `memory-automation`（写侧）通过 `instructions` 数组**每轮强制注入**，`consolidate-memory`（整理侧）只在被 load 时才进上下文。结果是只写不剪——MEMORY.md 单调上涨，而它每轮整份注入，等于每轮成本一直在涨。

  260901 判过一轮，当时结论是不能合并（合并后仍注入 = 把 125 行整理细则变成每轮成本）。那条判据没错，变的是前提：这次把 `instructions` 一并清空，两条都不再进固定前缀，合并的成本理由随之消失。`memory-automation` 是最后一个"既是 skill 又整篇常驻"的双重注册项，与 260718 摘掉的那四个（goal-automation/simplify/vision-autoagent/diagnose，当时实测白吃 ~2800 token/次）同因。

  **真正修的是触发条件的位置**：旧阈值「全局记忆超过约 30 条 / 200 行就提议整理」写在 `consolidate-memory` 里，而那份**不注入**——触发条件躺在一个"要先决定整理才会读到"的文件里，所以实测全局 MEMORY.md 已到 73 条也没人提醒过。现在阈值按**字符**（旧的条数/行数对索引行格式没有意义：73 条、49 行、8207 字符，数条数早超、数行数永远到不了），并移进私仓 AGENTS.md 的自检触发点。

  顺带修掉 `seed/skill/memory-automation/SKILL.md` **与私仓版本的漂移**：私仓那份 260901 已剪到 2535 字节，seed 这份还停在 8618 字节的旧稿，新用户一直拿到被取代的版本。

- **删掉 `beast.md` 与 `copilot-gpt-5.md` 两份旧档**（`packages/opencode/src/session/prompt/`、`session/system.ts`）：不会再拿上上代模型干活。`copilot-gpt-5.md`（143 行）是纯死文件——全仓零引用，`system.ts` 从来没 import 过；Copilot 侧模型 id 含 `gpt`，本来就走 `gpt.md`（与 `packages/core/src/github-copilot/` 那个 provider 集成无关，那个还在用）。

  `beast.md`（139 行）不同，它原本是活的，所以一并删掉 `system.ts` 里 `gpt-4 / o1 / o3` 那条路由分支。探针实跑 `provider()` 确认：48 个 `gpt-4*` 含 `gpt`、落在维护中的 `gpt.md`，24 个真正的 o1/o3 落 `default.md`（按兜底分支那段注释，重写后的 `default.md` 本就是一线水准）。

  **顺带修掉一处巧合匹配**：那条分支用的是裸子串 `includes("o1")` / `includes("o3")`，于是 `sao10k/*`（"Sa**o1**0K"，12 个 Llama 微调）和 `solar-pro3`（"pr**o3**"）这 13 个跟 OpenAI 毫无关系的模型一直在吃 beast 档，删掉分支后回落 `default.md`。与 `wantsFlashAnchor` 那处注释记的是同一个教训。typecheck 干净；`test/session/` 552 pass / 2 fail，与改前同（`revert-compact` 的既有 5s 超时）。

- **17 份模型提示词全部让位 soul，语气不再两处立法**（`packages/opencode/src/session/prompt/` 下 14 份）：接着上一条的兜底做第 2 步。原先只有 `deepseek.md`／`step.md`／`glm.md`／`grok.md` 带让位条款，而且那句"本文件不再重复规定"在多数文件里是假的——说完之后仍有四到八条在规定详略。现在路由到的 17 份**全部**带条款，同范围的条款已剪掉。

  剪的判据不是按小节，而是按「这条在描述谁」：说**你是谁／怎么说话**（长度、称呼、短句、表情、不说教、开场白与结尾话术）归 soul，删；说**通道或模型缺陷**（别把推理泄进正文、别空轮结束）、**格式机制**（markdown 渲染、列表层级、`file:line` 引用）、**行为**（别乱建文件、工具用法、安全）归提示词，留。校准直接取自 `d0b5dac2` 里实际删掉的那批。

  最重的三份：`trinity.md` 97→52 行——它整节 Tone and style 后面挂着 10 个演示"单词回答最好"的 example，还留着 `default.md` 早已移除的「不超过 4 行」硬钉、且写了两遍；`gemini.md` 155→142（「少于 3 行」、No Chitchat，以及 examples 区里 `1+2→3`、`13 是不是质数→true` 两条纯粹演示单词回答的例子）；`beast.md` 147→139（"casual, friendly yet professional tone" 及其 6 条语气示例）。

  `plan*.md`／`max-steps.md`／`build-switch.md` **刻意不加条款**——它们是叠在 model 提示词之上的 overlay，不是人格层。顺带删掉 **`copilot-gpt-5.md`（143 行）**——死文件，全仓零引用，`system.ts` 没 import 它；Copilot 侧模型 id 含 `gpt`，本来就走 `gpt.md`，删掉不丢覆盖（与 `packages/core/src/github-copilot/` 那个 provider 集成无关，那个还在用）。typecheck 干净；`test/session/` 552 pass / 2 fail，那 2 条是 `revert-compact` 的既有 5s 超时——换回改前的提示词跑同样是 5 pass / 2 fail。

- **soul 模板填上默认语气，新用户开箱不再没有语气约束**（`packages/opencode/src/project/template/Tsoul.md`、`Gsoul.md`）：`deepseek.md`／`step.md`／`glm.md` 里都写着"语气、称呼、详略由 soul 决定，本文件不再重复规定"，但这句话在三份里都是假的——说完之后文件里仍有四到八条在规定详略，大多聚在 `# Output channels`。而 `gpt.md`／`anthropic.md` 连这句都没有。

  之所以不能直接把那些条款删掉：**没有兜底层**。`system.ts` 的 `provider()` 返回的是单个文件（`[PROMPT_DEEPSEEK]` 而不是 `[PROMPT_DEFAULT, PROMPT_DEEPSEEK]`），model 档是**替换** `default.md` 不是叠加；soul 又是有条件注入的（`instruction.ts:170` 的 `existsSafe`）；而播种出去的模板**每一节都是空占位**。三条叠起来，一个没编辑过 soul 的新用户会一条语气约束都没有。

  所以先把兜底收进模板本身：与让位条款同范围的三节（我是谁／怎么称呼用户／语气风格）换成可直接使用的中性默认值——简洁、先结论、短句、无表情符号、长度跟着问题走、结尾不问"还需要我做什么吗"。其余四节保持空占位，那些是行为约束、model 提示词本来就覆盖，填了只会造出新的重复。

  顺带修掉一个一直靠碰巧工作的地方：首行改成 `# RedCode · TUI 灵魂模板`。首行不是装饰——`shared.ts:23` 用它取会话标题前缀、`local.tsx:27` 取 `·` 之前那截当 agent 名；原来没有 `·`，两处都是回落到 "TUI"／"GUI"。现在新用户看到的 agent 名是 "RedCode"。

  **已有 `~/.redcode/souls/*.md` 一律不受影响**（`bootstrap.ts` 只在文件不存在时播种）。note 见 `docs/notes/implemented/refactor/2026-09-02-soul-template-tone-floor.md`，其中记了下一步怎么剪 model 提示词里的重复条款。

- **GPT 系列提示词并入 `gpt.md` 并让位 soul**（`packages/opencode/src/session/prompt/gpt.md`、删除 `prompt/codex.md`、`session/system.ts`）：`codex.md` 是 Codex CLI 时期的遗留，其独有内容已并进按 GPT-5.6 重做的 `gpt.md`；分开维护只会让同系列的 sol/terra/luna 与 `*-codex` 拿到两套工程约束。路由相应简化成「id 含 gpt 就走 `gpt.md`」。

- **补记提示词改动的「模型可见改动三问」**（`docs/notes/`）：改提示词 / 注入段 / 工具 schema 前必答的三个问题写进 note，与 AGENTS.md 的检查点对齐。

---

### [0.10.4] - 2026-09-02

> GPT 接入批：`apply_patch` 改走 Responses 的文法约束工具；hy4 的推理档从数据路径提升到实测特判。

- **`apply_patch` 走 Responses 的 freeform 文法工具，不再包 JSON**（新增 `packages/opencode/src/tool/freeform.ts` 与 `test/tool/freeform.test.ts`、`session/tools.ts`、`session/processor.ts`、`session/llm/native-runtime.ts`、`test/session/llm-native.test.ts`）：GPT-5 系在 Responses API 上有 custom tool——工具调用不走 JSON，模型直接吐一段受 Lark 文法约束的裸文本（`custom_tool_call`，input 是字符串而不是对象）。codex 唯一这么发的工具就是 `apply_patch`（`core/assets/tools/apply_patch.lark`），文法原样搬了过来。

  值得做的理由：补丁正文本来就是纯文本，包进 JSON 字符串等于给每个换行和引号加一层转义——① token 明显变多；② 离模型训练时的输出分布更远，转义错一个字符整条调用就废（JSON 解析失败 → repairToolCall → 一轮白跑）。文法约束这条路上，解码器在采样阶段就被 Lark 挡住，语法上吐不出不合法的补丁。

  适用面刻意收窄到 `providerID === "openai"` + `@ai-sdk/openai` + gpt-5 家族（排除 `-chat`）：custom tool 只存在于 Responses API，而 `provider.ts` 里只有 openai 的 `getModel` 固定走 `sdk.responses()`。逃生口 `REDCODE_DISABLE_FREEFORM_TOOLS=1`。

  入参形状在**两个边界**上归一（freeform 回来的 input 是裸字符串）：进执行器前 → `{ patchText }`；落库前 → 否则掉进 `{ value }` 兜底，`apply_patch` 的 diff 视图渲染不出来。另外 native runtime 让位——它的 `nativeTools` 会把 provider 工具压成「参数是字符串的普通函数工具」静默发错，所以带 provider 工具时判 unsupported 回落 ai-sdk。线上形状用探针实测过：下行 `{type:"custom",name:"apply_patch",format:{grammar,lark}}`，上行 `custom_tool_call` 的 input 原样是补丁字符串。

- **hy4 推理档从数据路径提升到特判（实测 none/high）**（`packages/opencode/src/provider/transform.ts`、`test/provider/transform.test.ts`）：opencode-go 网关上同一道需要推理的题、`temperature 0`、`max_tokens 1200`，每档跑两轮只变 `reasoning_effort`，看 `reasoning_tokens`——**只有 `none` 是真的**（恒为 0、completion ~289）；`minimal/low/medium/high/xhigh/max` 与「完全不发这个参数」落在同一区间（421~1200），且不单调（medium 427/421 反而低于 low 615/541），是噪声不是分档。

  网关对任何值都回 200，连它压根不认的 `xhigh`/`max` 也回 200——**所以只能按行为判、不能按报错判**，这也正是提升到特判的理由：走数据路径时，models.dev 写错了不会有任何信号，UI 上会长出几个滑得动但什么都不改变的档位。值与当前 models.dev 数据一致（`["none","high"]`），提升的意义是**钉住**它，测试里直接喂一份「上游改成五档」的假数据断言仍只出两档。只认 hy4，hy3 的 `["none","low","high"]` 没实测过、继续走数据路径；id 匹配锚在串首或分隔符上（`hy4-preview` / `tencent/hy4-preview` 都认），并钉了 `hy40` 不被误伤。

---

### [0.10.3] - 2026-09-02

> 会话轮次导航栏：整份日志的目录 + 翻页跳转。

- **会话轮次导航栏**（`packages/opencode/src/session/outline.ts` 新增、`server/routes/instance/httpapi/{groups,handlers}/session.ts`、`packages/app` 的 `pages/session/turn-outline.tsx` 新增 / `session-history-loader.ts` / `session.tsx` / `session/session-side-panel.tsx` / `context/global-sync/bootstrap.ts` / `context/server-sync.tsx` / i18n 三语、新增 `packages/opencode/test/session/outline.test.ts`）：采自 DSH 的 `2026-08-30-web-turn-rail-outline-jump`。会话页右侧面板新增「轮次」标签，列出**整份日志**的每一轮（提问一行 + 回答两行预览），点一条自动往前翻页直到那一轮进窗口，再滚过去。

  上游那篇的问题陈述对本仓逐字成立：导航若从**已加载的消息窗口**推导，而窗口只是日志的一个分页后缀（本仓首屏 40 条），长会话里就只会列出最近几轮——恰恰是不需要导航也看得到的那部分。现有的 `session-message-nav.ts` 前后跳收的是 `UserMessage` **对象**，同样只在已加载的轮次之间走。实测他库里最长的会话 2612 条消息 / **379 轮**。

  三块各自独立：① **数据**走新增的 `GET /session/:id/outline`，直接查库、与窗口无关；不做上游那套投影折叠（本仓是 SQLite 不是事件溯源），预览在 SQL 里就截断，part 表按 `group by message_id` + `min(id)` 压成每条消息一行，否则长会话要拉几千行只为每条消息的头几十个字。② **跳转** `loadThrough(messageID)` 一路翻到目标进窗口；**无进展时不当场放弃而是等一拍再试** —— `loadMessages` 对并发调用是静默 no-op，"没进展"最常见的原因是用户同时在往上滚、pager 被占着（上游的 `fix(ui-chat): hold jumps while a plain pull owns the pager` 修的就是这种情况下退化成"落在最近一条"）；翻不到就 toast 明说。滚动放 rAF 里，因为 prepend 刚插的行还没被 virtua 测量。③ **UI** 不另起面板，加进右侧现成的标签组，内容包在 `<Show when={activeTab() === "outline"}>` 里——目录请求只在真的打开这个标签时才发，不给「点开会话」那条热路径加往返。

  实测（真实库只读探针，最长会话）：两条 SQL 共 414ms，1418 行 part 压成每消息一行，379 轮，载荷 107.2KB。测试 7 例，折叠逻辑抽成纯函数 `fold()` 与库解耦，覆盖轮次编号、「最后一条带文字的 assistant 才算回答」、孤儿 assistant 不造轮次、截断按码点不按码元、空会话。**界面未做视觉验证**（起 desktop dev server 在这台机器上曾把内存打到 2.9GB）。note 见 `docs/notes/implemented/feature/2026-09-01-session-turn-outline.md`。
---

### [0.10.2] - 2026-09-02

> 修复批：配置写盘改原子替换、持久化键里的裸控制字符、`@` 菜单的陈旧候选、配置上溯的层序、启动画面配色。

- **`@` 菜单的陈旧候选不再能被 Enter / Tab 选中**（`packages/ui/src/hooks/use-filtered-list.tsx`、`packages/app/src/components/prompt-input.tsx`、新增 `packages/ui/src/hooks/use-filtered-list.test.ts`、`packages/ui/package.json`）：采自 DSH 的 `2026-08-28-trigger-menu-stale-while-revalidate`。那篇是两半，**核实下来本仓第一半本来就有、第二半没有** —— `use-filtered-list.tsx` 的 `flat` 读的是 `grouped.latest` 而不是 `grouped()`，新查询在途时保留上一轮结果，所以列表不会像上游那样每敲一个字就塌成骨架屏；但 Enter 分支没有任何在途判断。

  `@` 那个列表的 `items` 每个按键都发一次 HTTP 文件搜索、**没有防抖**。于是敲 `@src/comp` 时高亮在 `src/components/app.tsx`，快速敲完 `onents/prompt` 并回车 —— 若最后一轮还没落地，插进去的就是 `src/components/app.tsx`，一个用户没挑过的候选，而且静默。`createEffect(on(grouped, () => reset()))` 让这件事更明确：结果一落地高亮就重置到新列表第一项，pending 窗口里那个高亮**注定**不是 settle 后会看到的那个。

  Enter 的闸设在 hook 里（返回不会漏成"提交草稿"—— `prompt-input.tsx` 的分发在 popover 打开时对 Enter 一律 `preventDefault()` 后 `return`）；Tab 走 `selectPopoverActive()` 绕过 hook，单独判一次，hook 因此多导出一个 `loading()`。`/` 菜单是同步数组，这道闸实际只对 `@` 生效。**刻意不给「加载中」的视觉反馈** —— 陈旧行本来就是对的样子，按键级的明暗切换会变成逐字符闪动。

  写回归测试时顺带发现 **`packages/ui` 的测试一直在用 solid 的服务端构建**：`bun test` 按 node 条件解析，`solid-js` 落到 `dist/server.js`，`createResource` 在那里直接抛 `getNextContextId cannot be used under non-hydrating context`。既有 7 个测试全是纯逻辑碰不到响应式，所以一直没暴露；但这是个浏览器 UI 包，解析到服务端构建本来就是错的。`test` / `test:ci` 都加 `--conditions browser`，对照过：不带是 38 pass / 2 fail，带上是 40 pass / 0 fail。note 见 `docs/notes/implemented/bug-fix/2026-09-01-trigger-menu-stale-selection-guard.md`。

- **配置写盘改成原子替换，并在 Windows 上重试被外部句柄顶掉的 rename**（`packages/core/src/filesystem.ts`、`packages/opencode/src/config/config.ts`、`cli/cmd/tui/context/kv.tsx`、新增 `packages/core/test/filesystem/write-atomic.test.ts`）：采自 DSH 的 `2026-08-29-windows-atomic-replace-retry`，但**回本仓核实后发现缺口比上游那篇大一档** —— 上游是「已有 `writeFileAtomic`，补上 Windows 重试」，而本仓 `config.ts` 六处写盘全是 `fs.writeFileString` 直写，连临时文件和 rename 都没有。直写被打断（关机 / 崩溃 / 磁盘满）留下的就是半截 JSON，下次启动读不出来；其中 `$schema` 回填那条尤其别扭，它不是用户主动保存，而是**读配置的副作用**在改用户的文件。全仓唯一一份 temp+rename 在 TUI 的 `kv.tsx`，没共享出去也没有重试，临时名用 `Date.now()`（同一毫秒连写会撞名）。`write-file-atomic` 确实在依赖树里，但只是 `conf`（electron-store）的传递依赖 —— 也就是 GUI 那条 persist 路径是原子的、配置文件这条不是。

  原语落在 `AppFileSystem`，普通 async 面（`writeFileAtomic`）与 Effect 面（`writeFileStringAtomic`）各一个。临时文件必须是同目录兄弟（跨卷 rename 直接 EXDEV），名字用 pid + 进程内计数器。Windows 上只对 `EACCES` / `EBUSY` / `EPERM` 重试 —— 杀软扫描、索引器、另一个读者临时握着目标句柄时替换会被拒，而这是瞬时的，跨进程写锁（`Flock`）排的是我们自己人、管不到外部句柄；别的错误码和别的平台立刻失败。延迟 20ms 起翻倍、封顶 200ms，9 次尝试累计最多多等 1.1 秒（**这次没有跟上游参数的取舍问题** —— 对比 260822 那次 JPEG 质量梯子，配置写盘既不在模型热路径上又罕见，偏宽容才对，何况这台机器 Defender 活跃）。重试耗尽时删掉临时文件再抛出：**目标文件全程没被碰过**，读者看到的始终是完整的旧内容。

  刻意没做：fsync（temp+rename 已经解决「读者看到半截文件」，为掉电那个窄窗口给每次配置写盘加 fsync 不划算）；`ensureGitignore` 不换（它创建新文件，没有「替换已有内容」这回事）；`writeJson` / `writeWithDirs` 不动（调用点是缓存 / 快照 / 临时产物，写坏了重新生成即可，原子替换的成本只给「写坏了就毁用户数据」的文件付）。

  测试 10 例，重试那部分**不 mock `fs/promises`**（全仓都在用它，换掉风险太大），改成把 rename 循环抽成 `renameWithRetry(from, to, deps)` 注入 `rename` / `sleep` / `platform`，于是能观察尝试次数与退避序列而不依赖墙钟。`test/config/` 那 31 个既有失败（`opencode.jsonc` 找不到，改名遗留的陈旧断言）**已用对照确认与本改动无关**：还原到 dev 基线跑同一批同样是 153 pass / 31 fail。note 见 `docs/notes/implemented/bug-fix/2026-09-01-atomic-config-writes.md`。

- **persist 的合并键分隔符写成了裸 NUL 字节，改回转义**（`packages/app/src/utils/persist.ts`）：源码里那个分隔符是直接打进字符串字面量的 `\0` **实体字符**，不是转义序列——文件里躺着一个真正的控制字节。行为上碰巧能用（它确实是 NUL），但任何一次经过不透明搬运（复制粘贴、编码转换、某些编辑器的规范化）都可能把它悄悄换掉或吃掉，而键一旦变了，用户已持久化的状态就全部读不回来。改回 `\0` 转义写法，行为不变、字节可见。

- **全局 `.redcode` 不再反压项目层，配置上溯收口到 worktree**（`packages/opencode/src/config/config.ts`、`cli/cmd/tui`）：配置目录上溯时会一路走到用户主目录，于是 `~/.redcode` 被当成「离得最近的项目层」参与合并、盖住真正的项目配置。上溯改成到 worktree 根为止，全局层只在它该在的那一层生效。

- **清掉配置测试里 opencode→redcode 的重命名欠账**（`packages/opencode/test/config/`）：`test/config/` 那 31 个失败是改名时留下的陈旧断言（找 `opencode.jsonc`），一直挂在那里遮住真实回归——上一条改动的对照就因此得先跑一遍基线才能说清。这次把断言更到新文件名。

- **启动画面：徽章放大 30%、底色改跟侧栏同色系**（`packages/app/src/index.css` 新增 `[data-splash-surface]`、`packages/desktop/src/renderer/index.tsx`、`packages/app/src/app.tsx`、`packages/ui/src/components/logo.tsx`）：他截图里那扇几乎全空的深紫屏，渲染的是 **desktop 渲染层**那个包住整个 UI 的 `<Show>` fallback（`renderer/index.tsx`），不是 `app.tsx` 的 ConnectionGate —— 两处 markup 逐字节相同、像素上分不出来，但主进程时序决定了占住那 1.4~1.6 秒的是前者（建窗已提到等 sidecar 之前，`awaitInitialization` 真的等 `serverReady`）。徽章 `size-40` → `size-52`（160px → 208px，正好 +30%）；**内联 base64 不动** —— 源图 320px 对 208px 仍有 1.54 倍余量，要覆盖 2 倍 DPI 得换 416px 源，实测 448px 的 base64 是 108KB、比现在多 65KB，全压在首屏内联路径上，为一个 1 倍屏用不到的清晰度不值当。

  底色原先是 `bg-background-base`，也就是 **v1 管线**的 `neutral[0]`（yuqi 暗色实值 `#200a22`，与 v2 那套灰阶是两条独立管线）—— 主题里最暗的一档铺满整屏，读起来是「黑屏上贴了张图」。改成复用侧栏那份掺色配方：同样的 `--frost-tint-aside` 掺进同样的 `--v2-background-bg-layer-01`，与 `index.css` 侧栏规则的内层逐字一致，以后调 frost 掺色两边一起动。计算值 `color(srgb 0.251312 0.216211 0.300331 / 0.835294)`，透出 `<html>` 的 `--background-base` 后合成约 `#3b3045`。

  两点与侧栏规则有意的差别：① **不带 `[data-app-frost]` 门控** —— 那个属性挂在 `layout.tsx` 的布局根上，而启动画面早于 Layout 挂载，那一刻 DOM 祖先链只有 html / body / #root 三层，壁纸和整套毛玻璃都还不存在，复用那个选择器一条都命中不了；② **不加 `backdrop-filter`** —— 背后没有壁纸可透，模糊一层纯色是白付成本。`ConnectionError` 那屏一并换底（保持 `size-24`），否则启动画面切到错误页会跳一次色。独立的 loading 窗（`renderer/loading.tsx`，DB 迁移时才出）没动。

---

### [0.10.1] - 2026-09-01

> 0.10.0 之后的收尾批：文件查看器支持 PDF；插件依赖等待从 15 秒砍到 2 秒并且超时后整个进程不再等（这是打包版「进项目要等二十秒」的最后一段）；权限姿态三档不再中英混排；等待首 token 的那行不再叫「思考中」。另把看板娘「赤」正式定下来——两个 exe 的图标、GUI 启动画面、README 立绘，并重写了双语 README。

#### 新增

- **文件查看器支持 PDF 预览**（`packages/opencode/src/file/index.ts`、`packages/ui/src/pierre/media.ts`、`components/file-media.tsx`、`packages/app/src/pages/session/file-tabs.tsx`、i18n 三语）：此前点开 PDF 只会得到「二进制文件，无法预览」。原因是服务端 `read` 在 `isBinaryByExtension` 那道早退里就把 PDF 挡了，而图片走的分支排在早退**之后**——所以 PDF 分支必须插在早退之前，否则加了也走不到。返回形态沿用图片那条（`type: "binary"` + base64 + `application/pdf`），**共用同一个 20MB 上限**，不另开一套。前端 `MediaKind` 加 `pdf`，`validDataUrl` / `dataUrlFromMediaValue` 与三处 `(k !== "image" && k !== "audio")` 的闸门一并放宽——这三处是同一个判断被抄了三遍，漏一处就是「能打开但渲染成空白」。渲染用 `<embed type="application/pdf">` 交给 Chromium 自带的 PDF 插件，不引第三方渲染器。

#### 优化

- **插件依赖等待 15s → 2s，且超时后整个进程不再等**（`packages/opencode/src/plugin/index.ts`）：打包版日志里 `session.list` 一次 20721ms，而 sidecar 本身 1.5 秒就绪——差额几乎全在这里。链条是：`~/.redcode/package.json` 声明了 `solid-js@^1.9.13`，而 `@opentui/solid@0.4.1` 把 peer 钉死在 `solid-js@1.9.12`；宿主装依赖用的 @npmcli/arborist 对 peer 冲突比 bun 严格得多，于是 ERESOLVE 失败（约 13 秒），后面那道 15 秒等待再空转满。**这一条我先前用错误的测量否定过**——当时量的是 sidecar 启动耗时（1388ms，看着没问题），而实际卡住的是实例 bootstrap，两者不是一回事。等待降到 2 秒，并加一个模块级 `depWaitTimedOut`：超时发生过一次之后，后续目录直接跳过等待而不是每个目录再赔 15 秒。依赖冲突本身在配置仓那侧修。

#### 修复

- **`auto` 姿态去掉中文 displayName**（`packages/opencode/src/agent/agent.ts`）：三档姿态在输入框下拉里并排显示，plan 靠 `capitalize` 渲染成 "Plan"，redmind 给 displayName 是因为 "RedMind" 的大小写靠 capitalize 出不来。给 auto 塞的「全自动」让这一栏变成 Plan / RedMind / 全自动，中英混排。名字这一栏跟着 `name` 走即可——危险性由 description 和橙色 warning 承担，不该让标签兼职。
- **等首 token 的那行不再叫「思考中」**（`packages/app/src/pages/session/message-timeline.data.ts`、`message-timeline.tsx`、i18n 三语）：开着推理摘要时，时间线底部那行动画的存在条件是 `assistantPartRefs.length === 0`——**一个可渲染 part 都还没到**，也就是在等供应商的首 token；首个 reasoning part 一落地它就消失，换成推理块自己的「思考中 → 已思考」。于是同一个词在一秒之内指了两件事，而先出现的那个恰恰不是思考（那行秒表的注释本来就写着「供应商排队等首 token 的等待也算进秒表」）。行上加一个 `awaiting` 布尔，为真时文案走新增的 `ui.sessionTurn.status.awaitingResponse`。按布尔分而不是按「有没有开推理摘要」分，是因为关掉推理摘要时这行横跨整个 busy 窗口，那种情况下前半段仍是等待、后半段才是思考。

#### 其他

- **看板娘「赤」**（`packages/desktop/scripts/build-icons.ts` 新增、`icons/{dev,beta,prod}/*`、`packages/desktop/赤.ico`、`packages/opencode/script/build.ts`、`packages/app/src/app.tsx`、`components/logo.tsx`、`docs/assets/chi-portrait.webp`）：两个 exe 的图标、GUI 启动画面、README 立绘统一换成她。图标生成脚本化而不是手搓 ICO，三件事写进了脚本头：边界按 alpha 扫不靠目测；**小尺寸（16/24/32/48）用放大到头部的裁剪、大尺寸（64/128/256）用完整徽章**——任务栏在 100% DPI 下只取 32×32，满幅细节缩到 32 没有剪影可言，而 ICO 本来就允许每帧不同的图；必须多尺寸——旧的 `icon.ico` 只有一帧 249×256（还不是正方形），Windows 取不到 32 那一档时整个回退成默认 Electron 图标。启动画面从原来那只猫的 GIF（base64 23.8KB）换成她的 GUI 徽章（320px webp）。
- **重写双语 README**（`README.md`、`README.en.md`）：原来的「核心能力」是一长串顿号堆到底，两个入口只有两行 bullet。改成表格分区（代码理解 / 动手 / 多模型 / 上下文 / 组织 / 代理 / 安全），补上此前从未写进 README 的三件事——首页用量看板、三档权限姿态（并说明三档**只差权限**，不换提示词也不换模型）、`redcode web --hostname 0.0.0.0` 的手机访问（含「局域网绑定必须设密码，否则直接拦下」这条实际行为）。0.10.0 那轮桌面端性能专项的结论也在「相比上游做了什么」里留了一句带数字的索引。

---

### [0.10.0] - 2026-09-01

> **桌面端性能专项**：定案「慢」的主因是主进程的同步 I/O 而非渲染 —— 共用的 .dat 被 base64 图片撑到 2.64MB，每一次持久化读写都在主进程上重写整个文件；provider 关键路径每进一个目录拉 5.7MB；建窗死等 sidecar 1.6 秒；流式渲染每 tick 重算全文。逐条实测修完，首屏 chunk 累计减 1.26MB。另新增首页用量看板（服务端聚合端点 + 前端面板）。此前积压的未发布项一并发布：插件加载的三条静默失败路径补上提示；gpt.md 按 GPT-5.6 重做；ChatGPT 套餐额度记录并上了 GUI 面板，TUI 侧边栏也出了同款面板；会话消息的 part 排序补掉思考链被工具气泡甩到前面的漏网。

#### 新增

- **首页用量看板**（`packages/opencode/src/session/usage.ts` 新增、`server/routes/instance/httpapi/groups/session.ts`、`handlers/session.ts`、`packages/app` 的 `pages/home-usage.tsx` / `home-usage.data.ts` 新增、`pages/home.tsx` / `home-kanban.tsx` / `home-stats.tsx`、`context/global-sync/bootstrap.ts`、`context/server-sync.tsx`、`index.css`）：首页主区会话卡旁边出一块用量看板，总览页给缓存命中环 + 八个指标块（会话数 / 请求数 / 产出 Token / 缓存读取 / 活跃天数 / 当前连续 / 最长连续 / 峰值时段）+ 活动热力图，模型页给按天堆叠柱与带 in / out / 占比的图例，右上角 `全部 / 30 天 / 7 天`。

  数据走**新增的 `GET /session/usage`** 而不是前端 reduce：前端只有已加载的那批会话（首页 `limit=114`），而库里有 505 个——原先侧边栏那个圆环显示的「累计花费」其实只是已加载部分的和，实测圆环 ¥253.68 而该项目全部 268 个会话的真实总额是 ¥287.77。作用域取 `InstanceState.context` 的 `project.id`，与 `Session.list` 的 project scope 同一口径（一个项目的多个 worktree 算在一起）。原侧边栏面板整个删除，圆环组件保留并复用。

  两条口径上的坑写进了 `usage.ts` 文件头：① **按天归集必须走 `message` 表**，`session.tokens_*` 是整个会话的累计值，按 `session.time_created` 归日会把「昨天开的、今天还在用」的会话全算进昨天（私仓那份看板 260812 踩过）；② **不照搬私仓那份的 `CNY_PROVIDERS` 硬编码名单**，GUI 侧 260827 已退役它改读 `model.cost.currency`，端点只出原始 cost 与 providerID/modelID，折算交给前端复用 `home-stats.tsx` 的汇率常量，避免出现第三份。`streaks` 的断点判定用本地日历日的字符串差而不是时间戳差——夏令时会让 86400000 说谎。

  视觉侧：面板与侧边栏共用同一条 `data-frost-surface` 磨砂规则（并进 `index.css` 的同一个选择器，以后调 frost 参数两边不会分叉），指标块用 `bg-layer-01` 上的 `layer-02`。图表选型按 dataviz 规范走：热力图是顺序编码、单色相、**0 走底色而不是最浅一档**（「没用过」和「用得少」是两回事）、分档用**分位数**不是等距（token 用量重尾，等距会把绝大多数格子压进最浅一档）；堆叠柱是分类编码、固定色序**不循环**、超出的折进「其他」（该项目历史上有 30 个模型，不折叠必然两个模型同色）。调色板按本仓 yuqi 主题底色（浅 `#faf2f6` / 暗 `#321a34`）跑过验证器：暗色五项全 PASS，浅色四项 PASS + 对比度 WARN（4 个低于 3:1）——**那条 WARN 规范里不可豁免、必须配可见标签兑现**，所以图例每行强制带 in / out / 占比三个数字，不是装饰。同一个 modelID 可能来自不同 provider（`deepseek-v4-flash` 同时挂在 opencode-go 与 deepseek 下），重名时带 provider 前缀，否则身份就只能靠颜色区分了。

  生成链已重跑，`openapi.json` 与 `sdk.gen`/`types.gen` 均为纯新增。数值字段用 `Schema.Finite` 而不是 `Schema.Number`——后者会生成 `number | "NaN" | "Infinity" | ...` 的联合，仓里既有字段用的都是 Finite。


- **记录 ChatGPT/Codex 套餐额度**（`packages/opencode/src/provider/quota.ts` 新增、`plugin/codex.ts`）：订阅认证下 Codex 后端把用量窗口放在**响应头**里，此前 `return fetch(...)` 原样丢弃。实测（Plus 账号，一次真实请求取证）带回 `x-codex-plan-type` / `-active-limit`、`x-codex-primary-*`（`window-minutes: 300` = 5 小时档）、`x-codex-secondary-*`（`10080` = 7 天档）、`x-codex-credits-*`，外加 `x-base-model-inference-*` 这组独立的 `gpt-reserve` 储备池——与 Claude Code 用量面板的三条进度条一一对应。现在解析并存进内存，日志可见。只读头、**绝不碰 `response.body`**（那是要交给 AI SDK / 原生运行时消费的 SSE 流）；`record()` 内部吞掉全部异常，解析失败不会把模型请求带走。存储刻意做成模块级而非 `InstanceState`——写入点是 AI SDK 起的裸 promise，没有 fiber 也没有 `InstanceRef`，`InstanceState.get` 会静默落到 `process.cwd()` 键上（见 `effect/instance-state.ts` 的 `fallbackContext`），写进去没人读得到且不报错；何况凭据本身就是进程级的。捕获点选在插件的 fetch 而不是 `provider.ts` 的 AI SDK 包装，因为原生运行时会绕过后者（`session/llm/native-runtime.ts:97` 那道 `openai` + `oauth` 闸门），插件 fetch 是两条运行时唯一的交汇点。
- **ChatGPT/Codex 套餐额度 GUI 面板**（`provider/quota.ts`、`server/routes/instance/httpapi/groups/provider.ts`、`handlers/provider.ts`、`app` 的 `server-sync.tsx` / `global-sync/bootstrap.ts` / `global-sync/event-reducer.ts` / `components/session/session-context-tab.tsx`）：额度从「记录在内存里」到「看得见」。服务端：`record()` 捕获后经 `GlobalBus` 广播 `provider.quota.updated` —— 额度是账号级事实，走 `GlobalBus` 不至于盖上某个实例的 directory/project 章、只在那个项目里可见；新增 `GET /provider/quota` 供首次拉取与刷新，`success` 用 `Schema.Array`（legacy OpenAPI transform 会在非 `/api` 路径剥掉 null 分支，空数组表示尚未捕获）。GUI：会话上下文页新增「ChatGPT / Codex 套餐额度」区块，primary（5 小时档）/ secondary（7 天档）/ reserve（`gpt-reserve` 储备池）三条进度条，颜色按用量分档（≥90% 告急 / ≥60% 警告 / 其余提示色），重置时间渲染成 `resetAt`（unix **秒** ×1000）的绝对本地时刻——零定时器、零周期重绘、不闪。事件接进 `applyGlobalEvent`：同 `providerID + accountID` 替换否则追加；新客户端首次进场由 `bootstrap` 拉一次，接上长跑服务端时面板不为空。文案走 i18n 三语。

- **ChatGPT/Codex 套餐额度 TUI 侧边栏**（`provider/quota.ts` 事件复用、`cli/cmd/tui/context/sync.tsx`、`feature-plugins/sidebar/quota.tsx`、`plugin/internal.ts`、`plugin/tui.ts`、`test/fixture/tui-plugin.ts`）：GUI 面板同一份数据源（`provider.quota.updated` 全局事件 + `GET /provider/quota`），TUI 侧边栏出一块——每条额度一行：planType + accountID + primary（5h 档）/ Weekly（7 天档）/ reserve（储备池）三条进度条，`█░` 条形按用量分档着色（≥90% 告急 / ≥60% 警告 / 其余提示色），重置时间渲染成 `resetAt`（unix 秒 ×1000）的绝对本地时刻——零定时器、零周期重绘。事件经 `useEvent` 的 global 分支进 `sync` store（同 `providerID + accountID` 替换否则追加），首次进场由 `bootstrap` 拉一次。`TuiState` 加 `provider_quota` 字段走插件 API 投影，sidebar 插件 slot 注册 `order: 250`。

#### 优化

> 这一批的共同结论：**桌面端「慢」的主因不在渲染进程，在主进程的同步 I/O。** 此前抓 CPU profile 得到「6017ms idle、JS 函数耗时几乎为零」，被读成「在等网络 I/O」——测量是对的，指向错了：渲染进程确实在 idle，因为它在等主进程回 IPC。而渲染层的性能浮层与 LoAF 看不到主进程。

- **历史记录不再把 base64 图片写进全局共用的 `.dat`**（`packages/app/src/components/prompt-input/history.ts`、`prompt-input.tsx`）：实测他机器上 `RedCode.global.dat` 2.64MB，其中 `prompt-history` 占 2678KB（98.9%，30 张 base64 PNG + 1 个 base64 PDF），而真正需要的 layout / model / command.catalog / server / notification 加起来只有约 30KB。electron-store 底下的 conf 是「一个 name 一个 JSON 文件」，且 **get 和 set 都要 readFileSync 整个文件 + JSON.parse**（set 还要 stringify + 原子写），于是这 2.6MB 的陈年图片给**每一次 `Persist.global` 读写**都加了一个常数——改侧栏宽度、切模型、写命令目录全都要连读带写过一遍，而且是在 Electron 主进程上同步做。草稿路径上这个 bug 早就修过（`context/prompt.tsx:167`，注释写着「贴图后打字卡顿的根因」），历史路径漏了，而历史比草稿严重得多：草稿在各工作区自己的文件里（实测都 ≤6KB），历史在共用文件里。`migrate` 与 `serialize` 两个都挂：前者管存量就地瘦身（`persist.ts` 的 `readCurrent` 在 migrate 改了内容时会写回盘），后者管以后别再写进去。拿他真实数据离线验过：**2675KB → 10KB，99 条非空文字历史逐条一致、顺序一致，整个文件 2.64MB → 42KB**。代价与草稿一致：重开应用后历史只保留文字。
- **持久化落盘合并**（`packages/app/src/utils/persist.ts`）：`makePersisted` 是写穿的，每一次 `setStore` 都序列化整个 store 并调一次 `setItem`，而桌面端的 `setItem` 是一条 IPC，主进程那边同步重写整个 `.dat`。最容易复现的是拖分栏条（`ui/components/resize-handle.tsx` 的 `onMouseMove` 直接 `onResize` → 一次落盘）。改在 persist 层而不是 resize-handle：调用点有 20 多个改不干净，而且 Chromium 已把 mousemove 对齐到帧、在那里加 rAF 基本是空操作——该合并的是落盘不是事件。同 key 连续写只保留最后一版、250ms trailing 落盘；`removeItem` 先撤销排队中的写（否则删完又被旧值写回来）；`beforeunload` / `pagehide` / `visibilitychange(hidden)` 三处补 flush。只对桌面端那条异步 IPC 路径做。
- **provider 关键路径换成 TUI 走的瘦端点**（`packages/app/src/context/global-sync/bootstrap.ts` / `utils.ts`、`context/server-sync.tsx`、四个对话框、`packages/opencode` 的 `handlers/provider.ts`）：他说「网页端加载比 exe 快，点卡片进会话倒是一样的慢」——一样慢那半边说明瓶颈在共用的服务端。逐接口计时：`/provider` **5879KB / 215 厂商 / 7378 模型 / 热态 630–915ms 且永远不变热**，而 TUI 从来不碰它（`cli/cmd/run/runtime.boot.ts:120` 拿的是 `/config/providers`，变量名就叫 connected，只有那条失败时才回退），后者 **105KB / 14 厂商 / 120 模型 / 热态 16–20ms**。两个端点的数据源本来就是同一个（`Provider.Service.list()` → InstanceState 里缓存的 `state.providers`），`/provider` 只是额外把整个 models.dev 目录并进来。而 GUI 的 query key 带 directory，于是全局拉一次 5.7MB、**之后每进一个目录再拉一次**。关键路径改走 `sdk.config.providers()`；全量目录降级成 key 不带 directory、`staleTime`/`gcTime` 无限、默认不 enabled 的懒查询，空闲窗口才拉一次；真正需要「未连接厂商」的四处（选厂商 / 连接 / popular / 设置页）在挂载时自己要。服务端 handler 里目录那部分按源对象 WeakMap 缓存——此前对 215 个厂商各跑一次 `fromModelsDevProvider` + `toPublicInfo`（后者是 `JSON.parse(JSON.stringify())`，7378 个模型走一遍完整序列化往返），每请求重算。不动 schema、不动生成链。
- **建窗提到等 sidecar 之前**（`packages/desktop/src/main/index.ts`、`renderer/index.tsx`）：打包版真实日志（两次一致）——`app starting` T+0、`sidecar healthy` T+1.63s（**原先窗口到这一刻才被创建**）、`awaiting server ready` T+2.07s（渲染层自己只花 0.44s）。也就是说点了图标之后 1.6 秒屏幕上什么都没有，而这 1.6 秒里渲染进程根本还没被 fork，两件事之间没有依赖。`createMainWindow()` 移到 `Fiber.await(loadingTask)` 之前（位置不能再往前：`port`/`url`/`password` 必须先算完，否则 `registerIpcHandlers` 的闭包撞 TDZ）；`awaitInitialization` 改成真的等 `serverReady`（原先是「注册 listener → 立刻注销 → 立刻 resolve」，那套 init-step 协议实际是死的）；`renderer/index.tsx` 那个包住整个 UI 的 `<Show>` **补 fallback**——它原先没有，窗口提前出现会变成约 1.4 秒的空白窗，比「点了图标没反应」更糟。他事后实测：启动到渲染层连上 **7.28s → 5.71s**。
- **健康检查先探一次再睡**（`packages/desktop/src/main/server.ts`）：轮询把 `sleep(100)` 放在循环头，而这个循环是在收到 sidecar 的 `ready` 之后才跑的，sidecar 又是 `await Server.listen(...)` 成功后才 `postMessage("ready")`（`sidecar.ts:119 → :127`）——循环启动时端口 100% 已在监听，第一次 `checkHealth` 必然成功，那 100ms 是纯损耗。他实测 `ready → healthy` 间隔 **118/123/123/134ms → 36/40ms**。
- **服务端 bundle 开 V8 编译缓存**（`packages/desktop/src/main/sidecar.ts`）：`import virtual:redcode-server` 是启动里最大的单项，他机器实测 1132 / 1183 / 1343 / 1777ms，占 sidecar 就绪时间的 92%（`Server.listen` 本身只要 100ms）。拿真实 bundle 做过冷热对照（Electron 42.4.1 自带 Node 24.16.0）：不开 1245/1294/1312ms、开了首次冷 1403ms、后续热 1035/1019/1149ms，约省 260ms，缓存 3.1MB。省不掉更多是因为这 1.3 秒里大部分是模块**执行**而不是编译。必须在 `await import` 之前调用；缓存目录名带 Node 版本与内容哈希，升级或重建自然失效。
- **流式 markdown 按定型前缀分段**（`packages/ui/src/components/markdown-stream.ts`）：`markdown.tsx` 的 per-block 缓存本来是对的，但 `stream()` 只在「文本正好停在未闭合代码围栏里」时才切块，其余一律返回**整条消息一块**，于是流式期间 `block.raw` 每 tick 都变、缓存永远不命中，每 tick 对整条消息重跑 `md.render` + `DOMPurify.sanitize`。每 tick 实测：10.9KB 4.1ms / 30.1KB 9.8ms / 61.5KB 21.5ms / 123KB 36.7ms，sanitize 是最大头。成本与**已写出的全文长度**成正比而每 tick 都付——这就是长回答越写越卡。改法是把已有的 head+tail 切法推广，但**按 4KB 分段**而不是每个顶层块一块（块缓存是全局 LRU、上限 200 条，30KB 的回答有约 300 个顶层块，全切会把缓存冲垮）也不是整个前缀一块（每完成一个块要重新 parse 整个前缀，模拟只省到 3.6 倍）。切点取 markdown-it 的顶层 token 边界，列表/引用整体是一个顶层 token 序列所以不会切进列表内部。模拟 30KB / 776 tick：**每 tick 重算总量 11.50MB → 0.72MB（16 倍）**，且成本不再随全文长度增长。
- **时间线行数组没变就别换引用**（`packages/app/src/pages/session/message-timeline.tsx`、`message-timeline.data.ts`）：`reuseTimelineRows` 逐行复用是对的，但它永远返回 `rows.map(...)` 这个新数组。`createMemo` 默认按 `===` 比较，所以哪怕每一行都复用成功（实测流式期间命中率就是 100%），下游整条派生链每 16ms 全量重跑一遍：`timelineRows` 对整个已加载会话 flatMap + 建全量 Map + 逐行 equals，`timelineRowKeys` / `messageRowIndex` / `lastAssistantGroupKey` 各自再遍历一次全量行，Virtualizer 的 data prop 每帧换新引用。实测（V8）481 行 0.68ms、1651 行 1.82ms、3601 行 3.96ms，按 `FLUSH_FRAME_MS = 16` 算是中等会话 4%、长会话 11% 的帧预算，整段回答期间持续。改成整个数组都没变时返回 `previous` 本身。函数搬到纯模块并补 6 条单测，断言几乎全是 `toBe` 而不是 `toEqual`——这条改动的价值全在引用语义上。
- **`@pierre/diffs` 改成用到才加载**（`packages/app/src/app.tsx`）：首屏 chunk 掉 510KB。**必须自带 Suspense**——`File` 是交给 `FileComponentProvider`、在消息内容深处由 7 处 `<Dynamic>` 渲染的，裸 `lazy()` 的挂起会一路冒泡到 ConnectionGate 里那个包住整个应用、fallback 是满屏 Splash 的 Suspense，展开一个 diff 会把整扇窗清掉。⚠️ 想验这条**别用切路由**：solid-router 的跳转跑在 `startTransition` 里，`createResource.read()` 有一支会替你兜住，于是裸 `lazy()` 在路由跳转时看着「没事」；会露馅的是不在 transition 里的路径——会话内展开 diff、侧栏点开文件。
- **katex 改成用到才加载**（`packages/ui/src/context/marked.tsx`）：从打包产物 sourcemap 归因，katex.mjs 594KB，占首屏 chunk（转译前 4.78MB）的 12.2%，是最大的单个文件。而 `MarkedProvider` 在 `app.tsx` 是静态引入的，每次启动都要解析编译一遍——哪怕整个会话一条公式都没有。三件事让它零视觉代价：`parse()` 本来就是 async；同文件里的 `highlightCodeBlocks` 早就是这个套路；katex 的**样式**走 CSS 层不受影响，公式渲出时不会有一瞬间没样式。另加 `MATH_PATTERN` 先挡一道，不含定界符的直接原样返回，连动态 import 都不发起。
- **外壳 i18n 不再静态引三份 app 字典**（`packages/desktop/src/renderer/i18n/index.ts`）：首屏少 90KB。app 层 `language.tsx` 本来把 zh/ja 写成动态 import 了，是这里的静态引用把切分废掉的——对照证据是 ui 层的 zh 正常切出了独立 chunk（7KB），只有 app 那两份被吸进主 chunk。外壳自己只用 7 个 key，6 个在它自己的字典里，剩下一个是 `import.meta.env.DEV` 分支里的开发期报错。
- **tauri shim 里的 marked 改成用到才加载**（`packages/desktop/src/renderer/tauri-api-shim.ts`）：首屏少 70KB，且它**挡在应用入口前面**——`index.html` 里这个文件是排在 `index.tsx` 之前的阻塞 module 脚本（有顶层 await），而它在 Electron 下检测不到 Tauri 就原样返回，`parseMarkdownCommand` 这条路径永远不会被调用。该函数本来就是 async，改成动态 import 对 Tauri 侧零影响。

#### 诊断

- **两个诊断工具从常驻路径上摘下来**（`packages/desktop/src/main/index.ts`、`logging.ts`）：都是当初为排查具体问题临时加的取证代码，没加开关就留在了常驻路径上。① 每 15 秒 spawn 一个 `powershell.exe` 跑 `Get-CimInstance Win32_Process` 拉全机进程表（260706 为排查「打开对话飙到 7G」加的），本机实测单次 565–697ms 墙钟，常驻一天 5760 次进程创建、每次还带一个 conhost 并触发 Defender 扫描；写盘那侧更直观——`logs` 目录 18MB 里 17.5MB 是它一个人写的，其余所有日志加起来不到 500KB。② Chromium NetLog 无条件常开，`captureMode: "default"` 记录全部网络事件，而这个应用的网络画像恰好是最坏情况（一条常驻 SSE + 模型输出时每 token 一条消息），实测 4 分钟写掉 10.55MB。分别改成 `REDCODE_METRICS=1` / `REDCODE_NETLOG=1` 才开，取证能力保留。关掉 NetLog 不影响导出调试日志。

#### 修复

- **插件加载的三条静默失败路径**（`packages/opencode/src/plugin/index.ts`）：`loadExternal` 的 install / compatibility / entry / load 四档都已 publish `Session.Event.Error`，唯独漏了三处——① `missing`（包解析到了但没有 server 入口）只有 `log.warn`，界面全无，RedCode-dcp 当年导出条件不匹配「从未被宿主加载」就长期落在这一档；② 整体的 `Effect.timeout("30 seconds")` 后面接 `Effect.catch(() => Effect.succeed([]))`，超时把**所有**外置插件一起吞成空数组，连日志都不留；③ `applyPlugin` 抛错处那个 `// TODO: make proper events for this`，事件被注释掉只剩日志。三处统一走 `publishPluginError`，措辞区分「未加载」与「加载失败」，超时那条带上被跳过的插件数量。
- **会话消息 part 排序：思考链恒置最前**（`packages/app/src/context/directory-sync.ts`）：GLM-5.3-Flash 等模型首轮流式里 `tool_calls` 会先于 thinking 到达（哥哥 260831 实测撞上），服务端按到达序写 part 时间戳——字典序排序落库时间序，把工具气泡甩到思考链前面（坏会话首屏「Shell 查看重置图文件夹内容」排在「已思考」上）。修复：`sortParts` 改语义序——reasoning 滤出恒置最前、段内保持字典序（=落库时间序）；`hasParts`/`mergeParts` 弃词典序二分改线性（数组已不是字典序，`Binary.search` 会 miss；260831 cc 消息层同款教训），`mergeParts` 插入位按语义段找（reasoning 插到第一个非 reasoning 之前）。

已知未决：sol / terra / luna 共用同一个 `x-codex-active-limit: premium` 桶，单次请求对百分比的权重差多少，在 0% 上量不出来，等实际用出读数再看。

---

### [0.9.19] - 2026-08-31

> 工具行的文件名前挂上文件类型图标；diff 收掉重复的文件名与那层盒子，变更行的着色给足；圆角标度三份合一。

#### 新增

- **工具行的文件名前挂文件类型图标**（`packages/ui/src/components/basic-tool.tsx`、`basic-tool.css`、`message-part.tsx`、`message-part.css`、`basic-tool.stories.tsx`）：读取 / 编辑 / 写入三种工具行的文件名前显示该文件的类型图标。查下来又是现成的多、缺的少——`packages/ui` 本来就有整套 `FileIcon`，`chooseIconName()` 带文件名表 / 扩展名表 / 文件夹名表与默认档，sprite 里一千多个图标（VSCode Material 那一脉），文件树与选文件 / 选目录对话框都在用，缺的只是没人接到工具行上。不是 emoji，是 SVG sprite 的 `<use>` 引用。`TriggerTitle` 加 `subtitlePath` 而不是从 `subtitle` 推——`subtitle` 只是 basename，而 `chooseIconName` 要看完整路径才能分辨按目录命中的规则。两处实现细节：图标必须是 subtitle 的**兄弟节点**（那个 span 带 `overflow:hidden` + `text-overflow:ellipsis`，svg 进去会被省略号机制波及）；`basic-tool` 的容器是 `align-items:baseline` 而 svg 没有文字基线、默认按下边缘对齐会整体坐低半格，故单独 `align-self:center`（`message-part` 那个容器是 center，不用处理）。性能：每行代价可忽略（一个 svg + use，`chooseIconName` 是几次查表且组件内 memo），真正的成本是 sprite 那 922K 只在首次被 `use` 引用时拉一次——文件树与两个对话框已经在用，但文件树是 `<Show when={fileOpen()}>`，所以从不开文件树的会话现在会新拉这一次；Electron 里是本地文件可忽略，走 WiFi 的手机端会有感。

#### 修复

- **edit / write 的 diff 去掉重复文件名的手风琴头**（`packages/ui/src/components/message-part.tsx`）：`ToolFileAccordion` 的头渲染「文件图标 + 目录 + 文件名 + `+N -N`」，而上面 `BasicTool` 的 trigger 已经有了同样的东西——一屏之内文件名出现两次（加了工具行图标之后连图标都重复）。折叠能力也是重复的：外层 `BasicTool` 本身就是 Collapsible，单文件场景内层再折一次没有意义。去掉后 diff 直接接在工具行下面，顺带少一层带边框的盒子。代价是长 diff 滚动时失去 sticky 的文件名——单文件、名字就在正上方，可接受；`apply-patch` 那种多文件场景仍用 `ToolFileAccordion`，那里每文件一个头是必要的。
- **diff 变更行的着色强度上调，行号槽单独给足**（`packages/ui/src/pierre/index.ts`）：变更行一直有底色，但深色档只有 8% 的着色量（`color-mix` 92% 背景 + 8% 基色），在磨砂紫底上读不出来。一个旁证说明 8% 偏低：同一份配置里 hover 态是 30%——鼠标划过一行的提示比「这行被改了」这个事实本身还显眼四倍，主次是反的。行底色 8% → 16%（深色 92→84，浅色 98→94），行号槽 15% → 26%（深色 85→74，浅色 91→86）。只动改动行，上下文行保持不着色——正是这个反差让人一眼看到改动的形状。嫌重嫌轻改这四个百分数即可；pierre 另留了 `--diffs-bg-*-override` 可在下游单独覆盖。注意这同时影响侧栏审阅面板与 enterprise 的公开分享页，它们走同一套变量。

#### 其他

- **圆角标度三份合一**（`packages/ui/src/styles/tailwind/index.css`、`ui/styles/theme.css`、`app/src/index.css` 及四处消费点）：此前三份——ui 的 `@theme`（2/4/6/8/10）、`ui/styles/theme.css`（同值重复且被前者覆盖的死副本）、`app/src/index.css` 的 `@layer base` 覆盖（4/6/8/12/16/24，每档上调一级）。base 层在 theme 层之后，所以桌面应用里生效的一直是 app 那份，**而下游只有 app 有那份覆盖**：`packages/storybook`（79 个 story，全在 `ui/src` 下）与 `packages/enterprise` 的 `/share/[shareID]`（公开的会话分享页，渲染 ui 的 `SessionTurn` 与 `SessionReview`）拿到的都是小一号的值，ui 组件 CSS 里那 48 处 `var(--radius-*)` 在这两处都受影响。生效值（含 ⑥ 的 `--radius-pane: 14px`）搬进 ui 的 `@theme`，删掉另外两份，下游不再覆盖；`--radius-pane` 进 `@theme` 后 Tailwind 会生成 `rounded-pane` 工具类，app 侧六处 `rounded-[var(--radius-*)]` 一并简化。桌面端逐档不变、零视觉变化，变的是 storybook 与分享页跟上来了。另：`--radius-2xl` 全仓零使用，`@theme` 里没人用的档位会被 Tailwind 摇掉、不出现在 `:root` 上，探针查它显示未定义是正常的。
- `packages/storybook/debug-storybook.log` untrack 并入 gitignore —— 2026-05-25 初始导入时误入仓的调试产物，跑一次 storybook 就被重写一次。

---

### [0.9.18] - 2026-08-31

> 玻璃质感六条清单收尾：光标辉光、两个侧栏脱边成卡、圆角标度补上缺的「面」这一格。

#### 新增

- **⑤ 光标 spotlight 辉光**（`packages/app/src/utils/spotlight.ts`、`app/src/pages/layout.tsx`、`app/src/index.css`）：一团跟着光标走的径向光，垫在所有玻璃面**背后**。底本是 DSH Aqua 从 deepseek.com 官方特性卡移植的那个 hover 交互。只做一个实例、挂在 `<main data-frost-surface="main">` 里——`z-index:-1` 的子元素按 CSS 绘制序画在**父背景之上、父内容之下**，而 `#file-tree-panel` / `#review-panel` / `home-sidebar` 全是 main 的后代，于是一团光同时垫在上面每一层玻璃底下，覆盖全应用，也不会像逐面板各挂一个那样在重叠处叠成两倍亮。逐帧只改 transform 不重画渐变（辉光是 2×半径 的定尺方块、渐变只栅格化一次，靠 `--spot-x/y` 驱动位移；Aqua 那边每帧重写整块 `background-image`，重画面积等于整个窗口）；几何量每次 hover 只测一次，逐帧路径零布局读取，面板可拖拽改宽故用 ResizeObserver 作废缓存。两处不照搬底本：半径 126px（官方 180 的 70%，实机看过定的），颜色取 `--frost-tint-aside` 那支蓝紫而非官方的青（本仓玻璃掺色语言是粉 + 蓝紫，青会是唯一的第三种色相）。`prefers-reduced-motion` 直接关掉。
- **④ 文件树 / 审查栏脱边成卡**（`packages/app/src/index.css`）：沿用首页侧栏那份配方——8px 脱边 + 14px 圆角 + 四边描边 + `--v2-elevation-floating`，再叠 ① 的迎光边。脱边量给 8px 而不是首页那档 12px：这两个栏可拖拽调宽，用户按内容宽度定的宽，左右各吃 12px 更肉疼。只在有壁纸时成卡（无壁纸时 main 自己就是带 `m-2` 的卡，里面再套两张是盒中盒）。两个容易静默失效的点都实测过：这两个元素带 `h-full`，只加 margin 会溢出 2×inset，必须同时改 height（实测 main 1228px → 面板 1212px）；`box-shadow` 不叠加，迎光边必须把 `--v2-elevation-floating` 一起写回来（实测 5 层且含 inset）。**`main` 保持满贴是本次拍的板，不是 ④ 没做完**——那会推翻 260610 定的「毛玻璃满贴标题栏，不再像镶嵌进去的一块玻璃」，且变成壁纸 + 大卡 + 卡里两张小卡的盒中盒。
- **⑥ 圆角标度补上「面」这一格**（`packages/app/src/index.css`）：⑥ 原计划是「立一套 14 面 / 10 控件 / 8 原子的三档语言」。勘查发现语言早就存在且更细——260602 就在的 `--radius-xs/sm/md/lg/xl/2xl`，全 ui 组件库在用（button/card/dropdown = md(8)，avatar/checkbox/icon-button = sm(6)，dialog = xl(16)）；计划里的「8 原子」其实是控件档的值，「10 控件」全仓零实例。真正缺的只有**「面」这一格**：脱边浮起、四边可见的那几张卡各写各的字面量（三处 14、`main` 是 10）。补 `--radius-pane: 14px`，四处收进来，`main` 的 10 并入同档。按角色命名而非尺寸是有意的——它不是「再大一号」，是「脱边浮起的面」这个身份；14 不吃现成的 `xl(16)` 是因为同心圆角要求外层面 > 内层面，内层的 composer / dock / 斜杠浮层是 `lg(12)`。

#### 其他

- **四处圆角字面量接回既有标度**（`packages/ui/src/components/dock-surface.css`、`app/src/components/prompt-input/slash-popover.tsx`、`app/src/pages/session/composer/session-composer-region.tsx`、`app/src/components/titlebar.tsx`）：三处 `12px` → `var(--radius-lg)`（值就是 12px），titlebar 那个 `rounded-[27px]` → `rounded-full`（元素高 20px，27px 本来就被钳成胶囊）。全部等值，零视觉变化。
- 勘查中记下的一处地形：**两套 `--radius-*` 并存**——ui 自己定义 `xs..xl = 2/4/6/8/10`，app 那套是每档上调一级的覆盖（4/6/8/12/16/24）。app 在 `@layer base`、ui 在 `@theme`，base 在后所以 app 生效（浏览器实测 `xs=4 sm=6 md=8 lg=12 xl=16`）。但 storybook 不加载 `app/index.css`，ui 组件在那里拿到的是 ui 那套——所以 app 定义的 token 不能给 ui 组件用（`line-comment-popover` 那处 14px 是浮层不是面，数值巧合，故意不动）。
- `.claude/` 入 gitignore（Claude Code 的本机开发配置，非源码）。

---

### [0.9.17] - 2026-08-31

> 点工具行里的文件名就能在侧栏看到那个文件（图片直接出图）；消息顺序钉在 store 自身，ID 回绕不再把新的一轮甩到会话最顶上；提示词按 zcode 对照补齐五条。

#### 新增

- **点工具行里的文件名，在侧栏打开它**（`packages/ui/src/context/file.tsx`、`ui/components/message-part.tsx`、`message-part.css`、`packages/app/src/pages/session.tsx`、`packages/opencode/src/file/index.ts`）：此前看到「读取 gen_test_prof.png」只能自己去文件树里翻路径。调研下来这条链上**现成的比缺的多得多**——服务端 `/file/content` 早就返回 base64 + mimeType，`file-media.tsx` 早就认 image / audio / svg，`file-tabs.tsx` 早就把 media 传给了 `<File>`（从文件树打开图片本来就能看），`basic-tool.tsx` 早就有 `onSubtitleClick` 与配套 `.clickable` 样式。真正缺的只有两点：**没人传 `onSubtitleClick`**，以及 **subtitle 只是 basename、拿不到完整路径**。read 走 object trigger 直接接回调，edit / write 用的是自定义 JSX trigger、在各自 filename span 上接，三处都从 `input.filePath` / `metadata.filediff.file` 取全路径；app 侧在 `session.tsx` 提供实现（`file.normalize` 转项目相对路径后复用现成的 `openReviewFile`，面板关着时先打开，否则点了没反应）。`FileOpenProvider` 刻意用 Solid 原生 context 而非 `createSimpleContext`——后者的 provider 带 ready 门控，而这里要的恰恰是「没有 provider 时安静返回 undefined」，storybook 与 playground 里没人提供实现。
- **内联文件 20MB 上限**（`packages/opencode/src/file/index.ts`）：超限按「二进制、不提供内容」返回并打 `read.tooLarge`。判断放在 base64 之前而不是先 stat——`AppFileSystem` 接口上没有 stat/size，加一个要动服务定义与各实现；读完再判省不掉磁盘读，但省掉了 base64 的 33% 膨胀与整段 JSON 传输，贵的是后两者。限额设 20MB 而非更低，是因为这条 `File.read` 与 `read` 工具给多模态模型读图共用，设低了会误伤模型。
- **提示词补齐五条**（`packages/opencode/src/session/prompt/{default,glm,deepseek,hy}.md`）：拿 zcode 里 glm-5.3-flash 的自述提示词逐条对照（那是模型的转述不是逐字原文，按「结构与意图」采信）。绝大部分我们已经有了；真正缺的是首句即结论、回复形状匹配问题形状、收尾前检查最后一段（以「我待会儿会…」结尾的回合就是未完成的回合）、描述问题 ≠ 要你改、以及 Markdown 会被渲染这条能力事实。**刻意没吸收**语气与详略那两条（`glm.md` 开头写死了「由 soul 决定，本文件不规定」，两处立法会让调 soul 时被莫名拽回）。另修掉一条从 zcode 带进来的假前提：「用户看不到推理通道」在本仓不成立——思考链默认折叠但**可展开**，`deepseek.md` 第 11 行自己就写着 `which the client collapses by default`。换成针对真实失效的规则：思考链里想明白了、正文又复述一遍，是回复变长而不变有用的最常见方式。铺开范围是在用的这四份，`step.md` 等其余十来份仍未铺——那属于 17 份提示词无共享底本的结构性漂移，另行处理。

#### 修复

- **消息顺序钉在 store 自身，ID 回绕不再把新消息排到会话最顶**（`packages/app/src/context/directory-sync.ts`、`context/global-sync/event-reducer.ts`、`pages/session.tsx`、`pages/session/message-timeline.tsx`）：ID 是时间编码且 795 天回绕一次，回绕后**新**消息的 ID 字典序反而**小于**旧消息——实测同一会话里 8/31 的 `msg_001a…` 字典序小于 7/29 的 `msg_fac…`，按 ID 排会把新的一轮甩到会话最前面，看起来像消息丢了（DB 实测 201 条一条没少；全库 504 个会话里 6 个 ID 序≠时间序，1 个会因此在 200 条窗口里真丢消息）。0.9.16 那次只排了显示层两处，是打地鼠——直接读 `sync.data.message[...]` 的消费者有 8 处，侧栏「最后活动」就是漏掉的那个（还显示一个月前）。这次把顺序钉在写入侧（`fetchMessages` / 乐观增删 / `message.updated` 插入一律按 `compareTime`），读取侧恢复裸读。代价是定位不能再用 `Binary.search`（它假设字典序），改线性 `findIndex`——消息数组最多几百条，插入本来就要 O(n) 拷贝。
- **乐观合并里漏网的一处二分**（`packages/app/src/context/directory-sync.ts`）：`mergeOptimisticPage` 仍在对 session 数组二分，而该数组这次已改成时间序。探针实测两个失效模式都成立——对**已在数组里**的消息 `found=false`（重复插入且 `confirmed` 永不填，乐观气泡不消失），插入位算成 0（新消息甩到时间线最前面）。
- **删掉一份没人跑却被测试盯着的同构 reducer**（`packages/app/src/context/sync.tsx`、`context/sync-optimistic.test.ts`）：`sync.tsx` 与 `directory-sync.ts` 各有一套 `mergeOptimisticPage` / `applyOptimisticAdd` / `applyOptimisticRemove`，活的是后者，前者零生产调用者、唯一导入方是 `sync-optimistic.test.ts`——**测试一直绿着测一份没人跑的副本，真正跑的那份反而裸奔**，上面那个排序 bug 就是从这个口子进来的。已删 `sync.tsx` 的三个导出（只留 `useSync`），测试改指活代码，并补两条用真实 ID 的回绕用例。
- **上下文面板换掉两个没有显示意义的压缩字段**（`packages/app/src/components/session/session-context-tab.tsx`、`app/i18n/*`）：改成「平均每轮」= 总 token ÷ 用户消息数；连带清掉已无消费者的 `lastCompaction` memo 与三份 i18n 里 7 个孤儿键。`findLastCompaction` 本体保留——它仍有独立测试，状态页日后可能还要用。

---

### [0.9.16] - 2026-08-29

> 子代理的模型、推理档、超时搬进 GUI 设置面板——此前只能手改 `~/.redcode/redcode.jsonc`；顺手修掉一处让「改回默认」根本发不出去的 schema 矛盾。

#### 新增

- **设置面板「智能体」页**（`packages/app/src/components/settings-agents.tsx`、`dialog-settings.tsx`、`app/i18n/*`）：给已有角色配「模型 / 推理档 / 超时 / 兜底模型」，分「主智能体」（`redmind`、`plan`）与「子代理」（`explore`、`execute`）两组；内部机件（`title` / `summary` / `compaction`）引擎侧已标 `hidden`，面板按 `!hidden` 过滤自动排除。写入走现成的 `globalSync.updateConfig({ agent: { <name>: { ... } } })`，落 `~/.redcode/redcode.jsonc`（同步层）——实测改一个值再读文件，键确实进同步层，注释与格式原地保留（`patchJsonc` 逐键改，不整文件重写）。三处按实测定的实现细节：
  - **档位集合按模型重算**（取 `models.find(...).variants`）：Hy4 preview 只有 `none` / `high`，别家是 low/medium/high/max。换模型时若旧档位不在新模型的档位表里，一并写回 `default`，不留一个引擎会静默丢弃的值（`prompt.ts` 只认 `variants` 里真实存在的档位名）。
  - **第一项叫「默认（不覆盖）」，不叫「跟随主模型」**：清空配置不等于跟随主模型——内建子代理的 `agent/definition/*.md` 自带 model / timeout_ms / fallback_model（execute 自带 GLM-5.3-Flash，explore 自带超时与 GLM 兜底），删键是**交回这份定义**；主智能体没有定义，才真的跟随会话主模型。文案按这个语义写，三语同步。
  - **下拉的选项值不能用空串 / 0**：Kobalte 的选中态对 falsy key 判定不稳，实测 trigger 显示空白、甚至串到别的模型上。界面上用哨兵值，落库前再翻译成空串。
- **改回默认时真正删键**（`packages/opencode/src/config/config.ts`）：HTTP 请求体传不了 `undefined`，所以「改回默认」只能发一个能过 schema 的哨兵值、由服务端在落盘前翻译——沿用 `shell: ""` 那条既有先例。现在 `model` / `fallback_model` 的空串、`variant` 的 `"default"`、`timeout_ms` 的 `0` 都在 `writableAgent()` 里转成 `undefined`，`patchJsonc` 据此删键；四项全清空时整个 agent 键一并删掉，不留 `"redmind": {}` 空壳——判空要算上 `normalize()` 总会塞进来的空 `options` / `permission`，否则每个 agent 都显得「还有东西」。
- **看板卡片上限收到 24 并整体放大**（`packages/app/src/pages/home-kanban.tsx`、`app/i18n/*`）：此前跟着 `HOME_SESSION_LIMIT`（64）全量铺开，一屏全是同尺寸小卡，「最近」这件事被数量稀释掉了——每张都一样大、一样多，扫视没有落点。改成看板自己的 `KANBAN_LIMIT = 24`，**只砍「空闲」列**：工作中与需关注的会话无论多旧都保留，那两列是报警灯，砍掉等于把指示关掉。折叠掉的部分在列底给一行「另有 N 个较早会话未显示」——静悄悄少一截最坏，用户会以为会话丢了（归档入口在右键菜单里，看板又没有分页）。卡片同步放大一档，纵向为主：列宽 `minmax(240px)` → `minmax(340px)`，内边距 `py-2.5` → `py-3.5`、`px-3` → `px-4`，标题 13 → 15px，副行与日期 11/10 → 12/11px。
- **TUI 消息时间线补「插队 → 送达」徽标**（`packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`）：GUI 侧（0.9.15 的送达徽标）对 busy 中插入的消息有完整状态机——等当前步骤吃完，已吞进的下一个 step 就是「已送达」，否则「已插队」。TUI 此前只有一个 QUEUED 徽标，判定只看「是否在未完成的 assistant 之后发送」，且 assistant 一完成徽标就消失——插过队的消息过后什么都看不到了，误判成一条普通消息。这次把判定对齐 GUI 的 `steerStateByID`（`app/src/pages/session/message-timeline.tsx`）：busy 中发送、无 assistant 子消息、非当前活跃轮首即计为插队；其后已有 assistant（按 `time.created` 比较）→ 淡灰 `DELIVERED`，否则维持 `QUEUED`。纯前端推导（消息时间戳 + `session_status` + 消息父子关系），引擎侧无改动；旧的 pending 时序判定删除，QUEUED 视觉保留。
- **GUI 设置面板「界面/代码/终端字体」从手输文本框换成系统字体下拉**（`packages/desktop/src/main/fonts.ts`、`main/ipc.ts`、`preload/*`、`renderer/index.tsx`、`app/src/context/platform.tsx`、`app/src/components/settings-general.tsx`）：此前三个字体项是自由文本输入，没有候选可挑——placeholder 写着 `System Sans` / `System Mono` / `JetBrainsMono Nerd Font Mono`，看起来像「只有 system 默认」，实际上是要用户自己记住字体名。现在主进程枚举真实系统字体（Windows 读注册表 `HKLM`/`HKCU` 的 Fonts 键并按 `reg query` 输出解码中文名；macOS `system_profiler SPFontsDataType`；Linux `fc-list`），经 7 层桥（apps → ipc → preload → renderer → `platform.tsx`）供设置页消费；三个字体行换成面板同款 Select，每个下拉选项**以字体本身渲染**——选之前就能看到长什么样，选完即生效无需重启。选「默认（系统）」回到跟随默认（不写配置）。枚举清洗：剔竖排（`@` 前缀）、浏览器合成样式（bold/italic/oblique 后缀）、位图尺寸表（逗号，如 `Courier 10,12,15`），按 `&` 拆分多字体族（`SimSun & NSimSun`），Windows 下本机实测 152 项干净结果。

#### 修复

- **`timeout_ms: 0` 被 schema 拒，超时一旦设过就改不回去**（`packages/opencode/src/config/agent.ts`）：这个字段用的是 `PositiveInt`，而它自己的注释从写下那天起就是「0/omitted = no timeout」——校验和注释打架，代价是面板选「默认」发 0、服务端直接 400、UI 静默退回旧值。改 `NonNegativeInt`（0 与「没写这一行」同义），落盘前翻译成删键，文件里不留 0。

---

### [0.9.15] - 2026-08-29

> 上下文面板那两块重叠的东西收成一块并让它跨重启存活；新模型 Hy4 preview 的接入适配；输入框悬浮补一条占比色条。

#### 修复

- **GUI 桌面通知/提示音从未真正生效——globalSDK 事件流是死监听**（`packages/app/src/context/global-sdk.tsx`）：`NotificationProvider`、权限通知 toast、权限自动应答全部订阅 `globalSDK.event.listen`，而 `globalSDK` 的 `event.start()` 在整个代码库里**没有任何调用者**——只有 `serverSDK`（`server-sync.tsx`）的 `onMount` 里显式 `start` 过，所以 dock 弹窗/消息流能活、桌面通知和提示音全是死监听。修法：`global-sdk.tsx` 的 `onMount` 里加 `void start()` 自启动。修复后实测：最小化窗口触发权限请求，Windows 桌面通知弹出 + 提示音可闻。
- **上下文估算让位给真实构成，不再同屏报两遍**（`packages/app/src/components/session/session-context-tab.tsx`、`app/i18n/*`）：真实构成把 26,994 拆到了「系统提示 6,671 / 工具定义 19,787 / 对话 536」、还能往下钻到每个工具的开销；同一屏下面的「上下文拆分」却把同一坨囫囵报成「其他 99.5%」——同一份东西上面拆开了、下面又报一遍，还报错了名字。根因是两块无条件并列：breakdown 的 `<Show>` 只看自己有没有数据、不看快照在不在。而估算**先天**看不到系统提示与工具定义（那两份从没到过客户端），所以它的「其他」恒等于「前缀整包」。改成只在没有真实构成时出现；顺手解开 `context.breakdown.note` 上挂着的 `class="hidden"`——那条说明早就写好了，而它恰恰在估算单独出现时才有价值。另修 `context.inspect.note` 里「与**上面**的估算不同」——估算在下面，且两块现在也不同屏了，直接去掉这句比较，三语同步。
- **hy4-preview 的人民币计价**（`packages/opencode/src/provider/provider.ts`）：`opencode-go` 早就在 `CNY_PROVIDERS` 名单里（GUI 一律按 ¥ 标注），但 `CNY_PRICING` 下只有三个 deepseek 键。models.dev 给的是**美元**价 0.834/2.501/0.042 —— ×7.2 正好等于官方人民币的 6/18/0.3（分毫不差，这也反证了那张表的币种）。不覆盖就是拿美元数字贴人民币标签，**费用显示只有真实值的 1/7.2**。与 0.9.x 那次 vision-exp 漏配同型。

#### 新增

- **上下文快照落盘**（`packages/opencode/src/session/context-snapshot.ts`、`server/.../handlers/session.ts`）：此前快照纯内存、只留最后一轮，代价是打开任何一个本进程没发过请求的会话——重启后、或刚被 evictor 回收的——都只剩「暂无」，UI 掉回估算那条废条。前缀本身是稳态的，上一轮的构成对「这个会话大概装着什么」是个好答案。
  **为什么是裸 fs 而不是 Storage 服务**（试过，走不通，记下来免得再走一遍）：`record` 的调用点在 runLoop 里，而 `prompt.ts` 的 `loop` 被显式标注成 `Effect.Effect<MessageV2.WithParts>`（零依赖契约），在里面 `yield* Storage.Service` 会把依赖漏进那个类型；改成在 layer 链上 `Layer.provide(Storage.defaultLayer)` 之后，另外三个测试的 layer 组合塌成 `Layer<unknown, unknown, unknown>`——那条链已顶到 TS 推断上限，再加一个 provide 就爆，链首链尾都试过、位置无关。而 Storage 的目录是 `path.join(Global.Path.data, "storage")`，**进程级常量、不按项目算**，纯模块自己算得出同级路径。刻意用另一个目录而不是写进 `storage/` 树：那棵树有迁移与可重入锁，多一个绕过它们的写入者是隐患。
  磁盘侧有界（每 200 次写按 mtime 修剪到最新 500 份——会话数无界，不加帽就是又一个「无界增长」）；UI 同批把快照时间显示出来——纯内存时它必然是本进程刚记的，能跨重启存活之后，标着「真实构成」却不说何时的就是误导。
- **Hy4 preview 专属提示词与路由**（`packages/opencode/src/session/prompt/hy.md`、`session/system.ts`）：接入前它一个分支都不命中，落通用档。新档以重写后的 `default.md` 为骨，只加两条，针对腾讯在发布说明里**自陈的两个已知问题**（「复杂任务的长思考和过度自我验证倾向」），并且写成可执行判据而不是「别想太多」：思考的目的是选出下一个动作而非穷尽可能，说得出「下一步做什么、为什么是它」就去做，想不清楚时做一次最小探查比再想一轮更快——这个环境里工具调用是廉价的；验证一次就往前走，判据是「这次验证会不会改变我的下一个动作」，需要复验的只有两种情形（上次失败了、或你在那之后改动了被验证的东西）。路由用 `/(?:^|[/\-_])hy[0-9]/i`，不能写 `includes("hy")`——那会捞走任何名字里带 hy 的模型；边界允许 `/` 是因为 nano-gpt 的 id 是 `tencent/hy4-preview`。补 4 条测试钉住边界。
  一并记下的元数据事实：推理档只有 `none` / `high` 两档（不是常见的 low/medium/high/max），而下拉里的「默认」是**不发 `reasoning_effort` 参数**（`session/prompt.ts:663` 把 `"default"` 映射成 `undefined`），对这种 reasoning 模型很可能等同于 high；`attachment: false` 纯文本，当主力则识图退回派子代理那条路。按官方 163 专家 / 203 工程任务盲测（2.99/4，对 GLM 5.3 胜 46.8% 平 12.8% 负 40.4%）当**同档**待遇配置，不按跑分表——那张表里对手成绩全是腾讯自跑，且给了非标准条件（SWE-Marathon 超时翻倍、Terminal-Bench 500 轮 12 小时、给 DeepSeek 换 scaffold、Opus 5 用的 high 档在 HorizonMath 上截断率 28.76%）。
- **输入框上下文悬浮加占比色条**（`packages/app/src/components/session-context-usage.tsx`）：此前只有三行数字，占用率要读百分比才知道，而「还剩多少」恰恰是它最该一眼给出的东西。分档与圆圈共用 `strokeTier()`，但**常态档刻意不同**——圈在常态不上色（没事发生时圈就该是平时的样子），而条没有填充色就什么都看不到，所以常态给 info 蓝，警戒两档与圈一致。底槽从 tooltip 自己的文字色 `color-mix` 出来，不引入新 token。
- **config.cost.currency 机制——CNY provider 纯配置接入**（`packages/opencode/src/provider/provider.ts`、`metrics/home-stats`、`context.tsx`、`packages/app/src/context/config/provider.ts`、`settings/provider.ts`）：此前人民币计价写死在 `CNY_PRICING` 表 + `CNY_PROVIDERS` 名单里——provider 只认这个名单，新增 CNY 模型必须两处手动加，否则费用显示美元数字贴人民币标签（vision-exp、hy4-preview 都踩过）。改成 models 配置里 `cost.currency: "CNY"` 驱动：`provider.ts` 循环里 fallback 带上 `model.cost.currency`，GUI 三处名单（metrics/home-stats/context）退役改读 `model.cost.currency`。tokenrhythm 是首个受益者（22 个 CNY 模型纯配置接入，端到端 0.021 元不回归）。
- **steer 插队消息送达状态徽标**（`packages/app/src/pages/session/message-timeline.tsx`、`packages/ui/src/i18n/*`）：busy 中发送的 user 消息（无 assistant 子消息、非当前活跃轮首）此前毫无指示——发送了但还在跑当前步骤，用户不知道「已插队」还是「根本没进去」。现在：后按时间 `created` 无更新的 assistant 消息 → 「已插队 · 等待当前步骤完成」；后续 assistant 消息出现（=下个 step 组装上下文已吃进）→「已送达」。判定用 `compareTime` + 反向扫描消息（assistant 记 `maxAssistantTime`），三语同步。

---

### [0.9.14] - 2026-08-29

> 一批玻璃材质的推进（迎光边、边缘渐隐、旋钮化、侧栏成卡），外加把 v2 色板并回主题这条根上的修正——首页上同时存在三种配色不是三处随手写的，是三套颜色系统同屏。正确性上最重的一条是「切走再切回会话，内容掉在很多条消息之前」：不是 Electron 的性能限制，是一次刷新拿 40 条覆盖了已加载的整段历史。

#### 修复

- **切回会话不再把已加载的历史窗口砍回首屏那一页**（`packages/app/src/context/directory-sync.ts`、`pages/session/message-timeline.tsx`）：症状是切到主界面或别的会话再回来，文件树和会话区先空白，然后会话区掉在很多条消息之前、必须手动滚到底。**不是 Electron 的性能限制**——同一份前端在浏览器里稳定复现，且表现是「内容被换掉」不是掉帧。两个独立缺陷叠在一起：① `session.tsx` 的 stale 判据是「prefetch 记录超过 15s」，离开超过 15 秒回来就必然触发 `sync(id, { force: true })`，所以在真实使用里"永远会出现"；而 `sync()` 走的 `loadMessages` 默认 `replace`，拿 `meta.limit` 那一页覆盖 store 里已有的全部消息。`meta` 是 directory-sync 实例级的 store，离开 `/:dir` 时随 `DirectoryLayout` 一起重建、被首屏装载写成 40，而模块级的 prefetch 记录明明还记着真实深度 1435，回填却只在 `meta.limit === undefined` 时才做，轮不到。② 锚定是「每会话只锚一次」，窗口从 1671 行塌成 12 行时 sessionKey 没变，就此永不重锚——这是"要手动滚到底"那一半。修法：回填条件放宽成「比 prefetch 记的浅」；手上已有消息时的刷新一律走新增的 `mode: "refresh"`（只拉最新一页并按 id 并集合并、保住原游标，绝不 replace）；行数相对上次锚定缩水过半即重新武装。实测同一路径：离开前 143220px 在底部 → 首页停 20s → 切回 143849px、距底 0px（修前是 1801px 且掉在历史中间）。
- **agent 展示名统一走 `displayName`**（`cli/cmd/tui/routes/session/index.tsx`、`cli/cmd/tui/util/transcript.ts`、`cli/cmd/run/runtime.lifecycle.ts`、`cli/cmd/tui/context/local.tsx`）：这是第三轮了——0.8.x 修过 TUI 输入框、0.9.x 修过 GUI 下拉，剩下的助手消息头、会话记录导出、`redcode run` 底栏仍在 `Locale.titlecase(name)`，于是同一屏上输入框写 RedMind、消息头写 Redmind。之所以反复复发，是因为前两次都在各自的渲染点手写 `displayName ?? titlecase`，没有唯一解析口。这次在 TUI 的 agent store 加 `label(name)`（与旁边 `color(name)` 同形），把三处并进来，输入框那份手写的也改调它。顺带把消息头取值从 `.mode` 换成 `.agent`——两个字段在 `prompt.ts` 的两个写入点都赋同一个 `agent.name`，`.mode` 是历史同义字段，而相邻取颜色用的正是 `.agent`。
- **上游 `TEAM_MEMBERS` 删了但两处还在读，build 在模块加载期就 ENOENT**（`packages/script/src/index.ts`、`script/raw-changelog.ts`）：0.9.13 那次清理上游 fork 残留删掉了 `.github/TEAM_MEMBERS`，但两个 top-level `await` 仍在读它，任何一次 `bun run build` 都在 import 阶段直接炸。`Script.team` 全仓零消费者，纯死代码，连 getter 一起删；`raw-changelog.ts` 那份是活的（贡献者列表与 `(@author)` 归属靠它过滤），改成内联。补记一句：`.github/TEAM_MEMBERS` 不是 GitHub 认的文件（`CODEOWNERS` 和 `ISSUE_TEMPLATE/config.yml` 才是），它只是构建脚本的数据文件——那次清理对它「对公开仓是活的」这条判断不成立，真正的影响是把 build 打断了。
- **看板卡片抬起时四周不再被切平**（`packages/app/src/pages/home-kanban.tsx`、`index.css`）：卡片网格是 `overflow-y-auto`，裁剪边就在网格自己的边上，而首行卡片 `content-start` 紧贴着它。主因不是形变那 4px，是阴影：`--v2-elevation-floating` 是给独立大卡设计的（`0 4px 14px` + `0 18px 44px`），向上够到 26px，被一刀切平读起来就是「卡片往上滑进了什么东西底下」。修法是两件事一起——`pt-2 -mt-2` / `px-2 -mx-2` 用负边距吃掉外层间距再由 padding 补回来（静止版式一像素不动，只把裁剪边推开 8px），阴影换成本地一对 `0 2px 6px` + `0 8px 16px`（向上延伸 4px 与 8px，正好收在那 8px 里，仍明显向下偏）。已知代价：网格比列宽 16px，`auto-fill` 的列数会在极窄的临界宽度上提前跳一档。
- **新建会话页去掉假下拉，布局跟窗口高度走**（`packages/app`）：字标改逐字母入场。

#### 变更

- **v2 色板跟着主题走，删掉手写的第二真源**（`packages/ui/src/theme/v2-neutrals.ts`、`theme/context.tsx`、`theme/resolve.ts`、`app/src/index.css`）：首页上一眼能看出三种配色——右下角 debug 面板吃 v1 token（由 `themes/yuqi.json` 的 `neutral #5a2f4c` 生成，色相约 320°）、卡片与搜索框吃 v2 token（约 285°）、侧栏还要再掺一层 230° 的冷蓝。根因是 v2 的 60 个语义 token 全都指向一条原始色阶（`--v2-grey-N` / `--v2-alpha-*`），而那条色阶只按 `data-color-scheme` 分五档、**不认 theme**（`v2/styles/theme.css` 全文只有 1 处 `data-theme`），所以 260823 只能在 `app/index.css` 手写一段 yuqi 覆盖顶着，而且只盖了 11 个、剩下 49 个照旧发灰。修法不动那 60 个语义 token，只把它们底下的原始色阶按主题重新生成，用 `:root` 覆盖 `@layer theme` 的默认值（无层样式天然胜过有层样式）。三条设计约束写在新文件头：**明度曲线一律不动**（每档保持原本的 OKLCH `L`，只换 `H`、加 `C`，v2 的深浅两块是按这条明度阶挑档位的，对比度全靠它）；**彩度随明度收敛**，`c = neutral.c × 0.75 × 4L(1-L)`——这是拿 260823 那份手调覆盖做的拟合，8 档里 6 档误差 < 0.002，不衰减的话暗端会出 `#15010e` 这种发紫发脏的东西；**无彩度主题逐字节还原**（默认 oc-2 的 neutral 是 `#1f1f1f`，直接返回空串、一个变量都不发）。此前一直发灰的 `grey-100/300/400/1200` 与全部图标色、状态色、elevation、overlay 现在也跟上了主题。
- **磨砂面加迎光边，会话滚动区加上下渐变模糊带**（`packages/app/src/index.css`、`pages/session.tsx`）：此前各磨砂面只有 `background` + `backdrop-filter`，没有任何边缘光学，读起来是「半透明的板」而不是玻璃——厚度感来自迎光边那道亮线。只给顶边真的露在外面的几处（标题栏、输入框、用户气泡，以及后面改成浮起卡片的首页侧栏）。渐隐带是会话滚动区上下各 14px 的伪元素，`blur(5px)` + mask 渐变 + 一层几乎看不见的 veil，内容滚到边缘融进模糊再消失。**连带记一条坑**：mask 只能加在这两个伪元素上，绝不能加到滚动容器本身——那会把它变成 backdrop root，其内 sticky 输入框的 `backdrop-filter` 静默失效（表现是输入框背后的内容不模糊）。
- **磨砂材质的模糊半径与不透明度收拢成按角色命名的变量**（`packages/app/src/index.css`）：此前是散在七条规则里的字面量，改一次口味要翻七处，而且「两侧暗、中间亮」这条分层规则只写在注释里、不存在于代码里。收成 `--frost-blur-*` / `--frost-alpha-*` / `--frost-tint-*` / `--frost-strength`，数值从大到小 = 从外壳到内联。实测重构前后计算样式逐项相同；`--frost-strength` 可用区间约 0.6–1.35，到 1.39 外壳档乘满 100% 会被钳成全不透明、壁纸整个消失。
- **首页侧栏从贴边的柱子改成浮起的玻璃卡片**（`packages/app/src/pages/home.tsx`、`index.css`）：起因是「看板卡片的玻璃质感明显比侧栏好」，而看板卡片**根本没有玻璃**（实色底、零 `backdrop-filter`），真磨砂一直在侧栏。差的不是光学是物体性：卡片有圆角、四边描边、阴影、一眼看得到四条边；侧栏只有一条 `border-r`、贴边到底，眼睛读成墙。所以杠杆不在把 68%/blur18 往上推，而在脱边留白 + 14px 圆角 + 四边描边 + 向下阴影。内容位置靠卡片内部的 `pt-10` 顶回原来的 52px，与改造前逐像素相同。
- **首页轮播 tips 下线，与新建会话页共用按时段问候**（`packages/app`）。

#### 新增

- **新建会话页加按时段问候**（`packages/app`）。

---

### [0.9.13] - 2026-08-28

> GUI 主界面的信息密度与材质分层：最占地方的两个东西内容都是「这里没有」，而 12 个项目排在侧边栏里、哪个在跑要逐个点进去才知道——那个分类看板早就算出来了。

#### 修复

- **看板空列不再占三分之一，卡片按宽度铺开**（`packages/app`）：三列都是 `flex-1`，宽窗口下「工作中」「需关注」各占约三分之一、**全是虚线占位框**，唯一有内容的列被挤进剩下的三分之一。改成空列只占 220px 最小宽度、不参与 grow，横向空间全给有内容的列。卡片列数原来按 `records.length > 6` 才切两列——决定该排几列的是**可用宽度**不是条目数量，改成按宽度铺。
- **卡片去掉常量信息，底部提示不再重复快捷键条**（`packages/app`、`app/utils/session-title.ts`）：人格前缀（`[宋雨琦] …`）占掉每张卡最值钱的那几个字符——标题开头，而同一批卡片的前缀几乎恒等；拆到第二行跟日期作伴（新增 `sessionTitleParts`，带「整个标题就是个前缀」的兜底），第一行变成纯标题。项目名每张卡都印、而侧边栏正高亮着同一个项目，改成只在**与当前选中项目不同**时才印（sandbox/worktree 会话可能归属别的项目行，那时它才有信息量）。

#### 新增

- **侧边栏项目行显示运行态**（`packages/app`、`app/utils/session-status.ts`）：12 个项目此前只有色块头像 + 名字，哪个有会话在跑、哪个有权限请求等着你，必须逐个点进去才知道——而看板早就把这个分类算出来了。项目行右侧给一个转圈（有会话在跑）和一个橙点 + 数字（有待关注）。看板计数三列口径统一。
  **窥探用 `sync.peek()`，不是 `child()`**：这一点第一版做错过，值得写下来——`child(dir, { bootstrap: false })` 的 `bootstrap: false` 只管要不要 bootstrap，**管不住 pin**，而 `child()` 无条件 `pinForOwner`，会把目录永久钉住，重连时「只刷新 pinned 目录」的过滤就形同虚设。侧边栏对 12 个项目各调一次，实测触发 **12 次串行 `session.list`、累计 28 秒**，期间首页一条会话都显示不出来。`peek()` 就是 `ensureChild` 本身、不 pin，改回后 `session.list` 从 12 次降到 1 次。
- **看板卡片补按压反馈**（`packages/app`）：配方取自私仓用量面板的 `.card`。

#### 变更

- **侧边栏按分层规则回到「外壳」档**（`packages/app`）：亮壁纸下侧边栏几乎不成立为一个面板——项目列表下方一大片没有任何容器感，「设置」和缓存命中环像浮在海面上。根因不是透明度拍脑袋定错了，是它**站错了档**：这套 frost 分层语言是 titlebar 58% / main（内容区）55% / 文件树·审查栏 72%，「两侧暗、中间亮」就是规则本身；而 home 侧边栏同为「外壳」却被定成 55%，与内容区完全相同，两者之间没有任何材质差别。

---

### [0.9.12] - 2026-08-28

> 角色收口过程中顺出来的八条独立项，各自动机独立，单独一批做掉。最要紧的是 `Agent.get` 那个类型谎言——收窄签名后编译器一次抓出两处真的没写守卫的空指针。另有两处**对外文档说错**：环境变量前缀与全局配置路径都是反的。

#### 修复

- **`Agent.get` 的返回类型是谎言，藏住两处空指针**（`agent/agent.ts`、`session/processor.ts`、`session/compaction.ts`）：签名标 `Effect.Effect<Info>`，实现是 `agents[name]`——`noUncheckedIndexedAccess` 关闭下被推成 `Info`，查不到时返回的其实是 undefined。16 个调用点里 12 个自己写了 `if (!x)`，全靠人肉发现。收窄成 `Info | undefined` 后编译器一次抓出 9 处，其中 src 里两处**真的没守卫**：`processor.ts` 的 doom_loop 分支读的是**落库 assistant 消息**的 agent 名（可能已删/已改名，别名表只接得住内建的老名字），紧接着就 `.permission`，真撞上是 TypeError——现在回落到默认姿态的规则集，`doom_loop` 在 defaults 是 ask，只会更谨慎；`compaction.ts` 取内建 `compaction` 机件，查不到属于不变量被破坏，明着抛比在下一行变成 `undefined.model` 强。
- **`redcode agent create` 造出来的文件永远加载不了**（`cli/cmd/agent.ts`）：它两处都写复数 `agents/`，而 loader 只扫单数——md 型 agent 唯一的运行时创建入口是坏的，创建完立刻「不存在」，只有一条 warning。文档里六处 `~/.redcode/agents/` 是同一个坑的另一半，一并改。
- **GUI 里每会话的 agent 残留老名字**（`app/context/local.tsx`）：per-session 选择存在 localStorage。原来只有全局默认 `store.current` 有自愈 effect，`saved.session` 没有——`pickAgent` 查不到时回落到 `items[0]`（**显示是对的**，看不出问题），但存的值原样留着，而 `write()` 每次改模型/变体都把 `scope()` 摊开写回去，`restore()` 的守卫又保证它再没机会被覆盖。补一条同款 effect，列表就绪后把不在列表里的名字改写成 `items[0]`（服务端 `list()` 把默认姿态排在第一个，`build` → `redmind` 正好是别名表的目标）。
- **skill 播种在 RedCode 仓库之外静默早退**（`project/bootstrap.ts`）：源目录写死 `ctx.directory/seed/skill`——那是**当前项目目录**，不是安装目录，别的项目里必然不存在，于是直接 `return`，全局 skill 一个都不播且一声不响。与「md-only 角色在发布二进制里根本不存在」是同一类病（读盘 vs 内联）。改成按候选顺序找（项目目录、`<dist>/bin/../seed/skill`），找不到且目标目录为空时打 warning。⚠ 长期修法（`seed/skill` 随发布包一起发）未做——今天只有 `script/sync-home.bat` 在**构建机**上拷过去，别的机器上从来就没播过。

#### 变更

- **`experimentalScout` 改名 `experimentalReference`**（`effect/runtime-flags.ts`）：scout agent 并入 explore 后，这个 flag 还门控着 @reference 的 git 物化与 `repo_clone` / `repo_overview` 的注册，名字跟它管的东西彻底对不上。新键 `REDCODE_EXPERIMENTAL_REFERENCE`，**保留 legacy 键** `REDCODE_EXPERIMENTAL_SCOUT`——它可能已经写在 live 环境里，静默失效等于悄悄关掉 @reference 的物化。`enabledByExperimental` 只收一个名字，按 `enableExa` / `enableParallel` 那套 `Config.all` 三键写法展开，新增用例覆盖新键 / legacy 键 / `REDCODE_EXPERIMENTAL` 总闸 / 都不设四条路径。
- **权限叠加的优先级钉成一条用例**（`test/agent/agent.test.ts`）：调研原本记的是「任何用户自建 md agent 的权限块都排在 `cfg.permission` 之后，用户全局配置整段失效」，实测**不成立**——真正出事的是我们自己发的工种 md 经 `~/.redcode/agent/` 回流，那时排在最后的是**我们的**块，已在上一版删掉 sync-home 的 agent 播种时解决。用户自己写的 md 属于「用户的 per-agent 配置」，盖过用户全局是对的。定死的顺序：**defaults < 内建块 < 用户全局 permission < 用户 per-agent 块**。

#### 文档

- **web 的 `agents.mdx` 三语同步**（`packages/web`）：内建清单（Build/Plan + General/Explore/Scout → RedMind/Plan + Explore/Execute）、Explore 的三段职能、Execute、「老名字」一节（写明别名**长期保留**、不承诺过渡后删除）、JSON 一节改成「只能覆写或禁用已存在的角色」、`@general` → `@explore`。**不改 `Share.tsx`**：它那两处 `agent: "build"` 在 v1→v2 消息迁移里给**历史**共享会话补字段，那些消息当年确实跑在 build 上，如实记录历史不是活引用，改成 redmind 反而是篡改。
- **`customize-redcode.md` 两处硬错**（`skill/prompt/`）：escape hatches 一节的七个环境变量写成 `OPENCODE_` 前缀，逐条对着 `flag.ts` 与 `runtime-flags.ts` 验过，引擎只认 `REDCODE_`，一个都不认；全局路径表写 `~/.config/redcode/` 还特意标注「NOT `~/.redcode/`」，而本 fork 的 `core/global.ts` 把 XDG 目录统一到了 `~/.redcode`（`config: () => root()`），**标反了**。这是进模型上下文的提示词，说错直接误导模型给用户错命令。
- **`docs/agent-roles-plan.md`** 补到修正十六，迁移步骤 1~6 与八条独立项全部标注落地。

---

### [0.9.11] - 2026-08-28

> **子代理与会话姿态的收口**：对用户可见的角色从 9 个收成 **4 个**（姿态 `redmind` / `plan`，工种 `explore` / `execute`），老名字全部经别名表长期解析。过程中实测出两处**权限回归**——工种读不了工作区外任何路径、`.env` 护栏失效。附带一次明确的能力删除：`redcode.json` 的 `agent.*` 不再能凭空创建角色。

#### 变更

- **角色从 9 个收成 4 个**（`agent/agent.ts`、`agent/definition/*.md`、`config/config.ts`）：姿态 `redmind`（默认）与 `plan`；工种 `explore`（只读——找东西 / 出方案 / 做审查）与 `execute`（可写——实现执行）；机件 `compaction` / `title` / `summary` 隐藏、不进任何列表。删掉的 `build` / `general` / `scout` / `architect` / `reviewer` / `fixer` / `advise` 经**别名表**解析（`build`→`redmind`，`general`/`fixer`→`execute`，其余→`explore`）。别名在 `get`、`list` 的排序谓词、`defaultInfo` **三处共用**——后两者不经过 `get`，只补 `get` 的话 `default_agent: "build"` 照样抛 not found；只补 `defaultInfo` 则排序退化成 name-asc、客户端 `at(0)` 实测变成 **plan**，TUI 与 GUI 都会静默进只读姿态。
  **别名是长期保留的，不要指望过渡一轮后删除**：`session/compaction.ts` 四处直接 `updateMessage` 铸 `role:"user"` 消息，绕开 `createUserMessage` 与 `Agent.get`，把历史 agent 名原样重铸——跑到自动压缩的老会话每压一次就再生一条 `agent:"build"`。live 规模：session `build` 56 / `general` 15 / `reviewer` 1，assistant 消息 `build` 17,607。
  **手打 `@architect` 不再可用**：交互式 @ 提及的 part 由客户端从 `list()` 造（`autocomplete.tsx`、`app/prompt-input.tsx`），别名进不去。仍可用的老入口只有 `subagent_type`、历史会话续跑、`--agent`、`default_agent`、配置里的 `agent.<老名>`。
- **`agent.*` 只能覆写 / 禁用，不能凭空创建**（`agent/agent.ts`、`config/config.ts`、`plugin/index.ts`）：原来配置循环对任何没有内建对应的 key 都造一个 `native:false` / `mode:"all"` / 权限 `"*": allow` / description 为 undefined 的角色——jsonc 里一个手滑的 key 就静默变成可派发子代理，同时进 @ 补全与 `describeTask`，而且从配置里删条目也删不掉。现在**新角色的唯一入口是 `agent/*.md` 文件**，未知 key 打一条 warning 后跳过。md 与 jsonc 落进同一个 `cfg.agent` 记录，靠新增的派生字段 `agent_origins` 区分来源（照 `plugin_origins` 的先例：不进 Schema、`writable()` 里剥掉、不落盘）。**插件的 `config` 钩子仍是合法创建通道**——它直接往 `cfg.agent` 塞 key，钩子跑完后新增的名字会补进 `agent_origins`。这是一次有意的能力删除，文档同步改掉。
- **三种语义各有自己的构造器**（`agent/agent.ts`）：`posture()`（只有权限与展示，**没有** model / prompt / timeout / variant / steps）、`subagent()`（整份定义来自 md frontmatter）、`machine()`（固定 prompt + 全 deny + hidden）。`agents` 记录从约 110 行手写字面量收成 40 行，「给姿态配一个 model」这类跨语义写法编译期就写不出来。**没有拆 Schema**：`Info` 带 `identifier: "Agent"`，是 `/agent` 端点与 SDK `Agent` 类型的 wire 契约，拆成联合等于改契约 + 重生成 + 所有客户端做类型收窄，而收益在定义处就能拿到——内建条目是唯一会手写这些字段的地方。
- **两个工种的模型与超时兑底**（`agent/definition/*.md`）：`explore` = `stepfun-step-plan/step-3.7-flash`，600s 超时（原 180s，它现在要干「读一圈再出结论」的活）；`execute` = **`opencode-go/glm-5.3-flash`**（由 `hy3` 改来：hy3 纯文本、256K/64K，glm-5.3-flash 1M/131K 且 in 0.075 / out 0.25 更便宜），900s 超时。两者各带**换族**的 `fallback_model`——失效模式是「模型自己卡住 / 推理烧不完」，同族换路由治不了。此前只有 explore 有 `timeout_ms` 且**没有 fallback**，按 `tool/task.ts` 那等于「超时即硬失败」，白等三分钟报 `no fallback model configured`。注意兑底是在**同一个子会话**里重发同样的 prompt，兑底模型看得到第一次留下的历史——对可写的 execute 就是「半截改动 + 换模型接着干」，不是从头来。
- **`general` → `execute` 会静默换模型**：general 从前不带 model、跟随会话模型（`tool/task.ts` 的 `next.model ?? 调用方那一轮的模型`），execute 自带 `opencode-go/glm-5.3-flash` + 900s 超时。影响历史 `subagent_type: "general"` 与 `/subtask`。
- **`execute` 比 general 严一档**：扁平 `"*": deny` 白名单意味着它**一个 skill 都看不见**（`skill/index.ts` 按 `evaluate("skill", name)` 过滤），`task`（不能再派子代理）与任意非白名单前缀的 MCP 工具也被禁。要放宽在 `src/agent/definition/execute.md` 里显式写 `skill: allow`。同理 `destructive` / `doom_loop` 对工种是 **deny 不是 ask**——扁平 `"*": deny` 盖掉了 defaults 的 ask 档，而 deny 是硬失败不是弹询问。这与 fixer 此前的行为一致，不是新收紧，但两份 md 的注释原本写反了，已改。
- **`redmind` 补上 `plan_enter`**：defaults 把它 deny 了而 redmind 没补回，默认姿态下模型没法自己提议进计划模式。这是定义时漏的一条，不是有意分工——redmind 的 description 只讲「敏感操作先问」，从没说过不做计划。
- **`~/.redcode/agent/` 不再由 sync-home 播种**（`script/sync-home.bat`）：工种 md 移进 `src/agent/definition/`，构建期用 `with { type: "text" }` 内联进二进制。同一份 md 经配置回流会把白名单再接到用户全局 permission **之后**，在 findLast 语义下把下面修的两条权限回归**一跑 build.bat 就打回去**，而且会让用户全局 `permission` 整段失效。用户自建的 `~/.redcode/agent/*.md` 照常加载，只是我们不再默认发一份同名的进去。
- **删掉两条上游遗留的装载路径**：随包 YAML profile 三份 + `agent/profile/{load,resolve,types,index}.ts`（`agent.yaml` 已被 disable，另两份与内建重复，用户目录空）；`{mode,modes}/*.md`（全机零文件）。`{agent,agents}` 收成只认单数 `agent/`，复数目录存在时打 warning 而不是静默丢定义。

#### 修复

- **工种读不了工作区外的任何路径**（`agent/agent.ts`）：md 里扁平的 `"*": deny` 其 rule 是 `permission="*", pattern="*"`，findLast 下匹配一切——**包括 defaults 里那些写成对象的权限**。`external_directory` 整段白名单因此作废：项目外 ask→deny、`~/.redcode/skill/*` allow→deny、`Global.Path.tmp` allow→deny、工作区 `.redcode/temp` allow→deny，而 deny 是 `DeniedError` **硬失败**不是弹询问。live 的 architect / fixer / reviewer 此前就是这样，读不了全局技能目录。修法只有一种站得住：`merge(defaults, md白名单, external_directory 重新宣告, user)`——它依赖 `ctx.directory` 与 `skill.dirs()`，静态表达不了，只能由代码在 md 块之后、`user` 之前重新宣告。另外两个候选被实测否掉：放进循环后补丁会把用户自配的 extdir 白名单从 allow 压成 ask（`instance-context.ts` 就是这个用法）；循环后再补一遍 `user` 会把「per-agent > 全局」的优先级颠倒。
- **`read` 的 `.env` 护栏失效**（`agent/definition/*.md`）：defaults 是 `read: { "*": allow, "*.env": ask, ... }`，被 md 的扁平 `read: allow` 顶掉——`execute` 能静默读 `.env`，而它同时有 write/edit。md 里改写成对象形式即可（这一条静态可表达，不像 `external_directory`）。

---

### [0.9.10] - 2026-08-28

> 测试基础设施与生成物闸门。主线是一条把 200GB 系统盘写到只剩 0.1GB 的临时目录泄漏——它伪装成大面积代码回归，排查时先被误判。另把 OpenAPI 漂移检查接进 pre-push：一天之内撞了两次「改了 schema 忘记重跑生成物」。

#### 修复

- **测试临时目录泄漏，40.3GB / 1565 个目录**（`config/config.ts`、`core/flag/flag.ts`、`test/preload.ts`、`test/lib/sweep-temp.ts`）：`%TEMP%` 里的 `redcode-test-*` 从 08-12 长到 08-28 无人知晓，最终把 C 盘写到只剩 0.1GB，测试开始以 1 fail → 9 fail → 31 fail 崩塌，**而失败信息与磁盘无关**。三个独立成因，只修一个都不够。大头是「npm install 比作用域活得长」：`config.ts` 用 `Effect.forkDetach` 把 `@opencode-ai/plugin` 装进项目 `.redcode/node_modules`——分离 fiber，不受作用域约束；临时目录的 finalizer 先跑，此时目录还基本是空的，删得掉、不报错，npm 随后把 `node_modules` 写回来，留下一个 38MB 的目录且**零告警**（实测一轮会话 177 个、6.5GB）。新增 `REDCODE_DISABLE_PLUGIN_DEP_INSTALL`，测试默认打开——不是测试专用开关，离线部署同样需要，且只跳过预装 SDK 包那一步，调用方本来就无法依赖它已完成。
- **插件依赖安装的第二份拷贝也受 flag 约束**（`cli/cmd/tui/config/tui.ts`）：按「后台工作的副作用比作用域活得长 / 失败被静默吞掉」两条判据扫全仓，只揪出这一处同类——它是 `config.ts` 那个安装逻辑的并行拷贝，测试里不触发，但生产上不受上面那个开关约束，离线用户设了开关 TUI 那条路照样去装。
- **`session/index.tsx` 的组件名与类型导入冲突**：`UserMessage` / `AssistantMessage` 两个组件加 `export`（好让新快照测试 import）之后，与同文件顶部 `import type { UserMessage, AssistantMessage }` 撞名，`<UserMessage>` 解析回 type-only 导入，报 `TS1361`。给类型导入起别名（`UserMessageInfo` / `AssistantMessageInfo`），组件保留原名，新测试的 import 照常可用。
- **两次生成物漂移补跑**（`packages/sdk/*`）：`webfetch.allow_private_hosts` 与 image 的 `max_pixels` / `max_dimension` 两批 config schema 改动都没重跑 `gen:openapi`，`check:openapi-drift` 在本地一直是红的。

#### 新增

- **会话记录整帧文本快照**（`test/cli/tui/conversation-snapshot.test.tsx`、`test/cli/tui/lib/transcript.tsx`）：界面侧测试比 0.09（GUI 91,085 行源码 / 7,753 行测试），DSH client 是 0.77，差距不在写没写而在用什么方式写——33K 行 `ui/` 靠组件单测补到 0.75 得写两万多行，DSH 自己的 0.77 是 33 个整帧文本快照堆出来的。5 个场景渲染 `routes/session/index.tsx` 里**真正在跑**的 `UserMessage` / `AssistantMessage`（单条用户消息、一轮问答、长文本按宽度折行含 CJK、多轮相邻间隔、助手带错误），不再用手写替身。
- **pre-push 接上 OpenAPI 漂移闸门**（`.husky/pre-push`）：改了 config schema 却忘记重跑生成物，本地全绿、推上去才在 CI 红——08-28 一天撞两次。`script/check-openapi-drift.ts` 自己的头注释就写着「没有副作用，可以放心进 CI 和 pre-push」，只是一直没接上来（实测约 5s）。

---

### [0.9.9] - 2026-08-28

> 三条互不相干的正确性修复：图片在压缩预算里被当成十几万 token、`webfetch` 对目的地只查 scheme（云元数据端点照发）、sync 写入路径的序号在默认配置下恒为 0。

#### 修复

- **图片按路由计价，不再按 base64 长度**（`session/image-tokens.ts`、`session/compaction.ts`、`session/context-snapshot.ts`）：`SessionCompaction.estimate` 是 `Token.estimate(JSON.stringify(modelMessages))`，而 `Token.estimate` 就是 chars/4、`toModelMessages` 把图片拼成内联 data URL——一张 400KB 的 JPEG 于是被算成约 **13 万 token**，它在 DeepSeek 上实际最多 384。触发线没被带偏（`level()` 取 provider usage，锚是对的），被带偏的是两处：保留范围 `select()` 倒着累加各轮 size，一张图必然让它所在那轮超预算，`splitTurn` 也切不出装得下的片，结果图片所在轮及更早的**全部被判出局**，即使那些内容加起来只有几千 token；以及用量面板的上下文构成，「messages 占多少」被一张截图完全带偏。新模块把事实与定价分开：内联载荷换占位再计长度，远程图片 URL 原样保留但同样计一张图（不计就是反方向失真，上游正是因为把图按结构 JSON 算成约 40 token 而让压缩迟到溢出），按 providerID 定价、取 DeepSeek 官方计算器封顶 384。
- **图片尺寸改总像素预算，候选改懒求值 + 按 alpha 路由**（`image/image.ts`、`config/attachment.ts`）：`scale = min(1, maxW/W, maxH/H)` 让一张 2000×20000 的整页截图变成 **200px 宽**，文字全糊——而它的代价本来该由总像素数决定，视觉 token 按面积算不按最长边。改成 `min(1, sqrt(maxPixels/(W*H)), maxDimension/W, maxDimension/H)`，新配置 `max_pixels`（默认 `max_width*max_height` = 4,000,000）与 `max_dimension`（8192）；`max_width`/`max_height` 标记 deprecated 但仍贡献默认预算，既有配置的**总量语义不变**，变的只是像素怎么分配到两个轴上。2000×20000 现在得 632×6325，方形图逐像素不变。**透传闸门刻意仍用旧盒子**：先写的版本把闸门也换成像素预算，实测一张 2964×488、base64 恰好 5.00MB 的图从「缩到 2000×329 再编码得 0.09MB」变成「原样透传 5.00MB」，**55 倍**——旧规则那个小 payload 是盒子的副作用不是有意的字节策略，放宽透传是独立决策。另外候选原来是 5 档全部编码再 `.find()` 取第一个达标的，尺寸降级最多 32 档、最坏 160 次编码（单次 JPEG 编码实测约 332ms），改成逐档编码、第一个达标即 break；PNG 候选不再对所有源排第一位——JPEG 源不可能带 alpha，给它 PNG 纯属浪费，更糟的是 PNG 一旦碰巧落在预算内就会被选中，那正是上游「照片被路由到无损编码器」的病。
- **`webfetch` 拒绝非公网目的地并逐跳校验重定向**（`tool/webfetch.ts`、`util/net-address.ts`）：此前对目的地只检查 scheme，模型给出 `http://169.254.169.254/`（云元数据）、`http://192.168.1.1/` 或 `http://127.0.0.1:port/` 都会照常发出去，而 `ctx.ask` 的 `always: ["*"]` 意味着用户选过一次「始终允许」之后任何 URL 都不再出现审批——**模型给的 URL 常常来自它读到的网页内容，那是不可信输入**。新增地址分类，分两档：配置可放行（环回、RFC1918、CGNAT、ULA——人真的会在上面跑服务）与不可放行（link-local `169.254/16`、`fe80::/10`，云元数据就在这里；组播、保留、未指定、文档段、基准段）。比上游更细一档：本地编码代理让代理看一眼自己起的 dev server 是正当工作流，但那不该顺带打开云元数据端点。IPv4 映射与 NAT64（`64:ff9b::/96`）都拆包按内嵌 v4 判，否则 `64:ff9b::169.254.169.254` 是一条免费绕过。配置 `webfetch.allow_private_hosts` 默认 false。审批仍在 DNS 解析**之前**——否则一次会被拒的调用也已经替模型做过名字解析，审批本身就成了探测原语。
- **sync 的序号读写同门控 + 投影豁免改显式名单**（`sync/index.ts`、`server/projectors.ts`）：`event_sequence` 的 upsert 原本在 `experimentalWorkspaces` 后面（默认关），而 `run()` **无条件**读这张表算 seq——默认配置下每个事件的 seq 恒为 0，还被 GlobalBus 原样广播；flag 中途打开时序号从 0 重开，对端 replay 会静默接受并缺掉全部历史。计数器移出 flag（一行三列，代价可忽略），event 表存事件全文、只有 workspace 同步要用，继续留在 flag 后面；现在 flag 中途打开会抛 `Sequence mismatch`（响）而不是静默缺历史（哑）。投影豁免从 `def.type.includes("next")` 改成 `init({ nonProjecting })` 显式名单——旧判据把「忘写 projector」的护栏对整个 `session.next.*` 命名空间关掉了，而那个 return 在插入块之前，同时跳过投影、持久化与发布；名字里碰巧带 next 的事件（`plugin.nextcloud.synced`）也会免费拿到豁免。生产名单只有 `session.next.tool.progress` 一个。

---

### [0.9.8] - 2026-08-27

> 这一版的主线是**每请求都要付的固定开销**：固定前缀瘦身 ~9.5k token、重复 read 折叠未变区段、五个近乎零调用的内建工具默认下线。另清掉一条让单元测试每轮静默少跑一条的老毛病。

#### 新增

- **后台任务完成桌面通知**（`app/context/notification.tsx`、`tool/task.ts`）：GUI 此前对 subagent/background 零消费——后台任务跑完没有任何提示，而 TUI 早就有 `subagent.start/stop` 与 toast。task 工具在 background 完成/失败时注入的合成消息以 `Background task ` 开头（`backgroundMessage`），notification provider 监听 `message.updated` 认这个前缀并 `platform.notify`，词条三语，受 `settings.notifications.agent()` 开关控制。
- **内建低频工具按需注册**（`tool/registry.ts`）：`repo_clone` / `lsp` / `repo_overview` / `external-directory` 全量历史 **0 次调用**，`ast_grep` 只有 4 次，却常驻每个请求的模型工具表——付的是 schema token，收的是负收益（模型会被诱导走弯路，例如拿 `lsp` 去干 typegraph-mcp 的活）。这五个进 `GATED_TOOLS` 默认过滤，需要时 `provider.<id>.models.<id>.tools.<id>=true` 显式恢复（复用既有 explicit 分支，优先级不变：deny > explicit > gated > 特判）。

#### 优化

- **固定前缀瘦身 ~9.5k token/请求**（`skill/index.ts`、`tool/registry.ts`、`effect/runtime-flags.ts`、`session/prompt/deepseek.md`）：拆一条真实请求体（287KB）量出固定前缀 **46,052 token**——system 提示词 21,209 + 内置工具 14,483 + MCP 工具 10,337，最肥的单项是 skill 工具定义 **4,990 token**，而 skill 工具七天只被调用 11 次。四处下刀：① skill 工具描述只列名字（`fmt` 加 `namesOnly`）——完整描述在系统提示词的 `<available_skills>` 里已经发过一遍，路由决策看的是那份，工具描述够拼出合法 name 即可，省 ~4,350；② 剔除嵌套 skill——`**/SKILL.md` 深度不设限，skill 自带的样例目录会被当成顶层技能注册（本机 `nuwa-skill/examples/` 下 15 个样例，比真装的 27 个描述加起来还长），判据与 glob 写法无关：`SKILL.md` 落在另一个 `SKILL.md` 的目录之下就是附属资源；③ `<available_skills>` 不再发 `<location>`——模型按 name 调用，加载后工具输出会再给一次 base directory，这行每条约 27 token 没人读，省 ~650；④ `goal_set/done/clear` 上 `enableGoalTools` 开关且默认关——goal 表 0 行、90 天零调用，三个定义却每请求付 214 token，引擎侧目标注入本就只在有 active goal 时才发，`REDCODE_ENABLE_GOAL_TOOLS=true` 可恢复。固定前缀 46,052 → 约 36,500。另有配置侧改动不在本仓（`~/.redcode/redcode.jsonc`：jcodemunch 白名单删 4 个 90 天零调用工具、mcp-process-mgmt 禁用 `pty_resize`）。同批把 `deepseek.md` 的批处理规则写实：79.9% 的 step 只带一个工具调用，而每多一步就把整个上下文重发一遍；同引擎下 step-3.7-flash 多工具率 32.5%、deepseek 只有 12~15%，是习惯问题不是被卡住。
- **重复 read 同一文件时折叠未变区段**（`tool/read.ts`）：实测每周 **928 次**「同会话内重复 read 同一文件」，其中 902 次文件确实变了，每次把整份文件重新灌进上下文，这些副本此后每一步都要被重读一遍，放大约 **195M token/周**的缓存读。**不发 diff，发折叠**——hashline 补丁靠 `replace N..M` 定位，纯 diff 会让模型自己数行号，等于把刚修掉的标签失效换个形式请回来；折叠保留绝对行号，只把连续未变区段收成一行 `... (lines A-B unchanged since your last read) ...`。旧内容不另开缓存，直接从对话历史里上一条 read 的输出反解（`recoverPriorLines`），好处是失效逻辑自带：那条若已被压缩掉（`part.state.time.compacted`）就找不到、自动退回发全文，不存在「模型看不见旧内容却收到折叠件」的形态。三道保守闸：只在整文件、未截断的读上生效（分段读行号基准对不上）；反解要求行号从 1 连续递增，因此折叠过的输出不能当下次的基准（`priorReadLines` 会继续往前找可反解的那条，第三、四次读仍能折）；省不到三成就不折，原样发全文。新增 6 条纯函数单测。
- **hashline 标签失效时把当前内容带回来，省掉一趟 read**（`tool/edit.ts`）：近 30 天 edit 调用 4,532 次、失败 525 次（11.6%），其中标签/哈希失效 286 次占 **54%**，是最大的一类；协议类失败合计 395 次（75%），模型真正「改错内容」只占 18%。原来只回一句 "Re-read the file to get the current hash."，一次失效烧三步（失败 → read → 重试），而文件内容此刻就在手上（`contentOld` 刚读完），那趟 read 还会把整份文件重新灌进上下文。改成把当前内容按 read 的排版（`[path#TAG]` + 行号）带进错误消息，模型可直接重建补丁重试；一并记 `FileTime`，否则重试会再撞「必须先 read」那道守卫（那一类另占 58 次）。上限沿用 read 的 50KB——带回来的绝不会比它本来要跑的那趟 read 更大，超限才退回让它自己读。

#### 变更

- **seed 子代理默认模型改 step**（`seed/redcode.home.jsonc`、`seed/agents/fixer.md`、`seed/skill/vision-autoagent/SKILL.md`）：mimo 停用，`explore(mimo-v2.5)` → `explore(step)`；审图提示词注明「别重复刷工具」（step 前科）。

- **美元兑人民币汇率 6.75 → 6.72**（`app/components/session/session-context-format.ts`、`app/pages/home-stats.tsx`、`cli/cmd/tui/feature-plugins/home/footer.tsx`、`cli/cmd/tui/feature-plugins/sidebar/context.tsx`）：哥哥给定的新汇率。这个常量在 GUI/TUI 各有两份共四处硬编码，必须同步改——漏一处就会出现同一笔花费在首页和侧边栏不一致。四处都留了注释互指。

- **10 个 MCP 的工具描述统一成「什么时候用 + 什么时候别用」**（`seed/redcode.home.jsonc`）：前缀里 MCP 工具定义占 10,337 token，描述写不准的代价是模型走弯路（0.9.8 那条瘦身里记的「拿 lsp 去干 typegraph 的活」就是这么来的）。补齐最后三个不合格的：`typegraph` 原本**没有描述**，`fff` 与 `su-prememory` 还是英文原文。每条都带反向路由 —— typegraph 指明「找定义/引用/调用链用 jcodemunch，读整文件用 read」，fff 指明「已知精确路径直接 read」。`su-prememory` 那条另有实质内容：它开的库就是 `~/.redcode/supermemory.db`，**和 MEMORY.md 是同一份**，所以描述里写死了「写入别用 memory 工具」—— 记忆是「MEMORY.md 索引行 + 库里全文」双写，只写库这一侧会留下有全文无索引的孤儿行（双写核对脚本目前就报着 15 条这种）。

#### 修复

- **GLM-5.3 的提示词与推理锚——改名不该换待遇**（`session/system.ts`、`session/prompt.ts`、`session/prompt/glm.md`）：GLM-5.3-Flash 就是先前以 ox-alpha / x-preview 名义在跑的那个模型。换成智谱官方名字接入后两处待遇被静默换掉，而两处都没有针对它的证据：① `api.id` 里出现 "glm" → 从重写过的 `default.md` 换到 `glm.md`，后者是 260625 给 5.1/5.2 那代写的管教式稿子（编号 do/don't、"Same fix twice → STOP"、"No deferral"），此后没再动过；② `model.id` 里出现 "flash" → 凭空吃到 deepseek 的推理锚（判据是「含 flash 且不含 step」），而它叫 x-preview 的时候名字里没有 flash、**根本不吃锚**。改法不是绕开 `glm.md`，而是把 `glm.md` 重写成当前一线水准（不迁就弱模型，step-3.7-flash 是唯一例外因为免费）：新稿以实测过的 `default.md` 为骨，另加三条 GLM 特有的——可见思考文本用中文（实测英文率 6.7%，deepseek 各路是 0.0~0.5%）、批处理规则（实测多工具率 11.7%，常用模型里最低）、hashline 标签失效后直接用返回的内容重试别再 read 一次（配合本版 `edit.ts` 那条）。锚点判据从内联移到 `wantsFlashAnchor` / `wantsStepAnchor`，并从「含 flash 且不含 step」收窄到「含 deepseek 且含 flash」，对齐这条锚的证据来源（WEAK_FLASH 对 DeepSeek V4 Flash 的实测）；`gemini-*-flash` 同样是被名字捎带进来的，一并排除。路由本身不动：glm/qwen 仍走 `glm.md`，旧稿不另存（它的目标模型 5.1/5.2 已不用）。6 条纯函数测试钉住路由归属与两条锚的互斥。
- **单元测试每轮静默少跑一条**（`opencode/test/preload.ts`）：`test/tool/edit.test.ts`、`read.test.ts` 这类文件每次运行**必定挂第 2 条**（5004ms 超时），且与用例内容无关——谁排第二谁挂；`--timeout 30000` 下不报错，只是白等。根因是一条真实的 3MB 下载：ModelsDev 层每次构建都 `forkScoped` 一个后台 refresh（`core/models-dev.ts`），它先拿 `models-dev` 的 flock 再去拉 `https://models.dev/api.json`；preload 虽把 `REDCODE_MODELS_PATH` 钉在 fixture 上，但 `fresh()`/`refresh()` 不看这个变量，照拉不误。第一条用例结束时 fixture 的 `afterEach → disposeAllInstances()` **首次把整个生产 AppLayer 建进测试进程**，它那份 ModelsDev 抢到锁开始下载，而 AppRuntime 全程不 dispose；第二条用例自己的 ModelsDev 就堵在 `Flock.effect` 上，而 `Effect.acquireRelease` 的 acquire 段不可中断 —— 它的 layer scope 关不掉，用例被拖满整段下载（实测 4–9s）。第三条起缓存文件已落盘、`fresh()` 为真，后台 refresh 直接跳过，所以只有第二条挂。preload 补 `REDCODE_DISABLE_MODELS_FETCH=1`（`test/lib/cli-process.ts` 给子进程早就设了，进程内跑的测试一直漏了）：`edit.test.ts` 默认 5000ms 超时下 60 pass / 0 fail（原 59/1），24s → 17.6s；`test/tool` 与 `test/provider`+`agent`+`config` 的失败数与净版逐项一致（2 / 35，均为存量）。**两条遗留未动**：`Flock.effect` 的 acquire 段不可中断，等锁最长可堵 `timeoutMs` 默认 5 分钟（`core/util/flock.ts`，`reference/repository-cache.ts` 同形）；`REDCODE_MODELS_PATH` 被 `populate` 认、却不被 `fresh()`/`refresh()` 认，钉了目录还照拉一遍属纯死工作。
- **上下文面板 token 列名对齐命中/未命中语义**（`app/i18n/*`、`cli/cmd/tui/feature-plugins/sidebar/context.tsx`）：GUI 侧词条「输入 token」→「输入（未命中）」、「缓存 token（读/写）」→「命中 / 未命中」——DeepSeek 的输入 = 命中 + 未命中恒等，`input` 是未命中残值恒 0，原名误导；与 usage-dashboard v0.1.2 同款修复，数字本就是真值、只改语义。TUI 侧删掉恒 0 的 "in" 行，cache read/write 改 `hit {read}` / `miss {write+miss}`（write 与 miss 是互斥双桶，read+miss+write 才算全输入，260707 的注释即此口径），out/reason 从「末轮值」改成会话累计——原来与 hit/miss 量纲不一致，现与 GUI 上下文面板账本对齐。

- **claude 经 openai-compatible 中转接入时不再摆出上游不认的推理档位**（`provider/transform.ts`）：`variants()` 按 `model.api.npm` 分派，中转站配的是 `@ai-sdk/openai-compatible`，于是 claude 一路落到 `openaiCompatVariants` 末尾的兜底 `effortVariants(WIDELY_SUPPORTED_EFFORTS)`，页脚摆出 low/medium/high 三档。**Anthropic 的 API 里根本没有 `reasoning_effort` 这个维度**——原生是 `thinking.budget_tokens`，只有 anthropic / bedrock 那几条分支发得出去；中转站也不会凭空造一个，本机 justwoker 的目录就是把思考做成独立模型 id（`claude-opus-5` 与 `claude-opus-5-thinking` 两张卡、两个价），选不选思考靠换模型而不是传参。选了不报错、只是什么都没发生，正是 deepseek medium 那段注释说的「骗人」。判据用模型不用 provider 名，同 GLM/Doubao 的教训（挂在聚合供应商下也要成立）。顺带删掉 `variants()` 里一个计算了却从没被使用的 `adaptiveEfforts` 局部（oxlint 没开 `no-unused-vars`，一直没报）。新增 3 条回归（含"走原生 anthropic npm 时档位照给"与"不误伤同一 npm 下的 GLM"）。

- **等 flock 的 fiber 现在打得断了**（`core/util/flock.ts`）：`Flock.effect` 原来是 `Effect.acquireRelease(Effect.promise((signal) => Flock.acquire(key, { signal })))`，而 **acquireRelease 的 acquire 段不可中断** —— 传进 `Effect.promise` 的那个 AbortSignal 永远不会被触发，于是一个正在等锁的 fiber 在拿到锁之前根本打断不了，最长 `timeoutMs`（默认 **5 分钟**）。这就是本版「第二个用例必挂」那条的另一半：ModelsDev 的后台 refresh 堵在这里，它的 layer scope 关不掉，整条用例被拖满上一个持锁者的下载时长。改法**不是**把 acquire 直接放开成可中断 —— 那会漏锁：`Flock.acquire` 可能在中断落地前一瞬刚好建好锁目录并起了 heartbeat，而我们已经没机会把它交给 release 了，heartbeat 会一直刷、stale 检测（`staleMs`）因此永远不触发，等于永久泄漏。改成按可中断性重新切粒度：新增 `Flock.tryAcquire`（单次尝试、不等待），**等待**（退避 sleep）挪到 Effect 侧、可中断，**单次尝试**用 `Effect.uninterruptible` 包住（只有几个 fs 系统调用、不等待），拿到锁之后在 `uninterruptibleMask` 的不可中断段里注册 finalizer —— 中断插不进这个缝。超时仍是 defect、消息不变。新增 4 条回归，其中「等锁时可被中断」在旧实现下实测挂满 20s 超时、新实现 0.6s 返回。**未动**：`reference/repository-cache.ts:177` 是同一形状（`acquireUseRelease` 里裹 `Effect.promise(Flock.acquire)`），改它要把上百行的 use 体整个挪进 `Effect.scoped` 并改掉 `LockFailedError` 的来源（超时从 fail 变 defect），diff 会淹掉真实改动；它的锁是 `repo-clone:<path>`，只在两个进程同时克隆同一个仓时才会争。

- **`REDCODE_MODELS_PATH` 钉了目录，refresh 却照拉不误**（`core/models-dev.ts`）：`populate` 认这个变量（`loadFromDisk` 用 `Flag.REDCODE_MODELS_PATH ?? filepath`），`fresh()`/`refresh()` 不认 —— 于是钉了目录的人（测试进程、离线/内网环境）照样每小时把 models.dev 那 3MB 拉一遍,而拉回来的东西**一行都用不上**：它写的是 Global 缓存里的 `filepath`,`invalidate` 之后 `populate` 重新读到的还是同一份钉住的文件。半截口子补齐:钉住时 `refresh()` 直接跳过并打一条 debug 日志(`redcode models --refresh` 因此也不再做无用功而是说明原因),且连那个每小时的 `forkScoped` 都不再建 —— 这个 fiber 的存在本身就是代价,它正是上一条里堵在 flock 上的那个。新增 2 条回归(钉住时 `refresh(false)`/`refresh(true)` 都不发请求;钉住时建层不 fork)。附带效果:`opencode/test/preload.ts` 里那行 `REDCODE_DISABLE_MODELS_FETCH=1` 现在是冗余的(preload 本来就钉了 fixture),保留只为显式。

- **清掉三个上游 fork 残留的 GitHub 元文件**（`.github/CODEOWNERS`、`.github/TEAM_MEMBERS`、`.github/ISSUE_TEMPLATE/config.yml`）：这三个不是躺着不动的垃圾,对公开仓是**活的**。`CODEOWNERS` 把 `packages/app/`、`packages/desktop/` 派给 `@adamdotdevin` / `@brendonovich`——上游的人、不是本仓协作者,GitHub 只会静默派不出去,里面还写着本仓根本不存在的 `packages/tauri/`;`TEAM_MEMBERS` 是 15 个上游名字;`ISSUE_TEMPLATE/config.yml` 最实际——`blank_issues_enabled: false` 挡掉空白 issue,再把来提问的人导去 **`discord.gg/opencode`**,等于把自己仓的提问送到别人家。删掉后空白 issue 恢复可用。四个通用模板(`bug-report` / `feature-request` / `question` / `pull_request_template`)内容不提上游,留着。

#### 文档

- **README/MANUAL 过时点清理**（`README.md`、`README.en.md`、`MANUAL.md`）：删已退役的防重复循环检测、补选择器鼠标能力、记忆系统章节重写为索引化机制。
- **双写核对脚本收进 seed**（`seed/scripts/check-memory-dualwrite.mjs`、`AGENTS.md`）：`sync-home` 对 scripts 目录是 wipe-then-copy 的镜像同步，live 独有脚本每次 build 都会被清掉，故收进 seed 受管；根 `AGENTS.md` 顺手修 CORE 标题的全角空格、双空行与文末换行。
- **日期勘误 260828→260825**（`MANUAL.md`、`seed/skill/memory-automation/SKILL.md`）：存量旧格式就地索引化的定案实为 260825。本文件 `[0.9.7]` 的标题日期同属这一族笔误，2026-08-28 → 2026-08-25——该版 bump 提交 `8b1f439a` 落在 08-25，条目内容也都是 08-25。

### [0.9.7] - 2026-08-25

#### 新增

- **工作区选择器支持鼠标**（`cli/project-selector.ts`）：启动前的 workspace 选择原本纯键盘，工作区 30+ 个时翻找不便。开启 SGR 鼠标追踪（`?1000h` + `?1006h`）：单击选中、点击已选中项（等价双击）打开、滚轮滚动，键盘路径原样保留。点击坐标→列表项的映射靠进入时清屏归位（`ESC[2J ESC[H`）把列表首行钉在视口第 1 行，点击 y 减 1 即列表行——**不能用 DSR 光标应答做锚点**：ConPTY 转发下该应答按它内部缓冲计行、与终端视口的鼠标坐标不同步（首版实测点击整体偏移若干行），清屏让两边同处视口坐标系。列表行数上限同步收紧为 `height - 9`：画面固定开销 9 行（标题区 5 + footer 区 2 + 选中项路径行 1 + 结尾换行 1），旧上限 `height - 6` 会让小窗口下的画面超高 2~3 行、终端被迫滚动、首行滚出视口导致映射整体漂移（实测全屏准、小窗口偏的根因）。终端不支持时点击/滚轮静默无效，键盘不受影响。退出时关鼠标模式，不漏事件给主 TUI。

- **记忆系统双写自检**（`seed/skill/memory-automation/SKILL.md`）：记忆机制正式化——MEMORY.md 索引行的完整全文必须落在 `~/.redcode/supermemory.db`（索引化后删索引行 = 删除唯一入口，260825 核对时发现 6 条旧索引有索引无全文，疑似被 260824 发现的 sqlite 多语句事务回滚坑吞掉）。此后写完双写跑 `bun ~/.redcode/scripts/check-memory-dualwrite.mjs` 自检，私仓 pre-commit 已挂自动检查——动 MEMORY.md 的提交缺全文直接阻断（`--no-verify` 可临时绕过）。
- **存量旧项目记忆就地索引化**（`seed/skill/memory-automation/SKILL.md`、`project/bootstrap.ts`）：索引化（260812）之前建立的项目，`.redcode/MEMORY.md` 正文是完整段落全文（无 `#NN` 索引行结构），不会自动迁移、也没人核对（私仓核对脚本只查全局）。定案：不做一次性迁移——在该工作区整理记忆（consolidate-memory 流程新增「旧格式检测」步骤）或收尾时发现旧格式，就地转换：每条教训全文 INSERT `supermemory.db`（content 首行 `[项目名·踩坑|决策] 标题（YYMMDD）`）+ 正文改写成索引行。新项目播种文案（bootstrap.ts:110）同步补上索引化指引，新播种的项目开局即知新机制。
- **flash 锚 ① 改复杂度分派 + 验证失败先审假设**（`session/prompt.ts`、`session/prompt/deepseek.md`；来源 dsh-routing-suite，note 见 `docs/notes/implemented/feature/2026-08-25-dsh-p30-depth-dispatch-and-hypothesis-audit.md`）：上游预设从我们上次看的 v1.9/v1.10 走到了 v1.27，**中间的东西证据分两档，必须分开对待**——P 系列（P1–P30）是 `n=2/n=3` 对照实验、有实测差值（0.8.x 的三锚就建在这上面），而 v1.22–v1.27 的「注意力工程五大支柱」验证口径只有 `selftest PASS + router.test 26/26`，那是**预设自己的单元测试、不是模型对照实验**。只从前者取两条。
- **① P30「深度效率」**量化出：决策闭环（"每块思考以决策或信息缺口收尾"）在复杂任务上**深度 +12% 且收敛更快（8.0 vs 8.3 步）**；而促成上游 v19 改动的实战反馈是「**硬收敛锚催停了复杂任务的探索**」，其改法是复杂度分派——简单任务快速收敛（1 步零浪费），复杂任务才给深度引导。我们的 flash 锚 ① 恰好是「决策闭环（对，已有）+ 无条件 Think deeply first（简单任务纯浪费）」的组合，故**只改前半句**为按任务复杂度分派，**后半句原样不动**——P30 单独量化认可过它，动它是退步。
- **② `deepseek.md` 补验证失败规则**：该文件有 "Verify after you edit"，却**没有一条讲验证失败之后该干什么**。新规则要求动实现之前先一句话点名"在重新检查哪个假设 + 这次失败给了什么新证据"，并明写"若代码其实是对的就说出来、**别为了给已经开始的返工找理由而编造缺陷**"。这条的依据不在上游而在自家账上：0.9.4→0.9.5 那条闪烁第一次「只是把滚动节流了，方向不对」、连修两轮才找到真根因；0.7.30 项目选择器冷启动那次，基于「能力协商随机失败」这个错误猜测加的三个强制开关，经对照测试证明**不是中性兜底而是有害**。两次同一种病——验证不过就把同一条流水线再跑一遍更用力，而不是回头质疑最初的假设。
- **③ 顺带把 P27 的修正记进代码注释**：上游发现 Pro 档的「67% 完成率」是 8 步上限造成的假象，16 步下天然 100%，「**Pro 的慢是深度思考的代价，不是缺陷**」。我们的锚按 `model.id` 含 flash / step 分档，Pro 本就不受影响；写下来是防止以后有人"顺手给 Pro 也加个收敛锚"。
- **明确否掉的两项**：搬「五大支柱」那套阶段机（阶段化工具解锁、`delivery_check` 门禁、阶段出口）——是 harness 形态的结构性改造，且只有预设单元测试背书、没有对照实验，与三锚不是一个证据档次；加预算锚（"最多 N 次工具调用"）——它实测能把完成率推到 100%，但**上游自己评估后也不放进 persona**，理由是"值是任务相关的"，我们同理不做。

#### 修复

- **分割线 token 对比不再越压越大**（`session/compaction.ts`、`session/message-v2.ts`）：260818 起 `estimate(filterCompacted(...))` 口径方向对，但 `filterCompacted` 的折叠循环假设 chrono 逆序输入，而 compaction.ts 回填收到的是展示序（`[parent, summary, tail, 后续]`）——折叠从不生效，before/after 恒为全量估算，分割线显示 534k → 535k，越压越大。改为内部按 `compareTime` 归一化成逆序：stream 路径排序前后值不变，展示序输入也能正确折叠。附带回归测试（chronological / display-order / stream 三种输入输出一致）。
- **矮终端下工作区选择器一个条目都不显示**（`cli/project-selector.ts`）：鼠标支持那次把可见行数从 `height - 6` 收紧到 `height - 9`（为了让帧不溢出、点击映射 `y - 1` 保持成立），但没留下限。终端 9 行时算出 `maxVisible = 0`、8 行时算出 `-1`，两种情况下 `filtered.slice(offset, offset + maxVisible)` 都返回空数组——**框架画得出来、列表整个是空的**。选择器是入口闸，连「新建路径」那个哨兵项也在同一个列表里、一起消失，用户无路可走；而且不崩不报错，看着就像"没有工作区"。这次改动把死区从 `≤6` 扩到了 `≤9`，分屏与 IDE 终端面板够得着。修法是给可用行数加 `Math.max(1, ...)` 兜底：宁可让帧溢出（点击映射偏一点、方向键仍可用），也不能让列表消失。顺带把这段算术抽成导出的纯函数 `listViewport()`——此前它内联在 `render()` 里，而 `render()` 要真终端才能跑，没法测；现在有 6 条回归钉住（含 1~11 行逐行扫、选中项恒在视口内、偏移不越尾）。
- **`updateToolCall` 的 orphan 兜底收窄到"从未注册过"**（`session/processor.ts`）：`readToolCall` 的 miss 有两个来源——① `ctx.toolcalls` 里根本没有该 callID，就是 AI SDK v7 那个 execute 早于 tool-call 事件的竞态；② 注册过但 part 在库里查不到／类型不对，此时它会顺手 `delete` 掉该条目。新加的 `adoptOrphanToolCall` 对两者一视同仁，于是 ②（revert／压缩把 part 移走等）会在**当前** assistantMessage 上复活一个本属于别处的 pending part，属于错挂。改为在 `readToolCall` 之前先记下"是否注册过"，只对 ① 兜底，② 保持原来的静默 no-op。
- **`updateToolCall` 丢失的 tracing span 补回**（`session/processor.ts`）：竞态修复那次把它从 `Effect.fn("SessionProcessor.updateToolCall")(...)` 改成了普通箭头函数返回 `Effect.gen`，span 名随之消失（同批新增的 `adoptOrphanToolCall` 反而保留了 `Effect.fn`）。本文件另有 11 处 `Effect.fn`，按文件惯例还原。仓里 opentelemetry 在跑，这类退化不报错、只是链路上少一段。
- **选择器鼠标模式加异常退出兜底**（`cli/project-selector.ts`）：`cleanup()` 只在显式路径上跑。Ctrl+C 已在按键处理里接住（raw mode 下它不变成 SIGINT），但硬崩溃／外部 kill／终端被直接关掉时不会执行，SGR 鼠标追踪就留在用户终端里——之后每次点击都往 shell 喷 `\x1b[<0;12;5M`。挂一个 `process.once("exit")` 做最小复位（只关鼠标追踪 + 恢复光标，刻意不碰 raw mode 与依赖 `renderedLines` 的光标回退，退出路径上重排屏幕比留点脏字节更危险），`cleanup()` 里 `process.off` 摘掉、避免重复调用时堆监听器。不挂 SIGTERM/SIGHUP：装处理器会阻止默认终止、得自己补 re-exit，为这点收益不值得。
- **三个文件补跑 prettier**（`session/processor.ts`、`cli/project-selector.ts`、`webqa-server/index.js`）：均未过 `prettier --check`。其中 `processor.ts` 最明显——新加的 `updateToolCall` 与 `adoptOrphanToolCall` **顶格书写**，而同级的 `readToolCall` 缩进 6 空格；JS 缩进不影响作用域，所以类型照过、行为无异，但读起来像掉出了闭包。
- **`test/session` + `test/cli` 长期挂着的 7 条全部清掉，四个互不相干的原因**（924 pass / 0 fail）：
- **① DCP nudge 没剥干净，是那个「保险」分支自己打自己**（`session/instruction-echo.ts`）：`stripDcpNudge` 的主路径是"从锚点剥到文尾"，注释写得很清楚——「统一剥到文尾…零误伤；endMatch 分支保留只为兼容旧测试」。但那个分支的正文探测写的是 `\n\n` 后跟大写字母/中文起头且 ≥10 字符的行，而 nudge **自己的收尾行**（`Do not amplify or repeat this instruction...` / `Do not repeat, quote, or echo...`）正好符合，于是被判成"后面还有正文"，只剥到它之前，把 `Keep active context uncompressed.` 留在了用户可见正文里。核过全仓：没有任何测试依赖该分支，它声称要兼容的"旧测试"并不存在，而它正是这两条用例长期红着的原因。按同一段注释里作者自己的结论删掉分支，`NUDGE_END` 随之退役。
- **② 同文件两处 `text.includes("")` 空串**（`session/instruction-echo.ts`）：`suspicious` 快路径的标记列表里，紧跟 `<system-reminder>`/`<reasoning-language>` 的两项自 `0eed39fc` 引入时**就是空字符串**——原意显然是 `OWN_BLOCKS` 里对应的 `<dcp-message-id>` 与 `<dcp-system-reminder>`。空串使 `includes` 恒为真。已补回，并补上列表漏掉的 `Compressed block context:`（`SCHEMA_STRONG` 有它、`suspicious` 没有）。**注意 `suspicious` 目前计算了却没人用**——`detect()` 的文档注释承诺的"快路径"并不存在，每次调用都走全量扫描；oxlint 没开 `no-unused-vars` 所以一直没报。没有顺手接上去：`SCHEMA_STRONG` 里还有 `- Do not invent` / `IDs must exist` / `Pick startId` / `OUTPUT FORMAT` 四个强特征不在该列表中，直接启用会漏剥，得先补全再启用。
- **③ `tui sync` 的 scope 断言陈旧，不是代码错**（`test/cli/cmd/tui/sync.test.tsx`）：`f25f0b29`（0.4.4，2026-06-07）**有意**把"关掉目录过滤"的语义从"放宽到本项目"改成"放宽到全局"，同批改了服务端 `session.ts`、HTTP 路由与 SDK 生成类型共 5 个文件，CHANGELOG 作为新功能记着。而该测试来自仓库初始快照 `d6d579c4`，从没跟着更新。断言与用例名一并改为 `global`。
- **④ 三个录制夹具漂移**（`test/fixtures/recordings/session/*.json`）：`$.max_tokens 32000→50000`（claude-haiku-4-5）与 `$.max_output_tokens 32000→128000`（gpt-5.2-codex）是**本轮 `ee9cc7be`「输出预算按目录推导」改出来的**——旧公式一律 32000，新公式对 200k 上下文的 Claude 算 50000。`$.include ["reasoning.encrypted_content"]` 则来自 `3aba7738`（08-22）。三个夹具的请求匹配已按代码当前真实下发内容手工对齐（录制响应的输出量为 54/36/43 token，远低于任一新上限，语义安全）。**这是手工更新匹配、不是重录**：真正的重录需要 OpenAI / Anthropic / Zen 的 live 凭证，仍然欠着——欠的那部分是 `encrypted_content` 的响应侧覆盖。
- **⑤ `snapshot race` 在 Windows 上从来没通过过**（`test/session/snapshot-tool-race.test.ts`）：命令是 ``echo '...' > ${path.join(dir, "race-test.txt")}``，把 `path.join()` 产出的 Windows 路径**裸插**进 shell 命令，而跑它的是 POSIX 系 shell——反斜杠被当转义吃掉，`C:\Users\...\race-test.txt` 塌成 cwd 下的单个文件 `CUsersAdministratorAppDataLocalTemp...race-test.txt`（探针实测的真实文件名）。工具还自报 `status=completed`，因为重定向本身成功了、只是写去了别处。改为引号 + 正斜杠，bash 与 PowerShell 下都成立。这条同样来自 `d6d579c4`。

### [0.9.6] - 2026-08-24

> 输入框上的 todo dock 与侧边栏「计划」面板功能重复（哥哥 8/23 定案：只保留侧边栏）。整个组件与状态机删掉，输入框回归纯粹——todo 多时不再有面板叠在输入框上、与正在输入的文字重叠。

#### 移除

- **输入框上的 todo dock**（`app/pages/session/composer/session-todo-dock.tsx` 及全部联动）：与侧边栏 `session-plan-tab` 功能重复（进度条、统计、完整列表、Goal 卡一应俱全，按哥哥定案只留右侧计划面板）。连带删除：`session-composer-state.ts` 的 `todoState`/`todoDockAtBoundary` 状态机与 dock store 字段（state 现只管权限/提问/决策）、`session-composer-region.tsx` 的 dock 渲染块/ResizeObserver 高度测量/`view.todoCollapsed` 折叠态（spring 动画改由 revert dock 滑入驱动）、`layout.tsx` 的 `todoCollapsed` 字段、i18n `session.todo.*` 4 key × 3 语言、index.css 的 dock 毛玻璃掺粉块、过期动画 playground story（`todo-panel-motion.stories.tsx`，其 props 早已与 region 脱节）与 storybook mock 残留。数据层不动：todo 由侧边栏走 `directory-sync` `store.todo` 拉取展示，与 dock 消费的 globalSync 镜像互不影响。原「todo 多时最后一条与输入文字重叠」根因（列表 pb-11 底部留白 + 输入框上移 36px 叠加）随组件删除一并消灭。
- **全局同步旧壳**（`app/context/global-sync.tsx`，522 行）：与 `server-sync.tsx` 同构双副本（同样的 bootstrap/event-reducer/child-store 依赖与 GlobalStore），全仓零引用——此前全局 store 重构为 server-sync 时留下的死壳，连带删除其 storybook alias 与 mock。`context/global-sync/` 目录（bootstrap/event-reducer 等活模块）不动。
- **旧的新会话视图**（`app/components/session/session-new-view.tsx`）：`USE_NEW_SESSION_DESIGN` 恒为 true，design 版（项目切换器 + 分支选择器，功能超集）一直是默认——旧视图与 fallback 分支、`params.id || !USE_NEW_SESSION_DESIGN` 恒等条件均为死代码，连带清 i18n `session.new.title/worktree.main/mainWithBranch/lastModified`（`worktree.create` 仍被输入框活引用，保留）。

#### 新增

- **压缩中状态 + 压缩完成提示**（`app/pages/home-kanban.tsx`、`app/pages/layout/notification-toasts.ts`）：引擎的 `session.time.compacting` 与 `session.compacted` 事件早就存在、TUI 侧边栏早就显示，GUI 一直零消费——压缩跑在后台时看板卡片毫无指示，压完了也没人报告数字。现在：①看板卡片标题旁显示「压缩中」徽标（`time.compacting` 非空）；②收到 `session.compacted` 事件弹 toast，描述带 `CompactionPart` 回填的 `tokens_before → tokens_after`（事件在回填之后发出，数字必在），异常路径只报标题。
- **webqa MCP 语义观察与智能等待**（`webqa-server/index.js`）：借鉴 ego-lite 的 snapshotText 设计补齐页面观察能力。新增 `observe` action：`ariaSnapshot({ mode: "ai" })` 输出带 `[ref=eN]` 注解的 aria 语义树，后续 click/fill/type 的 selector 直接传 `aria-ref=eN`（Playwright 原生选择器引擎解析，无需自建 refMap），agent 不再靠截图猜 selector 或盲写 eval 探测 DOM；ref 只在页面结构稳定期可靠，大幅 DOM 变化后重新 observe。新增 `waitFor` action（mode=selector/loadState/url），SPA 渲染等待替代死等 wait(ms)。截图文件名加 pid+序号防同毫秒覆盖。

#### 修复

- **工具调用 metadata 在竞态窗口丢失**（`session/processor.ts`、`session/tools.ts`）：AI SDK v7 在 fullStream 推出 tool-call 事件**之前**就已启动 execute，`TaskTool` 的 `ctx.metadata` 回调先于 `ensureToolCall` 到达——`ctx.toolcalls` 未注册、消息尚未落库，`updateToolCall` 查不到 part 就静默返回，title 与 `metadata.sessionId` 永久丢失，后到的流事件只会补写 running 状态（prompt.test.ts「running task tool preserves metadata after tool-call transition」稳定红）。修法：`updateToolCall` 增加 tool 名参数，miss 时现场创建 pending tool part（与 `ensureToolCall` 创建分支同构），metadata 回调的 update 直接落进 part；随后的 `ensureToolCall` 走 existing 分支不会重复建。顺带两个 shell 排队用例预算 3s→30s（Windows 上 git init + mock server + shell 子进程实测 5.6s，3s 顶格必超时）。
- **`permission/index.ts` 里一个裸 0x00 字节让整个文件对 grep 隐身**（`permission/index.ts:278`）：dedup Map 的 key 用 `` `${rule.permission}<NUL>${rule.pattern}` `` 拼接——**选 NUL 当分隔符本身是对的**（permission 与 pattern 里都不可能出现它，拼 key 不会撞），但它被写成了**裸 0x00 字节**而不是转义序列。后果不在运行时（两者完全等价，已实测 `raw === esc`、码点 0），而在工具链：12128 字节的文件里这一个字节就让 grep 报 `Binary file ... matches`、ripgrep 不加 `-a` 直接搜不到，本模块因此对全仓搜索隐身过一次（`reference_tool_input_escape_hazard` 在案）。改成转义写法并留注释说明为什么不能"清理"回去。修完 ripgrep 立刻能命中 `index.ts:143` 的 `@opencode/Permission`——**这条是评估 76 个 service tag 能否批量改名时发现的：任何跳过二进制文件的批量替换都会静默漏掉这个 tag，漏一个就是多出一个身份不同的服务且不报错。** 另记：`claude/nifty-shamir-c658f6` 分支上有个 `script/check-control-bytes.ts` 裸控制字节闸门（215 行，挂 pre-push），**尚未合进 dev**，所以这边没有守卫。验证：permission 三个测试文件 107 pass 0 fail、`turbo typecheck` 12/12。
- **裸控制字节闸门接进 dev（pre-push + CI），顺手修掉 CHANGELOG 里同一类的 0x01**（`script/check-control-bytes.ts`、`.husky/pre-push`、`.github/workflows/test.yml`、`package.json`）：该闸门此前只活在 `claude/nifty-shamir-c658f6` 分支上（`f35dbfd7` + `25e63d23`，215 行字节扫描），**从未合进 dev**——这正是上一条那个裸 NUL 能活到今天的原因。移植时跳过该分支的第三个提交 `cc086f83`：它修的是同一个 permission NUL，与 dev 上刚落的 `7dec94a7` 产出的代码行逐字相同（都是转义写法），本仓这版另多四行注释说明为何不能"清理"回去。两次独立排查落到同一根因，互为印证。闸门本身：扫 `git ls-files` 的跟踪文件，二进制按扩展名黑名单跳过（**刻意用黑名单**——漏登记一种二进制格式只会吵一次，白名单漏掉一种源码扩展名则是静默不检，正是它要防的失败），例外必须写进 `EXEMPT` 并带理由。CI 侧单独挂一条是因为 `--no-verify` 绕得过 pre-push，而这类字节零运行时征兆：代码照跑、测试照过，只有 grep 悄悄看不见那个文件。**CHANGELOG 里那个 0x01 同属一族**：`CHANGELOG.md:564` 描述正则时写的「反向引用 `` `<(name)>…</\1>` ``」，`\1` 落成了裸 0x01 字节，已还原。接入后实跑：3972 个非二进制文件无裸控制字节（跟踪 4309、豁免 1），`exit=0`。
- **`DiffViewerFileTree` 那个 flaky:固定 25ms 当渲染沉降的替身,正好压在 p90 上**（`test/cli/tui/diff-viewer-file-tree.test.tsx`）：`renderOnceSettled` 原本是 `renderOnce → setTimeout(25) → renderOnce`。写了个 20 轮探针量"渲染出可见内容"的真实耗时：**min 15ms / p50 18ms / p90 26ms / max 47ms**——25ms 恰好落在 p90，约每 10 次渲染输一次；本文件一轮跑 3~4 次渲染，于是三到四成的运行会挂，**且挂哪一条随机**（实测 3/1→4/0→4/0→3/1 交替，`test/cli` 整体在 399/3 与 400/2 之间跳）。失败形态是断言收到 `[]`：画面还没渲出来就被 `captureCharFrame` 抓走了。根因是 `KVProvider` 要异步读盘——测试 temp home 里 `state/kv.json` 通常不存在、走 ENOENT 回落；**日志里那串 "Failed to read KV state" 在通过的轮次里同样刷屏，是噪音不是原因**，一开始差点被它带偏。改成三条腿的判据：出现可见内容即停（tests 1/3/4 与 "No files" 走这条，约 20ms 返回）；loading/error 分支渲染的是空 `<text/>`、本就没有可见内容，靠画面连续 250ms 不变收尾（远高于实测 max 47ms）；两者都不满足由 2000ms 兜底。修后单文件连跑 8 次全绿、耗时稳定在 ~2.95s（比原来多 0.3s，是那两个"本就该空"的用例在付稳定窗口的钱），`test/cli` 连跑 3 次**全是 400 pass / 2 fail 且失败项逐字相同**——套件从此确定性。剩下那两条是既有失败（`transcript` 的 `Thinking`→`思考中` 全局替换导致的源码/测试不一致、`tui sync` 的 scope），与本条无关。顺带闭环了本轮早先记下的悬案「有一个测试在两轮间 fail→pass，flaky，未追」——就是它。同目录 `diff-viewer.test.tsx` 里那个 25ms 不是同一个毛病：它的 `waitForCommand` 已经是条件轮询（`commands.has(command)` + 10 次重试），是真判据，不动。
- **transcript 导出里唯一的中文标签是全局替换的误伤**（`cli/cmd/tui/util/transcript.ts:91`）：`formatPart` 对 reasoning 段输出 `_思考中:_`，而测试期望 `_Thinking:_`，这条从 `d6d579c4`（仓库初始快照）起就红着。判定依据不是"谁看着顺眼"，是**这份导出格式通篇英文**——`# Test Session` / `## User` / `## Assistant` / `**Session ID:**` / `**Tool:**` / `**Input:**` / `**Output:**` / `**Error:**` 全是英文结构标签，`_思考中:_` 是整个格式里唯一的中文，而测试保留的正是 fork 之前的原值。同批被那次 `Thinking`→`思考中` 替换扫到的还有标识符：`思考中Mode` ×13、`show思考中` ×5、`default思考中` ×5、`next思考中Mode` ×4、`use思考中Mode` ×3、`is思考中Mode` ×2（共 29 处，本次未动，另计）。**TUI 的实时显示不在此列**：`routes/session/index.tsx` 的 `_思考中:_`/`_已思考:_`/`"思考中: "` 是有意的中文、还带注释说明该格式驱动 markdown 强调色，与导出是两条路径，刻意不对齐——已在源码处留注释钉住这个区分，防止下次有人"顺手统一"。修后 `test/cli` **401 pass / 1 fail**，仅剩既有的 `tui sync` scope 一条。

#### 优化

- **Bun 1.3.14 → 1.4.0 尝试后回退,1.4.0 就地封存**（`package.json` 的 `packageManager`）：升上去实测收益确凿——`test/cli` 403 个测试 82~86s → **55.3s**，官方另有 Windows 冷启动 39.0→15.5ms、FFI 调用 2.13→0.70ns（opentui 整条渲染路径就是 Bun FFI）、JSC 补上 RegExp 差距后 `marked.parse()` 80KB markdown 912ms→6ms。全仓 typecheck 12/12、`test/cli` 400 pass、编译产物 smoke 通过。**但真机跑 TUI 25 秒后 segfault**（`Segmentation fault at address 0x26D3D500008`，RSS 0.82GB / Faults 449185，渲染本身正常、`/sessions` 弹窗与中文键位都出来了）。根因不在 Bun 也不在我们：**opentui 0.5.7 没适配 Bun 1.4，且自带一半 Bun-1.4 取向的 FFI 改动**——`2e7f96f5 fix(core): pass transient FFI buffers directly (#1394)`（08-20，把大批 FFI 参数从 `ptr` 改成 `buffer`）**在** 0.5.7 里，而补完剩下 18 条签名的 `3cf59ea6 runtime: require Bun 1.4`（08-21）在**未合并的 `upstream/bun-1.4` 分支**上，0.5.7 是 08-23 从 main 发的、不含它。Bun 1.4 下把接收临时 typed array 的参数声明成 `ptr`，拿到的地址会因存储搬移失效，野指针进 native 就是这个崩法（opentui 自己的 AGENTS.md 写明了这条版本差异）。**回退 `packageManager` 到 1.3.14 并用它重编**——0.5.7 的 `engines` 是 `>=1.3.0`，剩下那 18 条留成 `ptr` 恰恰是 1.3.14 的正确写法，所以「1.3.14 + 0.5.7」是被支持的组合，opentui 的布局收益照收。1.4.0 二进制原地封存为 `~/.bun/bin/bun.exe.1.4.0-parked`，等 `upstream/bun-1.4` 合并发布（该分支现落后 main 14 个提交，还额外要求 Node 26.4.0，不像马上会合）。教训：依赖升级前该查的不只是「目标版本有没有产物」，还有**上游有没有针对本次运行时的未合并适配分支**——那条 AGENTS.md 警告我标了两次却没当阻塞项。
- **`diff` 8.0.2 → 8.0.3（catalog）**：GHSA-73rr-hh4g-fpgx——文件名头里含 `\r`／`\u2028`／`\u2029` 时 `parsePatch` **死循环到 OOM**（不需要大 payload），畸形头另有 O(n³) 解析。归「无界算法」那一支，不是「缺超时」那支。两个调用点吃的都是模型产出的 patch，正好是这两个 API：`acp/agent.ts:1793` 的 `applyPatch`、`cli/cmd/tui/util/revert-diff.ts:7` 的 `parsePatch`。升级后拿三种对抗输入（`\u2028` 头、`\r` 头、24000 字符长头）实测均 0.1~0.6ms 返回；`revert-diff`／`apply_patch`／`patch` 三个测试文件 49 pass 0 fail。顺带去重：树里原先并存 8.0.2（catalog）、8.0.3（`@pierre/diffs`、`@tanstack/router-utils`）、9.0.0（`@opentui/core`）、5.2.2（astro），提到 8.0.3 后前两组合并成一份。
- **opentui 0.2.15 → 0.5.7**（`@opentui/core`／`keymap`／`solid`，catalog + `packages/plugin` 的 peer 下限）：[0.7.30] 那条记的阻塞点已经不成立——当时不敢升是因为 opentui ≥0.4.5 上编译产物会撞 [anomalyco/opentui#1275](https://github.com/anomalyco/opentui/issues/1275)（`normalizeLoadedFilePath` 对 undefined worker 路径调 `.startsWith`，standalone 二进制里模块加载即崩），该 issue 已由 PR #1293 修掉，对应提交 `55339390 fix(runtime): bundled asset path fallback` **就在 0.5.7 里**，`packages/core/src/platform/runtime.ts:87` 现在三条分支都有守卫。升级动机是性能：0.5.0 明写 `speed up Node FFI layout reads` 与 `reuse FFI struct storage`，而上游 `packages/core/src/benchmark/layout-benchmark.ts` 里有六个直接以 opencode 命名的场景（`opencode_many_rows_full_render`、`opencode_leaf_width_calculate_only` 等），形状正是 [0.8.x] 那条「消息列表无虚拟化、每次按键全树 `calculateLayout`」——上游在拿这个工作负载调优。RedCode 侧 `packages/opencode/src` 共 68 个文件、60 处具名 import、46 个名字，逐个对过 0.5.7 导出面：**全在**，无 API 断裂。
- **`fix-keymap-junction.ts` 把版本前缀写死，升级时反过来制造了它自己要防的故障**（`script/fix-keymap-junction.ts`）：该脚本的存在意义是消除 `@opentui/keymap` 双 hash 实例（[0.7.8] 记的 TS `#private` 不兼容），但选实例那一步是 `pool.filter((c) => c.version.startsWith("0.2."))`，注释写着「catalog 钉的是 0.2.15」。于是 catalog 升到 0.5.7 后，`bun install` 装对了、postinstall 里这个脚本又把 opencode 与 plugin 两处 junction **按回 0.2.15 的旧实例**——core/solid 在 0.5.7、keymap 在 0.2.15，正是跨大版本混装。改为从根 `package.json` 的 catalog 现取版本号精确匹配，取不到时退回原「多实例取最高版」兜底。这类「写死一个当时正确的常量 + 注释说明它为什么正确」的代码，在常量变更时不会报错、只会静默做错事。
- **0.5.7 类型收紧照出三处既有漏洞**（都不是升级引入的，是 0.2.15 的宽松类型一直盖着）：① `ui/dialog-prompt.tsx` 声明 `description?: () => JSX.Element`，但 `component/dialog-provider.tsx` 两个调用点写法不一致——326 行传函数（合规），356 行传的是对象查表得到的裸 Element；后者改为 `() => ({...})[id]`，顺带让两棵 `<box>` 只构造被选中的那一棵。② 同文件渲染处 `{props.description}` 把函数本身当 children 传，0.5.7 的 `<box>` children 已收窄为 `string | Element`，改为 `{props.description?.()}`。③ `routes/session/index.tsx:1628` 渲染 `{props.message.error?.data.message}`，而 `data` 是 `Record<string, unknown>`、该字段类型是 `unknown`——`<text>` 拿到非 string 是致命错误（[0.7.x] 那条「TextNodeRenderable 裸 number 渲染崩溃」同一族）。改用仓里现成且本文件已 import 的 `errorMessage()`，它内部就带 `typeof data.message === "string"` 判据与回落。
- **验证口径**：全仓 `turbo typecheck` 除两处别人在飞的调试块外全绿；`test/cli` 65 个文件 400 pass / 2 fail，两个失败经核与 opentui 无关（`util/transcript.ts` 与 `context/sync.tsx` 对 `@opentui` 的引用数均为 0；`transcript` 那条是 HEAD 里 `Thinking`→`思考中` 的全局替换连标识符一起换了导致的源码/测试不一致，早于本次改动）；另有一个测试在两轮间 fail→pass，flaky，未追。模块图探针实测：`resolveRenderLib()` 成功加载 win32 native dll（即 Bun FFI 那层在 1.3.14 上正常）、`@opentui/solid` 的 `extend` 可用、peer 仍钉 `^0.1.49` 的第三方 `opentui-spinner/solid` 注册成功、core 实例同源无双份。**尚未验证：编译产物**——`script/build.ts` 要求运行时 bun 匹配 `packageManager`（本批已升 `^1.4.0`），本地还是 1.3.14，需 `bun upgrade` 后重编一次再确认冷启动。旧 exe 已备份到 `E:/AI/.redcode-exe-bak/redcode.exe.opentui-0.2.15`。
- **输出预算改为按模型目录推导，退掉两条手工特例**（`provider/transform.ts`）：旧形状是 `OUTPUT_TOKEN_MAX = 32_000` 常量 + 每来一个长输出模型就加一行 `isXxxModel` 分支（MiMo 100K、DeepSeek V4 Flash 50K）。代价是**新模型默认吃老上限、要有人记得去补**。从会话库实测（`~/.redcode/data/redcode.db`，assistant 消息按 `output+reasoning` 统计）：`step-3.7-flash` 目录声明 output **256K** 却被夹在 32K，**17 次 `finish="length"` 全部精确停在 32000**，最近一次 2026-08-04；`x-preview-f-free`（Ox Alpha，声明 131072）同样只拿到 32K。改为 `min(声明值, max(下限, cap))`，cap 两道：绝对封顶 `OUTPUT_TOKEN_CAP = 128_000`，以及只对**没有 `limit.input`** 的模型生效的 `OUTPUT_CONTEXT_FRACTION = 0.25`。
- **护栏只挂在真正需要它的那条分支上**：`overflow.usable()` 分两支——有 `limit.input` 的走 `limit.input - reserved`，而 `reserved = min(COMPACTION_BUFFER, maxOutputTokens)` 恒等于 20000（本函数结果永远 ≥ 20000），对输出预算**完全免疫**；没有的走 `context - maxOutputTokens`，提上限会直接吃掉工作上下文。所以 fraction 只夹后者。效果：`step-3.7-flash`（有 input）拿满 128K 且 usable 一token 不少；`x-preview-f-free`／`deepseek-v4-flash`／`mimo-v2.5`（1M 窗口）usable 虽降但 `ceiling = min(threshold=400000, usable)` 里 threshold 仍占优，压缩时机不变；只有 `context≈output` 的中等窗口（`kimi-k2.7-code` 256K、`glm-5.1` 202K、`qwen3.5-*` 262K）掉 14%——不夹的话这一族是掉 43%。哥哥定案这三个已不用，护栏保留纯粹是因为本仓公开发行。
- **两条特例退役是因为推导值严格更优，不是因为它们错**：`deepseek-v4-flash` 50K→65536（即其目录声明值）、`mimo-v2.5` 100K→128000。顺带查清一桩看似的矛盾：MiMo 实测 max 也精确停在 32000、有 6 次截断，但**全部落在 2026-05-29~06-05，早于 260710 那条特例**；特例之后 994 条、max 10414、零截断——那条特例一直是好的。`isMimoModel` 随之删除，其空值保护迁进 `maxOutputTokens`（该函数位于 `maxOutputTokens → overflow.usable → isOverflow` 的压缩主路径上，抛在这里等于整条压缩链断掉）；`isDeepSeekV4FlashModel` 保留，`topP()` 还在用。
- **不会超发**：外层 `min(声明值, ...)` 保证永不超过模型自己声明的能力——目录里 **1087/3491** 个模型 output < 32K，它们仍被各自的真实上限夹住。
- 验证：新增 8 条回归（数字取自真实模型目录而非构造值，含「step 提上限后 usable 不变」这条耦合断言），`overflow-level` 19 pass 0 fail；全仓 `turbo typecheck` 12/12。`test/session` + `test/provider` 892 pass / 10 fail，**与 HEAD 基线做了对照**：基线同样 10 fail、其中 9 条逐字相同，差异那 1 条是轮换的 flaky（基线是 `plugin config providers persist` 30s 超时，本轮是 `Anthropic API key` 那条录制用例），本次改动零新增失败。
- **删掉废弃的 `@gitlab/opencode-gitlab-auth@1.3.3`**（`packages/opencode/package.json`）：npm 上该包全版本被标废弃（"This package has moved to 'opencode-gitlab-auth'"），而**替代包 `opencode-gitlab-auth@2.0.1` 早就装着并且是唯一被引用的那个**（`plugin/index.ts:17` 静态 import）。含 gitignore 路径的全仓穷举只剩两处命中：这条声明本身，以及 `.redcode/temp/upstream-package.json` 里的上游快照副本（留作 diff 参照，不动）。零功能引用。删后 `bun install` 干净、`turbo typecheck` 12/12、lock 里该包彻底消失。
- **Effect service tag 全量改名 `@opencode/*` → `@redcode/*`**（76 个文件、**77 个 tag / 78 处**）：这是代码层最后一块品牌残留。改名前先把风险逐条查过——`openapi.json` 0 命中且 `securitySchemes` 为空（`HttpApiMiddleware.Service` 的标识符不外露）、`packages/sdk/js/src` 0、`~/.redcode/{plugin,agent,skill,command}` 0、测试/脚本/specs/docs 0；数据库里 message 110 行 + part 413 行含该字符串，但那是**过去会话引用的源码文本、不是查找键**（模型读写文件时把 `Context.Service<...>()("@opencode/Foo")` 这行连带存进了对话记录），旧记录照实引用旧名反而正确。消费方引用的是 class 不是字符串（`yield* Xxx.Service`），所以没有跨文件同步问题。
- **枚举时抓到一个会静默漏掉的个例**：第一版模式写的是 `"@opencode/[A-Za-z0-9]+"`，**不允许名字里带斜杠**——而 `packages/opencode/src/v2/session.ts` 的 tag 是 `"@opencode/v2/Session"`。用那个模式批量替换会恰好把它留在原地，造出一个身份不同的孤儿服务，且**编译通过、测试也不报错**（Effect 的 tag 是身份键，不是类型约束）。重新枚举后数字从 76/77 修正为 **77/78**。前一条修掉的裸 NUL 是同一件事的另一半：不修它，`permission/index.ts` 对不加 `-a` 的批量替换整个隐身，`@opencode/Permission` 会以同样的方式漏掉。
- **无撞名**：仓里本来就有 `@redcode/*` tag（`packages/llm` 的 `LLMClient`/`LLM/RequestExecutor`/`LLM/WebSocketExecutor`、`effect-drizzle-sqlite/examples` 的两个），但那些包是改名之后写的、从没叫过 `@opencode/`。改完全仓只有两个 tag 出现次数 >1，都是良性：`"@redcode/acme"` ×9 是 `core/test/npm.test.ts` 里测 `Npm.sanitize` 的假包名（不是服务 tag），`"@redcode/ServerAuthConfig"` ×2 是定义 + JSDoc 示例。
- 验证：残留 `"@opencode/` **0**、`turbo typecheck` 12/12、裸控制字节闸门 3972 文件全绿；`test/session`+`test/provider`+`test/permission`+`test/cli/tui` 共 **1114 pass**，失败项与既有基线一致。其中 `DiffViewerFileTree` 单独连跑四次为 3/1→4/0→4/0→3/1 **交替**，错误是临时状态文件 `redcode-test-data-<pid>/home/.redcode/state/kv.json` 的 ENOENT ——测试隔离竞态，与本次改名无关（tag 字符串改名不可能造成临时文件缺失），单独记一笔待查。

### [0.9.5] - 2026-08-22

> 找到并修掉「模型一调工具整个界面就闪一下」的**真**根因——0.9.4 记的那条只是缓解，方向也不对。顺带把输入框那个上下文按钮与右侧面板的分工彻底切开，重写并砍半了兜底提示词。

#### 修复

- **模型每调一次工具，整个界面闪一下变成主题底色再回来**（`app/components/session/session-context-tab.tsx`）。真根因：「上下文」面板的 `context-inspect` 查询，`queryKey` 里带着最后一条 assistant 的 id 与 `tokens.context`，而后者是服务端**每个 step 覆写一次**的 —— 每次工具调用 key 就变，对 solid-query 就是一个全新且无缓存的 pending 查询。`useQuery` 内部是 `createResource`，渲染期读 `.data` 会向上抛给最近的 Suspense，而最近的那个是 `app.tsx:198` 包住**整个应用**的那一个，fallback 是满屏 `bg-background-base` + Splash。于是整棵树被卸载、换成一块满屏色块、请求回来后再整棵重挂。复现条件极窄——**只有该 tab 处于激活状态时才发生**（侧栏 tab 内容是 `<Show when={activeTab()===...}>` 真卸载的），纯文字流式不触发（`tokens.context` 每 step 才写一次）。修法是 `placeholderData` 保留上一轮快照，使其永不进入无数据 pending；并给侧栏 tab 内容加了自己的 Suspense 边界兜底。
  诊断口径记一笔：`LONG 0/0` 配 `CLS 1.47` = 内容被换掉了，不是算卡了；输入法组合被强行提交成裸拼音 = 编辑区所在的整棵树被重建。
- **时间线上一行被无谓重挂**（`app/pages/session/message-timeline.data.ts`）：`AssistantPart` 带着一个全仓没人读的 `lastAssistantPart` 字段。末尾插新行会让原来那行的该字段 true→false，行对象因此不再 equals、复用不到，而 virtua 的 `<For>` 按引用 key —— 那一行整棵 DOM 被销毁重建。已删除该字段并钉回归测试。
- **切回会话停在历史中间**（`app/pages/session/message-timeline.tsx`）：入场锚定走 `scrollToIndex`，按虚拟**估算**尺寸算落点（缓存未命中时每行 60px），落点一偏，紧跟的 scroll 事件就把 `measuredBottomAnchored` 置 false，而唯一能纠正它的实测锚定恰好拿这个标志当门禁——越偏越不修。加 force 模式并把固定帧预算改成沉降判据（插行 12 帧、入场纠偏 90 帧兜底）。
- **纯浏览器 dev 模式白屏**（`desktop/src/renderer/tauri-api-shim.ts`）：既非 Electron 也非 Tauri 时 `window.api` 不存在，而 `index.tsx` 与 `webview-zoom.ts` 在模块顶层就无条件调用它——一个模块级 TypeError 打断整个模块图。DEV 构建下装 Proxy 兜底桩，恢复「不重编调试 GUI」那条路子。

#### 新增

- **输入框那个上下文小按钮改成显示首字延迟与解码速率**（`app/components/session-context-usage.tsx`）：原先三行里有两行（会话累计 Token、成本）在右侧面板里一模一样地各有一格，纯重复。分工定成「面板是会话账本，悬浮是当下这一轮」。口径照搬 TUI 侧边栏：分子必须 `output + reasoning`（`output` 的定义已扣掉推理），分母必须从 `firstChunk` 起算（`created→firstChunk` 是排队与预填，用它会把 60 tok/s 稀释成 20）。两个陷阱各钉一条回归测试。进度圈同步改成跟着**上下文窗口占用**上色——此前按引擎压缩档位上色，而那个档位的分母是 `ceiling`（可用窗口扣输出预留、再被 threshold 封顶），与显示的百分比不是同一个分母，会出现「圈黄了但数字才 52%」。
- **上下文面板补上压缩机制两格**：「上次压缩」（`CompactionPart` 的 `tokens_before → tokens_after`，附自动/手动与溢出触发；服务端早就回填、TUI 早就显示、GUI 一直只有个没数字的死标签）与「自动压缩」（`config.compaction.auto` / `threshold`——关掉自动压缩的会话，进度圈变红也不会有人来救，此前界面上一个字都没有）。同时删掉与输入框悬浮重复的「上下文限制」「使用率」两格。

#### 优化

- **兜底提示词重写并砍到一半**（`opencode/src/session/prompt/default.md`，95 行 8594 字符 → 53 行 5400）。按 `model.api.id` 子串匹配挑模板，匹不上就落 `default.md`——所以走到兜底的恰恰是刚发布、还没人加分支的模型，**通常是当下最强的那个**；而旧 default.md 是全仓最紧的一份（4 行上限／单词回答最好／禁止任何注释），等于「未知 ⇒ 当成弱模型死死管住」。`grok`/`doubao`/`sensenova` 三份专属提示词的注释都明写唯一目的是逃开它——三次绕行没人修根。重写判据：**偶然事实与本地约定留下，普世工程道德删掉**；因由只在界定规则边界时保留（如 GBK 那条，没有它模型会以为规则武断）。
- **流式结束时不再把整块 markdown 拆了重建**（`ui/src/components/message-part.tsx`）：文本块与推理块都用 `<Show when={streaming()} fallback={<Markdown/>}>` 包着 `PacedMarkdown`，而后者在 `streaming=false` 时的输出与 fallback 逐字节相同。那个 Show 唯一的作用是在 `time.completed` 落库瞬间互换两个**不同组件**，导致整块 DOM 连同 Shiki 高亮全部重来（实测一个推理块 191~247 个节点）。改成常挂。
- **删掉 `doubao.md` 与火山方舟的提示词路由**：确认不再使用该供应商，且该文件逐条读下来没有任何 Doubao 特有内容。

### [0.9.4] - 2026-08-21

> 收口三条 GUI 输入体验主线（流式闪烁吞键、上下文面板去重、计划面板调色）与一条 TUI 布局线（消息左右对照），顺手把「无超时子进程」「总线通道 OOM」「doctor 死代码」三个稳定性隐患清掉，并接入官方 DeepSeek 视觉模型。

#### 新增

- **官方 DeepSeek 视觉模型接入**（`seed/redcode.home.jsonc`）：`deepseek-v4-flash-vision-exp` 与 flash 同价（官方定价页核实），与既有多模态主模型直读路径打通；顺带纠正 chat/reasoner 上「不支持图片」的错误附件标注。

- **TUI 消息左右对照**（`cli/cmd/tui/routes/session/index.tsx`）：用户消息改为右对齐气泡（宽度上限 80% 终端列、40 兜底，窄窗回绕不溢出），与左对齐的助手消息形成常见聊天界面排布。边框随气泡走，不再漂到屏幕左缘。

#### 修复

- **GUI 流式期间整窗闪烁、吞键**（`app/pages/session/message-timeline.tsx`）：流式 delta 每秒 50-100 次，每次触发 `virtualizer.scrollToIndex`（同步设 scrollTop + 强制布局），与 90 帧底锚 rAF 循环、`createAutoScroll` ResizeObserver 三路滚动叠加，每帧 2-3 次强制同步滚动 → 掉帧闪烁 + 键盘事件延迟丢失（已落字保留、正在打的字被吞）。scrollToIndex 改为 rAF 节流（每帧最多一次、已到底跳过），语义不变。

- **八个 git/安装类子进程调用全线无超时**（`core/process.ts`、`opencode/src/git/index.ts`、`installation/index.ts`、`snapshot/index.ts`）：挂起时日志一个字都没有，全部补上超时；并新增 `script/check-subprocess-timeout.ts` 可执行闸门（挂 pre-push），例外必须显式豁免。

- **bus wildcard 通道 unbounded → sliding**（`opencode/src/bus/index.ts`）：慢订阅者不再能把进程堆到 OOM（150k 条消息实测内存从 3.4GB 回落到 300MB 量级）。

- **doctor 四个 catch 全是死代码**（`cli/cmd/doctor.ts`）：一个检查失败整条诊断就没了，改为逐项收集错误。

- **删除不存在的会话不再假装成功**（`cli/cmd/session.ts`）：`session delete` 对不存在的 id 报错而不是返回空成功。

- **DeepSeek V4 Flash Vision 计费恒为 0**（`core/provider.ts` CNY_PRICING）：缺 `deepseek-v4-flash-vision-exp` 条目，cost 落 0 → 补上与 flash 同价；历史会话费用不回溯。**8/22 补齐同类遗漏**：opencode-go provider 键同样缺该条目（按 USD 计费 0.22/0.66，官方人民币口径 3/9 高峰、1.5/4.5 空闲）+ `tiered-pricing.ts` 的 deepseek/opencode-go 两个键的峰谷分段表缺 vision 条目，一并补上。[why](docs/notes/implemented/feature/2026-08-22-deepseek-vision-pricing.md)

- **上下文面板删掉重复的「上下文窗口」字段**（`app/components/session/session-context-tab.tsx`）：输入框 tooltip 已显示窗口占用率，右侧面板那行是重复。

- **计划面板毛玻璃掺粉调淡**（`app/index.css`）：todo dock 在壁纸场景补 [data-chat-frost]/[data-app-frost] 掺粉配方（与用户气泡同款 260812 配方），无壁纸保持原实色。

#### 重构

- **prompt.ts 三处 copy-paste 收成三个有名字的函数**（净 -54 行）；双写摘除留下的孤儿代码清掉（净 -77 行）。

#### 文档

- **五个 v2 空壳端点标 deprecated**（`docs/parallel-systems-plan.md`、`sdk.gen.ts`、`openapi.json`），记下删除前必读的地雷。
- **seed 模板同步**：opencode 白名单、解除禁用、vision 双路径、fixer 观察期注释、browsermcp 残留清理。
- **help 快照测试基线**：34 条 key 停在 opencode 时代、doctor 不在名单里——快照从没比对过基线，补上。

### [0.9.3] - 2026-08-20

> 一轮「代码里已有、前端从没显示过」的清点收口：上下文真实构成查看器、钉住的目标终于有了界面、GUI 补上输出被截断标记。清点本身还发现了一个空壳端点、一个把自动续跑轮数腰斩的复制粘贴 bug，和三处过时文档。

#### 新增

- **上下文真实构成查看器**（`session/context-snapshot.ts`、`session/prompt.ts`、`server/.../session.ts`、`app/components/session/session-context-tab.tsx`）：新端点 `GET /session/:sessionID/context-inspect`，把这一刻发出去的请求拆成**系统提示 / 工具定义 / 对话**三块，各自给出 token 数与明细（system 按段、tools 按最贵的 8 个、messages 按角色）。GUI 上下文面板新增「真实构成」一段。与既有那块估算拆分的区别不是精度是**范围**——系统提示与工具定义从来没到过客户端，估算器手里根本没有这两份数据，而它们恰恰是前缀里最大且最不透明的部分（「哪个 MCP 挂上来吃掉几千 token」只有这里看得到）。

  三个决定：① **在请求真正发出的那一刻记账**，不在读取时从 `PromptCaches` 重建——那里缓存的只是 system 的原料（env/instructions/skills），runLoop 每轮还要追加日期、WORK RULES、按模型家族分支的锚、canary、DCP 说明，重建等于把拼装逻辑复刻一份在读取侧，加一条锚漏一处数字就悄悄偏。② **只留最后一轮、只在内存**：这是「现在窗口里装的是什么」不是历史指标；没有快照时返 404 而不是空对象，空对象会被 UI 画成「构成全是 0」。③ **稳态成本靠 `WeakMap` 按对象引用记忆**——`modelMsgs` 的前缀是钉死的同一批对象，稳态下只算新增的那几条，不是每轮全量序列化。[why](docs/notes/implemented/feature/2026-08-20-context-inspector.md)

- **钉住的目标终于有了界面**（`session/goal.ts`、`server/.../session.ts`、`tui/feature-plugins/sidebar/goal.tsx`、`app/components/session/session-plan-tab.tsx`）：Goal 此前是「后端整套在跑、前端一个字都没有」最极端的一例——独立表与五态状态机、每轮把 `▸ ACTIVE GOAL` 注进系统提示、按 token 预算自动续跑、三个工具还是无 flag 门控的默认工具，而 `grep -ri goal` 打全 TUI + GUI + run 三个前端零命中。新增 `GET /session/:sessionID/goal`（没钉目标返 404，不返 `status:"cleared"` 的空壳——「从没钉过」和「钉过又清掉」在自动续跑那边是两回事）；TUI 侧边栏 slot 350（Todo 上方）、GUI Plan 面板顶部各加一块，显示目标原文、状态与已用 token。轮次与预算只在 `goal_auto_continue` 开启时显示——它默认关，关着时 20 轮上限与预算天花板不会拦任何人，画「3/20 轮」会让人以为有个并不存在的限制在逼近。[why](docs/notes/implemented/feature/2026-08-20-goal-panel.md)

- **GUI 补上「输出被截断」标记**（`app/pages/session/message-timeline.data.ts`、`message-timeline.tsx`）：`finish === "length"` 是模型撞到输出 token 上限被砍断，TUI 07-28 就标出来了，**GUI 从来没读过 `message.finish`**——被截断的回复和正常说完的长得一模一样，用户无从判断。复用既有的 `TurnDivider` 加第三个 label（旁边已有 compaction / interrupted 两条同类分割线）。取**最后一条** assistant 而不是 `some()`：`prompt.ts` 的 `finished` 判定把 `"length"` 当终止原因（只有 tool-calls / unknown 会继续），被截断的必然是本轮最后一条，分割线因此正好画在话被切断的地方。[why](docs/notes/implemented/feature/2026-08-20-gui-output-truncated.md)

#### 修复

- **自动续跑轮数被腰斩**（`session/goal-continuation.ts`）：`goal.tick()` 连着调了两次，而 `tick` 是无条件 `turn_count + 1`（`goal.ts:142`）不是幂等的——**每次自动续跑把计数推进 2，`MAX_GOAL_TURNS = 20` 实际只跑 10 轮就停**。21e1f71b 初次落地时就是两行，属复制粘贴。同一段的 `goal.mark("budget_limited")` 也是两行，那个幂等、无后果，一并收掉。做目标面板要显示「第 N/20 轮」，这个数必须先诚实。

#### 改进

- **`Goal.Info` 的两个计数器改用 `NonNegativeInt`**（`session/goal.ts`）：原本是 `Schema.Number`，而 JSON 表示里 Number 允许 NaN/Infinity，codegen 于是把 `tokens_used` 摊成 `number | "NaN" | "Infinity" | "-Infinity"`，客户端每次读都得先判类型。它们结构上就是非负整数（`tokens_used` 靠 SQL 累加、`turn_count` 每轮 +1）。

- **GUI 会话缓存淘汰漏了 goal**（`app/context/global-sync/session-cache.ts`）：`dropSessionCaches` 一并清理 `goal`，不留一处会随会话淘汰泄漏的键。

- **fixer 子代理换用 hy3（关推理档）**（`seed/agents/fixer.md`）：`model` 从 `opencode-go/deepseek-v4-flash` 换成 `opencode-go/hy3` 并显式 `variant: none`。bench 实测（6 任务 × 2 轮）：hy3 默认深度推理烧 300-5000 推理 token、慢 10-20 倍，`reasoning_effort: none` 后与 deepseek-v4-flash 速度同量级且判分全过，单价约 1/12、套餐 8x 额度。**hy3 网关侧纯文本**（图片被剥，三种格式实测均"没收到图"），识图任务仍走 explore(mimo-v2.5)，故只换纯文本执行类 agent。[why](docs/notes/implemented/feature/2026-08-21-fixer-hy3.md)

#### 文档

- **`docs/parallel-systems-plan.md` 的「记下防复述」里有一句是错的**：「/v2 路由组不在 openapi 里，SDK 没有对应方法，客户端无法调用」。实测 openapi.json 里有 9 个 `v2.*` 操作，SDK 也照常生成了 `client.v2.session.*`（`sdk.gen.ts` 的 `class Session3`）。成立的只有「没有客户端在**调用**」——零调用方不是零能力。这条写在防复述段落里，反而成了最容易被复述的错误。同时记入后续事实：`GET /api/session/:id/context` 已确认是空壳（摘除双写后 `session_message` 表只剩 `model-switched` / `agent-switched` 两类行，实测 live 库 782 行里一条对话都没有），其去留仍未决。

- **`AGENTS.md` 的 SDK 重新生成指令不完整**：`./packages/sdk/js/script/build.ts` 自己也会生成一份 openapi，但落在 `packages/sdk/js/` 下当临时输入、末尾 `rm` 掉，**不碰仓库里那份 `packages/sdk/openapi.json`**。改成两条命令并注明别跑 `script/generate.ts` 整脚本（最后一步是 prettier 全仓 `--write`）。

- **`httpapi/AGENTS.md` 补上路由覆盖门禁**：`bun run test:httpapi` 带 `--fail-on-missing` 跑三遍，任何在 openapi 里出现而 exercise 里没有场景的路由会让三遍全部失败。补上场景写法、单跑一条的命令，以及「不在 `AppLayer` 里的服务要在种子处单独 provide，别为了让测试跑通改生产接线」。

- **`MANUAL.md` 新增 7.6 与 8.1**：7.6「上下文用量：在哪看、怎么读」——两个界面的位置、档位颜色表（颜色是「引擎下一步会做什么」不是百分比，附 step-3.7-flash 上 52/70/88 的换算）、解码速率与首字延迟为什么分开、真实构成与估算拆分的范围差别、输出被截断标记；8.1「钉住的目标：钉了之后在哪看」。

### [0.9.2] - 2026-08-19

> 上下文窗口进度条改由引擎档位上色（颜色含义从「用了多少」变成「引擎下一步会做什么」），侧边栏新增解码速率与首字延迟，以及摘除会话事件系统双写（净 -1713 行）。

#### 新增

- **侧边栏显示解码速率与首字延迟**（`tui/feature-plugins/sidebar/context.tsx`）：数据早在库里（`time.firstChunk`/`time.completed`，埋点 `processor.ts` 的 `llm.ttft`，260811 为排查「首次交互为什么慢」而加），实测最近 400 条 assistant 消息 400 条有值，只是从没显示过。两段**刻意分开**不合成「总速度」——首字慢是排队/预填（供应商负载、上下文长度），解码慢是吐字本身，合成一个数会让两种完全不同的问题看起来一样。实测同一个 deepseek-v4-flash 解码在 15～73 tok/s 摆动四倍而首字稳定在 2.1～2.8s，只报总速度会把「解码忽快忽慢」误读成「整体时快时慢」。两个口径要点：分子必须是 `output + reasoning`（`session.ts:460` 把 output 定义成 `outputTokens - reasoningTokens`，只用 output 会漏掉思考的字，对长思考模型严重低估）；分母必须从 `firstChunk` 起算（用 `created` 会把排队算进解码，长上下文下 60 tok/s 稀释成 20）。[why](docs/notes/implemented/feature/2026-08-19-decode-rate-display.md)

#### 改进

- **上下文进度条改由引擎档位上色**（`session/message-v2.ts`、`session/prompt.ts`、`tui/.../sidebar/context.tsx`、`app/components/session-context-usage.tsx`）：原先颜色阈值是拍的（绿<60/黄60-85/红≥85），与引擎真正动手的时机对不上——档位相对 `ceiling()=min(硬顶,usable)` 算，而进度条分母是模型标称的 `limit.context`，step-3.7-flash 上三条线落在进度条的 52%/70%/88%，按 60/85 上色等于颜色比引擎慢半拍。assistant 消息新增可选字段 `contextLevel`（ok/soft/prune/compact），由服务端算好发出，客户端只做 level→颜色映射；不在客户端复刻 `ceiling()` 依赖的那张按模型家族匹配的 `maxOutputTokens` 表（复刻等于两处维护，加一个模型漏一处颜色就悄悄偏）。档位改为无条件计算并落库（原来只在 `result !== "compact"` 时算，恰恰在最该变红那一轮拿不到值），soft/prune 两档的**动作**门槛原样保留。GUI 侧收成三档（v2 语义色只有 success/warning/danger/info，没有橙色 state token，为装饰新增一对设计 token 不划算）。[why](docs/notes/implemented/feature/2026-08-19-context-bar-level-color.md)

- **摘除会话事件系统双写，退回单写**（`session/processor.ts`、`prompt.ts`、`compaction.ts`、`prompt/shell.ts`、`tui/plugin/internal.ts`、`effect/runtime-flags.ts`）：`experimentalEventSystem`（默认关）门控着 23 处双写分支，前两个文件是全仓改动最频繁的，每次改会话链路都要判断「双写那边跟不跟」而绕过是零成本的，两边必然渐行渐远。这是上游 opencode 的迁移工程（fork 点就带着），本仓从未采摘其主体——`provider-parity-checklist.md` 指向的 `src/v2/plugin/provider/` 目录根本不存在，剩余 20 个未勾项全是主体功能。摘除 23 处分支 + `SessionV2Debug` 调试插件（1186 行，唯一入口是被摘的注册行）+ `context/sync-v2.tsx`（307 行，其订阅的 24 种事件的发布者全部被摘）+ 测试侧 12 处传参与两段双写断言；保留 `specs/v2/`、`src/v2/session.ts`、`projectors-next.ts` 与两个有活消费者的非门控事件发布。净 -1713 行。[why](docs/notes/implemented/simplification/2026-08-19-event-dualwrite-removal.md)

### [0.9.1] - 2026-08-19

> GUI 上下文窗口收口：占用率口径与 0.9.0 的 TUI 那处对齐（原先拿会话累计除窗口，进度圈从会话超过一个窗口起就永远是满的），指示器挪到模型显示旁并去掉重复的一份。

#### 修复

- **GUI 上下文占用率拿会话累计除窗口**（`app/components/session/session-context-metrics.ts`、`session-context-usage.tsx`、`session/session-context-tab.tsx`）：`usage` 的分子是 `total`，而 `total` 按注释「Aggregate across all assistant messages」是**整个会话累计**——实测某会话累计 15,416,562 / 窗口 1M = **1542%**。`ProgressCircle` 内部又钳到 [0,100]，于是那个圈从会话累计超过一个窗口起就**永远是满的、再没变过**；tooltip 里并排的 `total` 与 `usage%` 正是把「会话累计」误读成「上下文窗口」的直接来源。与 0.9.0 修的 TUI 那处是同一个坑的两端（TUI 跨 step 累加、GUI 跨消息累加）。只改 `usage` 的分子、不动 `total`——`总 Token` 标签本来就对，且缓存命中率、逐轮 read/bad 序列、stalled 判据都依赖累计口径。新增 `window = message.tokens.context`（0.9.0 加的字段，processor 里覆盖不累加），`usage = window / limit`；历史消息无该字段则两者皆空、UI 整块不显示，等下一轮请求写入。tooltip 拆两行、面板补一行「上下文窗口」，i18n 三语补 key。[why](docs/notes/implemented/bug-fix/2026-08-19-gui-context-window-metric.md)

#### 改进

- **上下文指示器挪到模型显示旁，并去掉重复的一份**（`app/components/prompt-input.tsx`、`pages/session/message-timeline.tsx`）：prompt 控件行本来就是 `agent | model | variant`，指示器挂在其后与常见排布一致，也正是用户实际在看的位置。复用现成组件而非新写——它自带 `<Show when={params.id}>` 守卫，新建会话页不渲染；依赖的 `useSessionLayout` 只用 `useParams()`+`useLayout()`，路由树任意位置都安全。同时撤掉 timeline 顶栏那份（挪过来后成了同屏第二份、显示同一个数）。现在两处各司其职：prompt 控件行 button（点开分解面板）、侧栏 indicator（只读）。

### [0.9.0] - 2026-08-19

> 一次全仓审计的收口。最要紧的一条是 edit 工具里第四例「无界算法跑在任意文件内容上」——
> `BlockAnchorReplacer` 是 8 个 replacer 里唯一没有行数上限的，4 万行病理输入实测 16.5 秒
> 同步阻塞事件循环。其余：三处按会话累积的进程内缓存零回收、TUI 上下文窗口显示的是累加值
> 而非真实上下文、PrefixShape 的单槽误报漏报、诊断探针从「临时代码」转正为有开关有边界的
> 常驻件；外加 SDK 生成链与代码格式两处长期漂移的收口。

#### 修复

- **edit 的 BlockAnchorReplacer 二次方候选扫描**（`tool/edit.ts`）：8 个 replacer 里唯一没有行数上限的一个，候选收集是「外层遍历全部行找首锚点、内层从 i+2 一路扫到文件末尾找尾锚点」的嵌套双循环。病理输入（首锚点行大量重复、尾锚点永不以正确块长出现）实测 5000/10000/20000/40000 行 = 254/1013/4074/16518 ms，严格四倍/倍长的 O(n²)，且是同步 CPU——整个事件循环冻住。这是「无界算法跑在任意文件内容上」这一支的第四例（前三例 diffFull 260709、fuzzyFindBestMatch 260722、ContextAwareReplacer 260724），260724 补齐「剩余 5 个 replacer」行数帽时漏掉了它；触发条件正是历史事故场景——大文件 + 模型给的 oldString 不精确（前置 replacer 撞 3000 行帽直接 return，3000 行以上文件里本函数是第一个真正开扫的）。修法不是加帽（那会连带废掉大文件上唯一还在跑的模糊回退），而是利用 dbdef8fc(260812) 的行数一致性校验：候选被接受当且仅当 `j - i + 1 === searchBlockSize`，即 j 只能取 `i + searchBlockSize - 1` 这唯一一个值，内层扫描降为 O(1) 定位。等价性用 20 万例随机 fuzz 验证（0 例不符），40000 行 16518 ms → 4 ms、200000 行 21 ms。顺带给 `MultiOccurrenceReplacer` / `UnicodeNormalizedReplacer` 的 `while (true)` 补空 find 护栏（`indexOf("", i)` 恒返回 i、startIndex 不前进 → 原地打转，实测 5ms 内 yield 超 10 万次；当前经工具入口够不到，但 `replace()` 是 exported）。[why](docs/notes/implemented/bug-fix/2026-08-19-block-anchor-quadratic.md)

- **会话级内存缓存零回收**（`session/prompt-caches.ts`、`file/time.ts`）：三处按 sessionID 累积的进程内 Map 没有任何删除点——`settlePromptCaches` 只删 msgPin/modelMsgs 且只在 compact 边界触发，`system`（skills+env+instructions 全文，再按 modelKey 分桶）、`tools`（全部工具的 description+inputSchema）、`FileTime.state`（每会话「读过的文件 → mtime」全表）全无删除路径，全仓也没有任何 `Session.Event.Deleted` 订阅者做缓存清理。CLI 无影响（进程即会话），长驻的 GUI sidecar 与 `serve` 则按会话数只增不减，子代理放大这件事（每个 subtask 都是独立 sessionID，跑完即冷但缓存留着）。加惰性回收：TTL 为主（1 小时未使用即整会话摘除——此时 provider 侧前缀缓存早已过期，重建不多花钱）、数量为辅（32 会话，只挡突发；上限取得宽松是因为回收活跃会话要付一次全额前缀重建，正是 5670d86 刚花力气避免的那种），当前会话永不被自己这一轮的 touch 顺手回收。回收代价一律 fail-safe：system/tools 重建后只要指令文件没变就逐字节相同、前缀不受影响；FileTime 被回收后下次覆写要求先重读而不是放行旧内容（对一个一小时没动静的会话，这本就是更正确的行为）。[why](docs/notes/implemented/bug-fix/2026-08-19-session-cache-eviction.md)

- **PrefixShape 全局单槽 → 按 sessionID|modelKey 分桶**（`session/prefix-shape.ts`）：诊断状态是全局单槽 `{ sessionID, shape }`，两个毛病跟 5670d86 在前缀探针那边刚修掉的是同一对——不带 modelKey 导致同会话切模型必报假的「prefix cache changed: system」（system 提示词本就按模型分发，`system.ts` 是 15 分支路由），单槽被并发会话/子代理互顶导致 prev 恒取不到、真断裂漏报。改成 Map 按 `sessionID|modelKey` 分桶，`diagnose` 的 modelKey 做成必填而非可选（可选会让将来新增的调用点默默退回单桶行为，必填由 typecheck 逼着表态）。顺带：TTL+数量回收逻辑第三次出现，抽成 `util/session-evictor.ts` 共用。[why](docs/notes/implemented/bug-fix/2026-08-19-prefix-shape-bucketing.md)

- **TUI 侧边栏上下文窗口口径修复 + 显式标注**（`session/session.ts`、`session/processor.ts`、`session/message-v2.ts`、`tui/feature-plugins/sidebar/context.tsx`）：侧边栏那行 `185,925 tokens · 19%` 的分子拿的是 `tokens.total`，而 total 在 processor 里跨 step 累加（260706 为让 cost/缓存命中率对账，对那两个用途是对的），一次 assistant 消息含几次工具往返就累加几次请求的 total——长工具链下上下文占比显示成真实值的十几倍（`percentLabel` 里那句 `p > 200 → ⚠` 就是这问题被看见过但没改口径的痕迹）。与 a94ea6a（压缩分割线「42137k→42374k 越压越多」）是同一个坑的两处，那次只修了 compaction 侧。改法：`getUsage` 把早就算好的 `contextTokens`（= 本次请求提示词总量，峰谷/分档计价在用的同一个数）放进 `tokens.context` 一路透到 assistant 消息，processor 里**覆盖而非累加**；不让消费端拿 `input + cache.read + cache.write` 加回来，因为 `cache.read` 存的是未经上限钳制的原始值（DeepSeek 报 cached_tokens > prompt_tokens），缓存超报时加出来会超过真实提示词量（单测已钉）。schema 用可选字段，message 行是 JSON blob 存的不需迁移，历史消息无此字段时整块不显示、等下一轮请求写入。显示侧补上 `Context window` 标题、`186k / 1M · 19%` 与 24 格进度条（绿 <60%、黄 60–85%、红 ≥85%），与下方 `Session total` 用空行隔开——原先两行都没标签、头顶只有一个 `Context` 标题，会话累计值容易被读成上下文窗口。[why](docs/notes/implemented/bug-fix/2026-08-19-context-window-sidebar.md)

- **transform 用例跟不上孤儿 tool-result 过滤**（`test/provider/transform.test.ts`）：一条长期红着的断言，`result[5]` 恒 undefined。不是实现的问题——transform 里有一道刻意加的「丢弃无前置配对 tool_call 的 tool-result，整条 tool 消息若无剩余则删除」过滤（注释写明是实测「孤儿 result 让会话直接断」后加的），而用例构造的 `role:"tool"` 消息里 call-5/6/7 前面根本没有对应的 tool-call，于是整条被正确丢掉。给 assistant 消息补上配对的 tool-call，追加在末尾以免打乱既有断言下标。

- **SDK 生成产物落后于源 schema**（`sdk/js/src/v2/gen/types.gen.ts`、`provider/provider.ts`）：重跑生成链时一并补回了此前改了 schema 却没重跑的 `timeout_ms` / `fallback_model`（子代理超时兑底）与 `subagent_depth`（上游采摘）。生成产物一更新就暴露出 `provider.ts` 一处被这份落后掩盖着的类型错——`reasoningOptions` 的 schema 是 `Schema.MutableJson`（外部 models.dev 数据刻意不收紧），生成链把它压成 `unknown`，插件 `models()` 的返回值走生成类型、spread 进来赋不回内部的 `MutableJson`；值本身是 JSON 过来的，就地窄回去。

- **CHANGELOG 头部与 0.8.21 整节被复制两份**（`CHANGELOG.md`）：69cfd14 的版本 bump 把文件头（`# 更新日志` 以下的说明段）与 0.8.21 整节又插了一遍，且插入点落在「上游采摘」条目正文中间，把该条目劈成两半——后半截（`$...$` 行内公式那句）被错接到第二份副本的「回退压缩代理」条目尾部，顶掉了它的 `[why]` 链接。以 bump 前的文件为基准重建：重复块删除、劈开的条目按断口还原（缺失的 `` $` `` 依后文"保留块级 `$...$`"补齐）、`[why]` 链接归位。重建后与 bump 前逐行对比，差异仅剩本次 bump 的三处意图改动。

#### 改进

- **前缀断裂探针转正**（`session/prefix-probe.ts`）：`prompt.ts` runLoop 里那 64 行诊断代码，注释第一行写着「260804 Red debug probe v4 — 诊断完成后整块删除」，半个月没删还在长功能（5670d86 同日刚给它补了 modelKey），同时带着四个问题：没有开关、指纹表无界（`globalThis.__prefixProbe` 永不回收，加 modelKey 后条目数从「会话数」涨成「会话数 × 模型数」）、`appendFileSync` 同步写盘压在 prompt 构造主路径上、日志无上限无轮转（实测已 1.4 MB）。不删而是转正——`5670d86` 修 prune-skip 时「39 次跳水吃掉 4528k token」那个数就是从它的日志拿的。抽成独立模块并补齐：开关 `REDCODE_DISABLE_PREFIX_PROBE`（默认开，做成按访问时求值的 getter，否则运行期设的环境变量不生效）、指纹表接回收、写盘改异步并串成一条链（`appendFile` 之间不保证顺序而日志靠行序读）、日志 8 MB 上限轮转一代。日志路径可覆盖是必需的——默认路径那份是正在用的排查数据，用例的 reset 会删掉它。`prompt.ts` 2251 → 2202 行（runLoop 本身仍是 850 行单函数，结构性问题未解决）。[why](docs/notes/implemented/refactor/2026-08-19-prefix-probe-graduation.md)

- **175 个已跟踪源码文件格式化到仓库已配置的 prettier**：配了 prettier 3.9.6 却没有任何格式门禁（pre-push 只跑 typecheck，`script/format.ts` 又因 `generate.ts` 的死路径基本没人跑），漂移积到 175/2035（8.6%），其中 92 个在 `packages/opencode`、36 个在 `packages/app`，包括 `edit.ts`、`prompt.ts` 两个最热的文件。范围限定在 `git ls-files` 命中的源码，自动排除掉 `.claude/worktrees` 下那份被 ignore 的陈旧副本（直接 `prettier .` 会扫进去误报几百个），不碰 md/json（CHANGELOG 与 notes 是手工排版的）。纯机械改动、单条 commit 隔离，会给 blame 带来一次性噪音。

### [0.8.21] - 2026-08-19

> 压缩全灭优化二次修正：回退压缩代理跳过 head reasoning（随 0.8.20 发布的 a6c2af1 实测为负优化）、tail 预算 30K→50K。
>
> 另：上游 opencode 1.15.10→1.18.18 采摘三批合入（GUI 四包 40 余处用户可见修复）；前缀缓存两处止血——诊断探针按模型分桶、prune 跳过压缩时的缓存结算加“够本”门槛。

#### 新增

- **qwen3.8 本地模型专属提示词**（`session/system.ts`、`prompt/qwen.md`）：ollama 本地 Qwen3.8 27B（Q3_K_M 量化，Modelfile 别名 qwen3.8）新增专属提示词，针对该模型实际约束适配——Q3 量化能力上限（大工程任务降级策略：做能做的部分并明说跳过，不硬撑）、~15 tok/s 慢速（短输出 + 并行批处理工具调用）、32K 上下文（切片读文件 + 及时压缩）；自我认知锚定（训练知识不认识自身版本号，防止否认身份）。路由 `system.ts`：providerID 含 ollama 且 api.id 含 qwen → PROMPT_QWEN，**置于 ollama 通用路由之前**（否则 providerID 先命中短路）；minicpm 等其他 ollama 模型仍走 ollama.md 不受影响。

#### 改进

- **webqa MCP 跨调用保留页面状态**（`webqa-server/index.js`）：browser/page 提升为进程级单例（MCP local 进程按会话隔离，无跨会话共享风险），interact 调用之间 DOM/localStorage/导航不再重置——此前每次调用都 launch 新浏览器回到 about:blank，多步交互被迫挤进单条 steps、每次都要重复 goto；现在可分多次调用逐步推进。新增 `press` action（`keyboard.press`，支持 Enter/Tab/Escape 等键名，补上 `type` 无法可靠模拟的特殊键——实测 `type "\r"` 不触发提交）、`newpage`/`close` 管理生命周期（无页面时操作返回友好错误提示先 goto）。除 eval 外所有步骤结果附带当前 `page.url()`，跨调用一眼定位页面。exit 事件同步 kill chromium 子进程防泄漏。

#### 修复

- **回退"压缩代理跳过 head reasoning"**（`session/compaction.ts`）：摘要轮 head 无 reasoning、恢复轮保留（message-v2.ts 透传）——前缀在第一条 reasoning 处断裂，恢复轮无法命中摘要轮写入的缓存，变 2 次全灭（90K+177K）比 1 次（177K）更贵；head 必须与恢复轮逐字节一致（260817 实测，与 466bb79 同批同日回退，abf78d1）。`MAX_PRESERVE_RECENT_TOKENS` 30K→50K：长会话最近 2 轮常超 30K，装不进 budget 触发 tail fallback（head=全部历史）→ 压缩代理轮请求体爆炸；50K 后最近轮次保留原样，head 只剩老历史（budget 仍受 usable×0.25 上限约束）。[why](docs/notes/rejected/feature/2026-08-17-instruction-change-notice.md)

- **上游 opencode 1.15.10→1.18.18 采摘（三批）**（`ui/**`、`app/**`、`opencode/**`、`web/**`、`desktop/**`）：从上游 4600 余个提交里按落点甄别、逐条验证后落地。**UI 层**：oc-2 亮色主题 `icon-weak-base` 少个 `#` 致非法色值静默回落（默认主题直接受害）；v1 Tooltip 补 openDelay 400/skipDelay 300，扫过工具栏不再瀑布弹提示；ButtonV2 行高 1→20px 修下伸字母被裁；下拉展开态改按下色与悬停区分；ScrollView 改 flex 收缩 + `min-height:0` 不再溢出父容器；对话框改栈式渲染（弹窗套弹窗不再吃掉父层，Esc/遮罩逐层关闭）；文件树最小宽度 200→240（200 恰好裁掉标签条）。**交互**：ScrollView 支持空格/Shift+空格翻页、焦点在按钮时不抢 PageUp/Down、嵌套滚动内层到底交还外层、拇指拖拽按抓取点计算不跳位、pointercancel 兜底防拖拽态卡死；命令注册同 key 改遮蔽制（后注册者卸载后先注册的恢复，快捷键不再某次交互后静默失效）；终端内应用级快捷键改 capture 阶段监听不再被 xterm 吞（顺带补 mod+w 关当前终端）。**修复**：titlebar `mod+1..9` 误用项目数做 gate 致多标签时失效；安装更新缺 `.finally` 致按钮永久转圈；event-reducer 归档分支先解引用后判 found 致 Binary.search 未命中时越界抛错；终端面板收起后渲染器仍挂着吃 CPU；只发附件时产生空 text part；MCP 开关 refetch 用未归一化路径强转 PathKey 致 Windows 下状态不刷新；Windows 从搜索打开文件时文件树不展开父目录；会话顶栏 Portal 挂载点被替换致控件区整块消失；会话列表排序去掉"1 分钟内活动"特殊档改纯时间降序（列表不再自己跳）；分享页消息按创建时间排序；整文件补丁按完整 diff 渲染不再显示成片段；review 面板改 itemsMap 使 diff 更新即刷新；todo dock 跨会话不再串台。**引擎与桌面**：内容过滤中止（如 Anthropic `stop_reason: refusal`）不再静默转 idle，落 ContentFilterError 并发事件；子代理嵌套加深度上限（`subagent_depth`，默认 1）；Electron 主进程补导航策略，markdown 链接不再弹无地址栏裸窗口，一律转系统浏览器；provider 溢出识别表补 8 条模式（request_too_large、z.ai、llama.cpp 配置上限等）并新增限流排除表挡住误判；api-key + 额外 metadata（base_url/region）的 provider 连接对话框不再静默丢字段（对国内自定义端点直接相关）。**中文化**：dialog-usage-exceeded 与 titlebar 两处硬编码英文接入 i18n（三语补 key），zh 词典清掉最后一处"令牌"。删掉 `$...$` 行内公式正则（`$VAR`、`$5 到 $10` 会被 KaTeX 吃成乱码，保留块级 `$...$` 与 `\(...\)`）。

- **前缀缓存诊断探针按模型分桶**（`session/prompt.ts`）：指纹此前只按 sessionID 存，同一会话切换模型时拿模型 A 上一轮的指纹跟模型 B 这一轮比，必然逐条不等 → 报「第 0 条断裂」，而两个模型各自的 provider 前缀缓存其实都没断。实测 08-12~08-19 日志 161 处断裂里 37 处是这么来的误报（23%），既把真断裂淹在噪声里，也没法拿它验收缓存修复的效果。key 补上 modelKey，与 stabilize 的 modelMsgs 缓存同粒度。

- **prune 跳过压缩时的缓存结算加"够本"门槛**（`session/prompt.ts`）：该分支必然伴随 `settlePromptCaches`，msgPin/modelMsgs 一丢，DCP 攒下的全部改写（prune 标记、nudge 锚点、priority tag）同时生效，整条前缀从最早被改写处起重写——代价是当前上下文全量从缓存价打回全价。原判据只看「prune 后是否还超限」，于是释放 3% 也照付 100% 重建，且降幅太小下一轮又撞线 → 再 prune 再 settle，反复全额重建（实测 08-16~08-19 有 39 次短间隔同模型跳水吃掉 4528k 本该命中的 token，约占区间总成本 10%）。改为额外要求释放量 ≥ 当前上下文 15%（`PRUNE_SKIP_MIN_RATIO`）；不达标时不是「什么都不做」（那样 freed 虚报、上下文没真降、下轮照撞），而是走真 summarize，一次性压到位。日志带上 `freedRatio` 便于事后校准阈值。

- **跨盘路径解析统一**（`tool/*.ts`、`tool/read.ts`）：Windows 上无盘符但有根的路径（形如反斜杠开头的 `users\foo`）`isAbsolute` 判 true，若原样放行，`normalizePath` 里的 `path.resolve` 会按 `process.cwd()` 补盘符——仓库与目标不同盘（如仓库在 E:、temp 在 C:）时补错盘。路径解析统一走 `AppFileSystem.resolveFrom`；read 工具只对「缺盘符且非 UNC 的绝对路径」锚定实例目录，UNC 共享路径显式排除。CI runner 的 cwd 恰在 C 盘，一直掩盖着这个岔。

---

### [0.8.20] - 2026-08-18

> DSH 第二批收尾 + 稳定性加固：工具输出 head+tail 双端预览、goal 语义三件套、variants() 分派表拆分、压缩边界全灭代价优化、指令变更通知回退、reasoning 流级 stall 兜底、子代理超时兑底、flash 三锚约束、PromptCaches 会话隔离；Superpowers 方法论落地三个 skill。

#### 改进

- **工具输出截断 head-only → head+tail 双端**（`tool/truncate.ts`、`test/tool/truncation.test.ts`）：`direction` 扩为 `head|tail|both`，默认 `both`——预算按 4:1 切分（head 80% / tail 20%），收集逻辑抽为 `collectPreview` helper（tail 用 `skip` 防与 head 重叠），输出格式 `head → …truncated… → tail → hint`。尾部（错误栈/测试结果/命令收尾）此前被整体裁掉，模型被迫再调一次工具看尾部；压缩摘要侧 0.8.17 已落 4:1（17a7304a），工具输出侧补齐。预览总体积不变（预算只拆分不扩容），显式 `head`/`tail` 调用方语义不变。[why](docs/notes/implemented/feature/2026-08-17-tool-output-head-tail-truncation.md)
- **variants() 巨型 switch 拆分为分派表 + provider 函数**（`provider/transform.ts`、`test/provider/transform.test.ts`）：446 行的 16-case switch 拆为「模型族特判 + npm 分派表 + 15 个 provider 函数 + 形状工厂」。共享形状抽工厂（`adaptiveThinkingVariants`/`openaiShapeVariants`/`fixedThinkingVariants`/`anthropicThinkingVariants`），cerebras/togetherai/xai/deepinfra/venice/openai-compatible 等共享实现的 provider 指向同一函数。行为零变化（`-t variants` 131/131 锚定），加新 provider 只需分派表加一行 + 一个函数，停止「每加模型就塞 if/else」的持续腐烂。[why](docs/notes/implemented/feature/2026-08-17-transform-variants-dispatch.md)
- **goal 语义三件套**（`session/prompt.ts`、`tool/task.md`）：activeGoal 注入段新增 Blocked rules——同一具体阻塞条件持续 ≥3 轮仍无进展才可报告阻塞并说明条件；difficulty/uncertainty/remaining useful work 明文不算 blocked（对冲 V4 长程早停，对齐 DSH goal guidance）。task 派活纪律第 7 条把同规则传给子代理。resume 缴械经调研确认天然覆盖（resume 后用户不发消息无 idle 续跑事件，首条消息即隐式 rearm），无需改动。[why](docs/notes/implemented/feature/2026-08-17-goal-semantics-three-piece.md)
- **压缩边界全灭代价优化**（`session/compaction.ts`、`test/session/compaction.test.ts`）：cache turn=0 全灭轮双来源（260817 实测：①opencode-go 网关 Cloudflare 多节点路由，换官方直连已根治；②内置压缩边界——压缩重写上下文 → settlePromptCaches 丢 msgPin → 压缩后第一轮必然全灭）。每次压缩固定 2 次全灭 ≈22.6 万 token 全价（压缩代理轮 ~177K + 恢复轮 ~49K）。优化：压缩代理请求体跳过 head 的 reasoning part（摘要只要结论不要思考过程，估砍 40-50%）；`MAX_PRESERVE_RECENT_TOKENS` 8K→30K（tail 原样保留最近 1-2 轮，不再 tail fallback 全量进 head）。预期每次压缩全灭代价降至 ~10 万 token（60 单测 + typecheck 通过）。
- **回退指令文件会话中变更通知**（`session/prompt.ts`）：19b2bed3 的每轮读盘对比 + system 尾注入 Updated/Removed 通知实测对缓存命中率造成破坏性损伤（哥哥在家复现确认）——system 任何位置的变化都会让整条前缀（system 之后全部消息）失配，指令文件一旦在会话中变动（模型写 MEMORY.md 等）即全灭且恢复前持续污染。已 revert（5a07e94f），DSH 第二批第 2 项留待重新设计不破前缀的通知方式（如：变化信息塞进 user 侧尾部而非 system）。
- **reasoning 流级 stall 兜底——纯思考死锁不再挂死会话**（`session/processor.ts`、`test/session/processor-effect.test.ts`）：step-3.7-flash 实测会卡死在思考链里——reasoning 无限流、正文/工具从未产出、step-finish 永不到达。`Stream.takeUntil(() => ctx.needsCompaction)` 永不触发，`handle.process` 永不返回，runLoop 卡死，后续用户消息全部 QUEUED，只能 esc interrupt。此前唯一的 reasoningOnly 提升逻辑（prompt.ts）在 runLoop 下一轮检查，前提是 `lastAssistant.finish` 存在——卡死时 finish 根本不存在，走不到。修复：processor 流内检测——单 step 累积超过 3 万字符 reasoning（约 8 倍于正常思考量）且无任何 text/tool 产出，判定卡死：剥离注入指令复述（防 DCP reminder 泄露跟着进正文）→ 思考拼接提升为可见正文（用户看得到东西而不是对着一片空白等死）→ 收尾 reasoning part → 置 finish="stop" 并落库（runLoop 下一轮 break 条件依赖它，只改内存对象会死循环重发）→ 停流，process 返回 "stop" 走正常收尾路径。单测：30001 字符纯 reasoning 流断言返回 "stop"、思考被提升为正文、finish 落库。
- **子代理超时兑底——task 超时自动换 fallback 模型重跑**（`config/agent.ts`、`agent/agent.ts`、`tool/task.ts`）：opencode-go 五小时限额掐掉 mimo 请求时 explore 子代理永久挂起（streamText 无 timeout、maxRetries 显式 0）。AgentSchema 加 `timeout_ms` + `fallback_model`；runTask 包 `Effect.timeoutOption`——主模型超时 → cancel 当前会话 → fallback 模型重跑同一任务，无 fallback 时报错。explore 配 300s + step 兜底（走阶跃官方额度，不受 go 套餐影响）。同一 session 重跑干净：go 限额场景请求发不出，session 无脏消息。
- **PromptCaches 并发 session 隔离**（`session/prompt-caches.ts`、`session/prompt.ts`）：msgPin/tools 按 session 隔离，system/modelMsgs 按 session + modelKey 隔离——多会话并发不再互相污染缓存键；压缩边界丢 msgPin（cache turn=0 全灭轮双来源之一）的根因随之关闭。
- **flash 系列三锚约束 + step 收敛锚**（`session/prompt.ts` + RedCode-dcp）：flash 系列加深度思考/回顾/反跑题三锚（对照实验 reasoning +42%、决策闭环锚有直接证据）；三锚条件 `model.id.includes("flash")` 误伤 step-3.7-flash——step 思考行为与 deepseek 相反（纯思考轮 0.6%、同工具重发 3-8 次空转，CHANGELOG 0.8.2/0.8.9 实证），Think deeply 是反效果。条件排除 step 模型，step 加反向收敛锚：思考以行动决策收尾、不重发相同工具+相同输入、稳定节奏优先于单次超常发挥。
- **seed skill 同步 Superpowers 方法论**（`seed/skill/`）：diagnose 加修复失败升级路径（第 1 次回 Phase 3 重列假设 / 连续 2 次停手问用户 / 连续 3 次质疑架构——每次修复暴露新耦合=模式错了）；ce-code-review 加修复循环纪律（scoped 复审只看 fix diff、轮次上限 3、controller 不亲自修、修复报告必须带测试+命令+输出）；tdd-flow（仅私仓 live）加计划质量门禁（占位符/模糊引用/不可独立验证/接口无签名 = 计划失败）+ watch-it-fail 强制 + todo 台账纪律。
- **compaction 分割线 token 对比口径修复**（`session/compaction.ts`）：tokens_before/after 原用 sumTokens 累计「所有 assistant 消息的 token 消耗」（每轮 input 都等于当时完整上下文，长会话累计值远超真实上下文；且压缩后旧消息仅折叠不删除，after = before + 压缩代理轮消耗）→ UI 显示「Compaction 42137k → 42374k」越压越多。改为 estimate() 对 filterCompacted 折叠后的可见消息估算——before = 压缩前可见上下文，after = 压缩后可见上下文（summary + tail），与 select 的 head/tail 预算同一口径。

---

### [0.8.19] - 2026-08-16

> DeepSeek 峰谷定价通用机制落地；reasoning_content 与提示词规则对齐；GUI 归档图标与 assistant 回复消失两个渲染修复。

#### 新增

- **通用峰谷定价机制**（`provider/tiered-pricing.ts`、`session/session.ts`、`session/processor.ts`）：DeepSeek 2026-08-17 起执行峰谷定价（高峰 9-12/14-18 北京时间为空闲价的 2 倍），落地为旁路表 `TieredPricingSegment`（effectiveFrom + peak/offpeak + peakWindows + 时区偏移）；`Session.getUsage` 加 time 入参按请求时刻查价（tiered 优先于静态 `model.cost`），processor step-finish 传 `Date.now()` 记账定格——历史费用不随价段切换跳变，旧价段保留供历史会话查价。DeepSeek v4 同时按高峰价静态覆盖（UI 展示兜底）。

#### 修复

- **reasoning_content 仅 tool-call turn 回传**（`provider/transform.ts`）：对齐官方 thinking_mode 规则，避免思考内容在非工具调用轮被重复回传。（260822 更正：原文写的文件路径 `session/processor.ts` 是错的，该文件全域无 reasoning_content；实现一直在 `provider/transform.ts`。另：此规则已于 260822 翻转，见该版本条目。）
- **deepseek.md 提示词去双立法 + 补库幻觉抑制**（`session/system.ts`、`prompt/deepseek.md`）：对照三方证据（Claude Code opus5 / Codex 5.3 / 官方 harness）确认"没人教思考、全是行为契约"，删除 3 处与全局 AGENTS+铁律重复的条目，补回 default.md 被误砍的库幻觉抑制条。加载链 `system.ts:43`（model.api.id 含 deepseek → PROMPT_DEEPSEEK）。
- **归档按钮图标 fallback 成"+"，与新建会话按钮撞脸**（`ui/v2/components/icon.tsx`）：IconV2 图标字典缺 `archive`，`Icon` 对未知名静默回退 `plus`——首页工具栏"归档会话"按钮渲染成与旁边"新建会话"一模一样的"+"，看起来像两个重复按钮。补 `archive` 图标（复用 v1 同名 SVG 路径），并全量比对 app 内 IconV2 用法确认无其他未知名。
- **切换会话后 assistant 回复"凭空消失"——只剩连续 user 消息**（`pages/session/message-timeline.data.ts`、`message-timeline.tsx`）：切换/返回会话瞬间，`message.updated` 骨架事件先到但可渲染 parts 未到（流式生成中或 `session_status` 未同步），`sync()` 判定 cached=true 跳过 fetch 不补齐，原逻辑该条 assistant 一行都不渲染（user 行不依赖 parts 照常显示）——表现为图里只有连续 user 消息、AI 回复全无，过一会儿事件流/loadMore 补齐才恢复正常。修复：渲染层兜底，assistant 骨架在、parts 空、非 busy、无 error 时推 `AssistantPending` 占位行（头像 + "加载中…"），busy 时 Thinking 行照旧不重复；新增 5 个单测覆盖 Pending/Thinking/Part/Error/空边界（mock `@redcode-ai/ui/message-part` 纯函数规避 tsx→solid-js 测试环境问题）。

---

### [0.8.18] - 2026-08-15

#### 修复

- **MessageID 48 位回绕死循环 + 全仓 ID 比较改 time.created + ID 扩容 64 位**（`id/id.ts`、`session/message-v2.ts`、`session/prompt.ts`、`session/session.ts`、`session/revert.ts`、TUI 会话路由与 sync、app 端 8 文件、`core/util/binary.ts`、app/core 两份 ID 实现）：ID 编码 `Date.now()×4096` 压进 6 字节（48 位），回绕周期 2³⁶ ms ≈ 795 天；2026-08-14 19:19:55.136 第 26 次回绕后新 ID 字典序反小于旧 ID，`latest()` 永远选中回绕前旧消息、runLoop 退出条件 `lastUser.id < lastAssistant.id` 恒 false——实测一个 GUI 会话空转 219 步、50 分钟烧 $1.3 直到手动中断。修复：比较先后一律走 `time.created`（新增 `compareTime`/`cmpTime`，同毫秒用 ID tie-break），open code 9 处、TUI 7 处、app 18 处全部替换，消息数组二分改 `Binary.searchBy` comparator；ID 编码扩到 8 字节（64 位，2⁵² ms ≈ 14 万年不回绕），`timestamp()` 解码兼容新旧长度。无数据迁移，旧会话自动恢复。[why](docs/notes/implemented/bug-fix/2026-08-15-messageid-wraparound-fix.md)

- **新建会话页透出壁纸——毛玻璃 B 漏了 session-new-design 容器**（`components/session/session-new-design-view.tsx`、`index.css`）：`d1fc62b` 只清了 `#session-root`/`#session-chat-panel` 两个外壳容器，新建会话页（无会话 id）的内容容器 NewSessionDesignView 根自带 `bg-v2-background-bg-deep` 实色底把壁纸挡死——表现为标题栏/文件树都透出壁纸、中间会话区独独黑一块。补 `[data-app-frost] [data-component="session-new-design"]{background-color:transparent}`（与文件树同款配方），无壁纸时实色底照常生效。

---

### [0.8.17] - 2026-08-14

> DSH 采纳第一批落地：重复调用递进提醒软层、工具级 cooperative 超时、繁忙时插话/排队可选（stall nudge 随之退役）、压缩摘要截断保尾；决策记录制度（`docs/notes/`）与采纳路线图（`docs/dsh-adoption-plan.md`）建制。

#### 新增

- **重复调用递进提醒软层**（`session/repeat-tool-reminder.ts`、`session/processor.ts`）：同工具+同参连续调用 3/5/8 次递进把 `[System notice]` 提醒贴进该次 tool output 尾部（3 轻提醒，5/8 详细版带参数预览 500 字符头截断）；`todowrite`/`todoread` 对链透明防洗计数，错误调用也计数，running 分片跳过防并行双计。与 doom_loop 硬层互补：轮询类只触软层，真空转硬层弹权限窗兜底。注入不伪装 user 角色、append-only 不破前缀缓存。[why](docs/notes/implemented/feature/2026-08-14-repeat-tool-reminder-soft-layer.md)
- **工具级 cooperative 超时**（`tool/tool.ts`、`tool/repo_clone.ts`）：工具定义可自声明 `timeoutMs`（策略元数据，不进模型 schema），wrap 执行层统一拦截，超时产出结构化 `TimeoutError` 供模型自纠——整轮不再被一个挂死的工具吊死；协作式不硬杀。首个声明方 `repo_clone`（5 分钟），websearch/webfetch 已有超时不动。
- **繁忙时消息送达策略可选**（`config.ts` 新增顶层 `busy_enter`、`session/prompt.ts`）：`steer`（默认，原行为）＝中途消息下个 step 注入进行中轮次，可在途纠偏；`queue`＝对本轮隐藏、轮末自动作为新轮输入——真排队自此存在。[why](docs/notes/implemented/feature/2026-08-14-busy-enter-steer-or-queue.md)

#### 变更

- **stall nudge 退役**（`session/prompt.ts`）：与软层同指纹口径三层并存必双响，收敛为软层劝+硬层拦两层。[why](docs/notes/implemented/simplification/2026-08-14-stall-nudge-retired.md)
- **压缩摘要的工具输出截断 head-only → head+tail 4:1**（`session/message-v2.ts`）：2000 上限改 1600+400，长输出尾部的错误栈/退出码/结论对摘要器可见；主请求路径不传参、行为不变。
- **deepseek.md 提示词一进一出**：新增"API 行为去查不凭记忆"（V4-Pro-0813 独立评测知识推理仍差一档）；删除"result not worth re-fetching"条——重复调用防护已由机制接管，不再占每请求固定前缀。

#### 文档与制度

- **决策记录制度落地**（`docs/notes/`，引自 DSH `.agents/notes/` 四态实践）：非平凡改动同 commit 附 note，写/查/链三向规则入 AGENTS.md；notes 记 why、CHANGELOG 记 what、agent memory 记协作层。
- **DSH 采纳路线图**（`docs/dsh-adoption-plan.md`）：权威底本，已落地/二三批/记账区分层，保留特色明确不搬清单（毛玻璃/中文/多模型/Effect）。
- **测试纪律入规**（AGENTS.md）：证据面匹配、永不默认全量（260810 事故制度化）；带包脚本超时 `--timeout 30000`（260808 在案 260814 复踩后补）。
- **升版流程适配单一版本线**：`bump-version` skill 重写（不问 scope、15 包同号、合并线区域插条目、体检必跑）。

---

### [0.8.16] - 2026-08-14（版本线合并）

> 维护方式调整：TUI 与 GUI 不再分线，全仓统一单一版本号。GUI 从 0.7.20 跳版对齐 0.8.16（纯版本号变更，无功能改动）；内部包（`@redcode-ai/*`、sdk、vscode 扩展）的 fork 遗留版本号 1.15.x 一并对齐，该字段仅作标签（互引均为 `workspace:*`），Sentry release 与 GUI 自报版本自此跟随真实版本。README 徽章合并为单一"版本"徽章，`check-version-consistency.ts` 改为单线校验。

---

---

## TUI
### [0.8.16] - 2026-08-11

> 审计收尾日：msgPin 与 prune 停战（compact 边界分代结算，缓存优先）；HttpApi 假门禁转正并当场修掉门禁自己的冷启动竞速缺陷；两个静默失效的依赖补丁分道处置；apply_patch 补写前守卫；edit 锁表止漏；read 跨盘路径岔修复。

#### 修复

- **msgPin 与 prune 停战——compact 边界分代结算**（`session/prompt.ts`、新增 `session/prompt-caches.ts`）：overflow 三档的 prune(0.8) 给陈旧工具输出打 compacted 标记，而 msgPin 每轮用首次快照把旧消息钉回去——标记永远到不了模型可见的 prompt，三档实际只剩两档，每次都掉进最贵的全量摘要；"prune 释放够了就跳过 summarize"吃的还是虚报释放量。缓存优先落分代结算：平时 prune 只记账（标记入库、prompt 仍钉死快照、日志改口 `context.prune.marked` 不再谎报），compact 边界（缓存反正要重建）`settlePromptCaches` 丢弃 msgPin/modelMsgs——prune 标记与 DCP 累积改写一并生效、快照双份内存同步释放；跳过 summarize 的判断从此诚实。配套开启 `compaction.prune`（此前开关未开 = prune 档"配置关 + 被钉"双重空转）。
- **HttpApi 门禁转正 + 探测冷启动竞速**（`.github/workflows/test.yml`、`test/server/httpapi-exercise/`）：门禁 `if: runner.os == 'Linux'` 但 matrix 只剩 Windows，三条 `--fail-on-missing` 从未执行。转正时 coverage 报出 2 条无场景路由（`DELETE /project/{projectID}`、`POST /session/tts`）补齐；auth 模式首跑即暴露存量缺陷——/event 与 /pty/connect 无凭据探测稳定 500，定位为探测 1s 竞速对"裸路由链冷首请求"太紧（instanceRouterLayer 惰性构建超 1s 被 abort 打成空 500，其余 148 条都走已暖链），放宽 10s；runner 断言失败附响应体。本地三模式 150 场景全绿。
- **apply_patch 补"写前已读"守卫**（`tool/apply_patch.ts`）：gpt 系模型的写路径此前裸奔。断言全放校验阶段——任一文件过期整个 patch 一字不落盘（all-or-nothing）；update/delete/add-撞已有文件三径全覆盖，写后统一刷新 FileTime。
- **edit 文件锁表引用计数**（`tool/edit.ts`）：原 locks Map 只增不减，长驻 server 每编辑一个新文件永久泄漏一个 Semaphore。改 acquireUseRelease + 引用计数，最后使用者释放时删条目（不能"用完即删"——第二等待者仍挂旧信号量时第三者新建会失去互斥）；`fileLockCount()` 供测试断言回收归零。
- **read 修 Windows 盘符缺失路径跨盘岔**（`tool/read.ts`）：`/users/foo` 这类"根相对"路径 `isAbsolute` 判 true 跳过实例目录锚定，被按进程 cwd 的盘解析——仓库在 E 盘必 File not found，CI runner 的 C 盘 cwd 掩盖多年（read.test 的 Windows 归一化用例因此常年本地红）。现锚定实例目录所在盘，UNC 不受影响。
- **两个静默失效的依赖补丁分道处置**（`patches/`）：patchedDependencies 声明的 `solid-js@1.9.10`/`@npmcli/agent@4.0.0` 与实装 1.9.14/4.0.2 对不上，bun 静默不应用。solid-js 退役（实证 1.9.13+ 上游已逐字合入 #2046 transition 修复）；@npmcli/agent 对 4.0.2 重制（上游仍未修 `get proxy()` 返回 URL 对象，该包经 make-fetch-happen 服务 npm 拉取链路，代理环境刚需）。

#### 变更

- **chrome-devtools MCP 路径拆到本地层**（`seed/redcode.home.jsonc`）：命令是 npm 全局安装的绝对路径（含用户名/盘符），换机必 ENOENT——与 DCP 插件路径同类"因机而异"值，下沉 `redcode.local.jsonc`；同批的 github MCP 是远程 URL 机器无关，留在模板。

---

### [0.8.15] - 2026-08-10

> 全仓审计红级五连修：DCP 插件其实从未被加载（修复 + resolver 防复发）、write/edit 补"写前已读"守卫、hook 触发路径补超时隔离、env 工具关掉密钥外泄闭环 + 工具表按 agent 权限过滤、"始终允许"落库不再重启全忘。

#### 修复

- **DCP 插件 server 端从未被宿主加载**（`plugin/shared.ts`、`plugin/loader.ts` + DCP 仓 31f7361/f3a0469）：DCP `exports["./server"]` 指向从未构建的 `dist/index.js`，resolver 命中 exports 即返回不验文件存在，import 必败、整个插件放弃——`./tui` 指向真实源文件所以 `/dcp` 面板照常在，掩盖了压缩 hook 全灭（8/9 的 5 项改造从未生效，日志实锤 `failed to load plugin`）。三层修：① resolver 认 `"bun"` 条件导出（Bun 宿主直载 .ts 源码，桌面 sidecar 是 Electron/Node 24 走 `import` 指向的构建产物——类型擦除不解析无扩展名相对导入，只能吃 dist）；② exports/main 声明的入口逐个验存在性，全缺失降级到目录 index，坏声明不再炸整个插件；③ DCP 侧压缩通知默认改 toast，根治通知以 user 角色伪装进会话（260729 sourceFrom 退化的病根）。修后实测新日志 failed to load plugin 归零。
- **write/edit 无"写前已读"守卫**（新增 `file/time.ts`，接入 read/write/edit）：此前不校验文件是否被本会话 read 过、也不比对改动时间——IDE 手改、git 操作、并行 subagent 落盘的内容会被 agent 拿旧文整个推平（上游 FileTime.assert 未随 fork 带过来，hashline 路径反而有 hash 校验，说明只是主路径漏了）。read 记录 (会话, 路径)→mtime，写前断言"读过且 mtime 未变"，写后用自产 mtime 刷新；比对口径用 mtime 而非上游的读取墙钟——外部拷贝的"未来 mtime"文件不误报，还能抓到 mtime 倒退的原样恢复。hashline 已有 TAG 内容哈希（更强）不重复断言。守卫用例 ×6。
- **hook 触发路径无超时无隔离**（`plugin/index.ts`）：`Plugin.trigger` 逐 hook 裸 `Effect.promise`——插件 hook 抛异常=defect 整轮报废，await 卡住=agent 永久挂起（`tool.use.pre` 挂在每次工具调用前）；同文件加载路径早有超时+tryPromise 防御，唯独触发路径漏了。补 30s 超时 + fail-open 记日志（safe-shell 等否决语义走 output.denied 不靠 throw，不受影响）；bus 事件分发的 floating promise 同步补 catch；hookOwner WeakMap 旁挂归属，失败日志能报出是哪个插件。
- **env 工具无权限门 + 工具表不按 agent 权限过滤**（`tool/env.ts`、`tool/registry.ts`）：env 是全仓唯一无 ctx.ask 的取值通道，`vars` 直接回显 ANTHROPIC_API_KEY 等密钥进上下文，配合 fetch 一次提示词注入即可完成外泄闭环；且 registry.tools() 拿 agent 只用于生成描述，`permission.env="deny"`（含 `tools:{x:false}` 转译）对不调 ask 的工具完全失效，被禁工具照样进模型工具表白白诱导调用（plan agent 的 edit/write）。env 顶部单闸门罩住 vars/category 两分支（pattern=变量名）；registry 用 core 现成的 `Permission.disabled` 剔除无条件全 deny 的工具，带 pattern 例外的（bash 全禁放行 `git *`）保留给执行期逐次把关。
- **权限"始终允许"从不落库**（`permission/index.ts`）：有表、有读、有加载，唯独没有写入方（全仓唯一写入是一次性 json 迁移）——每次重启所有 always 重问一遍，且无从分辨是 bug 还是设计。reply=always 时按 (permission, pattern) 去重后 upsert PermissionTable。

---

### [0.8.14] - 2026-08-09

> 两个屏幕污染类修复：MCP 并发调用时 Bun 的 MaxListenersExceededWarning 把 stream 对象 dump 进 stderr；模型在正文末尾粘孤儿 XML 工具调用结束标签。

#### 修复

- **MCP 并发调用污染 TUI 屏幕**（`mcp/index.ts`、`cli/cmd/tui/worker.ts`）：子代理并行调 MCP 工具时，SDK `send()` 在 stdin backpressure（write 返回 false）下挂 `once('drain')`，listener 堆积超上限后 Bun 触发 `MaxListenersExceededWarning`——Bun 的警告输出会把 emitter 整个 WriteStream 对象 inspect dump 成几十行属性打到 stderr，经 Worker stderr 继承落到终端，与 TUI 渲染 buffer 交错（消息区出现 `_eventsCount: NaN`、`open: [Function: open]` 等对象属性、侧边栏文字错位）。双层修复：① 治本——`connectTransport` 连接成功后对 stdio transport 的 stdin 设 `setMaxListeners(0)` 解除上限（重连也覆盖，`_process` 在 `start()` 后才存在故挂 connect 后）；② 兜底——worker 进程监听 `warning` 事件，`MaxListenersExceededWarning` 只记日志不打屏。复现脚本实测：无修复必现警告 dump，有修复零输出。
- **孤儿 XML 工具调用结束标签泄漏**（`session/xml-tool-call.ts`、`session/processor.ts`）：deepseek-v4-flash 实测在正文末尾粘 `</parameter></invoke></tool_calls>`（Qwen/Hermes 形态结束标签残留，无开头无内容），旧快路径只认 `<function=`/`<args>` 所以原样泄漏给用户。新增第三种形态识别：三连标签齐全 + 前面至少两个换行 + 必须贴消息尾部才摘除（防正文讨论 XML 误伤）；`salvageToolCalls` 改为无条件应用 stripped（calls 为空但剥离有变化时也生效）。新增 2 条测试，19/19 全绿。

### [0.8.13] - 2026-08-07

> 两条主线：AI SDK v6→v7 整族迁移（21 个包，从调研到合并当天闭环，含记账三档实测比对）；以及一批"只有换个环境才炸"的暗雷——空转检测从未生效、$REDCODE_ROOT 把家目录认成安装根、1M 窗口下分级压缩全部失效、弹窗遮罩吃掉中文。

#### 重大

- **AI SDK v6 → v7 整族迁移**（`ai` 6.0.208 → 7.0.50 + `@ai-sdk/*` 全族 21 包，版本按 bunfig `minimumReleaseAge` 供应链门槛选发布满 3 天的）。61 个导入点全数处理：copilot 工具工厂改名、类型放宽 V4|V3 联合（vendored copilot 不必重写）、`ToolExecutionOptions` 补必填 `context`、telemetry 摘除 `tracer`/`metadata`（OTel 拆去 `@ai-sdk/otel`，span 输出待接）、流分片补 `reasoning-file`/`tool-approval-response`/`custom`。**记账实测无偏移**：`usage()` 映射器因历史上的双形态防御式写法（v7 details → v6 顶层 → DeepSeek raw 三级兜底）零改动通过；真实 DeepSeek 会话对照 dev 基线，cache read/write/cost 三档全部在流。测试面 94/2 与 dev 基线持平，还顺带修好了 dev 上挂着的 bedrock pdf 用例。`patches/@ai-sdk%2Fxai@3.0.82.patch` 清债删除（4.x 已原生支持 PDF input_file）。
- **vision 附件路径两处 v7 适配**（`session/message-v2.ts`，测试炸出的真雷，不修则运行时静默失败）：工具结果附件分片 `"media"` → `"file-data"`（v7 并入 file 族，旧形态直接被拒收）；bedrock 搬移路径撤销 `stripDataUrlPrefix`——v6 时代剥 `data:` 前缀防 SDK 双重包裹，v7 语义反转为走真 `new URL()` 解析，裸 base64 抛 `ERR_INVALID_URL`，改为 data: URL 原样保留、裸 base64 补包。

#### 修复

- **空转检测从未生效过**（`session/processor.ts`、`message-v2.ts`）：step-3.7-flash 实测把同一工具调用逐步重发 3–8 次刷屏。旧判据取样只看当前助手消息内部分片，而这类重复每步各是一条独立消息、单条内永远凑不满阈值——**全库 15.6 万个工具分片回放，旧判据历史触发 0 次**。改为会话级跨消息取样，并放宽"必须有报错"为"有报错或同工具+同输入+同输出"（输出相同防轮询误伤）。回放新判据 31 次、占比 0.02%，两个问题会话分别命中 1/7 次。
- **`$REDCODE_ROOT` 把用户家目录认成安装根**（`mcp/index.ts`，260805 引入的回归）：`.redcode/` 是引擎给每个项目自动建的目录、家目录也有一份，exe 路径向上经过家目录即被误判 → 六个相对路径 MCP 全部 ENOENT。撤销 `.redcode` 分支判定，标记只认安装根独有物，另加家目录一票否决。附带纠正：此前"源码 bun 跑时 MCP 连不上是 execPath 固有限制"的判断是错的，就是本 bug。
- **1M 窗口模型的分级压缩便宜档全部失效**（`session/overflow.ts`）：分级比例乘在 usable 上，但硬顶 threshold=400k 先到——deepseek/mimo 的 soft(570k)/prune(760k) 永远在硬顶之后，每次压缩都直接全量摘要重写（打掉前缀缓存+多付一次调用）。比例改乘 `min(threshold, usable)`：deepseek 变 240k/320k/400k，step（硬顶够不着）一个数不变。
- **弹窗遮罩吃掉背景中文**（`tui/ui/dialog.tsx`、`routes/session/index.tsx`）：半透明黑遮罩（alpha 150/70）经 opentui 原生层合成时，双宽字符续格被当空白覆盖，CJK 整段消失而 ASCII 仅变暗。遮罩改全透明，用户实测确认修复；代价是弹窗背后不再变暗。
- **postinstall 删 junction 在 Windows 上 EFAULT**（`script/fix-keymap-junction.ts`）：`rmSync` 删目录型 junction 走不通，后果是任何 `bun install/update` 整体失败回滚、升级看似"没生效"。改 unlink 失败退 rmdir，只摘链接不碰目标。后续又补两刀：目标实例 hash 改运行时探测（solid-js 升级即换 hash，钉死必崩 TUI）；悬空 junction 下 `existsSync` 顺链接说谎导致 EEXIST，改 lstat 判链接本身。
- **DCP compress 铁律注入**（step 模型专用，`session/prompt.ts`）：step 常无视 soft nudge 不调 compress，直接铁律约束。（小宋 0a9d51a）
- **typegraph-mcp 兼容 TS7**（`plugins/typegraph-mcp/tsserver-client.ts`，commit 0aad824）：根 TypeScript 升 7.0.2（tsgo Go 原生版）后彻底移除 tsserver，typegraph-mcp 按设计从目标项目根解析 `typescript/lib/tsserver.js` 命中 TS7 报 `ERR_PACKAGE_PATH_NOT_EXPORTED`、server 启动即崩（侧边栏 -32000 断连）。改为 try/catch 回退：先试目标项目 TS（保留原设计意图），解析失败回退 MCP server 自带 typescript@5.9.3。官方 MCP SDK 实测：tsserver ready、ts_definition/ts_type_info/ts_module_exports 三工具在线。

#### 变更

- **deepseek-v4-flash 下发 `top_p=0.95`**（`provider/transform.ts`）：对齐官方 V4-Flash-0731 公告的基准采样配置；温度不写（服务端默认即 1.0）。此前 deepseek/step 在分派表一条不中，两参数整个不出现在请求里。
- **`prompt/deepseek.md` 按一线水平重校**：新增 Output channels（推演留思考通道、可见回复只放结论——治思维链漏正文，该通道 08-05/06 漏正文率 9.5%→33%、同期 step/mimo 为 0%）与 Corrections 两节；补篇幅纪律（长度跟问题不跟工作量、show don't tell、不写兜底收尾）、代码风格随文、结果不重取；全文统一为"粗体判据+一句展开"要点体例——依据用户实测：v4Flash-0731 规则遵守变强，提示词越结构化表现越好。
- **低风险依赖批量升级**：prettier/turbo/oxlint/glob/sst、DCP 3.1.14、MCP SDK 1.30、solid-js/hono/@tsconfig/bun/opentui-spinner（catalog）、app 侧 solid 全家。注意 `bun update --latest` 在本仓不可用——会把 `catalog:` 间接引用替换成硬版本并把 workspace 依赖提升到根。
- **openrouter 移入 disabled_providers**：已不使用；不删仓库代码（上游维护中，删了每次同步都要处理冲突）。
- 落地 `docs/ai-sdk-v7-migration.md` 迁移调研全文（影响面、61 点分类、验证矩阵）。
- **`redcode` 终端入口改跑编译产物，checkout 路径改探测**（`~/.redcode/bin/redcode.cmd`，私仓 `d8de0fd`）：此前 shim 跑的是 `bun run ./src/index.ts`，两个后果——① 源码树有并发会话在改，别人半成品的编辑会直接让日常入口起不来 ② 纯启动 3.3s。改跑 `dist/redcode-windows-x64/bin/redcode.exe` 后 **0.75s**。同批修掉一个伪装成"命令不存在"的 bug：shim 无条件把 cwd 塞成第一个位置参数，于是在任何 git 仓库里 `redcode doctor` 实际是 `index.ts <cwd> doctor`，默认命令 `[project]` 吃掉第一个位置参数、`doctor` 沦为多余的第二个 → yargs **打印帮助并 exit 0**，看起来像"这命令不存在"或"版本太旧"（我第一次就误判成后者）。现改为首参是裸词（子命令或显式路径）就不注入，无参或纯旗标才注入。checkout 路径解析三级：`REDCODE_HOME`（**独占**，其内没编译就跑其源码，绝不回落到别的 checkout 的 exe——那等于悄悄换代码库）→ 探测已知位置 → 都没有则回退源码并在 stderr 明说。另外不再 `cd` 到 `packages/opencode`，保住调用方 cwd，`doctor` 因此能正确认出 project memory。
- **webqa MCP server 落地**（`webqa-server/`，替代 browsermcp）：Playwright headless 视觉验证闭环成型——`webqa_screenshot`（URL/尺寸/fullPage/wait 参数截图，落 `%TEMP%\webqa`）、`webqa_interact`（JSON 动作序列：goto/click/fill/type/screenshot/resize/wait/eval）。审图链路由多模态子代理（mimo-v2.5）read 图片完成，vision MCP 保留作离线兜底。browsermcp（需浏览器扩展+手动 Connect，从未启用）配置移除。playwright 钉 1.60.0 复用既有 ms-playwright 缓存（chromium-1223，零下载）；换机器需 `npm install`（webqa-server/ 内）+ `npx playwright install chromium` 一次。
- **edit 工具 Unicode 归一化模糊匹配**（`tool/edit.ts`，commit 3040fc6，learn from Pi）：replacer 链新增 `UnicodeNormalizedReplacer`（Simple 之后）——NFKC + 智能引号→ASCII + Unicode 破折号→`-` + 特殊空格→空格，逐字符等长归一化、匹配命中后替换原文子串（匹配区外字符不被洗白）。治中文全角字符/智能引号/NBSP 等不可见差异导致的 edit 反复重试、乃至降级 write 整文件重写的路径；纯 ASCII 文件短路零开销。
- **guardrail 行为指令层退役**（`~/.redcode/plugin/`，私仓）：loop-guard 连续改动计数闸门删除——该门禁为旧模型「不守指令闷头干出破坏」而设，现模型执行力 + redmind 关键权限弹窗兜底已足够。irreversible / block-no-verify / encoding-guard / config+secret 路径四个安全阀**原样保留**；`ECC_PROFILE` 环境注入与 guardrail-profiles skill 移除（doom_loop 服务端检测继续兜底）。AGENTS.md / MANUAL.md / HOOKS.md 同步清理。

#### 待办

- **Playwright 前端视觉验证闭环已落地**（260807，见上方变更区 webqa MCP）：`webqa_screenshot`/`webqa_interact` 工具 + 多模态子代理审图（mimo-v2.5）链路成型，260807 实测交互前后像素级对比通过。剩余：登录态/移动端多尺寸实测、`browsermcp-server/` 目录清理（确认后删）。
- **另一台机器的 `redcode.cmd` 仍是旧版（回家处理）**：上面那条 shim 修复只落在公司这台的 `~/.bun/bin/redcode.cmd`。家里那台同样有"git 仓库内所有子命令被位置参数吞掉"的问题，也同样写死了 checkout 路径。修复版已随私仓同步到 `~/.redcode/bin/redcode.cmd`，拉下来覆盖 `~/.bun/bin/redcode.cmd` 即可。若该机 checkout 不在探测列表内（`E:\AI\RedCode` / `D:\AI\RedCode` / `D:\AI\KLX\RedCode` / `C:\AI\RedCode`），设 `REDCODE_HOME` 或在 shim 里加一行 `call :probe "<路径>"`。
- **shim 有两份拷贝、会漂移（回家定方案）**：PATH 上的 `~/.bun/bin/redcode.cmd` 与私仓里的 `~/.redcode/bin/redcode.cmd` 是两个独立文件，改一处不会同步另一处——与 0.8.12 那条"同一份配置两台机器来回改"是同类问题，只是换了个载体。根治方案：把 PATH 上那份改成一行转发 `"%USERPROFILE%\.redcode\bin\redcode.cmd" %*`，逻辑只剩一份、跟着 git 走；代价是日常入口从此依赖 `~/.redcode` 目录可用（该目录正在 git 操作中途时有风险）。未做，等拍板。

### [0.8.12] - 2026-08-05

> 起因是"同一份配置在公司和家里来回改、改完另一台必炸"的死循环，追下去发现根子不在同步本身，而在一份文件里混了机器无关与机器相关两类值。修法是加一层永不上传的本地覆盖层。顺着这条线做了一次仓库自查，捞出四个**从落地那天起就没生效过**的功能——三个子代理、自定义主题、装在仓库外时的模板播种、一半的 skill 播种——它们的共同点是失败时完全静默，没有任何报错。

#### 新增

- **机器本地覆盖层 `~/.redcode/redcode.local.json(c)`**（`config/config.ts`）：在全局配置链末尾加载，同名键覆盖同步来的主文件，其余键照常继承；不进 `globalConfigFile()` 候选，所以引擎写配置仍落在主文件上，本地层只由人手写、由私有仓 gitignore。绝对路径、按显存挑的模型档位这类值放这里，两台机器互不干扰。**实现时踩到的坑**：配置文件有两处加载点，`loadGlobal` 之后 directories 循环还会对每个 `.redcode` 目录把 `redcode.json(c)` 再读一遍且时序更靠后，只改前者的话同步层会把本地层重新盖回去——现象是"本地层独有的键生效、同名键静默失效"，两处都要列。
- **architect / fixer / reviewer 三个子代理真正生效**（`script/sync-home.bat`）：这三个 `.md` 自 0.8.10 落地起就躺在暂存目录里，而 agent 的 `.md` 发现只发生在 `.redcode` 目录内，`Filesystem.up` 匹配的是 `<祖先>/.redcode` 目录本身、不会下潜进去——`agent list` 里一直查无此人，四角色实际只有 explore 那一角在跑。现由 sync-home 播种到 `~/.redcode/agent/`，`agent list` 已确认三者以 subagent 出现。

#### 修复

- **首启模板改编译期内嵌**（`project/bootstrap.ts`）：souls 与 MEMORY 模板原先从 `ctx.directory/.opencode/` 读盘，装在仓库外的二进制（拿 release 的常态）找不到源文件，播种静默失败、`souls/` 永远是空的——而模板正文还写着"首次启动时自动播种"。三份模板移进 `packages/opencode/src/project/template/` 并以 text 导入 inline，任何安装位置都能播。
- **skill 播种不再中途截断**（`project/bootstrap.ts`）：原先用非递归 `readdir` 把 `references/` 子目录当文件读，抛错被外层 `catchCause` 整段吞掉，字母序排在 `red-scribe` 之后的 skill 全部不播种（实测 12 个只落 7 个，无任何提示）。改整目录递归拷贝 + 逐个 skill 隔离错误。
- **项目级自定义主题从来发现不了**（`tui/context/theme.tsx`）：主题发现只向上找 `.opencode/themes`，而主题安装器写的是 `<项目>/.redcode/themes`，装了也读不到。另外 `mytheme.json` 带 UTF-8 BOM，`readJson` 直接抛错被上层吞掉，表现为"没有这个主题"。
- **首页提示指错路**（`tui/feature-plugins/home/tips-view.tsx`）：5 条提示教用户往 `.opencode/{commands,agents,tools,plugins,themes}/` 放文件，但配置发现链只扫 `.redcode`。
- **`$REDCODE_ROOT` 在纯 `.redcode` 项目里落到 fallback**（`mcp/index.ts`）：项目根探测只认 `redcode.jsonc` 或 `.opencode` 目录，补上 `.redcode`。
- **`doctor` 统计不到项目级技能与指令**（`cli/cmd/doctor.ts`）：只看 `.opencode/` 下的 `AGENTS.md` 与 `skill(s)`，补 `.redcode/` 与项目根 `AGENTS.md`。
- **YAML agent profile 目录**（`agent/profile/load.ts`）：补 `.redcode/profiles` 为主，`.opencode/profiles` 保留兼容。
- **文档站构建修复**：`packages/web/src/content/i18n/*.json` 全带 UTF-8 BOM，starlight 的 `JSON.parse` 直接抛错，整站构建挂掉（该问题早于本次改动）。
- **`script/switch-vision-model.ps1` 硬编码机器路径**：写死的 `D:\AI\KLX\RedCode\...` 只在某一台机器上存在，改为相对脚本自身定位仓库根。

#### 变更

- **`.opencode/` 更名 `seed/`**：这个目录从来不是"项目配置"——引擎只扫 `.redcode`，它下面的东西必须被 `sync-home` 拷进 `~/.redcode` 才生效，本质是种子/暂存区，改名让名字说实话。**没有改成 `.redcode/`**，那样会把 65 个惰性文件一次性激活：`plugins/memory.ts` 会与全局同名插件重复加载（CORE 块每轮注入两遍）、冒烟测试插件被当正式插件、13 个 command 与全局重复。
- **全仓 1036 个被跟踪文件去 UTF-8 BOM**（ts 768 / tsx 165 / json 81 / md 17 / js 2 / css 2 / yml 1）。打包器吃得下 BOM，只有运行时 `readJson`/`JSON.parse` 那条路会炸，所以症状永远是"功能静默失效"。`.bat` 与 `.ps1` 刻意不动——PowerShell 5.1 靠 BOM 判定 UTF-8。
- **文档语种收敛为中日英**（root / ja / zh-cn）：原 18 种全部来自上游、无人维护，改一处文档要同步 18 份。其余语言按匹配规则回落，简繁统一走 zh-cn。三语文档内 3269 处路径与品牌名定向重写（`~/.config/opencode` → `~/.redcode`、`opencode.json(c)` → `redcode.json(c)`、`opencode.ai` → `redcode.dev` 等），并以三层保护避开上游包名、第三方 URL 与连字符复合词。
- **删除 Ornith 模型定义**：很早以前用的本地模型。按既往教训，模板与 live 配置两处必须同时删，否则 sync-home 会在下次构建时把它写回来。

### [0.8.11] - 2026-08-04

> 缓存命中率"切模型后一路跌到 50% 且不自愈"的根因查清了：不支持图片输入的模型（deepseek-v4-flash）会把历史里每张图替换成一段占位文本，而占位文本里带着 `Date.now()` 生成的临时文件名——同一张历史图片每一轮都生成不同的字符串，它在消息列表里位置又固定，于是从那条消息往后的所有内容每轮全部失配，provider 的前缀缓存被永久钉死。近 10 天光这一条就白白重写约 35M token。同批把状态栏的缓存指标换成三个真正不同的量，并让"缓存停止延伸"自己报警。

#### 修复

- **vision 临时文件名改用内容哈希**（`provider/transform.ts`）：不收图的模型走 `unsupportedParts()`，历史里每张图被替换成 `ERROR: Cannot read … TEMP_FILE:<路径>`，而该路径此前是 `redcode-vision-${Date.now()}.png`。**把冻结期的真实请求体从错误日志里抽出来逐条 diff**，相邻两次请求的第一处差异**恒定**落在那条含图的 user 消息上，长度分毫不差、只有时间戳数字在变（`ses_035a2d2e3ffe` 第 101 条 user 952 字符 `…-1785809543199.png → …-1785809578133.png`；`ses_0357643d8ffe` 第 1 条 361 字符同理）。表现为 read 钉死在某个值（97k/110k/114k，就是那条消息之前的长度）、write 每轮全量重写、命中率线性跌到 50% 上下且不自愈。对照实验（同一客户端、同两个供应商、同样的切换动作）：**零图片会话** 3M token、切两次模型、上下文过 100k —— 全程 99%+ 不冻；**有图会话修复前** 切回 deepseek 第 2 轮 66% 此后一路跌；**修复后** 第 2 轮 99.8%、write 248/279/476。能收图的模型（step-3.7-flash）不进这段代码，所以从来不复现——这正是"切到 DeepSeek 就开始掉"的真正原因。排查中曾误判为切模型本身、DCP、供应商差异、DeepSeek 服务端抽风、服务过载、上下文过大、缓存容量天花板，七个假设逐一被数据推翻，均与本问题无关。改用内容哈希后同一张图恒定映射到同一路径，请求体逐字节稳定；顺带不再每轮往 temp 目录扔新文件（已存在就跳过写入，被清理掉会自动重写）。
- **prompt 缓存键加 modelKey**（`session/prompt.ts`）：`_caches.modelMsgs` / `_caches.system` 原来只按 sessionID 做键，而 `toUIMessages` 对"由其他模型生成的消息"会剥 `providerMetadata`、降级 reasoning——同一条消息的序列化形态是跟当前模型走的。切模型后缓存仍按 sessionID 命中，发出去的就成了"旧模型风格的缓存对象 + 新模型风格的新消息"拼成的混合前缀，目标 provider 从没见过，只能全量重建。6/29 曾加过同款被连带 revert（主犯是 `Canary.clear`，已修），本次重新落地。

#### 变更

- **状态栏缓存指标改成三个**（`cli/cmd/tui/component/prompt/index.tsx`）：原来是 `Cache hit X% · miss Y%`，而 miss 恒等于 100−hit、纯冗余；且累计值对"缓存卡住"几乎没有诊断力——它是全窗口平均，卡住要几十轮才看得出来，恢复后要上百轮才爬回去。现在是 `cache turn 99.5% · conn 96.1% · hit 96.1%`：**turn** 是最近一次请求（唯一有诊断力的，缓存被钉住时两轮内就掉到 60~80%）；**conn** 是本次连接以来（`sync.data.message` 范围，重启归零、受历史回填进度影响）；**hit** 是会话全历史（取会话记录上的累计 token，跨重启不丢，不会被客户端状态骗）。conn 与 hit 在历史加载完之后通常相同，只在重启后回填未完成的那段时间分开——08-04 排查时界面显示 94.3% 而全历史实为 95.9%，就是这个窗口造成的误判。另加自动告警：**连续 3 轮 read 完全不变且本轮未命中 > 3k → 标红 `⚠ stalled`**，这正是前缀缓存被钉死的充要形态。拿当天真实数据回放该判据：四个冻结过的会话分别告警 48/179/39/21 轮，健康会话 207 轮**零误报**。颜色档位仍走原来的 `cacheTierColor`。
- **`default_agent` 补上，内置的 `agent` profile 禁用**（`.opencode/redcode.home.jsonc`）：默认 agent 一直是 `build` 而不是 redmind，原因是 `default_agent` 这个键从来没设过（`config.ts` 注释写明没设就 fallback 到 `build`）。切换列表里那个多余的 `agent`（description 与 `build` 完全相同）删不掉，是因为它来自随包发行的内置 profile `src/agent/profile/default/agent.yaml`——加载器 `ProfileLoad.loadAll` 会同时读内置 default 目录和用户的 `.opencode/profiles/`，从配置里删条目没用、每次启动都会被重新造出来，只能用 `disable`（`agent.ts` 的配置循环跑在 profile 加载之后，会直接 delete 掉它）。模板里只放 `agent.agent.disable` 一项、不重写整段，避免覆盖 live 配置里 explore 的 MCP 放行规则。

### [0.8.10] - 2026-08-03

> Continuation Enforcement 插件（借鉴 oh-my-claudecode）：agent 回合结束（session.idle）时查 todo，有未完成任务就注入一条 synthetic 提醒消息让它继续。提醒不硬拦，三道闸门防骚扰——用户主动 stop 后 15s 冷却、距上次提醒至少 30s、每会话最多提醒 3 次。

#### 新增

- **续跑提醒插件**（`.opencode/plugins/continuation-enforcement.ts`）：监听 `session.idle` 事件 → `client.session.todo` 查未完成任务（pending/in_progress）→ 注入 `synthetic: true` 的提醒消息（列前 3 项 + 总数）触发 agent 继续。`session.stop` 冷却期（15s）内不提醒，避免打扰用户主动打断；`session.end` 清理状态。默认开启（`.opencode/plugins/` 自动加载）。
---

### [0.8.9] - 2026-08-03

> DCP 元数据标签双防线（提示词禁止 + 输出剥离）堵住正文泄漏；子代理四角色体系上线（architect/fixer/reviewer 三个新角色，按角色路由模型与权限）；子代理权限放行 MCP 检索工具，四角色都能用 jCodeMunch/TypeGraph 查代码。

#### 新增

- **四角色子代理体系**（`.opencode/agents/architect.md`、`fixer.md`、`reviewer.md`）：在内置 explore（检索）基础上新增 architect（只读，出方案/架构设计）、fixer（读写，直接实现）、reviewer（只读，severity 分级审查报告，commit 永远用户拍板）。按角色路由模型：explore=opencode-go/mimo-v2.5（原生多模态识图）、architect/fixer=opencode-go/deepseek-v4-flash（聚合商额度多）、reviewer=step_plan/step-3.7-flash。
- **子代理放行 MCP 检索工具**（`agent/profile/types.ts` 权限体系）：markdown agent frontmatter 的 `"*": deny` 通配会把 MCP 工具（jcodemunch_*/typegraph_*/indexgraph_*/web-search_*/vision_*）一起禁用，三个新角色和内置 explore 均补 `: allow` 放行——子代理现在能用代码检索 MCP。

#### 修复

- **DCP 元数据标签正文泄漏双防线**（`session/instruction-echo.ts`、`session/prompt.ts`）：模型偶发把 `<dcp-message-id>`/`<dcp-system-reminder>` 元数据标签抄进可见正文（实测 `<m0364</m0364>`、整段压缩提醒）。提示词层明确禁止输出标签、遇压缩提醒继续任务；输出层 instruction-echo 快路径 + A 类整块剥离兜底。测试 +2 条。
---

### [0.8.8] - 2026-08-03

> Write 工具显示 .md 文件内容时改用渲染视图——`**文字**` 直接显示粗体、星号隐藏，不再是一眼 TXT。其余语言保持源码视图不动。

#### 变更

- **Write 工具 markdown 渲染视图**（`cli/cmd/tui/routes/session/index.tsx`、`cli/cmd/tui/feature-plugins/system/session-v2.tsx`）：Write 组件对 `filetype === "markdown"` 的文件内容改用 OpenTUI `<markdown>` 组件（MarkdownRenderable，marked 块级解析 + inline 渲染，conceal=true 隐藏 ** 显示粗体），其余文件保持 `<code conceal={false}>` 源码视图。Edit 的 diff 组件不支持 markdown 渲染视图，保持原样。
---

### [0.8.7] - 2026-08-03

> shell 工具的临时文件不再落 C 盘 `Temp\redcode`，改到每个工作区自己的 `.redcode/temp`——测试文件、下载物、临时脚本都在工作区里，系统盘垃圾不再累积。同批把 4 个 defaultAgent 测试对齐 fork 后的真实行为（05890af 默认 agent 改 redmind + 92ab606 引入 primary agent profile）。

#### 新增

- **shell 临时文件改工作区管理**（`tool/shell.ts`、`tool/shell/prompt.ts`、`agent/agent.ts`、`tool/shell/shell.md`）：提示词里的 `${tmp}` 从全局 `Global.Path.tmp`（Windows 上 = `C:\Users\...\AppData\Local\Temp\redcode`）改为 `<workspace>/.redcode/temp`——shell init 闭包里 `yield* InstanceState.context` 拿当前工作区 directory，`mkdirSync` 自动创建；权限白名单 `whitelistedDirs` 同步加 `path.join(ctx.directory, ".redcode", "temp", "*")`。`.redcode/` 已在 gitignore，temp 不进 git。全局 `Global.Path.tmp` 保留给进程内部临时文件（vision 图片、剪贴板 png、editor md、jdtls data），C 盘旧文件暂不清。

#### 修复

- **defaultAgent 4 个测试对齐 fork 行为**（`test/agent/agent.test.ts`）：05890af（260725）把默认 agent 从 build 改为 redmind 且 `list()` 将 redmind 排第一；92ab606（260712）YAML profile 功能引入了 primary "agent"（字母序最前）。无配置默认断言改为 redmind；"只禁 build+redmind 后默认 plan"改为需再禁 agent；"全禁抛错"补禁 agent。41 pass 0 fail。
---
### [0.8.6] - 2026-08-01

> Goal 功能从「半实装」补成完整闭环：钉目标 → 系统提示词注入 → 会话空闲自动续跑（防跑飞三闸门）→ token 记账收尾。同批把标题生成从本地小模型切回当前会话主模型——额度管够，不再受 small_model 掉线拖累。

#### 新增

- **Goal 自动续跑完整实装**（`config/config.ts`、`session/goal-continuation.ts`、`session/prompt.ts`、`effect/app-runtime.ts`、`.opencode/command/goal.md`）：此前 goal 只有数据层 + 工具层（goal_set/done/clear 已注册），接线全断——system 无注入、无开关、无续跑。本次补齐四件：① config 新增 `experimental.goal_auto_continue`（默认关）与 `goal_token_budget`（默认 20 万 tokens）两个开关；② `goal-continuation.ts` 新服务订阅 `SessionStatus.Event.Idle`（run-state onIdle 与 processor 错误路径都会发），`maybeContinue` 七步闸门——开关开、goal active、turn_count < 20、距上次 ≥30s、预算超限时注入收尾 prompt + `mark("budget_limited")`、用户插话即停（对比最新 user 消息 id 与上次 steering 记录）、通过则注入 synthetic steering 消息 + `tick` + `ops.loop` fork 续跑（仿 task.ts resumeWhenIdle 模式）；③ prompt.ts 三处——每步累计 `usageTokens`、runLoop 收尾 `goal.addUsage`（无 goal 行时 UPDATE no-op 零成本）、system 在 MEMORY 条款后 canary 前注入 `<goal>` 块（只 bust 尾部缓存不动前缀大块）；④ AppLayer mergeAll 挂 `GoalContinuation.defaultLayer`。`/goal` 命令同步升级：引导模型调 goal_set/goal_done/goal_clear 工具落库，不再"自己记着"。

#### 变更

- **标题生成改用当前会话主模型**（`session/prompt.ts` ensureTitle）：此前标题走 `small_model`（本地 ollama/qwen3.5）兜底主模型，qwen 掉线会失败重试。哥哥拍板"额度管够"——直接 `provider.getModel(input.providerID, input.modelID)` 主模型生成，删除 getSmallModel fallback 分支与 isMain 判断，失败直接 orDie。
---
### [0.8.5] - 2026-08-01

> DeepSeek V4 Flash 输出上限提到 64K——max_tokens 覆盖 reasoning_content + content 总和，思考链一长正文就被 32K 共享预算挤断，多次中断的根因。同批把 Windsurf 式主动记忆条款写进 system 尾部，遇持久事件不等收工立刻落盘。

#### 修复

- **DeepSeek V4 Flash 输出上限 32K → 64K**（`provider/transform.ts`）：`max_tokens` 覆盖思考链 + 正文总和，V4 Flash 开 max 档思考时（平均 311、长尾远超）正文被 32K 硬顶挤断，导致输出中断。新增常量 `DEEPSEEK_V4_FLASH_OUTPUT_TOKEN_MAX = 64_000`，`maxOutputTokens()` 三分支（MiMo 100K / v4Flash 64K / 其余 32K），新增 `isDeepSeekV4FlashModel()` 按 api.id 含 `deepseek-v4-flash` 判定，覆盖 `-free`/`-think`/`empiriolabs` 家族变体。模型自身 output 上限 384K，64K 是保守余量，后续再断可一行提到 100K。

#### 新增

- **Windsurf 式主动记忆条款**（`session/prompt.ts`）：上下文会被压缩，两层 MEMORY.md 是连接下一个会话的唯一桥梁——之前只靠 AGENTS.md 的记忆规则触发，遵守率低。在 system 尾部铁律之后、canary 之前插入静态条款：遇用户决策/项目坑/被纠正/架构选择立即写入、无需用户许可；`read + edit` 追加、禁用 `write` 覆盖；只有跨项目通用教训才进全局。纯静态文本插在 canary 之前，前缀缓存零影响。
---

> redmind 品牌名修正（Redmind → RedMind），destructive 授权门补全进程/系统级高危命令——此前只拦文件操作和 git 写操作，`taskkill`/`shutdown` 这类命令会静默执行。

#### 新增

- **redmind 显示名改驼峰式 RedMind**（`agent/agent.ts`、`cli/cmd/tui/component/prompt/index.tsx`、`cli/cmd/tui/component/dialog-agent.tsx`）：输入框和切换 agent 对话框原来走 `Locale.titlecase(name)`，`redmind` 被渲染成 "Redmind"。启用 schema 里本来就有的 `displayName` 字段（此前没有任何 agent 用过），redmind 声明 `displayName: "RedMind"`，显示层统一 `displayName ?? titlecase(name)`，build/plan 等其余 agent 显示不变。

- **火山引擎 Doubao 新增专属提示词**（`session/prompt/doubao.md`、`session/system.ts`）：Doubao-Seed 系列此前落 `default.md` 兜底，那句「不超过 4 行、单词回答最好」会把强模型的输出能力压扁，和 grok 是同款坑（0.8.3 已给 grok 补过）。新增 `doubao.md` 参照 `deepseek.md` 的精炼结构，补全五条铁律、Engineering judgment、Windows GBK 环境事实、Task management、并行工具调用等，且保留 soul 人格房规（语气/称呼/详略不双立法）。匹配走 `providerID` 包含 `"volcengine"` 判断，支持火山方舟所有 Doubao 模型。

- **attention 新增任务栏闪烁提醒**（`cli/cmd/tui/attention.ts`、`cli/cmd/tui/config/tui-schema.ts`、`cli/cmd/tui/config/tui.ts`）：打游戏/离开时不知道 agent 在等权限或任务已完成。Windows 下通知触发（失焦 + 非 subagent）时输出 BEL（`\x07`），配合 Windows Terminal `bellStyle: "taskbar"` 让任务栏图标像微信一样闪烁；BEL 是控制字符不占格子、不干扰 OpenTUI 渲染缓冲，console-hijack 不劫持 stdout 所以通道干净。新增 `attention.bell` 配置开关（默认开，`attention.enabled` 默认仍为关）。
#### 修复

- **destructive 授权门漏掉进程/系统级命令**（`tool/shell.ts`）：破坏性判定原先挂在 `FILES`（文件命令）分支里，只覆盖文件操作 + git 写操作（260730 白名单反向判定），`taskkill`、`Stop-Process`、`shutdown`、`Stop-Computer`、`Restart-Computer`、`Clear-Content`、`reg`、`format`、`format-volume`、`diskpart`、`sc`、`schtasks`、`vssadmin`、`bcdedit` 共 14 个进程/系统级高危命令在 redmind 下会静默执行。判定逻辑拆成独立行（`if (cmd && DESTRUCTIVE.has(cmd)) scan.destructive = true`，不再依赖 FILES 分支），DESTRUCTIVE 表补齐这些命令——`reg`/`sc`/`schtasks`/`vssadmin`/`bcdedit` 有只读用法（query/list/enum），但 agent 极少用它们做只读诊断，整命令进门宁可多问一次。PowerShell/cmd 的命令名已先行小写化，bash 分支不受影响。

- **所有 `.md` 提示词/工具描述在导入时被转成 HTML 送进模型**（`session/system.ts` 等 27 个文件、51 处导入）：Bun 的内置 `.md` loader 把 markdown 转成 HTML，编译产物里存的就是 `` var qI=`<p>You are RedCode, an interactive code agent…` ``。实测 `# Tone and style` → `<h1>Tone and style</h1>`、`- ctrl+p…` → `<li>ctrl+p…</li>`、`` `file_path:line_number` `` → `<code>…</code>`；`anthropic.md` 8197 字节进、8638 字节出。仓库里没注册任何 `.md` loader，是 Bun 默认行为，多半是某次升级后静默变的；`src/markdown.d.ts` 声明的是 `const content: string`，HTML 也是 string，类型检查从不报。**后果**：每份提示词多约 5% 体积的标签，精心调过的 markdown 结构落到模型眼里全是 HTML——之前调提示词排版的工作有一部分是白做的。**修法**：导入处加 `with { type: "text" }`，实测拿到一字节不差的原文。**执行**：按 0.8.3 待办的建议分两步走——先改 `system.ts` 里 15 个 per-model 提示词（anthropic/default/beast/deepseek/gemini/gpt/kimi/mimo/minimax/codex/trinity/glm/grok/step/ollama），验证 typecheck + bun build 产物均拿到原文（8197 字节、无 `<h1>`）后，再推平其余 35 处工具描述导入。全仓 51 处（含 skill/index.ts 原本就带 `with` 的 1 处）无一遗漏。typecheck exit=0，编译产物验证原文。


- **火山引擎 volcengine-ark 手动补 CNY 定价**（`provider/provider.ts`）：火山方舟是国产 provider 且不在 models.dev（纯 config 自定义 provider），`CNY_PRICING` 表里没它 → config 循环 cost 兜底全 0 → 费用恒显示 ¥0.00（stepfun-step-plan 同款坑，0.8.1 修过）。按官方定价补 Doubao-Seed-2.1-turbo（输入 ¥3.00、缓存读 ¥0.60、输出 ¥15.00）和 Doubao-Seed-2.1-pro（¥6.00/¥1.20/¥30.00），cache write 按惯例 = input。国产 provider checklist（历史教训 #62）：新增时必须同步 `CNY_PRICING`（服务端 cost 落库）和显示层币种判断——volcengine 走 `model.cost.currency`（`provider.ts` 设 `currency: "CNY"`），显示层读 cost.currency 不需要另加名单。
---
### [0.8.3] - 2026-07-31

> 0.8.0/0.8.2 为了治 step-3.7-flash 的通道纪律，往每一步注入了一条「可见思考的语言 + 称呼」约束。这一版把它整条撤了——实测它是「模型以为用户一直在催」「把答复写进思考链、不展开根本看不见」「无人发话时反复做无用功」三个现象的共同来源，比它要修的那个偶发 XML 泄漏严重得多。同批还有首页视觉调整。

#### 修复

- **每步注入的思考语言/称呼约束整条撤除**（`session/prompt.ts`）：这条注入是 0.8.0（`b26d09a` 语言约束、`4c5707b` 让它真正生效）和 0.8.2（`63cf56b` 称呼约束）加的，起因是想让 step-3.7-flash 别在思考通道里跑偏。查 `ses_04916ea36ffe`（step-3.7-flash，07-31）实测，三个用户可见的毛病都出自这一条：① 它以 `role: "user"` 注入，**且没有 step 门槛，每一步都注**——对模型来说对话永远停在"用户刚说完话"，于是每步都重新推导用户意图而不是继续干活。最后一条真实用户消息之后的 9 分钟里跑了 154 次工具调用，其中只有 62 个不同：同一个 `redcode.jsonc` 读了 16 次、改了 8 次，同样 4 个 `.md` 各读 4 次。② 称呼约束的原文是「在可见思考文本里同样称呼用户为「X」，**与正文保持一致**；……**从第一句思考开始就这么称呼**」——等于明确要求模型把思考写成正文。通道纪律弱的模型照做了：该会话 93 个 assistant 轮次里只有 5 轮有正文，却有 46 段思考在直接对用户说话，答案产出了、只是从思考通道出去了。③ **开关挂错了地方**：语言约束读 `config.reasoning_language`，称呼约束却只读 `config.username`，而 `username` 是 TUI 标签的显示设置——用户撤掉 `reasoning_language` 之后注入照常，根本关不掉。跨模型对照（同一份注入，07-29 至今）：step-3.7-flash 1075 轮里 11.3% 有正文，deepseek-v4-flash 60 轮里 36.7%（样本小，仅供参考）；而两者「在思考里直呼用户」的频率按每百轮算相当（13.3 vs 10）——说明两个模型都在执行这条指令，差别是 V4-Flash 照做的同时照样回话，step 是用思考代替了回话。**改动是通用的，伤害不是**：它需要一个通道纪律本来就弱的模型才会发作。`session/reasoning-language.ts` 与 `instruction-echo.ts` 的剥离逻辑都保留，历史会话里已经存了大量被复述的 `<reasoning-language>` 块还得继续管；要重新启用得先解决两件事——不占用户回合，且每回合最多注一次。
- **正文称呼接回 `config.username`**（`session/system.ts`）：0.8.2 下线 `USER.md` 时把称呼来源指定为 `config.username`，但当时唯一读它的就是上面那条每步注入。注入撤掉之后 `username` 就此悬空——配置项还在、文档还写着，实际不起任何作用。改为接进 env 块：跟着 `environment()` 走，随 `_caches.system` 一次性缓存，**不占用户回合、不每步重复**（被撤除的那条正是栽在这两点上）。措辞只约束正文并明确写出「不约束思考」——原来那句「与正文保持一致」是把模型推去在思考里回话的直接原因，不能再犯。soul 里其实已经规定了称呼，这里是正文层的兜底：实测 soul 写了「叫哥哥"哥哥"」，正文仍会冒出"确认后再给你结论"。

#### 待办（已定位，未修）

- **所有 `.md` 提示词在导入时被转成 HTML 送进模型**：~~Bun 的内置 `.md` loader 把 markdown 转成 HTML，编译产物里存的就是 `` var qI=`<p>You are RedCode, an interactive code agent…` ``；`anthropic.md` 8197 字节进、8638 字节出；`src/markdown.d.ts` 声明 `const content: string`，HTML 也是 string，类型检查从不报。修法已验证：导入处加 `with { type: "text" }` 拿到一字节不差的原文。当时未修：会让所有模型的系统提示词同时变形，血量太大。~~ **已于 0.8.4 修复**（`94bbd92`）：全仓 51 处导入全部加 `with { type: "text" }`，见 0.8.4 修复节。

#### 变更

- **DeepSeek 提示词从 GLM 共用的精炼档拆出来升档**（`session/prompt/deepseek.md`）：`deepseek.md` 此前与 `glm.md` **除标题外逐字节相同**，两个模型共用一份"准一线精炼档"（37 行），而那份是给 V4-Flash-Preview 那一代写的，通篇是给弱模型的补课式脚手架。V4-Flash 0731 正式版 07-31 上线，agentic 项相对 Preview 跃升很大——Terminal Bench 2.1 `61.8 → 82.7`、DeepSWE `7.3 → 54.4`（七倍）、Toolathlon-Verified `49.7 → 70.3`，多项已贴着 Opus-4.8（`82.7 vs 85.0`、`25.2 vs 25.7`），普遍高于 GLM-5.2，继续按精炼档喂它是低估。参照 `anthropic.md` 重写成 57 行：补上 professional objectivity、engineering judgment（欠明确的请求自己做常规判断并说明假设）、任务完整性、`todowrite` 的时机与粒度、探索类任务委派给 `task` 子代理、并行工具调用、RedCode 自身知识与反馈入口；去掉全大写威胁式的重复措辞。保留 Windows 代码页乱码那条环境事实（模型运行时推断不出来）和"语气/称呼交给 soul"的房规。`glm.md` 未动。
- **思考里的称呼改由稳定系统提示词承载**（`session/system.ts`）：本版撤除每步注入时，连带撤掉了"可见思考里也按设定称呼用户"这个效果。用户实测该效果本身有价值（V4-Flash 上「思考链中文也多了起来，也会叫我哥哥，工作流也很规范」），问题从来不在效果、在承载它的机制，所以加回来但三个致命点一个不留：① 不再占用户回合、不再每步注入，跟正文称呼一起进 env 块随 `_caches.system` 一次性缓存；② 措辞去掉「与正文保持一致」「从第一句思考开始就这么称呼」，改为明确写出「思考是你写给自己的推理过程，不是对他说的话，要说的写进正文回复」——保留称呼、切断"思考=正文"的暗示；③ 触发条件与开关同源，只看 `config.username`。**语言约束（强制中文思考）没有一并加回**：它原本靠"看用户这轮说什么语言"做 auto 判定，而稳定系统提示词的位置按定义不能随轮次变，要重新支持得先决定是只认显式配置还是换个位置。
- **首页视觉**（`cli/cmd/tui/routes/home.tsx`、`component/prompt/index.tsx`、`component/starfield-render.ts`）：logo 与输入框整体放大约 30%，宽屏下不再缩在一片留白里；上下留白从 1:1 改成 5:8，整块内容的视觉重心抬到屏幕约 43%（等分时 logo 正好压在几何中心，观感偏"沉"）；首页输入框空输入时文本区给 2 行而不是 1 行——做成 `Prompt` 的 props 而非改默认值，会话页的输入框该让位给对话内容，只有首页它是画面主体。星空原来全屏一律 3% 密度：宽屏下总量偏少，而且 logo 背后和四角一样密，等于在主体后面撒噪点；改成中心 2.5%、边缘 8.5%，按到中心的归一化距离做 smoothstep 爬升，归一化用相对半宽/半高，所以干净区是跟终端同比例的椭圆、宽屏下自然是扁的，正好贴合 logo + 输入框那一块宽而扁的形状。245×55 终端实测总量 425 → 836 颗，而中心 100×22 那块反而从 65 降到 56。

### [0.8.2] - 2026-07-30

> edit 的 hashline 模式对 CRLF 文件每编辑一次就把行数翻一倍——自 6-10 引入起一直存在，因为对工具自己完全隐形（read 看不见、文件指纹也洗得掉），只有拿外部工具数行才会暴露。同一批还修了 hashline 的另外两个 bug，以及读取侧的编码问题——PowerShell 的 `Get-Content` 和 RedCode 自己的 read/edit 此前都无条件假定 UTF-8。

#### 修复

- **edit hashline 对 CRLF 文件每编辑一次行数翻一倍**（`tool/edit.ts`）：`applyHashlineOps` 只按 `\n` 切行再按 `\n` 拼，CRLF 文件的 `\r` 原样留在行尾，紧接着 `convertToLineEnding` 又做一次 LF→CRLF 转换，行尾就成了 `\r\r\n`。裸 `\r` 在 .NET / `Get-Content` / 编辑器 / 浏览器眼里都算换行，于是每行后面凭空多一个空行。实测 `某项目的 templates/index.html` 三次成功的 hashline 编辑后，6905 行变成 27707 行（≈ 4×6905）。这个损坏对工具自己完全隐形：`read` 和 `applyHashlineOps` 都只按 `\n` 切行，看到的还是 6905 行；`Hash.fileTag` 的 `/[ \t\r]+(?=\n|$)/` 又把多出来的 `\r` 洗掉，tag 也不变，所以 edit 既不报错也不失配。修法是交给 `applyHashlineOps` 前先 `normalizeLineEndings` —— 经典 `oldString/newString` 路径一直是先归一化再转的，只有 hashline 这条漏了。hashline 此前**零测试覆盖**，本次补 7 条（CRLF 单次/连续三次、LF、insert/delete、hash 失配不写盘）。
- **edit hashline 给写入的每一行多加一个前导空格**（`tool/edit.ts`）：`edit.md` 明写 body 行前缀是 `+ `（加号 + 一个空格），但 `readBody` 只 `slice(1)` 切掉加号，那个分隔用的空格被当成内容写进了文件。在有格式化器的语言里被 format 抹平了，所以一直没暴露；`index.html` 里则留下实证——hashline 写过的行是 3 空格缩进，邻居是 2 空格。改为 `/^\+ ?/`，`+foo`（不带空格）也照样接受。
- **edit hashline 同锚点时 insert 会被 delete 吃掉**（`tool/edit.ts`）：op 排序的比较器写成 `a.type === "delete" ? 0 : 1`，对 `(delete, insert)` 和 `(insert, delete)` 不返回相反符号，不满足反对称性，实际顺序全看 `sort` 的实现。`insert after 2` + `delete 3..3` 两条都锚在 idx 3，先插后删删掉的正是刚插进去的那行。改成 `deleteFirst(a) - deleteFirst(b)`。
- **写入侧新增行尾回车膨胀护栏**（`util/bom.ts`、`tool/edit.ts`、`tool/write.ts`）：上面那个 bug 能潜伏一个多月，就因为它绕过了所有既有检查。新增 `Bom.detectCrBloat()`，与 `detectGarbled` 并列接在 edit 三个写入点 + write 一个写入点上，发现新增的 `\r\r\n` 就拒绝写入。只在"新内容比原文多"时拦——否则已经损坏的文件连用 edit 修都修不了。8 条测试。
- **PowerShell 读文件仍按系统代码页解码**（`tool/shell.ts`）：0.7.x 加的 `PS_UTF8` 只把**输出**编码钉成了 UTF-8，读侧一直漏着——Windows PowerShell 5.1 的 `Get-Content` 默认按系统 ANSI 代码页解码，中文 Windows 上读 UTF-8 文件直接读成乱码（本机实测 "中文测试" 读成 "涓枃娴嬭瘯"）。内容在读的那一步就已经毁了，之后不管怎么写回都是在写乱码，写入侧的 `detectGarbled` 护栏也拦不住（PUA/FFFD 占比够不上阈值）。给 `Get-Content`/`Import-Csv`/`Select-String` 补上 `$PSDefaultParameterValues` 的 UTF-8 默认值；实测 `Env:`/`Function:` 等非文件系统 provider 不报错、`-Raw` 正常、显式 `-Encoding` 仍然优先。**写侧故意没动**：5.1 里给 `Set-Content`/`Out-File` 指定 utf8 会强制写 BOM，给 .py/.json/.html 加 BOM 是拿一个 bug 换另一个；写文件本来就该走 write/edit 工具。
- **读取侧编码检测：真 GBK 文件不再读成满屏 `�`**（`util/bom.ts`、`tool/read.ts`）：`Bom.readFile` 此前无条件按 UTF-8 非 fatal 解码，非 UTF-8 的文件读进来全是替换符，模型根本没法干活（靠写入侧 `detectGarbled` 兜住不写回，不算数据丢失，但确实读不了）。新增 `Bom.sniff()`：BOM → 严格 UTF-8 → 才退系统代码页。**检测只能单向做** —— 「严格 UTF-8 解得通 → 就是 UTF-8」可靠，UTF-8 有自校验结构，实测 20000 样本里 5 个汉字往上、GBK 字节凑成合法 UTF-8 的次数为 0；反过来「GBK 解得通 → 是 GBK」毫无价值，GBK 太宽松，8 个汉字的 UTF-8 字节流有 31% 能被它照单全收。判定只看开头 4096 字节，且 `read` 与 `edit` **必须共用同一条规则、同一段采样**：read 产 `[path#TAG]`、edit 用 `Bom.decode` 算 currentHash 校验陈旧度，两边解码方式不一致就会在该类文件上次次 hash mismatch（read 是流式的、拿不到全文，所以规则就定成只看头部）。只看头部同时也更稳：一个 99.99% 是 UTF-8、末尾混进一个坏字节的文件，全文校验会判成 GBK 然后整个解花，头部校验则判 UTF-8、只有那个坏字节退化成 `�`。顺带认了 UTF-16LE/BE 的 BOM——PowerShell 5.1 的 `Out-File`/`>` 默认就写 UTF-16LE，Windows 上并不罕见。
- **配套的转编码护栏**（`util/bom.ts`、`tool/edit.ts`、`tool/write.ts`、`tool/ast_grep.ts`、`tool/apply_patch.ts`）：检测之前，"不许把 GBK 文件写回成 UTF-8"这件事是由 `detectGarbled` 顺带挡着的（GBK 读成 UTF-8 满屏 FFFD、占比 83% 远超阈值，直接拒写）；检测之后文本干净了，那道墙自动失效，不补就成了"悄悄把用户的 GBK 文件转成 UTF-8"。新增 `Bom.detectEncodingChange()`，接在 edit 三个 + write 一个写入点上明确拒绝，ast_grep 的 rewrite 跳过该类文件（与它已有的"超大/语言不认识/解析失败"跳过同一处理方式），apply_patch 的 update 直接报错。**不做反向转换**：`TextEncoder` 只出 UTF-8，仓库里也没有 iconv，我们只有解码能力没有编码能力，所以拒绝而不是假装能转。顺带说明：`ast_grep`/`apply_patch` 此前连 `detectGarbled` 都没接，改之前它们在 GBK 文件上会直接写一堆 FFFD 把文件毁掉，现在至少不动它。
- **提示词/工具说明文字漏进可见正文**（新增 `session/instruction-echo.ts`、`session/processor.ts`）：DCP compress 工具的说明整段进了正文（`Rules:` / `- Do not invent IDs.` / `BATCHING` / `THE FORMAT OF COMPRESS` 加一段 JSON schema）。`xml-tool-call.ts` 管不住它——那边靠 `<function=` 子串触发，这里一个尖括号标签都没有。分两类处理：A 类是我们自己注入的包装块（`<system-reminder>`、`<reasoning-language>`、`[System notice]`），有明确起止、模型复述永远是错的，整块剥掉；B 类是工具说明/JSON schema，没有闭合标签、边界靠猜，只做行级判定，要求连续 3 行以上像 schema 且命中强特征标题才切。宁可漏切不可错切——错切会吃掉真正的回答，比留着泄漏更糟。11 条测试。
- **「刚才用户让我做 xx」——用户其实一个字都没发**（`session/prompt.ts`）：`userReminderText` 的边界写成 `m.info.id > lastFinished.id`，而 `lastFinished` 来自 `MessageV2.latest()`、当前这条 assistant 消息整轮都不算 finished，于是它一直钉在上一轮。结果"开启本轮的那条用户消息"永远满足条件，被当成"中途新到的"每一步重新注入一次——20 步的回合模型会被告知 19 次「用户发话了，请处理」。本意只是捕捉回合**中途**新到的消息，边界改为本轮起点，并对已提醒过的消息去重。与此前查到的 DCP 以 user 角色注入消息是两个独立来源，叠在一起才让现象那么明显。

#### 变更

- **`USER.md` 下线**（`.opencode/redcode.home.jsonc`、`project/bootstrap.ts`、`cli/cmd/tui/context/local.tsx`、删除 `.opencode/agents/USER.template.md`）：这份"用户画像"由 `redcode.jsonc` 的 `instructions` 每轮注入，但内容基本被 `souls/Tsoul.md`、`souls/Gsoul.md` 覆盖了——称呼"哥哥"、语气要求、根因优先、连败两次停手、诚实说做不到，soul 里都写着，等于同一件事说两遍、每轮白吃一道加载。唯一真正只有它有的是 TUI 对话标签上的称呼（`local.tsx` 去解析 `**称呼：**` 这个粗体字段），改读 config 已有的 `username` 字段（缺省退到系统用户名），比解析 markdown 稳。shipped 模板与 live 配置**同时**改——只改 live 的话同步时会被模板反向覆盖回来（0.7.25 vision-mcp、本版 anthropic 块都栽过这个坑）。老用户的 `~/.redcode/USER.md` 不会被删除，只是不再加载。

- **从 `redcode` 命令启动时 provider 全挂**（`packages/core/src/models-dev.ts`）：报的是 `2 of 5 requests failed: Unexpected server error… config.providers, provider.list`，日志里只有一句 `Failed to fetch models.dev`，而双击 exe 却完全正常。根因是取数的三级回落——磁盘缓存 → 编译期内嵌快照 `REDCODE_MODELS_DEV` → 网络：exe 里烤了快照（构建时走代理取的），而 `~/.bun/bin/redcode.cmd` 从源码跑没有快照，磁盘也没缓存，只能落到网络取数；这台机器的代理**只配在 git 里**（`http.proxy`），环境变量一个都没有，于是 `git push` 通、运行时取数直连超时。构建脚本 0.8.1 已经修过同一个问题（`634af25` 配了 git 代理就优先走代理），运行时没跟上。两处改动：① 环境变量没设代理但 git 里配了时，**只给 models.dev 这一个请求**带上该代理（只读 git 配置不修改；不改全局 env，否则会把 Ollama 这类本地 provider 也一起代理掉；Bun 的 fetch 认 `init.proxy`，Node 忽略未知字段等于不生效，行为与改前一致；超时按代理路径的实测放宽到 90 秒）。② 取数失败**不再 `orDie`**——模型目录取不到只降级成空目录，已配好的 provider 照常可用，并打一条说清怎么办的 warning（是否走了代理、怎么设、怎么手动刷缓存）。原先 `orDie` 把网络超时变成 defect，顶层只剩一句无信息的 `Unexpected server error`，跟本版另一条 `ConfigInvalidError` 是同一类毛病：**底层失败被包装成无信息的顶层错误**。

- **`ConfigInvalidError` 不说是哪个键错了**（`packages/core/src/util/error.ts`、`config/parse.ts`）：`NamedError` 的构造函数无条件 `super(name)`，于是 `Error.message` 永远等于错误类名，`data` 里拼好的 message 一个字都到不了日志。实测踩过一次：往两端共用的 `~/.redcode/redcode.jsonc` 里加了一个本端 schema 不认识的键，配置校验失败导致整个 server 起不来（表现是 GUI 上"无法加载会话/列出文件失败/无法重新加载"三连的 `Unexpected server error`），而日志里只有 `ConfigInvalidError: ConfigInvalidError`——文件路径和键名全躺在 `data.issues` 里没人看得见，只能靠"知道自己刚改了什么"才定位到。改为：带了 `message` 字段的 `NamedError` 用它当 `Error.message`（没带的行为不变），`config/parse.ts` 两个抛出点补上 message，未知键的提示里点明"这个键可能来自更新版本的客户端，两端读的是同一份配置"。现在报的是 `~/.redcode/redcode.jsonc: Unrecognized key: xxx. …` 和 `~/.redcode/redcode.jsonc: share: Expected "manual" | "auto" | "disabled", got "nope"`。**背景**：TUI 与 GUI 版本号独立演进却共用同一份全局配置，新版加的键会直接打死旧版的另一端。

- **自动压缩后的续跑提示被模型当成用户发言**（`session/compaction.ts`）：自动压缩结束时会插一条 `role: "user"` 的消息（正文只有 `Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.`），part 上虽然标了 `synthetic`，但**模型看不到这个标记**，读到的就是用户在说"继续"。线上实测（会话 `ses_04e354872ffe…`，07-30 08:44:45 那条注入）之后连着四步思考写的是：「用户说"继续"」→「用户要求继续做下一步」→「用户要求"继续"，说明他认可前面的改动方向」→「用户说"先commit再测"」——最后一句用户一个字都没发过，它先把注入当成用户发言，再顺着编出后续指令。`role` 保持 `user` 不动（对话必须以 user 轮结尾才能续跑，中途插 system 消息各家 provider 支持度不一），改的是文案：① 开头声明"这不是用户发言，用户此刻没有说话"（`[System notice]` 前缀与 `xml-tool-call`/`text-loop-detection` 的注入一致，`instruction-echo` 也按这个前缀剥离复述）；② 带上本轮用户的原始请求做锚点——压缩会把"用户到底要什么"摘没，只剩一句含糊的 continue，模型就从摘要里最显眼的旧状态接着跑；③ 明确"已完成的工作在摘要里，别重头再来"，且默认倾向汇报而非继续。这个现象在 0.8.2 里变明显是因为本版同时修掉了"每步重复注入用户提醒"——那个 bug 过度注入的同时，顺带每步把"用户到底要什么"重新钉了一遍，拿掉之后压缩后的失忆就没有东西兜着了。

- **人民币金额被当美元又乘了一次汇率**（`cli/cmd/tui/feature-plugins/home/footer.tsx`、`packages/app/src/components/session/session-context-metrics.ts`）：显示层用一份硬编码的 `CNY_PROVIDERS` 精确匹配集合判断币种，而 `provider.ts` 的 `CNY_PRICING` 是另一份名单——同一件事在两处各存一份，加 provider 必漏。漏的正是 0.8.1 刚补过定价的 `stepfun-step-plan`：它的 cost 落库时已经是人民币，却因为不在这个集合里被当美元乘了 6.76，库里 `¥7.504382` 显示成 `¥50.73`（实测与截图分毫不差；按阶跃官方定价 1.35/0.27/8.1 独立验算，落库值倍数 1.00，**存的一直是对的，错的只是显示**）。TUI 侧改为直接读 `model.cost.currency`——`provider.ts` 套 `CNY_PRICING` 时本来就写了 `currency: "CNY"`，读它就不会再漏；`currency` 是可选字段，models.dev 来的报价没有它，所以判定是 `=== "CNY"` 才不折算。GUI 侧 `home-stats.tsx` 只拿得到 session、拿不到 model 报价，暂时仍用名单，补上缺的条目并注明 `CNY_PRICING` 增删时必须同步。

- **文本态工具调用的第二种形状没被打捞**（`session/xml-tool-call.ts`）：打捞逻辑的快路径第一行是 `if (!text.includes("<function=")) return`，只认 Qwen/Hermes 式的 `<function=name>` + `<parameter=name>`。07-30 实测 step-3.7-flash 吐的是另一种形状——`<edit><args><filePath>…</filePath></args></edit>`，于是既没打捞也没摘除：原始 XML 原样留在正文里给用户看，本轮零个 tool part 却是 `finish: stop`，表现成"它自己停下来了"（那轮的 part 构成是 `step-start reasoning(778) text(261) step-finish`）。新增第二个识别器，误判防线是双重的——标签名必须是**真实注册的工具名**，且紧跟着必须是 `<args>`；只靠其中一个条件会误伤正文里讨论 XML、粘贴 HTML 片段的情况。参数解析用反向引用 `<(name)>…</\1>`，因为实测参数值里就带着 `</tr></thead>` 这类标签，靠"闭合标签必须同名"才切得准。两种形状各自扫全文，摘除前排序并跳过重叠区间。6 条测试。

- **`git` 的写操作此前完全不过授权门**（`tool/shell.ts`）：`DESTRUCTIVE` 那张表只收文件操作命令（`rm`/`cp`/`mv`/`chmod` + PowerShell/cmd 的对应项），**`git` 一个字都没有**——于是 `cp` 会弹授权，`git push --force`、`git reset --hard`、`git clean -fd`、`git commit` 反而一路静默执行。07-30 实测：agent 在用户一句话没说的情况下自己 `git commit` 了。这不是"谁点过 always allow"——全局配置没有 `permission` 段、DB 的 permission 表 0 行、该会话的 permission 列为空；根因是 07-25（`05890af`）把 redmind 的 blanket `bash: "ask"` 去掉、改走 `destructive: "ask"` 之后，git 就从这个口子整个漏了出去。改为**白名单反向判定**：只读子命令（`status`/`log`/`diff`/`show`/`rev-parse`/`fetch` 等，`branch` 不带 `-d/-D/-m/-f` 时也算）放行，其余一律进 destructive 门。不用黑名单是因为黑名单漏一个就是静默执行，白名单漏一个只是多问一次。
- **解析不出的命令会绕过整个授权门**（`tool/shell.ts`）：`ask()` 里 `patterns.size === 0` 直接 return，本意是给 `cd` 这类纯导航命令留口子，但 tree-sitter 解析失败时 patterns 同样是空的——于是**任何解析不了的写法都不需要任何授权**。实测 PowerShell 下 `git checkout -- .` 就解析不出命令节点，一路直接执行。改为解析不出命令节点时回退成拿整条原始命令去要授权，并按空白切一遍跑同样的破坏性判定（否则真该拦的命令会因为"解析失败"反而降级成最轻的授权）。

- **可见思考里的称呼**（`session/reasoning-language.ts`、`session/prompt.ts`）：soul 和 per-model 提示词只管住了正文——模型把"人格"理解成输出风格，一进思考通道就退回默认的第三人称，正文喊"哥哥"、思考里写 `The user wants me to...`。修法与 0.8.0 那条语言约束同源：必须显式点明"这条同样约束可见思考文本"，且用命令式措辞。称呼取 `config.username`，与两条语言约束合在同一个 `<reasoning-language>` 块里注入，不多占 user turn。触发条件比语言那条宽——`auto`（判不出用户在说什么语言）时不注入语言约束，但称呼照样注入。`username` 缺省会被 config 填成系统用户名，等于系统用户名时视作没设过，否则会注入"称呼用户为 Administrator"，比不注入更糟。7 条测试。

- **语气交还 soul；新增 `grok.md`**（`session/prompt/*.md`、`session/system.ts`）：语气/称呼/详略本该是 soul 独占的领域，per-model 提示词也立法会让调 soul 时被莫名拽回。从实际在用的 6 份里删掉 `Match the user's language` 与 `Be concise: …` 两类规定，各自保留机制性条款（诚实报告失败、`<system-reminder>` 权威、准确优先于附和）。真正的问题在 `default.md`——第 19 行强制「回答不超过 4 行、单词回答最好」，那才是会碾平人格的规定；但它是所有未匹配模型的兜底，不宜为 grok 单独改，故新增 `grok.md` 并在 `system.ts` 里前置匹配。内容按 xAI **API 文档**核实到的真实特性写（grok-4.5 无法禁用推理、effort 默认 high），没有硬塞泄漏的消费级产品提示词。
- **shipped 模板里也删掉 anthropic 块**（`.opencode/redcode.home.jsonc`）：`~/.redcode/redcode.jsonc` 里删过一次，当天就又出现——根因是这份 shipped 模板还留着同一个块，同步时反向覆盖 live 配置。与 0.7.25 vision-mcp 是同类坑：配置改动往往要同时落在 live 文件和 shipped 模板两处。该块三重无效：apiKey 是占位符、`ANTHROPIC_API_KEY` 未设、唯一模型 `gpt-5-chat-latest` 实测请求 404。

---

### [0.8.1] - 2026-07-29

> 0.8.0 构建产物之后落的一批修复。其中「reasoning 语言约束被 DCP 注入消息挡掉」是 0.8.0 自己引入的功能当天就被证伪——功能在二进制里，但从未生效。

#### 修复

- **reasoning 语言约束整条静默失效**（`session/reasoning-language.ts`、`session/prompt.ts`）：线上实测（会话 `ses_0536c…`）用户说的是「怎么了敏敏」，模型思考却整段英文 `"The user asked 怎么了敏敏…"`，而运行的二进制确实包含 0.8.0 的语言约束。根因是取语言判定来源时直接用了「最后一条 `role==="user"` 的消息」——但 DCP 的压缩通知（`▣ DCP | -148.1K removed…`）同样是 user 角色，只是文本 part 标了 `ignored`。于是流程变成「取到通知 → 过滤掉 ignored 的 part → 只剩空串 → 判为 auto → 不注入」。过滤本身没错，错在选消息。改为从后往前找第一条真的含用户自撰文本的消息，跳过纯注入消息；判定逻辑一并从 `prompt.ts` 的循环体里提到模块中，原先既没测试也没法测，现补 6 条（含照着线上真实消息序列构造的那条）。
- **`stepfun-step-plan` 费用恒为 ¥0.00**（`provider/provider.ts`）：models.dev 里 `step-3.7-flash` 有四个 provider 条目，两个 "Step Plan" 的 `cost` 字段直接是 `null`，而 `CNY_PRICING` 只覆盖了 `stepfun` 一个键。实测近 30 天 `stepfun` 6596 轮累计 ¥286.29、`stepfun-step-plan` 1882 轮累计 ¥0.00，而最近 400 条消息里 351 条走的正是后者——当前全部开销都没被记账。按阶跃官方定价补上（1M tokens：输入未命中 1.35 元、命中 0.27 元、输出 8.1 元）。未补 `stepfun-ai-step-plan`（Global）：海外站按美元计价，套人民币表会把币种搞错，比不显示更糟。

#### 变更

- **`step.md` 补上三条针对实测毛病的约束**（`session/prompt/step.md`）：此前该提示词规则齐整但完全没有覆盖 step 自己的两个高发问题，等于"能用提示词管住却没管"。新增：① 只用原生 tool-call 通道，禁止把 `<tool_call>`/`<function=…>`/`<parameter=…>` 当正文写出来（实测 14 次 XML 泄漏 100% 出自 step）；② 不许把答案留在思考通道里——思考默认折叠，只有思考没有正文的一轮跟崩溃无法区分（step 此类轮次 0.6%，是 deepseek 的 4 倍）；③ "简洁"不等于"不说话"，一句也比零句强（实测 step 平均思考 3553 字、正文仅 144 字）。是代码层兜底（`xml-tool-call.ts` 的打捞与 reasoning-only 纠正）之外的第一道防线，互补而非替代。

#### 性能

- **构建取数配了代理就优先走代理**（`script/generate.ts`）：0.8.0 的做法是先试直连、失败再退代理。但"git 里配了代理"本身就是"这台机器要靠代理出网"的强信号，先试直连只是白等一次超时（本机直连 12 秒无响应，且这是常态）。改为有代理配置就先走代理、不通再退直连；没配代理的机器行为不变。实测构建取数从 24.0 秒降到 4.8 秒，省下的全是等直连超时的时间。

---

### [0.8.0] - 2026-07-29

> 围绕前缀缓存的一批改造，外加可见思考语言约束。设计取自 [DeepSeek-Reasonix](https://github.com/esengine/DeepSeek-Reasonix) 的 `compact.go` / `reasoning_language.go` / `cache_shape.go`（该项目同为面向 DeepSeek 的 agent，`prefix-shape.ts` 早前也借鉴过它）。

#### 新增

- **可见思考文本的语言约束**（新增 `session/reasoning-language.ts`）：DeepSeek / step 等模型即使面对纯中文提问，`reasoning_content` 也常整段用英文写，界面上"已思考"是英文、正文是中文，割裂得厉害。新增配置 `reasoning_language: "auto" | "zh" | "en"`，默认 `auto`。三处设计都不是随手定的：
  - **命令式措辞**，不是"偏好/建议"。软措辞在"中文提问里嵌了英文日志/代码"时会丢掉**第一个** reasoning 段，而第一段会锚定整轮——provider 会把先前的 reasoning 回传给模型，第一段丢了整轮就回不来。
  - **注入 user turn，不进 system prompt**。这是用户可随时切换的偏好，放进稳定前缀等于每次改设置都打掉整个 prefix cache。
  - **auto 模式保守**：剥掉代码块与 RedCode 自己注入的包装块后再数汉字，英文和拿不准的一律不注入，保持旧行为。
- **逐工具 schema token 成本诊断**（`session/prefix-shape.ts`）：工具 schema 每轮都在前缀里付费，某个 MCP server 挂上来就可能悄悄吃掉几千 token，此前完全不可见。`prefix cache changed` 的日志现在带上 `toolCount` / `toolSchemaTokens`，并在 tools 确实变化时列出最贵的 5 个工具。逐工具成本只在 tools 变了时才算，不是每轮都序列化。

#### 变更

- **压缩改为分级，廉价手段先上**（`session/overflow.ts`、`session/compaction.ts`、`session/prompt.ts`）：原先是单一二值判定——没溢出什么都不做，一溢出就直接摘要压缩。但摘要压缩是**前缀缓存重置点**：重写历史、打掉整个 prefix cache，还要付一次模型调用，单阈值意味着它总是来得突然且已无便宜手段可用。现在分三档（比例相对 `usable()`，即扣掉输出预留之后的可用窗口）：
  - `soft`(0.6) — 只记一条提示，**刻意不做任何重写**，在这里动前缀是白白炸掉缓存
  - `prune`(0.8) — 裁剪陈旧工具输出，纯本地改写，不花钱不调模型
  - `compact` — 真正的摘要压缩，**触发点与改造前完全一致**（`count >= usable`），刻意不动，避免改变既有压缩时机
- **prune 先于 summarize**（`session/prompt.ts`、`session/compaction.ts`）：压缩触发时先裁剪陈旧工具输出，若光这一步就把用量压回阈值以下，则**跳过这一轮付费的 summarize 调用**——省一次模型调用，也少一次缓存重置。溢出（模型被上下文顶断）时不做此判断，那种情况必须真压。`compaction.prune` 相应从返回 `void` 改为返回 `{ tokens, parts }`。

#### 修复

- **GLM-5.2 支持推理强度却看不到档位**（`provider/transform.ts`）：`variants()` 里有一张硬编码排除表，整个 `glm` 家族无差别返回空变体，页脚因此没有任何档位可选。按智谱官方「核心参数说明」，`thinking.type` 是 GLM-4.5 及以上都有的二值开关，而 `reasoning_effort` **自 GLM-5.2 起支持**——排除对 5.1 及以下成立，对 5.2 已经过时。现在按版本号判定（`glm-5-turbo`/`glm-5v-turbo` 都是 5.0，不算；`glm-5.3`/`glm-6` 自动跟上）。档位只暴露 `none`/`high`/`max` 三档：官方 7 个取值里 `none`+`minimal`、`low`+`medium`→`high`、`xhigh`→`max` 互为别名，全摆出来等于骗人——用户选 `low` 实际吃到的是 `high`。`max` 是官方默认值，因此不选变体时的行为即等于 `max`。
- **grok-4.5 / kimi-k3 同样支持推理强度却没有档位**（`provider/transform.ts`）：与 GLM 同一张排除表的问题。依据两家官方文档——xAI：grok-4.5 支持 `reasoning_effort`，取值 `low`/`medium`/`high`，默认 `high`，**无法禁用推理**（故不提供 `none` 档）；Moonshot：K3 始终开启思考，取值 `low`/`high`/`max`，默认 `max`。两者档位集合不同（一个有 `medium`、一个有 `max`），各用各的表。均按版本号判定：`grok-3-mini` 保持原有分支不受影响，`grok-4`/`4.2`/`4.3` 与 `kimi-k2` 系列继续无档位，更高版本自动跟上。
  经会话库验证聚合层确实转发该参数：`opencode-go/deepseek-v4-flash` 三档的平均 reasoning token 为 default 133 / high 202 / max 311，单调递增，样本 4608 轮——同一条聚合路径上参数生效，不是摆设。
- **GLM 挂在聚合供应商下时拿不到 `thinking` 参数**（`provider/transform.ts`）：注入条件原先只认 `providerID` 含 `zai`/`zhipuai`，但同一个 GLM 也可能挂在别的聚合商下（如 `opencode-go/glm-5.2`），那条路径既无档位又无 `thinking`，完全靠上游默认值。判据改为按模型本身识别，原有 zai/zhipuai 路径不变。
- **构建时 models.dev 拉不动，每次都退到过期缓存**（`script/generate.ts`）：0.7.39 加的缓存回退虽然让构建不再直接失败，但每次都刷一屏 stale 警告，治标不治本。根因是 git 有自己的 `http.proxy` 配置而 bun 的 `fetch` 只认 `HTTPS_PROXY` 环境变量——同一台机器上 push 能通、build 不通，而指望每次构建都记得 `set HTTPS_PROXY` 并不现实。现在直连失败后自动读取 `git config --get https.proxy`（回退 `http.proxy`）并用 bun fetch 的 `proxy` 选项重试；只读不写，不碰用户的 git 配置。同时给两次请求都加了 90 秒超时——代理路径实测拉这 1.2MB 要 20 秒上下，超时太短会半路断掉又白白退回缓存。缓存回退与那三个不回退的条件（自定义源 / CI / 无缓存）保持不变，作为最后一道防线。
- **`isMimoModel` 裸取 `model.api.id` 会抛**（`provider/transform.ts`）：`model.api` 并非在所有构造路径上都存在，而它经由 `maxOutputTokens` → `overflow.usable` → `isOverflow` 位于压缩判定的主路径上，抛在这里等于整条压缩链断掉。加空值保护并回退到 `model.id`。`compaction.test.ts` 里 8 条 `isOverflow` 用例长期失败的原因就是这个，不是断言写错——该文件从 23 pass / 28 fail 变为 31 pass / 20 fail。

---

### [0.7.39] - 2026-07-28

> 两处授权绕过 + PowerShell 中文乱码 + 三处性能热点；CI 自 fork 起从未真正运行，本次修复并收敛到 Windows。

#### 安全

- **跨盘路径被判成"在项目内"**（`core/filesystem.ts`、`opencode/util/filesystem.ts`）：Windows 上 `path.relative` 在两侧不同盘时返回的是目标的绝对路径，而绝对路径不以 `..` 开头，于是 `contains("E:\proj", "C:\Windows\win.ini")` 返回 true。项目只要不在系统盘，另一个盘上的任何路径都被当成项目内部，`external_directory` 授权永远不会触发。`contains`/`overlaps` 改为先比较盘符根（大小写不敏感），不同直接判否。自 fork 点从上游继承，单盘机器上不会暴露。
- **无条件信任项目父目录**（`project/instance-context.ts`）：`containsPath` 除 directory/worktree 外还信任 `dirname(worktree)`，等于把整个父目录划进项目内——repo 在 `C:\Users\you\project` 就静默信任整个 `C:\Users\you`（`.ssh`/`.aws` 都在里面），且因判定为"项目内"而完全不触发授权提示。改为显式白名单，用现成的 `permission.external_directory` 规则表配置。

#### 修复

- **PowerShell 5.1 输出被按 UTF-8 解码**（`tool/shell.ts`）：子进程输出用 `Stream.decodeText`（UTF-8）解，而 Windows PowerShell 默认按系统 ANSI 代码页写 stdout/stderr——中文 Windows 上是 GBK(936)。任何带中文的命令输出和 PowerShell 自身报错进到工具输出全是乱码。`-Command` 前置 `[Console]::OutputEncoding` 与 `$OutputEncoding` 赋值。
- **JSON 解析失败变成 defect 打死会话**（`core/filesystem.ts`）：`readJson` 用裸 `JSON.parse`，语法错误抛出的是 defect 而非 typed error，调用方的 `Effect.catch` 兜不住——`models-dev.ts` 的降级路径形同虚设，defect 一路炸到 HTTP 中间件变成 `UnknownError`。用户的 `~/.redcode/cache/models.json` 坏一个字节就会每次对话直接死。改用 `Effect.try` 包装。
- **`cd`/`cat`/`dir` 被当成破坏性命令**（`tool/shell.ts`）：`FILES`/`CMD_FILES` 回答的是"命令带不带路径参数"（驱动 external_directory 扫描），被直接复用为破坏性判定，导致纯导航和只读命令弹最重的那档授权。拆出独立的 `DESTRUCTIVE` 表。
- **输出被 token 上限截断时无提示**（TUI 消息页脚、`cli/cmd/run`）：`finish="length"` 与 `"stop"` 走同一条路，被砍断的回复在界面上和正常说完完全一样。页脚加 warning 色标记，`redcode run` 发 system 提示。
- **工具调用被写成 XML 文本，整轮白跑**（新增 `session/xml-tool-call.ts`，接在 `session/processor.ts`、`session/prompt.ts`）：模型偶发不走原生 tool_calls 通道，改把 `<tool_call><function=名字><parameter=键>值</parameter></function></tool_call>` 当普通正文吐出来。这种调用永远不会被执行，用户只看到一坨标签，本轮无任何效果。现在在 part 收尾时认出并从可见正文里摘掉，把解析结果回灌给模型强制续跑一轮，让它用原生通道重发；最多纠正 2 次，仍不改则留一句可见说明收尾。只认本 step 真实注册的工具名，避免把讨论/日志里出现的同款标签误摘。不直接执行打捞出的调用——默认 ai-sdk 运行时里工具由 `streamText` 内部执行，凭空合成 tool-call 事件会造出永不 settle 的 running part 并绕过 `permission.ask`。
- **整轮只产出思考、正文为空**（`session/prompt.ts`）：同一个根因的另一面——模型该切正文通道时继续往 `reasoning_content` 里吐，界面上表现为空回复，和被打断/卡死完全无法区分（内容其实在折叠的"已思考"里）。现在检测到"有思考、无正文、无工具调用"时先纠正一次，仍然为空则把思考内容提升成可见正文，不再让用户对着空白猜。

  以上两条以 `~/.redcode/data/redcode.db` 近 14 天实测定位（运行时日志不含原始流内容，只能查 DB）：XML 泄漏 14 次 100% 出自 `step-3.7-flash`，同期 `deepseek-v4-flash`(4608 条)、`gpt-5.6-luna`(902 条)、`kimi-k3`(103 条) 均为 0；泄漏落 reasoning part 还是 text part 纯看模型断在哪个通道（6/14 vs 8/14）。"只有思考"轮次 step 约 0.6%、deepseek 0.15%、luna 0%。两条修复都不依赖对成因的假设，因此不限定模型生效。

  一并评估过给 step 系压低采样温度（`provider/transform.ts` 的 `temperature()` 原本返回 `undefined`，用服务端默认），**已放弃**：模型吐 Hermes 式 XML 是回退到另一套训练分布，那个模式在部分上下文里本身就是高概率，降温未必压得住；而 0.3 对 code agent 足够激进，会推高退化重复的风险——拿一个没验证的缓解手段去换一个已有 n-gram 检测器在对付的风险，不划算。

#### 性能

- **`@` 文件补全每敲一个键全仓扫描一次**（`file/index.ts`）：`ensure()` 在 await 完 `Effect.cached` 后立刻重建它，缓存只能命中一次，等于每次按键都跑完整 `rg --files`（无 maxDepth/无条数上限）再重建祖先目录表。改为按实例的 TTL 缓存 + 信号量串行化。
- **`read` 为 4 个字符的 tag 把整个文件读进内存**（`tool/read.ts`）：流式读取刚做完 50KB 截断，紧接着又全量读一遍算 `fileTag`。改为流式增量哈希，摘要不变、内存有界。
- **`grep` 把全部命中收进内存后才截断到 100 条**（`tool/grep.ts`、`file/ripgrep.ts`）：无 limit 全量 `runCollect`，且在截断前先对所有命中路径 stat 排序。加上限并在超限时提示收窄 pattern。

#### 构建

- **CI 自 fork 起从未真正运行**：`runs-on` 指向上游的第三方 runner 服务 blacksmith，本仓无对应账号，job 一直排队到 24 小时上限被掐；07-20 加入的 gitleaks 因 action commit 不存在而 3 秒失败，才让整个 run 开始显红。换成 GitHub 托管 runner 并重钉 gitleaks。
- **CI 收敛到 Windows**：本 fork 只面向 Windows 10/11，`test`/`typecheck` 砍掉 Linux 半边；清掉 23 个上游遗留 workflow（发行渠道、文档站、社区机器人、beta 频道、自动生成提交）。其中 `publish.yml` 的构建 job 全带 `if: github.repository == 'anomalyco/opencode'`，在本仓恒为 false，本仓至今 0 个 release。
- **models.dev 连不上就整个构建失败**（`script/generate.ts`）：build 时裸 `fetch("https://models.dev/api.json")`，把快照烤进二进制。国内直连该域名无响应（实测 12s 超时），而 git 的 `http.proxy` 配置对 bun 的 `fetch` 无效——它只认 `HTTPS_PROXY`/`HTTP_PROXY` 环境变量，于是只给 git 配过代理的机器上 push 能通、build 必挂，报错 `ConnectionRefused` 完全看不出是代理问题。现在 fetch 失败时回退到本地缓存 `~/.redcode/cache/models.json`，**并打显眼 warning**（含缓存年龄）——悄悄用过期快照等于悄悄发布带旧定价/旧上下文上限/旧能力位的版本。回退只在「默认源 + 非 CI + 缓存存在」三条同时成立时发生：设了 `REDCODE_MODELS_URL` 不回退（缓存属于另一个源），CI 里不回退（发版构建不许静默用陈旧数据），无缓存则报错并提示 `HTTPS_PROXY` 与 `MODELS_DEV_API_JSON` 两条出路。

#### 诊断

- **Windows 上的命令超时从未被测到**（`test/tool/shell.test.ts`）：三个 abort 用例写的是 `echo started && sleep 60`，`&&` 在 Windows PowerShell 5.1 里是语法错误，命令直接解析失败，超时机制零覆盖。改用 `;` 后确认机制本身正常。
- **测试基线**：`test/tool`+`test/file`+`test/util` 失败数 38 → 3。除上述修复外，重录了停在 fork 点的 tool parameters 快照（4 次有意变更未跟进），并让 `apply_patch`/`skill` 用例跟上两处 fork 行为改动。

---

### [0.7.38] - 2026-07-27

> LLM 延迟排查结案 + 清理 TEMP 诊断代码 + profile 权限合并修复。

#### 新增

- **`llm.setup` 计时日志**（`session/llm.ts`）：每次 LLM 请求记录 resolve 和 prep 阶段耗时到 `~/.redcode/data/log/*.log`，用于区分本地管线延迟与服务端延迟。实测 resolve 1-35ms、prep 1-11ms，瓶颈确认在 provider 服务端。

#### 修复

- **Profile 覆盖时权限重复合并**（`agent/agent.ts`）：YAML profile 覆盖已有 agent 时，旧代码把 `defaults` 和 `user` 重复 merge 而非在 `existing.permission` 上叠加，导致权限规则顺序错乱。改为 `Permission.merge(existing.permission, profilePerms)`。

#### 变更

- **清理 TEMP 诊断代码**：删除 `session/diag.ts`，移除 `prompt.ts` 的 evloop 漂移探针、`message-v2.ts` 的 toModelMessagesEffect 耗时探针、`tools.ts` 的 Diag.toolStart/End 调用——LLM 延迟排查已结案，不再需要。

---

### [0.7.37] - 2026-07-25

> 中文 IME 括号自动跳入内部 + doom_loop 放宽到仅报错触发 + guardrail 工具分类与工作流规范更新。

#### 修复

- **中文 IME 自动闭合括号光标定位**（`prompt/index.tsx`）：onKeyDown 记录预期闭括号，onContentChange 检测 `value.endsWith(expectedClose)` 后 `moveCursorLeft()`，不额外插入字符。覆盖 `（）【】《》「」「"”’`。
- **doom_loop 放宽到仅工具报错触发**（`processor.ts`）：exactLoop 和 cycleLoop 均加 `.some()` 要求至少一个工具 `status === "error"` 才触发，正常完成的工具不再误拦。

#### 其他

- **guardrail 工具分类更新**（`guardrail-profiles/SKILL.md`）：明确"连续失败=工具 status error"不是连续工具调用；read/glob/grep/env 调高风险感知；各类工具放行。

---

### [0.7.36] - 2026-07-24

> 0.7.35 修完 edit.ts 那批之后，同一份 RedMon 文件又在完全不同的地方卡死——这次没有 evloop drift 报警，因为卡的不是 CPU，是一个没设超时的子进程 spawn。

#### 修复

- **格式化子进程加超时**（`format/index.ts`）：编辑后调用外部格式化程序（prettier/biome 等）的 `appProcess.run()` 之前完全没有超时,格式化程序在超大文件上卡住/异常慢时整个回合无限期挂起,且不会触发 evloop drift 诊断（事件循环本身没被占用,只是 await 永远不 resolve,这是跟 0.7.35 那批 CPU 型卡死不一样的信号）。加了 30 秒超时,复用已有的 `Effect.catch` 容错路径。`git/index.ts`/`worktree/index.ts`/`snapshot/index.ts`/`installation/index.ts` 有同样的缺口,这次只修了实际撞上的这一个。

### [0.7.35] - 2026-07-24

> 补上 0.7.34 那批修复漏掉的 5 个 replacer + 一个 pid 校验加固,顺带输入框括号自动补全。

#### 修复

- **`edit.ts` 剩余 5 个 replacer 补行数上限**（`LineTrimmedReplacer`/`WhitespaceNormalizedReplacer`/`IndentationFlexibleReplacer`/`EscapeNormalizedReplacer`/`TrimmedBoundaryReplacer`）：跟 0.7.34 修的 `fuzzyFindBestMatch`/`BlockAnchorReplacer` 同一类风险（不调用 levenshtein，风险更低，但对大文件仍是无上限的逐行扫描），统一按 3000 行封顶,不等第四次真出事故再补。
- **`ContextAwareReplacer` 补行数上限**：0.7.34 那批修复漏掉的兄弟函数,结构跟 `BlockAnchorReplacer` 一样但没上限——同一份 RedMon `data/species.json` 又把事件循环卡死了 18.7 分钟（`blockedMs=1123864`）,现已按同样模式加 `CONTEXT_AWARE_MAX_CONTENT_LINES=3000` 修复。
- **杀进程前拒绝退化 pid**（`core/cross-spawn-spawner.ts`、`desktop/main/server.ts`）：`taskkill`/`process.kill` 之前加校验,拒绝 `undefined`/`≤1`/调用者自己的 pid——Unix 侧原本把 `-pid` 传给 `process.kill` 做进程组广播,pid≤1 时会变成"杀自己的组"或"广播给调用者有权限信号的所有进程"。

#### 新增

- **输入框内 `(` 自动补全**（`cli/cmd/tui/component/prompt/index.tsx`）：光标处输入 `(` 自动补全成 `()` 并把光标留在括号中间。

### [0.7.34] - 2026-07-22

> 两处修复:大文件编辑时精确匹配失败会掉进不设上限的模糊匹配兜底,阻塞单线程事件循环数分钟、键盘UI全无响应;canary 防注入标记措辞太像"给你用的信息",导致模型往自己的 memory 日志写会话总结时引用它而被误杀会话。

#### 修复

- **大文件编辑触发模糊匹配无限放大,冻结整个进程**(`tool/edit.ts`):`fuzzyFindBestMatch`(exact match 失败时的诊断兜底,用来提示"最相似的位置在哪")对文件大小没有任何上限,对目标文件的每一行都跑一次滑动窗口 + Levenshtein 编辑距离计算,复杂度约 `文件行数 × 搜索块大小²`。真机复现:Build 模式对 RedMon `data/species.json`(24666 行、506KB)做一次编辑,exact match 未命中掉进这条兜底,把单线程事件循环锁死约 6.5 分钟(日志里消息流在某一刻停止,下一条日志时间戳相差 391257ms,期间无任何输出,esc/输入全无响应)。定位靠已有的 `TEMP DIAG evloop drift` 探针 + 这段日志时间差,不是靠猜。`BlockAnchorReplacer`(真正参与匹配、非仅诊断)有同类风险:JSON 文件里 `},` 这类锚点行过于常见时,候选块能炸到几百个,每个还要逐行跑 Levenshtein。修法:两处都加了熔断上限——文件超过 3000 行跳过模糊匹配兜底(退化为普通"未找到"报错),候选块超过 50 个直接放弃打分,两个兜底都只是"锦上添花"的诊断辅助、不影响匹配正确性,牺牲提示精度换来不锁死整个进程完全值得。真机对着实际的 `species.json` 验证过:原本会挂的路径现在 0.8ms 返回;另外测过小文件场景确认模糊匹配没有回归。
- **canary 防注入标记措辞太像正常信息,导致会话被误杀**(`session/prompt.ts`、`session/canary.ts`):注入系统提示词的那行写的是 `Session marker: RC-<hex>`,紧挨着上一行 `Today's date: <date>`,措辞、格式跟"给你用的信息"一模一样。真机复现两次:RedMind 往自己的 memory 日志写会话总结时,很自然地把这个"Session marker"当成合理的会话标识拿来当标题引用,撞上了纯字符串匹配的泄露检测,会话被强制终止——不是真的泄露了什么,只是模型把一句"看起来像信息"的话当信息用了。修法:改成明确的"绝不能展示/记录/复述/以任何方式包含这个值"指令,检测机制本身(纯子串匹配)未变。这样应该能大幅减少误伤,而且如果真有内容"无视了这条明确指令"还是复述出来,反而是比之前更强的信号。

### [0.7.33] - 2026-07-22

> 两处根因修复：`bun run dev` 下本地 MCP 的 `$REDCODE_ROOT` 会展开成当前打开的项目目录而不是 RedCode 自身安装根，导致依赖它的本地 MCP 全部连接失败；项目 id 解析失败时全部共享同一个 `global` sentinel 行，导致工作区列表里的项目会被后打开的另一个项目静默挤掉。

#### 修复

- **本地 MCP 因 `$REDCODE_ROOT` 解析错误而连接失败**（`mcp/index.ts`）：`findRedcodeRoot()` 只从 `process.execPath` 向上找安装根，`bun run dev` 下 execPath 是 `bun.exe`，永远找不到，于是静默回退到 `InstanceState.directory`（当前打开的目标项目，而非 RedCode 自身）。配了 `cwd: "$REDCODE_ROOT"` + 相对路径命令的本地 MCP（如内置的进程管理、SQLite 查询等）因此在错误目录里找不到脚本文件，报 `Module not found` / `MCP error -32000`。之前配置整体解析不了（见下条）时这个 bug 一直被掩盖，配置修好后才第一次暴露。修法：找不到时追加一次基于 `import.meta.dirname`（源码文件自身位置）的向上查找，编译产物场景下这是虚拟 bunfs 路径、安全地查不到、不影响原有分支。
- **项目 id 解析失败时共享同一个 `global` 行，工作区列表互相挤掉**（`project/project.ts`）：`Project.fromDirectory` 在"找到 git 仓库但算不出内容哈希 id"的几种情况下（没有 git 二进制、`git rev-parse --git-common-dir` 失败、还没有根提交——比如 rollback/reset 过程中）统一落到 `ProjectID.global` 这个唯一 sentinel。`ProjectTable` upsert 以 id 为冲突键，所有命中这个兜底的目录共享一行，谁最后打开谁的 `worktree` 就把上一个目录挤没了，表现为"项目从工作区选择器里消失"。真机复现：给该函数临时加调试日志（已撤销）定位到具体分支，并在测试过程中亲眼抓到共享行被另一个无关目录实时覆写。修法：改成按目录绝对路径算一个稳定的 fallback id，让每个解析失败的目录有自己独立的行，不再互相踢；同时把已有的"global → 真实 id 时迁移会话"逻辑，扩展到覆盖新的 path-fallback id，避免会话散落。真正意义上"完全没有 `.git`"的分支不变，继续用字面量 `global`（`file/index.ts` 里 HOME 目录的专属语义依赖这个）。

### [0.7.32] - 2026-07-21

> 新增 RedMind agent 模式——心有 Red 行前先问（bash 操作弹框确认），日常读写自动放行。README 中英文版重构：替换 hero 图为启动截图，新增与上游 OpenCode 的对照表。权限审计完成，bash 列为高危权限。

#### 新功能

- **RedMind agent 模式**（`agent/agent.ts`）：介于 build（权限全放）与 plan（只能写计划）之间的折中模式。常规操作（read/edit/grep/glob/webfetch/websearch）自动执行，bash 等系统命令弹框征询同意后再执行。
- **`default_agent` 配置生效**：用户 `~/.redcode/redcode.jsonc` 设 `default_agent: "redmind"` 后新会话默认使用 RedMind。

#### 文档

- **README 重构**（`README.md` / `README.en.md`）：替换启动截图为 hero 大图（`docs/assets/screenshot.png`），新增"为什么是 RedCode？"对照表突出 97%+ 缓存命中率、DeepSeek 计价修复、中文体验、稳定性、国产模型适配。
- **权限审计**：审查全部 16 个权限项，`bash` 列为唯一高危全放权限，`external_directory` / `repo_clone` 已有封锁无需额外处理。

### [0.7.31] - 2026-07-20

> 永久移除 FreeLLMAPI 供应商 + Anthropic URL 修正 + workspace selector 支持外部新目录 + 模板安全加固。（发布次日修复：selector 重构引入的冷启动渲染回归、路径输入不支持粘贴，见下方修复条目。）

#### 新功能

- **Workspace selector 支持打开新项目目录**（`cli/project-selector.ts`）：列表底部新增"Open a different directory..."选项，选中后进入路径输入模式，Enter 确认 Esc 返回，支持启动 RedCode 于任意未注册的工作目录。
- **RedCode 注册到 PATH**：创建 `~/.bun/bin/redcode.cmd` 批处理入口，任意终端输入 `redcode` 即从当前目录启动。

#### 修复

- **FreeLLMAPI 反复重现**（`.opencode/redcode.home.jsonc`、`~/.redcode/redcode.jsonc`）：根因是 `merge-home-config.ts`（`sync-home.bat` → `build.bat` 调用链）每次合并模板时，因 FreeLLMAPI 曾在 `redcode.home.jsonc` 模板中存在，用户手动删除后模板又会补回（`deepMergeUserWins` 的"用户没有的键就加"逻辑）。修法：从模板彻底移除 `opencode` provider 段，用户配置中删除并加入 `disabled_providers` 双重保险。
- **Anthropic 供应商 URL 缺 `/v1`**（`.opencode/redcode.home.jsonc`、`~/.redcode/redcode.jsonc`）：`baseURL` 从 `https://api.chhlink.xyz` 补为 `https://api.chhlink.xyz/v1`，模型从 `claude-sonnet-4-20250514` 更正为 `gpt-5-chat-latest`（实为 Codex GPT 模型代理）。
- **编译版 exe 冷启动（Explorer 双击 / 全新终端窗口）下文字不可见，中文尤甚**（`cli/project-selector.ts`）：根因是 workspace selector 这次改动里，`render()` 把手动拼接的 `content += ... + "\n"` 换成了 `buf: string[]` 数组 + `buf.join("\n")`——`join` 不会在最后一个元素后面补分隔符，导致新版本比旧版本**少了一个末尾换行**。这直接影响紧接着的 `renderedLines = content.split("\n").length`：每次少算一行，选择器每次重绘、以及退出时用 `"\x1b[" + renderedLines + "A\x1b[J"` 收尾的光标回退量都跟着错位一格，把一个位置错误的光标状态交给了紧接着启动的主 TUI，赶上它自己的终端能力探测（`capabilities.unicode`/`rgb`/`explicit_width`）跟这个错位的光标产生冲突，导致探测失败、宽字符/默认色文字整体画不出来——中文首当其冲，因为宽字符对光标列位置最敏感。通过逐段二分（0.7.30 baseline 上只叠加本文件改动 → 复现；只叠 stdin 排空 → 不解决；再叠这个末尾换行 → 问题消失）精确定位，非猜测。修法：`const content = buf.join("\n") + "\n"`，一个字符。用已开着的终端敲 `redcode` 命令不受影响，因为那条路径从不冷启动。`cleanup()` 里的 stdin 排空作为防御性加固保留，但确认不是本问题根因。**同时移除**之前基于"能力协商随机失败"这个错误猜测加的三个强制开关（`win32ForceTerminalCapabilities()`：`OPENTUI_FORCE_WCWIDTH`/`OPENTUI_FORCE_EXPLICIT_WIDTH`/`COLORTERM`）——对照测试证明它们不是中性兜底而是有害：同样带换行修复的构建，无强制开关正常、带强制开关复现渲染损坏；且手动单测 `OPENTUI_FORCE_EXPLICIT_WIDTH=1` 时 logo 整个消失，强制 CPR 显式宽度测量在冷启动控制台上本身就是不可靠路径，强制开启反而制造了它想防的问题。教训记录在案：症状驱动的"修复"在真根因找到后必须重新验证是否该保留，而不是默认叠着。opentui 本身与此问题无关（已验证），跟下面的版本升级是两件独立的事。
- **Workspace 路径输入模式不支持粘贴**（`cli/project-selector.ts`）：新增的"Open a different directory..."路径输入框，`stdin` 的 `data` 事件里粘贴内容是作为一整块（`key.length > 1`）到达的，而输入判断写的是 `key.length === 1`，导致粘贴的路径被原样丢弃、只能逐字手敲。修法：改成只要不是转义序列开头就按可打印内容处理（过滤掉控制字符），单字符键入和整段粘贴统一走这条路径。修复后已用 ConPTY 驱动编译版 exe 做过端到端验证：冷启动 → 列表导航 → 进入路径输入 → 整段粘贴回显 → 确认后主 TUI 于目标目录启动，全链路通过。

#### 已评估、延后

- **opentui 0.2.15 → 0.4.3 升级**：`@opencode-ai/plugin`（第三方 auth 插件带入的传递依赖）已经要求 `@opentui/core >= 0.4.3`，版本长期不对齐有重演 [0.7.8] 那次"同一个包不同 content-addressable hash 导致 TS `#private` 字段类型不兼容"的风险，值得做。也顺带评估了把 `build.ts` 里 tree-sitter worker 的嵌入方式改成跟上游 anomalyco/opencode 一致的做法（不把 `parser.worker.js` 真实路径塞进 `Bun.build` 的 `entrypoints`，改成 `Bun.file(...).text()` 读成字符串后以虚拟文件名通过 `files` 选项嵌入——原写法在 opentui >=0.4.5 上会撞见一个已知未修复的编译产物崩溃，[anomalyco/opentui#1275](https://github.com/anomalyco/opentui/issues/1275)）。**这次没有落地**：当时升级后重测冷启动仍复现渲染问题，一度归因为"无法排除 0.4.3 重新引入时序敏感性"——事后查明那次测试构建里还带着后来被证明有害并已移除的三个强制环境变量（见上方冷启动修复条目），失败大概率是它们造成的，与 0.4.3 本身无关。但 0.4.3 至今没有在"无强制开关"的干净状态下重测过，因此维持 0.2.15 不动，留待有完整测试窗口时单独升级验证；升级路径、`build.ts` 改造方案、#1275 规避方法均已调研完毕，下次可直接执行。

#### 安全

- **模板凭证清理**（`.opencode/redcode.home.jsonc`）：移除公仓模板中的真实 API key，替换为占位符 `sk-your-key-here`。私有配置 `~/.redcode/redcode.jsonc` 保留真实 key，sync 机制不受影响。
- **Gitleaks 秘密扫描接入 CI**（`.github/workflows/test.yml`）：新增 `gitleaks` job，每次 push/PR 自动检测密钥泄露，避免凭证误提交公仓。

#### 优化

- **模型能力标记**（`session/system.ts`）：DeepSeek V4 Flash/Pro 补充 `tool_call+reasoning+temperature` 标记、上下文窗口对齐 1M；Step 3.7 Flash 补充 `tool_call+temperature`、上下文窗口对齐 256K。
- **Compaction 阈值提升**：`compaction.threshold` 从 150000 → 400000，适配 1M 上下文窗口，减少不必要的压缩。
- **Today's date 位置优化**（`session/prompt.ts`、`session/system.ts`）：date 从缓存的 `<env>` 头部移至每次刷新的小段尾部，减少 provider prefix cache 每日失效开销。

---
### [0.7.30] - 2026-07-17

> GUI session list 跨 project 显示——不传 scope 时有 directory 就走 listGlobal，不限 project_id。

#### 修复

- **GUI 其他项目会话显示为空**（`session/session.ts`）：`Session.list()` 在不传 scope 时强制加 `project_id` 条件，GUI 的 `loadSessions` 只传 directory 不传 scope，其他项目的 session 被 project_id 过滤排掉。修法：scope 未指定且有 directory 时走 `listGlobal`，直接按 directory 过滤，不限制 project_id。
- **ai-sdk.ts raw cache tokens 累积保护**（`session/llm/ai-sdk.ts`）：DeepSeek 返回的 `prompt_cache_hit_tokens` 可能是累积 KV-cache 大小而非单次请求值，加 `safeDeepSeekCacheRead` 兜底过滤。`prompt_cache_miss_tokens` 同理。
- **transform.ts mistral typo**（`provider/transform.ts`）：`toLocaleLowerCase` → `toLowerCase`。
- **v2 session handler middleware**（`server/routes/.../v2/session.ts`）：添加 `InstanceContextMiddleware` + `WorkspaceRoutingMiddleware`，directory fallback 从路由上下文读取。

---
### [0.7.29] - 2026-07-17

> 事件钩子系统类型修复——stash 中的钩子代码（compact.post、session.start/end、user.prompt.submit、session.stop、tool.execute 三阶段）通过 typecheck。

#### 修复

- **`Effect.catchAll` → `Effect.catch`**（`session/compaction.ts`、`session/prompt.ts`、`session/session.ts`、`session/tools.ts`）：Effect v4 beta 移除了 `catchAll`，统一改用 `Effect.catch`，涉及 8 个调用点。
- **钩子函数泄漏 Plugin.Service**（`session/prompt.ts`、`session/session.ts`）：`cancel()`/`prompt()`/`createNext()`/`remove()` 内直接 `yield* Plugin.Service` 向 `Interface` 类型函数的 requirements 中泄漏了 Plugin 依赖。已改为闭包捕获或 `Effect.serviceOption` 模式，与 `permission/index.ts:181` 一致。
- **Model schema 字段名**（`session/session.ts`）：`modelID` → `id`，对齐 Model 类型定义。
- **task.test.ts 类型适配**（`test/tool/task.test.ts`）：no-op Plugin 层加入 `Layer.mergeAll`，测试 Effect 能获取 Plugin.Service。

### [0.7.28] - 2026-07-17

> 0.7.27 长会话压测通过——1000 万+ token 会话验证后台子代理默认开启改动，缓存命中率、DCP 触发时机、子代理后台交互均未发现问题。

#### 功能

- **PreToolUse 阻塞钩子系统**（`packages/core/src/plugin.ts`、`packages/opencode/src/session/tools.ts`、`packages/plugin/src/index.ts`）：新增 `"tool.use.pre"` 挂载点，在 AI SDK 执行 `execute` 回调之前拦截。钩子可以设置 `output.denied = true` 阻断工具调用，工具永不执行。内部 `HookSpec` 和外部插件 SDK `Hooks` 接口同步对齐。fail-open 设计：钩子崩溃不影响工具执行，无钩子注册时行为零变化。
- **内置 safe-shell 守卫插件**（`packages/opencode/src/plugin/safe-shell.ts`）：自动注册 `"tool.use.pre"` 钩子，拦截 `bash` 工具的危险命令。覆盖：根文件系统删除（`rm -rf /`）、直接磁盘写入（`dd`/`mkfs`/`fdisk`/`mkswap`）、fork 炸弹（`:(){`）、系统命令（`shutdown`/`reboot`/`poweroff`/`halt`）。无配置、无需主动触发，默认全量生效。模型尝试危险命令时直接返回 blocked 结果。

#### 诊断

- **0.7.27 压测确认**：针对 0.7.27 的 `experimentalBackgroundSubagents` 默认开启、`task.ts` 后台模式提示词强化、以及此前的 DCP/原生 compaction 双重触发修复，用户实测跑了一轮 1000 万+ token 的长会话。三个此前重点关注的方面——上下文缓存命中率、DCP compress 触发时机是否仍会与原生 compaction 打架、子代理后台派发后主界面交互是否顺畅——均未复现问题。无代码改动，仅记录验证结果。

### [0.7.27] - 2026-07-17

> 后台子代理默认开启——派发子代理不再冻住主界面；配套修好模型不知道该用它的提示词缺口；顺手根治了 registry/task 测试套件的间歇性超时。

#### 功能

- **`experimentalBackgroundSubagents` 默认开启**（`effect/runtime-flags.ts`）：非后台模式下 `task` 工具会同步等子代理跑完整个 session 才返回，而 `session/prompt.ts` 的主循环在此期间一直把 session 标记 busy——主界面全程没法交互，等于白设计了后台派发这条路。现在默认打开（`background: true` 参数和配套的 `task_status` 轮询工具默认就在模型可见的工具 schema 里），设 `REDCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=false` 可退回旧的全阻塞行为。

#### 修复

- **模型不知道该用后台模式**（`tool/task.ts`）：开关打开后实测（RedMon 项目，DeepSeek V4 Flash）连续派发两个 explore 子代理，主 session 分别被冻住约 54 秒和 100 秒——查日志（`~/.redcode/data/log/dev.log`）确认 `task_status` 工具确实已注册、开关是真的生效了，但模型从没传 `background: true`。根因是 `BACKGROUND_DESCRIPTION` 只讲了"怎么用"，没讲"什么时候该用"，而 `task.md` 唯一相关的指引（单条消息并发起多个 agent）跟"陆续派、派完还想接着聊"这种场景对不上。改写 `BACKGROUND_DESCRIPTION`，明确告诉模型：只要下一步动作不直接依赖这次结果，默认优先 `background=true`。改完实测生效。

#### 测试

- **`registry.test.ts`/`task.test.ts` 间歇性超时根治**：原怀疑是 LSP/git/ripgrep 二进制发现拖慢（实际都在 `InstanceState.make()` 后惰性触发，测不到），真正原因是 `Plugin.defaultLayer` 每个测试都重建一遍，会真的动态 import server 模块、跑全部内置 auth 插件，且只要 config 里 `plugin_origins` 非空就调 `config.waitForDependencies()`——这是真实的 npm 依赖校验，读的是机器上真实的 `~/.redcode/redcode.json`，内部超时 15 秒，实测每个测试白白卡 3.5-4.2 秒，正好卡在 bun test 默认 5 秒超时边缘，导致每次挂的测试都不一样。9 个内置 auth 插件都不注册 `tool` hook，用一个 no-op `Plugin.Service` 换掉即可，测试关心的注册/过滤逻辑不受影响。`registry.test.ts` 单文件耗时从 44-63 秒（常伴超时）降到稳定 5-8 秒。`task.test.ts` 因为用的是打包好的 `ToolRegistry.defaultLayer` 没法单独换其中一个依赖，照着 `tool/registry.ts` 源码原样重建了一份组合、只换 Plugin，需要留意：以后 `defaultLayer` 的真实组合变了，这份手抄副本得跟着手动同步。
- 同时补了几个原本隐式依赖旧默认值（`experimentalBackgroundSubagents: false`）的测试断言，改成显式传 `noBackground` 测试层，不再依赖环境默认值。

### [0.7.26] - 2026-07-17

> DCP 压缩与原生 compaction 双重触发修复；依赖漏洞排查（87→65，critical 清零）；新增每日依赖审计 + npm provenance + 容器化隔离指南。

#### 修复

- **DCP compress 与原生 compaction 双重触发**（`session/prompt.ts`）：DCP 的 `compress-range`/`compress-message` 工具调用要等下一次请求发出才真正生效地缩减上下文，但那一轮刚结束时 `lastFinished.tokens` 报的还是压缩前的用量——下一步循环立刻拿这个旧数字判断 `isOverflow`，原生阈值 compaction 跟着又触发一次。两套系统本是分工（DCP 在 50k-100k 区间做任务边界感知的主动压缩，原生 150k 阈值只是兜底），不是要合并成一个。加了 `EXTERNAL_COMPRESS_TOOLS` 检查：刚结束那一轮如果有已完成的 DCP compress 工具调用，这一轮跳过阈值检查，等下一次真实请求体现出压缩效果后再评估。

#### 安全

- **`dompurify` XSS 系列漏洞修复**（`packages/ui/package.json`）：`3.3.1 → 3.4.12`。排查确认 `markdown.tsx` 里 LLM 回复/reasoning/glob-grep 工具输出统统经 `DOMPurify.sanitize()` 渲染进 app/desktop 聊天界面，且代码用到了 `addHook`/`USE_PROFILES`，正好踩中这批漏洞点名的两种用法——是真实可达路径，不是理论风险。
- **清理两个死依赖**：`packages/opencode` 里从未被任何源码引用的孤儿 `minimatch` pin（装的是漏洞版本 10.0.3，排查确认没有代码路径真正用到它），以及自 v0.1.0 起从未被 import 过的 `@aws-sdk/client-s3`（critical 级 `fast-xml-parser` 漏洞正是靠它才"存在"于依赖树里，实际零可达路径）。两个都直接删除。
- **`bun audit` 复查**：87 → 65 个漏洞，critical 1 → 0。剩余的集中在自建官网/企业后端（`packages/web`/`packages/enterprise`，不随产品分发）和 dev-only 工具链，按正常节奏处理即可。

#### 构建 / 文档

- **每日依赖审计**（新增 `.github/workflows/audit.yml`）：daily cron 跑 `bun audit --audit-level=moderate`，之前完全没有自动化在盯这个。
- **npm 发布重新启用 provenance**（`publish.yml`）：`NPM_CONFIG_PROVENANCE` 一直是 `false`，workflow 早就有 `id-token: write` 权限，基础设施齐了只是没打开。
- **容器化隔离指南**（新增 `packages/opencode/docs/containerization.md`）：`SECURITY.md` 原来那句"自己找 Docker/VM"扩成两个今天就能用的方案（用仓库自带 `packages/opencode/Dockerfile` 打镜像跑、VM 隔离要点），外加一个"只把工具调用路进沙箱"的设计方向说明（未实现，只是把形状写清楚）。

#### 诊断

- **evloop drift 排查修正**（`session/prompt.ts`、`session/diag.ts`）：之前怀疑 DCP `buildPriorityMap` 每轮全量重新分词是长会话卡顿的元凶——查证后发现不成立，该函数被 `compress.mode !== "message"` gate 挡住，当前配置（`mode: "range"`）下根本不会执行这条路径。翻了 `~/.redcode/data/log/` 里现存的全部 16 条 `TEMP DIAG evloop drift` 记录，`heapMB` 全部在 70-155 区间，均出现在进程启动阶段，与多个 MCP server（尤其远程的）连接、插件加载、后台 npm install 超时强相关——跟 DCP、跟长会话都对不上。是否与 0.7.25 描述的 2000 万+ token 长会话卡顿是同一个问题，还是那批日志已经轮转清掉、这是另一个独立问题，尚未确认。

### [0.7.25] - 2026-07-16

> 长会话卡顿排查收尾：漂移探针坐实"没坐实"（>2000万 token 会话跑下来未复现明显卡顿），顺手清了几处一直在刷屏的日志噪音 + 一个装错的本地 MCP。

#### 修复

- **`@opencode-ai/plugin` 后台安装失败无限重试刷屏**（`config/config.ts`）：每次 `Config.load()` 都会对同一个必然失败（网络/registry 问题）的目录重新触发一次安装并打 warn，长会话里每隔几分钟到二十几分钟复发一次。按目录记住上次失败时间，10 分钟冷却期内跳过重试，冷却期外照常重试——网络恢复后仍能自愈，不是一次性拉黑。
- **MCP 工具调用重试无退避、吞掉真实报错**（`mcp/index.ts`）：3 次重试间隔固定 1 秒，对瞬时网络抖动太急；且失败日志只打了 `attempt` 序号，没打实际错误信息，完全没法诊断。改成指数退避（1s/2s）+ 补上 `err.message`。
- **MCP `prompts`/`resources` 未实现被当 ERROR 打**（`mcp/index.ts`）：不少小型 MCP server（typegraph/sqlite-query/su-prememory/mcp-process-mgmt 等）本来就没实现这几个可选 capability，服务器如实回了 `MethodNotFound`（-32601），代码却无脑当故障打 `log.error`，每次连接/重连都刷一遍。识别该错误码后降级为 debug，真错误照常 error。
- **vision MCP 装错了本地 server**（`.opencode/redcode.home.jsonc`）：`command` 是裸命令 `"vision-mcp-server"`，PATH 解析到全局 npm 装的旧版本，硬要求 `MODELSCOPE_TOKEN`、没有本地 Ollama 兜底，启动直接报错退出。上次 0.7.23 之前切到 `minicpm-v4.6:f16` 时其实已经新建了 `plugins/vision-mcp-local/index.js`（默认走本地 Ollama），只是撞名了没把 `command` 改过去，一直在调错的那个。改成显式指向新脚本。

#### 诊断

- **事件循环阻塞探针（TEMP，保留）**（`session/message-v2.ts`、`session/prompt.ts`、`session/tools.ts`、新增 `session/diag.ts`）：0.7.24 加的漂移探针补上了工具归因（`active` 字段——阻塞发生时若有内置工具/MCP 工具/DCP compress 正在跑会标出来）和 `heapMB`/`rssMB`，用来交叉验证是不是 DCP 同步 tokenizer 或缓存膨胀在捣鬼。实测 2000+ 万 token 的长会话里探针触发的漂移都在 300~950ms 量级，且从未抓到 DCP compress 处于 `active` 状态，`toModelMessagesEffect` 侧探针也从未触发——本次没能坐实一个具体阻塞源，但也没再复现 0.7.19/0.7.24 描述的那种明显卡顿。探针**故意保留**，不是忘了删，方便下次直接看日志复诊：
  - **看哪**：`~/.redcode/data/log/` 下当次会话的时间戳日志（或 `dev.log`），搜 `TEMP DIAG evloop drift` 和 `toModelMessagesEffect slow`。
  - **字段怎么看**：`blockedMs` 是这次事件循环阻塞了多久（>300ms 才会打）；`active` 是阻塞时正在跑的工具+已耗时（如 `compress:2481ms`），空着说明阻塞时没有工具在跑，嫌疑转向 GC/缓存；`heapMB`/`rssMB` 是当时的堆/常驻内存，持续走高要怀疑 `msgPin`/`modelMsgs` 缓存膨胀（见 `session/prompt.ts` 里 `_caches`）。
  - **复发了怎么办**：把 `blockedMs`、`active`、`heapMB` 三者按时间对齐看——`active` 有值就是那个工具的问题；`active` 空但 `heapMB` 持续走高就是缓存/GC；两者都不像就再加埋点。
  - **确认没事了想删**：三个源文件里搜 `260716 Red TEMP diag` 逐处删掉，再删 `session/diag.ts`，跟 6f7e7f2 那次删法一样。

### [0.7.24] - 2026-07-15

> 修复 YAML agent profile 的 subagent 权限通配符误伤 MCP 工具和 DCP compress——子代理静默失去 MCP 访问，压缩权限被误判 deny 导致卡住不压缩也不继续。

#### 修复

- **[核心] subagent `"*": deny` 误伤 MCP/插件权限**（`agent/profile/types.ts`）：0.7.23 引入的 `toolsToPermissionConfig()` 给所有 `mode: subagent` 的 profile 加了裸通配符 `config["*"] = "deny"`，但 `toolPermissionMap` 只登记内置工具名，jCodeMunch/TypeGraph 等 MCP 工具、DCP 插件自己的 `compress` 工具永远不可能出现在 YAML `tools:` 白名单里被重新 allow 回来，导致所有 subagent 静默失去 MCP 访问；DCP 侧 `resolveEffectiveCompressPermission` 复用同一条通配规则，把 compress 权限误判为 deny——上下文超限时 nudge 仍会提示"必须立即压缩"，但工具本身不可用，表现为卡住不压缩也不继续干活。改为只对 `toolPermissionMap` 已登记的内置工具类别做默认拒绝，其余权限键落回原有 defaults/user 判定。

#### 诊断

- **事件循环阻塞探针（TEMP，待删）**（`session/message-v2.ts`、`session/prompt.ts`）：0.7.19 修的 snapshot `structuredPatch` 冻主线程问题疑似以另一种形式复发（长会话侧出现阻塞），重新加了独立漂移探针（不预设阻塞点）+ `toModelMessagesEffect` 拆分计时排查。目前 `toModelMessagesEffect` 侧探针从未触发，说明这次瓶颈不在 message 转换链路，定位到具体源头后随手删除。

### [0.7.23] - 2026-07-12

> YAML agent profiles——声明式子代理定义，支持 `extends` 继承 + `tools` 白名单自动转 Permission。

#### 新增

- **YAML agent profiles**（`agent/profile/` + `agent.ts`）：新增 `src/agent/profile/` 模块，支持用 YAML 文件声明式定义 agent。内置默认 profiles（`agent.yaml`/`general.yaml`/`explore.yaml`），用户可在项目 `.opencode/profiles/` 下自定义。支持 `extends` 继承链避免重复定义，`tools` 字段白名单自动映射为 Permission 规则集（子代理自动 deny 未列出工具）。零 system prompt 缓存影响——所有缓存键基于 sessionID，agent.prompt 不在任何缓存键中，扩展来源不同但同一文本的 LLM 请求字节序列完全相同。
- **`js-yaml` 依赖**：新增 `js-yaml` + `@types/js-yaml`。

### [0.7.22] - 2026-07-11

> `opencode-go` provider 补全官方 CNY 定价——DeepSeek/MiMo 通过 `opencode-go` 接入时价格用 ¥1/M 而非 models.dev USD 价目。

#### 修复

- **`opencode-go` provider CNY 定价缺失**（`provider.ts`）：数据库分析发现 11 个 session 的 `providerID` 为 `opencode-go`（通过 `auth login` 自动发现配置），此 ID 不在 `CNY_PRICING` map 中（仅含 `deepseek`/`xiaomi`/`stepfun`），计算成本回退到 models.dev 的 USD 默认价。在 `CNY_PRICING` 新增 `opencode-go` 条目，deepseek-v4-flash / pro 共享官方 CNY 价目（¥1/M input, ¥2/M output）。同步补全 `CNY_PROVIDERS`（`sidebar/context.tsx`、`home/footer.tsx`、GUI `session-context-metrics.ts`），确保 UI 正确识别成本币种。

### [0.7.21] - 2026-07-10

> Todo 层级子任务——`id`/`parent_id` 可选字段，模型可表达子任务嵌套，TUI/GUI 侧栏与 composer 均按层级缩进渲染。

#### 新增

- **Todo 层级子任务**（`session/todo.ts`、`tool/todo.ts`、`session.sql.ts`、迁移 `20260710070135_add_todo_hierarchy`）：Todo 结构新增可选 `id`/`parent_id` 字段，模型可给任务标 id（如 `"2"`）并让子任务用 `parent_id` 指向它（如 `"2.1"`）表达层级；不填则完全等同旧的纯扁平列表，向后兼容。TUI 侧栏（`sidebar/todo.tsx`）、GUI composer（`session-todo-dock.tsx`）均按 `parent_id` 链条计算缩进层级渲染，防环/防越界兜底深度上限 5 层。
- **`TodoItem` 组件支持 `depth`**（`component/todo-item.tsx`）：新增可选 `depth` prop 控制缩进。
- **plugin SDK `TuiSidebarTodoItem` 补字段**（`plugin/src/tui.ts`）：追加 `id`/`parent_id`，插件可读取层级信息。

### [0.7.20] - 2026-07-09

> Snippet 系统接入——read 工具自动提取符号并注册 snippet，支持按 snippet ID 精准重读代码片段。

#### 新增

- **Snippet 系统完整接入**（`read.ts`、`session/snippet.ts`、`tool/snippet.ts`）：read 工具读取 TS/JS/Python/Go/Rust 文件时，用正则提取顶层符号（函数/类/接口/类型等），注册为 snippet 并在输出末尾附 `<snippets>` 索引。模型可用 `snippet` 工具按 ID 精准重读某个函数/类，不必重读整个文件，省上下文窗口。灵感来自 deepcode-cli 的 snippet 编辑系统。
- **snippet 工具增强**：去掉无用的 `filePath` 参数；输出带行号前缀和 `[path#TAG]` header，可直接配合 edit hashline 格式使用。
- **snippet service 修复**：`get()` 改为跨所有 messageID 搜索（原按 messageID 分桶，read 和 snippet 工具的 messageID 不同导致永远查不到）。

### [0.7.19] - 2026-07-09

> 修复 snapshot Myers diff 冻死事件循环（采样分析器实测 59s），清理排查探针。

#### 修复

- **[核心] snapshot structuredPatch 冻死事件循环**（`snapshot/index.ts`）：`patch()` 调用 diff 库的 `structuredPatch`（Myers O(ND) 差分），对大文件或病态编辑距离无护栏，采样分析器实测单次调用卡 59s（6274/6278 samples）冻死主线程，流式 delta 在冻结期间缓冲、解冻后 burst 涌出——即敏敏"等几十秒→整段话一瞬间刷出"的根因。加 256KB 大小护栏（超限跳过全量 patch）+ 2s timeout 兜底，验证 blockedMs 从 49398~70962ms → 消失。
- **清理 TEMP 诊断探针**（`provider.ts`、`llm.ts`、`message-v2.ts`）：删除 260709 排查用的事件循环卡顿探针、JSC 采样分析器、fetch 计时、transformParams 计时、toModelMessages 计时。

### [0.7.18] - 2026-07-08

> TUI 消息列表 windowing——长会话（400+ 消息）输入不再卡顿，清理 DIAG 探针。

#### 修复

- **[核心] TUI 消息列表无虚拟化，长会话输入卡顿**（`routes/session/index.tsx`）：`<For each={messages()}>` 全量挂载全部消息（如 422 条），每条内含 tool/reasoning/text part 全部建成 opentui renderable，opentui 每次按键触发 yoga `calculateLayout` O(总节点) 全树布局，数百节点时每次敲字重算→输入回显延迟 1 秒+。改为消息级 windowing：默认只渲染最近 50 条消息（`MSG_WINDOW_DEFAULT=50`），滚动到顶部自动加载更多（`MSG_WINDOW_STEP=50`），Ctrl+Home 展开全部。屏外消息不进 yoga 树、不建组件——同时省下布局+组件+绘制开销。所有导航（Page Up/Half Page Up/Previous Message/Timeline/Fork/Jump to Last User Message）均适配 windowing，自动展开窗口定位目标消息。切换会话时重置窗口大小。
- **清理 DIAG 探针**（`provider.ts`、`llm.ts`）：删除 260708 排查用的临时 fetch begin/headers 计时日志和 transformParams 计时日志。

### [0.7.16] - 2026-07-07

> 修复 LSP 的 tsserver 无内存上限、大 TS monorepo 下涨到 2.5G+ 吃掉 GUI 绝大部分内存。

#### 修复

- **[核心] TypeScript LSP 的 tsserver 无内存上限**（`lsp/server.ts`）：排查"小宋跑任务吃 2.5G 内存"时按父进程树实测，真凶既不是 Electron（renderer 仅 ~530MB）也不是 sidecar 本体（仅 ~276MB），而是 RedCode 内置 LSP 启动的 `typescript-language-server` 再 fork 出的 `tsserver.js`——它默认没有 `--max-old-space-size` 上限，在本仓这种大 TS monorepo 上把整个类型图加载进内存后一路涨到 2508MB，被任务管理器显示成一个"独立"的 Node.js JavaScript Runtime，之前一直被误判为 sidecar/消息缓存。给 `Typescript.spawn` 的 `initializationOptions` 加 `maxTsServerMemory: 2048`，typescript-language-server 会将其转成 tsserver 的 `--max-old-space-size` 并在超限时自动重启 tsserver，内存不再无限增长。

### [0.7.17] - 2026-07-07

> 修复 `redcode doctor` 一次性命令在 Windows 下无法退出 + StepFun `step-3.7-flash` 价格显示为 USD 而非官方 CNY。

#### 修复

- **`redcode doctor` 因 `InstanceRef` 缺失而 die**（`instance-state.ts`）：`doctor` 命令使用 `instance: false` 避免 full bootstrap，但 `Config.Service` 内部走 `InstanceState.make` 时需要 `InstanceRef`，没有时直接 die 导致进程挂起。新增 `fallbackContext()` 函数在 `InstanceRef` 缺失时合成 minimal `InstanceContext`，`doctor` 现在无需 project instance 即可正常运行。
- **StepFun `step-3.7-flash` 价格显示为 USD 数值而非官方 CNY**（`provider.ts`）：models.dev 返回的是 USD 价格（input $0.2/M, output $1.15/M），但 UI 侧对 `stepfun` provider 未做 CNY 转换，导致价格被当成人民币显示。给 `CNY_PRICING` 添加 StepFun 官方 CNY 定价（input ¥1.35/M, output ¥8.1/M, cache_read ¥0.27/M），同时在 sidebar `CNY_PROVIDERS` 中加入 `stepfun`。

### [0.7.15] - 2026-07-07

> 新增 `redcode doctor` 诊断命令 + 修复 Windows 下 MCP stdio 子进程导致进程无法退出。

#### 新增

- **`redcode doctor` 诊断命令**（`src/cli/cmd/doctor.ts`、`src/index.ts`）：新增 `doctor` 子命令，对 TUI 运行环境做 6 项快速自检（version / config / providers / plugins / mcp / database），`--json` 可输出机器可读结果。命令注册在 CLI 入口，`instance: false` 已移除，走正常 project instance 上下文。

#### 修复

- **Windows 下 MCP stdio 子进程阻塞进程退出**（`src/mcp/index.ts`）：Windows 上 `StdioClientTransport.close()` 等待的 `close` 事件在 console 子进程场景下可能永远不触发，导致 `redcode doctor` 等一次性命令执行后进程挂起不退出。在 `win32` 平台对 `StdioClientTransport` 的 `close()` 做 override，先 `killProcessTree(pid)` 强制清理子进程树，再调用原始 close。
- **dispose 无超时保护可无限挂起**（`src/effect/instance-registry.ts`）：`disposeInstance()` 原来直接 `Promise.allSettled` 跑完所有 disposers，任一个卡住就会让整个命令 hang 住。新增 5 秒 `Promise.race` 超时，超时后直接返回，防止单点 disposer 拖垮整个退出流程。

### [0.7.14] - 2026-07-07

> 修复 DeepSeek 计费金额偏低 + 缓存命中率虚高（99% 显示 vs 官方结算 ~96%）。

#### 修复

- **[核心] DeepSeek/Xiaomi 官方 CNY 定价只在 `config.provider` 声明时才生效**（`provider.ts`）：CNY 价格表 patch 原来写在"用 config 扩展 models.dev 数据库"的循环里，只对 `redcode.jsonc` 里手写声明过的 provider 生效——纯靠 `auth login` 自动发现（不在 config 声明）的 DeepSeek 完全没打上官方 CNY 价目，直接落回 models.dev 的默认 USD 量级价格（`cache.write:0`），而 UI 侧一直假设"deepseek/xiaomi 的 cost 已经是 CNY"直接显示，导致实际花费被严重低估。改为对 models.dev 数据库无条件 patch，不再依赖用户是否在 config 里声明该 provider。
- **缓存命中率公式 `sumMiss || sumWrite || sumInput` 的"三选一"掩盖了实际未命中量**（`prompt/index.tsx`、`sidebar/context.tsx`）：DeepSeek 的真实 miss/新鲜 token 有时会因为 SDK 响应用的是哪个原始 metadata 字段，被 `session.ts` 的缓存上限兜底逻辑错记进 `cache.write` 而非 `cache.miss`（`tokens.cache.miss` 按构造恒等于 `tokens.input`，与 `write` 从不重叠计数），旧公式用 `||` 优先取 `sumMiss`，正好选中了被"抽空"的那个残缺值，命中率虚高到 99%。改为 `sumRead + sumMiss + sumWrite` 直接求和，不再二选一漏记。

### [0.7.13] - 2026-07-07

> 补全 sidecar Event Loop 阻塞的最后一个死角：`toUIMessages` 循环内部本身没有让出点。

#### 修复

- **`toUIMessages()` 同步遍历全部历史消息、循环内部零让出**（`message-v2.ts`）：0.7.12 的 `yieldNow` 只加在循环外（`toModelMessagesEffect` 调用前后、msgPin 里），拦不住 `toUIMessages` 这个 `for (const msg of input)` 循环本身——长会话下它一次性同步跑完（含 `truncateToolOutput` 等重活），Event Loop 仍被这一段独占，心跳/健康检查照样被堵。将 `toUIMessages` 从普通同步函数改为 `Effect.fn` 生成器，循环内每处理 10 条消息 `yield* Effect.yieldNow`，让批处理中途也能喘气；同步更新唯一调用点 `toModelMessagesEffect` 改为 `yield*`。

### [0.7.12] - 2026-07-06

> Sidecar Event Loop 阻塞导致 GUI 断连 + 状态灯误报 Healthy + 输出一阵一阵慢。

#### 修复

- **Sidecar Event Loop 被同步操作长时间阻塞**（`message-v2.ts`、`prompt.ts`）：Agent 每步之间，`toModelMessagesEffect` 同步遍历历史消息、`structuredClone(msg.parts)` 深拷贝、`JSON.stringify(msgs)` token 估算连续执行，Event Loop 被阻塞 2–10s。期间 `Stream.tick("10 seconds")` 心跳发不出 → SSE 超时 abort（30s→90s 后仍可被堵超 30s 的步打断）、`/global/health` 健康检查 3s 超时→粉红 dot、AI 输出事件堆积→输出卡顿。在 `toUIMessages()` 后和 msgPin 循环每 10 条消息加 `yield* Effect.yieldNow`，让 Event Loop 在同步批处理间喘口气，处理积压的心跳和健康检查。

### [0.7.11] - 2026-07-06

> 修复 GUI 成本显示偏低（tokens 覆盖 + 子代理成本未汇总）+ 前缀缓存命中率无法收敛到 97%+。

#### 修复

- **message tokens 覆盖 bug**（`processor.ts`）：多 step assistant 消息的 `tokens` 字段用 `=` 覆盖而非 `+=` 累加，导致只保留最后一个 step 的数据。GUI 上下文面板据此汇总的缓存命中率被严重低估。改为与 `cost` 一致的逐字段累加。
- **子代理成本未汇总**（`session-context-tab.tsx`、`session-context-usage.tsx`）：Task 工具创建的子 session LLM 成本未纳入父 session 面板"总成本"显示，导致金额偏低数倍。新增 `childCost` memo 遍历子 session 消息汇总。
- **MCP 工具描述缓存/连接不一致**（`mcp/index.ts`）：`convertMcpToolCached` 曾追加 `[cached — not connected]` 后缀，MCP 服务器重连时描述变化打断前缀缓存。改为与 `convertMcpTool` 字节级一致，断线提示挪到 `execute()` 抛错。
- **工具定义未缓存致前缀缓存命中率上不去**（`prompt.ts`）：`describeSkill()` 每步调 `Glob.scan()` 扫磁盘、`describeTask()` 每步读 agent 列表，是 system/messages/tools 三大前缀组件中唯一未做 per-session 缓存的。build agent 创建文件匹配 skill path 模式时 Skill 工具描述变化 → 工具 schema JSON 变化 → 整个前缀缓存失效。新增 `_caches.tools` 第一步缓存所有工具 description + inputSchema，后续步骤用缓存覆盖。

### [0.7.10] - 2026-07-05

> 修复 DeepSeek 成本少报（miss 部分按 cache_hit 计费）。

#### 修复

- **DeepSeek cache miss 计费少报**：`ai-sdk.ts` 未从 `raw` 提取 `prompt_cache_miss_tokens`，`cacheWriteInputTokens` 始终为 0。同时 `getUsage` 的 cap 未考虑 cache write 部分，当 `prompt_cache_hit_tokens > prompt_tokens` 时多余部分被 cap 吃掉，本应按 ¥1/M 计费的 miss 部分被按 ¥0.02/M 计费。双修：ai-sdk.ts 补充 miss tokens 提取（`deepSeekCacheWrite`）；session.ts cap 改用 `inputTokens - cacheWriteInputTokens` 为基准。

### [0.7.9] - 2026-07-05

> 修复 DeepSeek V4 Flash 成本少报（~7x 低估）。

#### 修复

- **DeepSeek V4 Flash 成本计算少报**：`getUsage()` 中 `adjustedInputTokens = inputTokens - cacheReadInputTokens`，DeepSeek 返回 `cached_tokens > prompt_tokens`（比例 1.5x–20x），导致非缓存 input 未被计费，仅输出计费。将 `cacheReadInputTokens` cap 在 `inputTokens` 范围内（`session.ts:418`），同时修正 `ai-sdk.ts` 中 DeepSeek `prompt_cache_hit_tokens` 解析。

---
### [0.7.8] - 2026-07-05

> 修复 `@opentui/keymap` 双份类型冲突 + 首页项目分区选择器。

#### 修复

- **`@opentui/keymap` PKG 重复导致 TS 类型错误**：`@opencode-ai/plugin` 内置的 `@opentui/keymap` 与 TUI 依赖的版本虽文件全等，但 Bun content-addressable 存储为不同 hash（`0d7da94b` vs `77dde1de`），TypeScript 视为不同类型，`#private` 字段不兼容报错。将两个 junction 统一指向 `77dde1de`（`node_modules/.bun/`）。

#### 新增

- **首页项目分区选择器**：TUI 首页新增交互式 workspace 选择器，展示项目/分区列表，支持快速切换工作区（`project-selector.ts`、`api.tsx`、`command-shim.ts`、`thread.ts`）。

#### 移除

- **NVIDIA BILLING-INVOKE-ORIGIN header**：去掉 `provider.ts` 中发送给 NVIDIA 的 `X-BILLING-INVOKE-ORIGIN: RedCode` 头，该头导致第三方托管模型（如 `z-ai/glm-5.2`）返回 404。

### [0.7.7] - 2026-07-04

> 提示词文件 .txt→.md 格式升级 + 新增 ollama 本地模型专属提示词。

#### 重构

- **提示词外置格式升级**：全部 50 个 `.txt` 提示词文件重命名为 `.md`（Bun 原生支持），提升可读性与 diff 体验，26 个 `.ts` 导入路径同步更新。

#### 新增

- **ollama 本地模型提示词**：新增 `prompt/ollama.md`，针对 GLM-4.7-Flash / Qwen3.6 等本地模型设计 harness 式提示词——保留全部工具（DCP compress、MCP 代码智能、子代理）同时加装反幻觉规则、分步思考、工具优先级排序与大文件阅读指引。`system.ts` 按 `providerID` 匹配 ollama，路由优先于 GLM/Qwen 通用档。

### [0.7.6] - 2026-07-04

> 修复删除 session 报 404、GUI 卡在"思考中"不恢复。

#### 修复

- **删除 session 404**：`session.remove()` 先 `get(sessionID)` 校验存在性，级联删除子 session 或重复删除时若目标已不存在会抛 `NotFoundError` → HTTP 404。改为 `catchTag("NotFoundError")` 静默返回，已删即成功（`session/session.ts`）。
- **GUI "思考中"永久卡住**：`session_status` 仅在 bootstrap 时轮询一次，之后完全依赖 WebSocket 事件推送。网络抖动或事件丢失会导致 busy→idle 转换永远不到达前端，表现为模型已完成但界面一直显示"思考中"。新增 5 秒间隔轮询 fallback：仅当存在 busy session 时才发请求，idle 时零开销（`global-sync.tsx`）。

### [0.7.5] - 2026-07-03

> `redcode web` 根路径改为 xterm.js + PTY 的 TUI web 终端，手机浏览器可直接操作 RedCode TUI。

#### 新增

- **TUI Web Terminal**：`redcode web` 的 `GET /` 不再代理 GUI web app，改为返回内联 HTML 页面（`tui-terminal.html`），用 xterm.js (CDN) + 现有 PTY WebSocket 直接在浏览器中 spawn 并操作 `redcode.exe` TUI 实例。支持窗口自适应 resize、移动端防双击缩放。其他路径仍 fallback 到原有 GUI 代理。
- **`tuiTerminalHtml()` + `TUI_CSP`**：`ui.ts` 新增 TUI HTML 模板读取函数和专用 CSP 策略（允许 jsdelivr CDN）。服务端用 `split().join()` 注入 `__REDCODE_DIR__` 和 `__REDCODE_BIN__` 占位符，避免 Windows 反斜杠被 `String.replace()` 吞掉。

### [0.7.4] - 2026-07-02

> 输入框下方空白区加常用快捷键滚动提示。

#### 新增

- **`ShortcutsTicker` 常用快捷键跑马灯**：输入框下方状态栏原本 Cache hit 左侧一大片空白，现改为循环滚动展示 `新会话/会话列表/切换模型/MCP 状态/切换主题/帮助` 的实际快捷键，遵守 `animations_enabled` 开关（关闭动画时降级为静态一行）（`component/prompt/shortcuts-ticker.tsx`）。

### [0.7.3] - 2026-07-01

> 新增 `todoread` 工具，支持 compress 后重新读取 todo 状态，避免丢失上下文后重复已完成工作。

#### 新增

- **`todoread` 只读工具**：从 SQLite 持久化读回当前会话的 todo 列表，返回完整状态 + 摘要行（`N total · M done · A active · P pending`）。权限复用 `todowrite` 通道。在 `compress` 后调用可恢复已完成/待办认知，不再因摘要遗漏而重复已做完的步骤。

### [0.7.2] - 2026-07-01

> 修复隔离 worktree 子代理用完不释放实例，导致子进程/内存持续累积（GUI 长驻 sidecar 尤其明显）。

#### 修复

- **隔离 worktree 子代理泄漏 `InstanceStore` 实例**：`session/prompt.ts` 的 `runIsolated`（`task` 工具 `isolation:"worktree"` 用）创建隔离 worktree 的 `InstanceContext` 后，任务跑完从未释放，而 `InstanceStore` 缓存 `capacity: Infinity`，只能靠显式 dispose 清理——每次隔离子代理都会在内存里永久累积一份该 worktree 的 LSP server 等子进程。TUI 因 server 进程随每次 CLI 调用重启，泄漏会随会话结束自然清空；GUI 的 sidecar 是 Electron 整个 app 生命周期只起一个长驻进程，泄漏无限累积，表现为任务管理器里两三百个子进程、内存持续升高。修复：`runIsolated` 用 `Effect.ensuring` 包裹任务执行，无论成功/失败/中断都调用 `InstanceStore.dispose(ctx)` 释放隔离实例（`session/prompt.ts`）。

### [0.7.1] - 2026-07-01

> 0.7.0 首页美化的后续微调：footer 文案改英文、Logo idle 扫光调到肉眼可见并改为蓝色调。

#### 修复

- **footer 统计条文案**：`缓存 xx%` 改成 `cache hit xx%`（`feature-plugins/home/footer.tsx`）。
- **首页 Logo 启用 idle 扫光**：`buildIdleState`/`shimmerConfig` 这套呼吸扫光此前从未被启用过（`<Logo />` 一直不带 `idle`），首页加 `idle` 后发现幅度是给点击 burst 余韵设计的，常驻场景太淡——放大 `haloAmp`/`ambientAmp`/`primaryMix`，并把高光目标色从纯白 `PEAK` 换成偏白的饱和 `primary` 蓝（`idlePeak`），扫光经过时读出的是明显蓝色而不是泛白。同时把 idle 态 tick 频率从 60fps 降到静止时约 14fps（点击 burst/ring 特效仍满帧率），避免首页常驻页面拖 CPU（`component/logo.tsx`）。

### [0.7.0] - 2026-07-01

> 首页视觉美化：去掉一部分上游 opencode 观感，加了三处点缀——星空背景、footer 统计条、提示语呼吸点。

#### 新增

- **首页星空背景**：新增 `component/starfield.tsx` + `starfield-render.ts`，基于 `FrameBufferRenderable` 铺一层稀疏光点，位置/字符/闪烁相位由坐标哈希确定性生成，挂在 Logo 后面（`routes/home.tsx`）。手动低频 `requestRender`（~700ms 一次）代替常驻 60fps `live` 循环，呼应 Logo 组件默认不空闲动画、省 CPU/电量的既有设计取向。
- **首页 footer 统计条**：`home_footer` 插件（`feature-plugins/home/footer.tsx`）新增花费 + 缓存命中率，跨 session 聚合 `sync.data.session` 的 `cost`/`tokens`（落库时已 denormalize，纯本地 reduce，无新请求）。
- **提示语呼吸点**：`home_bottom` 的提示语前缀圆点（`feature-plugins/home/tips-view.tsx`）加低频呼吸色变，用 `tint()` 在 `background`/`warning` 间插值。

### [0.6.43] - 2026-07-01

> 修复 canary token 模块级 store 在 bun compile 下可能重复实例化，导致 prefix cache 命中率卡在 95%（此前巅峰 98%）。

#### 修复

- **canary token store 改用 globalThis**：`canary.ts`（260629 引入）的 token store 用裸模块级 `const store = new Map()`，与 6/20 已修过的 `prompt.ts` `_caches` 是同一类坑——bun compile 可能重复实例化模块，重复实例的 Map 是空的，`Canary.get(sessionID)` 会误判成新 session、铸造新随机 token，导致注入 system prompt 的 "Session marker" 那行每 turn 变化，打断 DeepSeek 的 prefix cache。改为 `globalThis` 兜底存储，与 `prompt.ts` 缓存同一套模式（`packages/opencode/src/session/canary.ts`）。

### [0.6.42] - 2026-07-01

> 修复压缩切断 tool 配对导致的 DeepSeek 400 断会话。

#### 修复

- **孤儿 tool-result 兜底**：上下文压缩（DCP 插件的 compress / core compaction）可能切断 `tool_call`/`tool_result` 配对，留下没有前置 `tool_calls` 的孤儿 tool 消息，发给 DeepSeek 等 OpenAI 兼容 provider 时报 `Messages with role 'tool' must be a response to a preceding message with 'tool_calls'`，会话直接卡死（孤儿会赖在历史里直到某次 collapse 才消失）。在 `normalizeMessages` 初始 sanitize 之后、所有 provider 专用块之前（deepseek/interleaved 分支会提前 return，必须前置）加入发送前扫描：丢弃无前置配对 `tool_call` 的 tool-result，整条 tool 消息若无剩余则删除（`packages/opencode/src/provider/transform.ts`）。

### [0.6.41] - 2026-06-30

> 第三方 code review 收尾 P1-b 续：prompt.ts 继续拆分，shellImpl 迁出。

#### 重构

- **prompt.ts 拆分续**：把 `shellImpl`（用户终端命令落库为 tool part，约 155 行）从 prompt.ts 巨型闭包提取到 `prompt/shell.ts`，沿用工厂函数 + 显式依赖注入模式（`makeShell(deps)`），行为不变、typecheck 通过，prompt.ts 由约 1866 行瘦到约 1700 行，后续 createUserMessage / runLoop / command 将陆续迁出（`packages/opencode/src/session/prompt.ts`、`prompt/shell.ts`）。

### [0.6.40] - 2026-06-30

> 第三方 code review 收尾 P1：handler 裸 SQL 收归 Session.Service，prompt.ts 启动拆分。

#### 重构

- **server handler 不再直接读表**：`handlers/session.ts` 此前用裸 Drizzle ORM 查询 `MessageTable`/`PartTable` 找最近一条 compaction 消息（GUI 初始加载跳过旧消息用），绕过了 `Session.Service` 抽象、handler 与表结构耦合。新增 `Session.Service.latestCompactionCursor()` 把这段 SQL 收归 session 层，handler 删去 `Database`/`MessageTable`/`PartTable`/drizzle-orm 全部直接引用，性能不变（仍是单次索引查询）（`packages/opencode/src/session/session.ts`、`src/server/routes/instance/httpapi/handlers/session.ts`）。
- **prompt.ts 拆分启动**：1866 行巨型文件开始按职责拆分，首批提取 `getModel`/`currentModel`/`sessionSourceLabel` 到 `prompt/shared.ts`（工厂函数 + 显式依赖注入模式 `makeShared`），后续将陆续迁出（`packages/opencode/src/session/prompt.ts`、`prompt/shared.ts`）。

---

### [0.6.39] - 2026-06-30

> 清理 prefix-cache 诊断代码 — 调查结论：客户端逐 turn 字节完全稳定，唯一 cache break 来自 auto-compaction 重写消息（结构性开销，非 bug）。

#### 移除

- **prefix-cache hash 诊断日志**：0.6.38 部署后插桩 119 turn 分析，仅 compaction（153→26 blocks）触发 1 次 `cacheBreak=YES`，其余全为 `growth-only`。确认客户端 prompt 构建字节级稳定，诊断代码功成身退（`packages/opencode/src/session/prompt.ts`）。

---

### [0.6.38] - 2026-06-30

> 移除未使用的 Office 聊天室功能 — 顺带消除一个 prefix cache 不稳定源。

#### 移除

- **Office 群聊/聊天室功能下线**：该功能自上线从未实际使用，且 `groupChatContext()` 把群聊消息注入系统提示词的 canary marker 之后——群聊内容一变就改写 system prompt 尾部、打断 DeepSeek 严格 prefix cache（历史日志多次记录命中率下跌与此相关）。后端删除 `src/chat/` 服务与 SQL schema、server `chat` 路由组与 handler、`prompt.ts` 的群聊注入与 `_caches.chatCtx` 缓存（`packages/opencode/src/session/prompt.ts`、`src/server/routes/instance/httpapi/{api,server,handlers/chat,groups/chat}.ts`）。前端 UI 与桌面第二窗口见 GUI 0.6.14。已应用的 migration 与 `session.client` 列作为历史保留，不影响运行。

---

### [0.6.37] - 2026-06-30

> 还原 canary commit 误删的 text-part 落盘逻辑。

#### 修复

- **交错 text→tool→text 丢失首段文本**：canary commit `1220d25af` 在 `text-end` 分支误删了 3 行 text-part 最终化逻辑（持久化 plugin 转换后的最终文本 + providerMetadata、重置 `currentText`），导致一个 step 内 text→tool→text 交错时第一段文本不落盘直接丢失。现在在 canary 泄漏检查之后还原这三行（`packages/opencode/src/session/processor.ts`）。

---

### [0.6.36] - 2026-06-29

> 修复 DeepSeek prefix cache 命中率断崖下跌——0.6.35 引入的 canary 重置 + modelKey 缓存键。

#### 修复

- **DeepSeek prefix cache 命中率从 95%+ 暴跌至 45%**：根因有二。一是 canary token 每轮被 `Canary.clear(ctx.sessionID)` 清空后重生成新值，system prompt 尾部字节每轮不同，DeepSeek 严格 prefix cache 无法匹配尾部。二是 `_caches.system` / `_caches.modelMsgs` 缓存键加上 `modelKey` 后，同一模型在不同路径下引用不同对象时 key 不匹配，缓存频繁失效。修复：删除 `processor.ts` 中的 `Canary.clear(ctx.sessionID)`，回归 `sessionID` 单键缓存（`packages/opencode/src/session/processor.ts`、`packages/opencode/src/session/prompt.ts`）。

---

### [0.6.35] - 2026-06-29

> 修复同 session 切换模型时系统提示缓存错用前一模型的缓存。

#### 修复

- **模型切换缓存键修复**：`_caches.system` 和 `_caches.modelMsgs` 的缓存键由单一 `sessionID` 改为 `sessionID + modelKey（providerID:modelID）`。切换模型后系统提示重新构建，避免新模型沿用旧模型的 system prompt、图片能力判断失效、模型自我认知错乱等问题（`packages/opencode/src/session/prompt.ts`）。

---

### [0.6.34] - 2026-06-27

> 修复 DCP nudge 配置导致的启动崩溃 + schema passthrough。

#### 修复

- **`dcp` key 导致 ConfigInvalidError 启动崩溃**：`redcode.jsonc` 加入 `"dcp"` 字段后，`config/parse.ts:topLevelExtraKeys` 将其识别为未知 key 并抛 `ConfigInvalidError`，进程无法启动。在 `config/config.ts` 的 `Info` schema 中新增 `dcp: Schema.optional(Schema.Unknown)` passthrough，插件 config 由插件自行校验，不影响主 schema（`packages/opencode/src/config/config.ts`）。
- **DCP nudge 配置恢复**：`nudgeForce: "strong"`（user 角色消息）+ `iterationNudgeThreshold: 10`（10 轮提前触发）重新写入 `~/.redcode/redcode.jsonc`。

---

### [0.6.33] - 2026-06-27

> StepFun prefix cache 命中率修复 + DCP nudge 增强。

#### 修复

- **StepFun prefix cache 命中率偏低**：`stepfun` / `step-plan` provider 缺少 `promptCacheKey`，导致 Step 3.7 Flash 跨调用缓存命中率仅 63~82%，远低于 DeepSeek/MiMo 的 94~97%。在 `transform.ts` 的 `promptCacheKey` 条件中补入两个 providerID，实测命中率上升至 88%+（`packages/opencode/src/provider/transform.ts`）。

#### 变更

- **DCP compress nudge 增强**：`nudgeForce` 从 `"soft"`（assistant 消息，易被忽视）改为 `"strong"`（user 消息，服从性更高）；`iterationNudgeThreshold` 从默认 15 降至 10，提前触发提醒（`~/.redcode/redcode.jsonc`）。

---

### [0.6.32] - 2026-06-26

> 移除上游 SaaS 控制台包，减重 ~35MB。

#### 变更

- **移除 `packages/console/`**：上游 opencode 云控制台 web app，RedCode 不走 SaaS 路线，零内部引用，删除后瘦身 521 文件 / 35MB，`package.json` 同步清理 workspace 条目与 `dev:console` 脚本。

---

### [0.6.31] - 2026-06-26

> 修复自定义 provider 下引擎压缩永不触发：context 未知时也按 threshold 硬上限压缩，DCP 不再无限催不执行。

#### 修复

- **overflow.ts 阈值守卫顺序修正**：`isOverflow()` 中 `compaction.threshold` 检查提到 `model.limit.context === 0` 守卫之前。自定义 provider（models.dev 无条目、config 未声明 limit）会兜底为 `context:0`，旧顺序在阈值检查前就早退，等于对这类 provider 关掉了压缩——DCP 一直 nudge 但引擎永不 compaction，撑到中断。现在 context 未知也照样按硬上限触发，符合该逻辑原本注释声明的意图。

---

### [0.6.30] - 2026-06-25

> sync-home 防覆盖加固：command/ 改为只铺缺失（不再盲覆盖私仓 persona 命令），merge-home-config 写入时保留 JSONC 注释。

#### 修复

- **command/ 同步改为 seed-only**：`sync-home.bat` 中 `xcopy /y` 替换为逐文件 `if not exist` 检查，私仓编辑的 persona 命令不再被公仓模板覆盖。
- **merge-home-config 保留注释**：新增 JSONC-aware patcher（`patchNewKeys`），合并模板新键时直接原文插入而非 `JSON.stringify` 重写，`// YYMMDD Red` 日期注释不再被剥。
- **模板 stepfun 端点修正**：`.opencode/redcode.home.jsonc` 的 stepfun 从无效的顶层 `api` 字段改为 `options.baseURL`，防止合并时向私仓重复注入已删除的 `api` 键。

---

### [0.6.29] - 2026-06-25

> 修复人格自我误认（GUI 被说成 TUI）与多模态误判：基础提示词写死 "CLI agent" 让模型把界面认错，env 又缺客户端事实。

#### 修复

- **提示词去 CLI 化**：13 个 `prompt/*.txt` 开头 `interactive CLI agent/tool` 统一改为 `interactive code agent`，消除"敏敏 TUI / 小宋 GUI 都不涉及 CLI"的语义偏差。
- **env 注入客户端类型**：`<env>` 块新增 `Client: RedCode Desktop GUI / Terminal TUI`（取 `flags.client`），给模型权威的客户端事实，避免把 GUI 误判成 TUI（`session/system.ts`）。

---

### [0.6.28] - 2026-06-25

> 修复流式重试时的 part 重复：断流重试会从头重跑，旧的失败 part 未清理导致消息里 text/reasoning/tool/step 重复。

#### 修复

- **流式重试 part 清理**：进入每个 step 前快照已有 part，重试时删掉失败那次新建的全部 part，并丢弃在途追踪（`currentText`/`reasoningMap`/`toolcalls`），避免重复内容落库（`session/processor.ts`）。

---

### [0.6.27] - 2026-06-25

> 修复 PTY 子进程泄漏（Windows 僵尸进程）+ sync-home 配置覆盖问题。

#### 修复

- **PTY 子进程泄漏**：Windows 上 PTY teardown 改用 `taskkill /T` 杀整棵进程树，防止 shell 子进程（node/python 等）残留成僵尸占满内存（`pty/index.ts`）。
- **sync-home 配置覆盖**：`sync-home.bat` 不再盲目 `copy /y` 覆盖 `~/.redcode/redcode.jsonc`，改为 JSONC 感知的深度合并——用户已有 key 保留，模板新增 key 自动补入（新增 `script/merge-home-config.ts`）。

---

### [0.6.26] - 2026-06-24

> 接入 Horizon MCP（AI 日报 pipeline），同步配置到 home 文件，更新 ai-daily skill。

#### 新增

- **Horizon MCP 配置**：在 `.opencode/redcode.home.jsonc` 和 `~/.redcode/redcode.jsonc` 添加 `horizon` MCP server 配置，调用本地 `D:\AI\Red\Horizon\src\mcp\server.py` 提供 `hz_run_pipeline` 等工具。
- **MCP resource template listing**（上游 `c6cc13e`）：新增 `resourceTemplates` 接口，支持发现 MCP server 的参数化资源模板。
- **ai-daily skill 升级**：skill 触发后自动调用 Horizon MCP 运行完整 pipeline（fetch → score → filter → enrich → summarize），替代原有 webfetch/web_search 聚合方式。

---

### [0.6.25] - 2026-06-24

> 移植上游 4 项 bugfix：快照子目录路径、MCP 结构化错误、skill 路径格式、OAuth 安全加固。

#### 修复

- **快照子目录路径**（上游 `dcf7b4e`）：`git add`/`git rm` 的 `--pathspec-from-file` 输入加 `:(top,literal)` 前缀，子目录下路径正确相对 worktree root 解析（`snapshot/index.ts`）。
- **MCP 结构化错误保留**（上游 `c17b955`）：`toolResultText` 对 `content` 类型提取纯文本而非 JSON dump 整个结构，模型能直接读到错误信息（`llm/protocols/shared.ts`）。
- **Skill 路径格式**（上游 `246d40d`）：skill base directory 由 `file://` URL 改为文件系统路径，避免 Windows 上 `file:///D:/...` 格式让模型困惑（`tool/skill.ts`）。
- **OAuth 回调绑定**（上游 `af31e97`）：MCP OAuth callback server 显式绑定 `127.0.0.1`，防止意外监听所有网络接口（`mcp/oauth-callback.ts`）。

---

### [0.6.24] - 2026-06-24

> 修复流式输出阻塞 + Windows 僵尸子进程泄漏。

#### 修复

- **AI SDK 流式输出阻塞**：`result.result.response` 实际在整个流完成后才 resolve（非 HTTP 头阶段），`await` 它会阻塞 `fullStream` 消费，网络异常时直接触发 `NoOutputGeneratedError`。改为 fire-and-forget 异步捕获 `X-Routed-Via`，不阻塞流（`packages/opencode/src/session/llm.ts`）。
- **Windows 僵尸子进程**：`cross-spawn-spawner.ts` 在 Windows 上直接 `return Effect.void` 跳过了非零退出码的子进程树清理，导致 `Start-Process`/`cmd /c start` 等启动的子进程变僵尸、内存持续增长。移除 Windows 提前返回，统一走 kill group 逻辑（`packages/core/src/cross-spawn-spawner.ts`）。

---

### [0.6.23] - 2026-06-23

> 系统提示词统一升级：deepseek/glm/mimo/minimax 全面增强，新增 Step 路由。融合 CC 最佳实践。

#### 变更

- **系统提示词全面增强**：以 deepseek.txt 为基准，融合 Claude Code 最佳实践，统一升级 6 个模型提示词（deepseek/glm/mimo/minimax/step）。新增"探索性问题不动手"、"如实汇报结果"规则；mimo/minimax 补齐 FIX SIBLINGS / THINK ARCHITECTURALLY / SURFACE TRADE-OFFS 三条规则。
- **Step 路由新建**：新增 `step.txt` + `system.ts` 路由（匹配 `step-`），Step 3.7 Flash 不再走旧 opencode default 提示词。

### [0.6.22] - 2026-06-23

> 补全 DeepSeek prefix cache 稳定性修复（MCP 工具排序 + tool key 排序 + system-reminder 注入时序）；AGENTS.md 新增纠正行为规范与注释格式规范；`/recall` 语义搜索增强。

#### 修复

- **MCP 工具顺序非确定性**：`Effect.forEach` 并发查询多个 MCP server 导致 tool 插入顺序随响应时序变化，破坏 prefix cache。改为顺序执行（`packages/opencode/src/mcp/index.ts`）。
- **Tool key 序列化顺序不稳定**：内建工具与 MCP 工具混合后 key 顺序不固定。resolve 后按 key 字母排序，保证 JSON 序列化 bytes 稳定（`packages/opencode/src/session/prompt.ts`）。
- **system-reminder 注入被 msgPin 缓存覆盖**：step>1 时对 user message parts 的 `<system-reminder>` 包裹在 msgPin 之前执行，缓存恢复后包裹丢失。改为在 modelMsgs 稳定化之后作为独立 user message 追加，不污染缓存前缀（`packages/opencode/src/session/prompt.ts`）。
- **注释格式不合规**：4 处 `// 260614 fix:` 缺 `Red` 标签、1 处 `// 260610 CC` 统一修正为 `// YYMMDD Red` 格式。

#### 变更

- **AGENTS.md**：新增"被纠正 → 先动手再开口"规则（被用户纠正后下一条回复必须以行动开头）+ 注释格式规范 `// YYMMDD Red xxx`。

#### 新增

- **`/recall` 语义搜索**：双路召回——关键词打分 + Ollama embedding cosine similarity 加权融合。有 Ollama 时自动启用语义路（`nomic-embed-text`），无 Ollama 时静默降级为纯关键词。支持 `--index` 预计算 embedding 缓存，MEMORY.md 变更后自动重建（`.opencode/scripts/recall-memory.mjs`）。

---

### [0.6.21] - 2026-06-22

> 修复 DeepSeek prefix cache 命中率随对话增长持续下降的问题，新增 LAN 访问支持。

#### 修复

- **DeepSeek prefix cache 命中率 cliff-drop**：DCP compaction 后 `cache_read` 从 139K 骤降到 52K 且持续冻结。根因是每次 turn 生成 model messages 时 DCP transform 和 AI SDK 转换链引入微小非确定性，导致 prefix bytes 逐轮变化。修复分两层——① 将 `toModelMessagesEffect` 的 `UIMessage[]` 构建抽成同步纯函数 `toUIMessages()`，消除 `Effect.fnUntraced` 内部的调度非确定性；② 新增 `_caches.modelMsgs` 缓存层，每轮发完 model messages 后快照，下一轮用缓存版本替换旧消息前缀，保证发往模型的 bytes 完全一致（`packages/opencode/src/session/message-v2.ts`、`packages/opencode/src/session/prompt.ts`）。

#### 新增

- **LAN 访问支持**：`redcode run` 新增 `--hostname` 参数，设 `0.0.0.0` 可监听所有网口，手机/平板可浏览器直连做临时 GUI（`packages/opencode/src/cli/cmd/run.ts`）。

#### 重构

- **`toModelMessagesEffect` 拆分**：同步纯函数 `toUIMessages()` 输出 `{ messages: UIMessage[], tools }`，使转换步骤可独立复用和测试（`packages/opencode/src/session/message-v2.ts`）。
- **build.bat 清理**：移除无效的 `full` 分支参数解析逻辑（`packages/opencode/build.bat`）。

---

### [0.6.20] - 2026-06-22

> X-Routed-Via 路由溯源 + build.bat 不再清空自定义 provider 配置。

#### 新增

- **X-Routed-Via 路由溯源**：捕获 LLM 响应头中的 `_routed_via` 字段（FreeLLMAPI 路由标识），存入 `Finish` 事件并在会话页脚显示路由来源（`packages/opencode/src/session/llm.ts`、`packages/opencode/src/cli/cmd/run/footer.view.tsx`）。

#### 修复

- **build.bat 不再清空自定义 provider 配置**：`build.bat` 会调 `sync-home.bat` 用仓库模板覆盖 `~/.redcode/redcode.jsonc`，导致 FreeLLMAPI 等自定义 provider 每次重编后丢失。修复方法：把 FreeLLMAPI 和 Step Plan provider 配置写入 `.opencode/redcode.home.jsonc` 模板，重编后不再丢失（`.opencode/redcode.home.jsonc`）。

#### 配置

- **阶跃星辰 Step Plan 接入**：新增两个 provider 配置到 `~/.redcode/redcode.jsonc`——`step-plan`（普通 API `api.stepfun.com/v1`，走余额）和 `stepfun`（Plan 模式 `api.stepfun.com/step_plan/v1`），模型 `step-3.7-flash`，用用户自有 key 鉴权。FreeLLMAPI 路由中已有的免费 `stepfun-step-3.7-flash` 保持不变（`~/.redcode/redcode.jsonc`）。

---

### [0.6.19] - 2026-06-25

> GLM/Qwen 提示词路由 + DCP compress 优先级 + build.bat 跳过 WebUI 重打包。

#### 新增

- **GLM/Qwen 提示词路由**：新增 `glm.txt` 强模型提示词（含 sibling-check/架构思维/trade-off 三条额外要求），`system.ts` 匹配 `glm`/`qwen` model ID 路由到精炼档，不再走 default 兜底（`packages/opencode/src/session/system.ts`、`packages/opencode/src/session/prompt/glm.txt`）。

#### 优化

- **DCP compress 优先级写入提示词**：deepseek/mimo/minimax 三个主力提示词新增"主动用 DCP compress，不等系统 auto-compact"指引，减少 compaction 触发导致的前缀缓存 miss（`packages/opencode/src/session/prompt/{deepseek,mimo,minimax}.txt`）。
- **build.bat 默认跳过 WebUI 嵌入**：日常编译用 `build.bat`（跳过 SPA 打包），需要完整嵌入时用 `build.bat full`，编译速度大幅提升（`packages/opencode/build.bat`）。

---

### [0.6.18] - 2026-06-22

> 新增 memory-auto-capture 插件 — 自动捕获被批评/被表扬/项目决策到每日日志。

#### 新增

- **memory-auto-capture 插件**：监听 `chat.message` 和 `experimental.session.compacting` 钩子，检测到用户批评、表扬、决策或要求记住时，自动追加到 `~/.redcode/memory/YYMMDD.md`，解决 agent 选择性遗忘问题（`~/.redcode/plugin/memory-auto-capture.ts`）。

---

### [0.6.17] - 2026-06-21

> Web UI 启动时从 API 种子项目列表，嵌入式 UI dev 模式加载修复。

#### 修复

- **Web UI 首次加载无项目**：手机/浏览器首次打开 Web UI 时，`server.projects.list()` 为空（无 localStorage 种子），页面只显示空白 loading。新增 `createEffect` 在启动时从 `globalSync.data.project` API 数据中写入项目列表，判断 `worktree.includes("redcode-test")` 跳过测试项目，做到首次加载立即可看（`packages/app/src/context/layout.tsx`）。
- **嵌入式 UI dev 模式 500 错误**：`serveUIEffect` 使用 bare import `import("redcode-web-ui.gen.ts")`，bun 从调用方模块目录（`src/server/shared/`）解析不到 gen 文件，退到 upstream proxy `https://app.redcode.dev` 又不可达，全请求返回 500。改为 bare import 失败后 fallback 到 CWD 相对路径加载，dev 模式下恢复正常（`packages/opencode/src/server/shared/ui.ts`）。

---

### [0.6.16] - 2026-06-20

> MCP 工具列表缓存优先加载 — 启动时立即可用，不等待 MCP server 就绪。

#### 优化

- **MCP 工具列表磁盘缓存**：MCP server 启动成功后，工具定义持久化到磁盘缓存。后续启动时若 server 未就绪或连接失败，自动回退到缓存工具定义，保证启动后立即可用（`packages/opencode/src/mcp/index.ts`）。

---

### [0.6.15] - 2026-06-20

> bun compile 模块重复实例化致前缀缓存失效修复 + MCP 孤儿进程泄漏修复。

#### 修复

- **DeepSeek 前缀缓存 bun compile 退化**：`bun compile --single` 下 `prompt.ts` 模块可能被实例化多次，导致模块级 `let` 缓存变量（`_systemCache`、`_chatCtxCache`、`_msgPinCache`）多副本不同步，系统提示词每轮字节级变化，前缀缓存命中率从 98% 骤降至 ~50%。迁移至 `globalThis.__rc_prompt_caches` 容器，绕过 bun compile 模块隔离，前缀在 session 内保持字节一致（`packages/opencode/src/session/prompt.ts`）。
- **MCP 孤儿进程泄漏（Windows）**：`connectLocal()` spawn 子进程后若连接失败，`transport.close()` → `process.kill()` 在 Windows 编译 exe 下不可靠，子进程成孤儿持续占锁/端口。`reconcile()` 热加载 1s 防抖看到失败重试 spawn 新进程，多次 config 写入 → 8+ 副本同时运行。修复：connect 前捕获 `transport.pid`，catch 分支调 `killProcessTree` 杀整棵树；新增 `creating` Set 防重入守卫（`packages/opencode/src/mcp/index.ts`）。

---

### [0.6.14] - 2026-06-18

> DCP 消息钉住 — 阻止 DCP 累积修改破坏 DeepSeek 前缀缓存。

#### 修复

- **DCP 累积修改致前缀缓存命中率下降**：DCP 的 `experimental.chat.messages.transform` 每轮对旧消息做累积修改（工具输出裁剪 `prune` 增量增长、压缩提示 `nudge` 锚点漂移、消息 ID 标签 `priority` 随裁剪变化），导致 DeepSeek 前缀从修改点起整段缓存 miss。经济账：裁剪省 ~$0.0005/轮，缓存 miss 多花 ~$0.01/轮，损失是收益的 20 倍。新增 `_msgPinCache`：DCP 转换后按 `msg.info.id` 缓存每条消息的 `parts`，后续轮次直接恢复缓存版本，前缀在整个 session 内保持字节一致。切换 session 自动清空（`packages/opencode/src/session/prompt.ts`）。

---

### [0.6.13] - 2026-06-18

> DeepSeek 前缀缓存退化修复 — _systemCache / _chatCtxCache 重建，命中率从 70% 恢复到 98%。

#### 修复

- **DeepSeek 前缀缓存退化**：Commit 7ee58bfcb 新增的 `_systemCache` / `_chatCtxCache` 缓存层被工作树回退约 30 行变更，导致 `instruction.system()` 每轮重读磁盘、`groupChatContext()` 每轮重查数据库，DeepSeek 前缀缓存命中率从 95%+ 骤降至 60-70%。通过 `git checkout HEAD` 恢复缓存逻辑；`groupChatContext()` 接受 sessionID 作为缓存键（`packages/opencode/src/session/prompt.ts`）。

#### 优化

- **依赖安全升级**：root catalog（solid-js 1.9.10→1.9.13、zod 4.1.8→4.4.3、ai 6.0.168→6.0.208）、opencode（immer 11.1.4→11.1.8、glob 13.0.5→13.0.6、@opentelemetry/api 1.9.0→1.9.1、@modelcontextprotocol/sdk 1.27.1→1.29.0）、desktop（electron 42.2.0→42.4.1），typecheck 全部通过。

---

### [0.6.12] - 2026-06-17

> LLM 依赖循环修复 — 提取 route 工具函数消除 packages/llm 菱形依赖。

#### 重构

- **LLM route 工具函数提取**：将 `route/client.ts` 中 `eventError`、`encodeJson`、`validateWith` 三个工具函数提取到 `route/errors.ts`，切断 client→protocols/shared 反向导入路径，消除 `packages/llm/src` 内 14 文件菱形依赖循环（`packages/llm/src/route/errors.ts`、`packages/llm/src/route/client.ts`）。

---

### [0.6.11] - 2026-06-16

> 缓存 miss 颜色显示 + type 级联修复。

#### 新增

- **缓存 miss 颜色显示**：miss 率 ≤20% 绿色（正常），≤50% 黄色（警告），>50% 红色（偏高）；与 cache hit 颜色阈值对称反转，miss 越低颜色越安全（`tui/component/prompt/index.tsx`）。

#### 修复

- **cache miss 字段缺失导致 typecheck 级联失败**：`types.gen.ts` 新增 `miss` 字段后，所有未含 `miss` 的 cache 类型定义报 TS 错误。根治：在核心 Schema (`message-v2.ts`) 的 `Assistant` 和 `StepFinishPart` cache 定义中补充 `miss: Schema.Finite`，确保所有派生类型自动包含 `miss`；同步修正 6 个 fixture/token 默认对象及 9 个测试文件中的对应类型（`session/message-v2.ts`、`session/prompt.ts`、`session/compaction.ts`、`cli/cmd/debug/agent.ts`、`cli/cmd/stats.ts`）。

---

### [0.6.10] - 2026-06-16

> 文档大扫除 + skill 触发词优化 + bump-version skill。

#### 修复

- **MANUAL.md 多处过时**：Browser MCP 标记已禁用；灵魂文件描述改为"自动注入+命令可选"；skill 表从 6 个扩充到 12 个并加触发词列；自定义 skill 说明改为 frontmatter 自动发现（不再需要注册 instructions）（`MANUAL.md`）。
- **README.en.md 过时**：Browser MCP 标记已禁用；配置路径从 `.opencode/opencode.jsonc` 改为 `.redcode/redcode.jsonc`（`README.en.md`）。
- **AGENTS.md 引用不存在的 skill**：`skill/auto-validate/SKILL.md` 已删除，改为内联说明（`AGENTS.md`）。
- **vision-autoagent 缺 frontmatter**：公开仓模板补 name + description，否则引擎无法发现（`.opencode/skill/vision-autoagent/SKILL.md`）。

#### 变更

- **Skill 触发词口语化**：所有 skill 的 description 加入中文口语触发短语（"帮我看看代码""查bug""太复杂了""小心点"等）；stop-slop/yuqi-slop 消歧为英文/中文分流。
- **新增 bump-version skill**："升版""bump""更新版本"触发，自动化 package.json→README 双语徽章→CHANGELOG→commit 全链（`~/.redcode/skill/bump-version/SKILL.md`）。

---

### [0.6.9] - 2026-06-16

> session 记录 client 字段 + Karina 主题配色优化。

#### 修复

- **Office 群聊会话分类误判**：`isTuiSession()` 原用 `directory.includes("redcode")` 判断，项目路径 `D:\AI\RedCode` 恒匹配导致所有会话都归 TUI。根治：session 创建时写入 `client` 字段（`flags.client`：desktop=GUI，cli=TUI），前端优先读 client 精确分类；老会话无 client 走标题前缀 `[宋雨琦]`/`[GUI]` fallback（`session/session.ts`、`session/session.sql.ts`、`app/pages/chat/index.tsx`、migration `20260616065539_session_client`）。

#### 改进

- **Karina 主题配色**：新增柳智敏应援色（品红 `#8d0079`、黄色 `#efd500`），标题→金色、链接→青色、链接文字→蓝色、行内代码→绿色、代码块语法高亮→多色、列表序号→品红。清理 opentui 不支持的条目（斜体/加粗/引用/列表项文字无 TextMate scope，设为基底白色避免误导）（`theme/karina.json`）。
- **缓存命中率显示精确到两位小数**：TUI 输入框下方 `Cache hit 98.50% · miss 1.50%` 从一位改为两位小数（`tui/component/prompt/index.tsx`）。

---

### [0.6.8] - 2026-06-16

> 写入侧乱码护栏 — write/edit 写入前检测私用区字符/替换符，拦住"把文件写成乱码"。

#### 修复

- **写入乱码护栏**：新增 `Bom.detectGarbled()`，统计私用区字符(PUA E000–F8FF)/Unicode 替换符(U+FFFD)——这是 GBK 错解 UTF-8 的乱码标志，正常文本几乎不含。write 写入前、edit 三个写入点（普通×2 + hashline）全检测，超保守阈值（FFFD 占比 >0.5% 或 PUA >30 个且占比 >2%）即拒绝写入并报错引导"用 read 重读 UTF-8 原文，勿写回乱码"。根治"用错误编码读取后把乱码写回固化文件"这类事故（SKILL.md 曾被写成 72 个 PUA）；不误伤正常文本/少量 Nerd Font 图标（`util/bom.ts`、`tool/write.ts`、`tool/edit.ts`）。

---

### [0.6.7] - 2026-06-16

> 会话标题加来源前缀 — 自动命名时标注 `[人格名/TUI/GUI]`，会话列表一眼区分是哪个 agent 起的。

#### 新增

- **会话标题来源前缀**：session 第一句话自动生成标题时加来源前缀——从对应 soul 文档第一行 `# 名字 · ...` 提取人格名（GUI→`[宋雨琦]`、TUI→`[柳智敏]`），通用 RedCode 无 soul / 非标准格式自动 fallback `[GUI]`/`[TUI]`（不写死人格名）。解决 Office 多会话分不清是 TUI(敏敏) 还是 GUI(小宋) 起的痛点。client 经 `REDCODE_CLIENT` 区分（desktop=GUI，其余=TUI），与 soul 注入同源（`session/prompt.ts` 的 `title()` + 新增 `sessionSourceLabel` helper）。

---

### [0.6.6] - 2026-06-16

> 修复 read/edit 读文件崩溃 — `Bun.hash` 在 GUI 的 Node sidecar 里 undefined，导致小宋读任何文本文件都报 `Bun is not defined`。

#### 修复

- **read/edit 文件指纹跨运行时崩溃**：6-10 引入 hashline 编辑时，`read.ts`/`edit.ts` 各自用 `Bun.hash.xxHash32` 算文件指纹 `[path#TAG]`。TUI 是 `bun --compile` 二进制（有 `Bun` 全局）正常，但 **GUI 的 sidecar 跑在 Electron 的 Node 运行时**（`process.parentPort` + `node:` 模块，无 `Bun` 全局）——读任何文本文件都在 `computeFileHash` 抛 `ReferenceError: Bun is not defined`，与文件编码无关。修法：抽出 `Hash.fileTag()`（`core/util/hash.ts`，改用 `node:crypto` 的 sha1 取前 16bit），read 产 tag、edit 校验 currentHash 共用同一跨运行时实现，删除两处重复的 `computeFileHash`。输出仍为 4 位大写 hex，碰撞空间不变（`tool/read.ts`、`tool/edit.ts`、`core/util/hash.ts`）。
- **markitdown MCP 服务器连接失败**：`~/.redcode/redcode.jsonc` 中 markitdown 的 `command` 错写为 `["markitdown-mcp-npx"]`，但实际安装的可执行文件是 `markitdown-mcp`（通过 `pip install markitdown-mcp` 安装在 Python Scripts 目录）。修正命令名称即可恢复连接（`~/.redcode/redcode.jsonc`）。

---

### [0.6.5] - 2026-06-15

> Office 多 agent 群聊后端 — 用户在群聊发消息，服务端自动派 TUI + GUI 两个 agent 顺序回复，打通跨 persona 协作。

#### 新增

- **Office 群聊多 agent 编排**：群聊 `office` 房间收到用户消息后，后台 fork 异步派发——TUI(敏敏) 先响应、GUI(小宋) 看到 TUI 回复后再响应，两条回复回写 chat room。各持独立持久化 session（`Office Group — TUI`/`GUI`）维持各自上下文，每 agent 注入专属 persona 系统提示词（TUI=后端/架构、GUI=前端/UI）（`server/routes/instance/httpapi/handlers/chat.ts`）。
- **主 agent 群聊感知**：主 agent（非子代理）系统提示词注入 office 群聊最近 10 条消息，知晓协作指令与对方进度，子代理不注入省 token（`session/prompt.ts`）。

---

### [0.6.4] - 2026-06-15

> MCP 生态扩充 — 进程管理 + SQLite 查询两个本地插件，配套工具优先级引导。

#### 新增

- **`mcp-process-mgmt` MCP 服务器**：从 DesktopCommanderMCP 提取进程管理核心，精简为独立 MCP 插件（`plugins/mcp-process-mgmt/`）。提供 6 个工具：`start_process`（启动 shell 或执行命令）、`send_input`（写入 stdin）、`read_process_output`（分页读取输出）、`wait_for_prompt`（等待 REPL 提示符）、`list_processes`（列出活跃 session）、`stop_process`（强制终止）。依赖从 25+ 个减至 2 个（`@modelcontextprotocol/sdk` + `zod`），适配 Windows `cmd.exe`。
- **`mcp-sqlite-query` MCP 服务器**：基于原生 `node:sqlite` 的轻量查询插件（`plugins/mcp-sqlite-query/`），提供 `sqlite_query`（执行 SQL）、`sqlite_schema`（查表结构）两个工具，结构化返回、免 shell 转义。

#### 优化

- **MCP 工具优先级引导**：`mcp-gate.js` 提醒文案补充 `get_call_hierarchy`（调用链）、`get_blast_radius`（改动影响面）、`get_symbol_source`（取定义源码）三个 grep 物理做不到的能力，引导改代码前先摸清依赖；新增两个 MCP 的 `description` 标注使用时机（sqlite 优先于 `bash sqlite3`、process-mgmt 仅管交互/长驻进程），让模型按场景自选（`.opencode/redcode.home.jsonc`）。

---

### [0.6.3] - 2026-06-15

> TUI 视觉优化 + 构建简化 — 侧栏分隔线/MCP 错误醒目/底栏紧凑化/品牌修正；build.ts 砍掉跨平台根治 ghostty-web 504；启用内置 LSP。

#### 布局调整

- **侧栏圆角边框**：整体加 `rounded` 圆角框（`╭╮╰╯`）+ 暗色边框色，品牌版本号嵌入底部边框线 `bottomTitle`，不再占独立行（`session/sidebar.tsx`）
- **侧栏 section 内嵌标题**：手写 `─` 分隔线改 `border={["top"]} + title`，标题嵌在分隔线里（`─ MCP 7/9 ─`、`─ LSP 2 ─`、`─ Todo 3/5 ─`、`─ Files 4 ─`），折叠箭头 `▼▶` → `▾▸`（`sidebar/{mcp,lsp,todo,files}.tsx`）
- **对话框圆角边框**：弹窗外框加 `rounded` 圆角框 + 暗色边框色，更有层次感（`ui/dialog.tsx`）
- **MCP 错误醒目化**：failed / needs_auth / needs_client_registration 条目前缀从 `•` 改 `⚠`，名字和状态文字着 error 红色，一眼可辨（`sidebar/mcp.tsx`）
- **底栏信息优化**：MCP 改紧凑格式 `⊙ MCP 7/9 ⚠2`（连接/总数+错误数）；末尾加 `^p cmd  ^x +` 快捷键提示；LSP 无连接时隐藏（`session/footer.tsx`）
- **侧栏品牌修正**：底部 `OpenCode` → `RedCode`（`session/sidebar.tsx`）

#### 配置

- **启用内置 LSP**：`redcode.jsonc` 加 `"lsp": true`，内置 38 种 LSP server 按文件扩展名自动探测启动（TypeScript/Go/Rust/Python 等），侧栏显示连接状态（`redcode.jsonc` + `.opencode/redcode.home.jsonc`）

#### 构建

- **build.ts 简化为 Windows 单平台**：移除 12 个跨平台 target（linux/darwin/musl/baseline）和 `--single`/`--baseline`/`--skip-install` flag，不再需要 `bun install --os="*"` 全平台原生依赖解析——根治 ghostty-web GitHub API 504 导致编译失败的问题（`script/build.ts` + `build.bat`）

---

### [0.6.2] - 2026-06-15

> 工作流稳定性 + MCP 生态扩展 — 把"搜代码先 MCP""不确定先停下问"从必漂的提示词软约束，下沉到插件 hook 硬层；新接入 MarkItDown/Semgrep/DBHub，修复 jcodemunch Win 编码崩溃。

#### 新增

- **MCP 优先门禁插件 `mcp-gate.js`**：用 `tool.execute.after` 拦 grep，每会话首次在结果尾部追加一次"代码符号优先 jcodemunch/typegraph"提醒、之后静默。根因——"搜代码先 MCP"写在提示词里是软约束，对抗不过预训练里 grep 的海量先验而漂移；hook 是代码层 `if`，稳定触发，补上"执行时负反馈"（`~/.redcode/plugin/mcp-gate.js`）
- **三新 MCP 接入**：MarkItDown（文档转 Markdown）、Semgrep（结构代码搜索）、DBHub（SQLite inspects 工具）。MarkItDown 从 git 源码装 0.0.1a5（PyPI 版缺 server 入口），`--no-deps` 绕过依赖冲突；Semgrep 1.166.0，clone semgrep/mcp repo 到 mcp-servers 目录；DBHub 全局 npm 安装，`--demo` 模式（`~/.redcode/redcode.jsonc`）

#### 变更

- **工作流逃逸口收紧**：AGENTS.md 任务循环第 1 步原文"模糊或不可逆才停下来问用户，**否则继续**"自带逃逸许可——模型"意识到不理解"时援引"否则继续"闷头干。改为"没把握/不理解/不可逆时**默认停下问**，只有需求清晰且可逆才直接动手"，直接压 completion bias（`AGENTS.md`）

#### 修复

- **敏敏称谓不稳（用"你"不叫"哥哥"）**：根因是人格 few-shot 示例的回答里一个称谓都没有（对照另一人格每条都带），模型照着示例学会了不叫。6 句示例全部补上称谓 + 新增"我的工作习惯"段植入 MCP 优先（`~/.redcode/souls/Tsoul.md`）
- **jcodemunch Windows GBK stderr 崩溃**：`run_stdio_server()` 往 stderr 打印含 💀 emoji 的 banner，Windows 控制台默认 GBK 编码无法转义，stdio 初始化失败。配置加 `PYTHONIOENCODING=utf-8` 解决（`~/.redcode/redcode.jsonc`）
- **mcp SDK 版本冲突**：semgrep 1.166.0 依赖 `mcp` SDK ≥1.27.0（新增 `transport_security` 模块），而 markitdown 锁的版本太低。统一将 mcp SDK 升级至 1.27.2（pip install -U mcp）
- **DeepSeek/MiMo 计费改用官方 CNY 定价**：models.dev USD 值经汇率换算存在精度损失；现 `models-dev.ts` 对已知模型直接注入官方 ¥/M 价格（Flash: input=1/output=2/cache=0.02，Pro: input=3/output=6/cache=0.025），`provider.ts` 同步覆盖。TUI 侧 `sidebar/context.tsx` 按 providerID 判断币种，CNY 直显/USD 按 6.76 换算

#### 清理

- **移除损坏的 gbrain MCP**：gbrain 二进制 bin 元数据损坏（装自已清理的 `Temp/gbrain-clone`）导致长期"老断"，且其核心"存/查记忆"功能被轻量本地的 su-prememory（SQLite+FTS5）完全覆盖。从配置移除，数据目录备份至 `~/.gbrain.bak`，卸载 bun 全局包（`.opencode/redcode.home.jsonc`）

---

### [0.6.1] - 2026-06-14

#### 修复
 - **粘贴图片被 LLM 拒绝后 vision MCP 找不到文件**：非多模态模型（DeepSeek）提交图片时，`unsupportedParts()` 只替换 base64 data URL 为错误文本，从不落盘。现改为在抛弃前将 base64 解码写入 `%TEMP%/redcode-vision-{timestamp}.{ext}`，并在错误文本追加 `TEMP_FILE:<path>` 供 vision-autoagent 直接读取（`provider/transform.ts`）
 - **修复数据字段名错误**：`savePartToTemp` 最初读取 `FilePart.url`（始终 undefined），AI SDK v4 FilePart 实际使用 `data` 字段。同时 `ImagePart.image` 可能是 `Buffer`/`Uint8Array`，非纯 base64 字符串，现已原生处理二进制数据。修完后图片正确落盘，`TEMP_FILE:` 路径正常输出（`provider/transform.ts`）
 - **vision-autoagent SKILL.md 缺少 TEMP_FILE 路径优先检查**：新增第 2 步——从错误消息中提取 `TEMP_FILE:` 路径直接调用 vision MCP，不再盲目按文件名搜索（`~/.redcode/skill/vision-autoagent/SKILL.md`）

---

### [0.6.0] - 2026-06-13

> RedCode Office — 虚拟办公室 / 聊天室。敏敏 + 小宋 + 哥哥在同一个界面里协作，不再开三个 exe 来回切换。

#### 新增

- **RedCode Office 聊天室 UI**：标题栏新增聊天气泡按钮（`chat-bubble` 图标），点击进入 `/chat` 路由，填满整个窗口区域（`titlebar.tsx` + `layout.tsx` + `pages/chat/index.tsx`）
- **聊天室侧栏 session 列表**：左侧按 TUI(敏敏)/GUI(小宋)/Group(办公室) 三个头像分组，点击展示该 agent 的所有 session 历史，按 `directory.includes("dist")` 区分 TUI/GUI（`pages/chat/index.tsx`）
- **ChatRoom + ChatMessage DB schema**：两表（`chat_room` / `chat_message`），sender 支持 `user`/`tui`/`gui`，可选关联 `session_id`（`src/chat/chat.sql.ts` + `migration/20260612082823_chat_room/`）
- **Chat Service 层**：`ensureRoom` / `sendMessage` / `getMessages` / `getLastMessage`，同步 Drizzle 模块（`src/chat/index.ts`）
- **Chat HTTP API**：Effect HttpApi 三端点 — `POST /chat/room/:roomId`(ensureRoom)、`GET /chat/room/:roomId/message`(messages)、`POST /chat/room/:roomId/message`(send)，send 自动 ensureRoom（`groups/chat.ts` + `handlers/chat.ts`）
- **办公室群聊**：`/chat` 页面的 Group 联系人可发送/接收消息，走 `chat_message` 表，3 秒轮询

#### 变更

- **移除跨会话感知（recentSessionDigest）**：不再每轮往系统提示词注入最近 10 条 session 摘要，省 ~500 token/轮。协作改由聊天室实现（`instruction.ts`）

> **Office 后续计划（0.6.3+）**：点击 session 查看对话详情 / 聊天室 ↔ agent 同步机制 / `@敏敏`/`@小宋` 路由 / 在线状态显示 / UI 对齐小宋主题（毛玻璃/背景图/头像）

---

### [0.5.9] - 2026-06-13

#### 优化

- **侧栏 context 面板五彩颜色 + 累计 total**：各 token 指标用鲜艳颜色区分（红色 context/淡紫 total/琥珀 in/绿 out/橙 reason/蓝 cacheRead/紫 cacheWrite/粉 cost），新增 session 累计 total token 行（`sidebar/context.tsx`）

#### 修复

- **TUI 侧栏费用 USD 显示为 ¥ 汇率缺失**：models.dev 定价以美元计，但侧栏 `money.format(cost())` 直接用 CNY 格式化，未乘以汇率，实际少显示了很多。添加 `USD_TO_CNY = 7.2` 汇率换算，与 GUI 侧保持一致（`sidebar/context.tsx`）
- **侧栏 input 与 context 颜色重复**：input 和 context 都用了红色系（`#ef5350` 与 `#ff5252`），视觉上难以区分。input 改为琥珀色 `#ffb300`（`sidebar/context.tsx`）

#### 清理

- **Console mail 死代码**：移除未使用的 `Wbr` / `WbrProps` / `SplitString` 组件（`packages/console/mail/emails/components.tsx`）

### [0.5.8] - 2026-06-13

#### 修复

- **缓存命中率断崖（6/12 分水岭根因）**：`recentSessionDigest()` 用相对时间戳（`5m ago`）注入系统提示词，每轮都变 → DeepSeek 自动前缀缓存全部失效 → 每轮 100% cache miss。改为绝对时间（`06-13 15:30`），系统提示词在会话内不再变化，前缀缓存恢复（`instruction.ts:39-46`）
- **小宋 memory 文件覆盖/乱码（根因链）**：① Gsoul 第 43 行"写文件一律用 write 工具"→ `write` = 覆盖 → 已有 memory 丢失 ② 发现丢了用 bash `echo >>` 追加 → Windows GBK 编码 → 中文乱码 ③ 发现乱码再 write 重写 → 重复内容。修复：Gsoul 改为"read+edit 先读后改"，memory-automation SKILL.md 加 "How to append" 示例，提示词加 CRITICAL 编码警告
- **小宋简单任务过度探索**：改 CHANGELOG 等已知文件时派 4 轮 explore 子代理 + 多次 Shell 读取，耗时 5-6 分钟。提示词加"简单任务直接 read+edit，不派子代理"

#### 优化

- **系统提示词瘦身 ~4KB/轮**：`redcode.jsonc` instructions 移除 `guardrail-profiles`、`defensive-agent` 两个 SKILL.md 全文注入，改为 skill 机制按需加载
- **三档提示词（deepseek/mimo/minimax）强化工具纪律**：CRITICAL 级 Windows 编码警告（读+写都不用 Shell），简单任务禁止 explore

#### 变更

- **小宋人设优化（Gsoul）**：基于真实宋雨琦性格（北京大妞、开口即段子、容易害羞、豪爽直率）调整。工作行为与敏敏对齐——先查再做、冷静高效，人格差异只体现在语气风格上。移除"利索"等速度暗示，消除 soul 与工作纪律的冲突
- **敏敏人设优化（Tsoul）**：基于真实柳智敏性格（"猪猪蛇"反差、外冷内软、完美主义、ENFP）丰富。补充私下软萌黏人面、完美主义代码洁癖。工作习惯不变
- **新用户 skill 自动播种**：bootstrap 启动时将 `.opencode/skill/` 子目录自动复制到 `~/.redcode/skill/`（跳过已有），新用户拉取后首次运行即可使用全部 skill（`bootstrap.ts`）
- **移除 exa-search MCP**：与 web-search 功能冗余，且极少使用。直接删除配置节约启动 token（~600 tokens/turn）（`~/.redcode/redcode.jsonc`、`.opencode/redcode.home.jsonc`）
- **新增 hot-trends skill**：`看热点` 触发，聚合 GitHub Trending（webfetch 爬取）+ B站排行（agent-reach_search_bilibili）+ 抖音热榜（web-search）。agent-reach 保留用于按需查询（`~/.redcode/skill/hot-trends/SKILL.md`）

### [0.5.7] - 2026-06-14

#### 修复

- **缓存命中率 100% bug**：opencode-go 代理不返回 DeepSeek `promptCacheMissTokens` 元数据，导致 `read / (read + 0)` = 100%。改为 miss/write 均为 0 时，用 `input`（实际输入 token）做分母兜底（context.tsx、prompt/index.tsx、subagent-footer.tsx、session-data.ts、session-context-metrics.ts）
- **`cache.write` 始终为 0**：DeepSeek 走 `@ai-sdk/openai-compatible` 时 `prompt_cache_miss_tokens` 不会被映射到 AI SDK 字段，`metadata.deepseek.promptCacheMissTokens` 始终 undefined。改为通过 `adjustedInputTokens`（AI SDK 报告的缓存调整前输入）推算 miss token，确保 cache 数据完整性与持久化（`session.ts` `getUsage()`）
- **TextNodeRenderable 裸 number 渲染崩溃（全面修复）**：OpenTUI `<text>` 只接受 string，多处直接渲染 number 导致致命错误。全面审计 TUI 所有 tsx 文件，共 16 处全部改为模板字符串。涉及：底栏 cacheHitPct/mcp count、侧边栏 messageCount/mcp on/bad、session-v2 numResults/questions count/grep count/matches count、dialog-status MCP/LSP/formatter/plugin count、footer permissions/lsp/mcp length、index reverted/diagnostic/webSearch numResults、subagent-footer index/total、diff-viewer files count（`prompt/index.tsx`、`sidebar/context.tsx`、`sidebar/mcp.tsx`、`session-v2.tsx`、`dialog-status.tsx`、`routes/session/footer.tsx`、`routes/session/index.tsx`、`routes/session/subagent-footer.tsx`、`feature-plugins/home/footer.tsx`、`diff-viewer.tsx`）
- **FFF MCP 配置缺失**：0.5.6 全局目录整合后，`~/.redcode/redcode.jsonc` 的 MCP 段未包含 fff，TUI 找不到该服务器。补回 `~/.redcode/redcode.jsonc` `mcp.fff` 定义（本地 exe，cwd `$REDCODE_ROOT`，60s timeout）
- **默认主题被 getCustomThemes 错误覆盖为 opencode**：`init()` 中 `getCustomThemes()` 扫描已不存在的 `~/.config/redcode/themes/` 目录后抛错，catch 将其强制设为 `"opencode"`，覆盖了 store 默认的 `"karina"`。改为 fallback 到 `"karina"`（`theme.tsx` catch handler）
#### 变更

- **侧边栏缓存百分比移至底栏**：侧边栏 `cache X,XXX,XXX (98.5%)` 因 row 宽不足换行，去掉百分比显示，仅保留 token 数字。百分比移到底栏 color-coded 显示（≥80 绿 / ≥50 黄 / ≥20 灰 / <20 红），一眼判断缓存效率（`sidebar/context.tsx`、`prompt/index.tsx`）

### [0.5.6] - 2026-06-13

#### 变更

- **全局目录统一到 `~/.redcode/`**：废弃 XDG 散落的 4 个目录（`~/.config/redcode`、`~/.local/share/redcode`、`~/.local/state/redcode`、`~/.cache/redcode`），全部收归 `~/.redcode/` 下子目录（`data/`=数据库+auth+log、`state/`=会话状态、`cache/`=bin 缓存）。config 直接用 `~/.redcode/` 根目录（已有 redcode.jsonc/souls/skill）。移除 `xdg-basedir` 依赖，不再依赖 XDG 规范。一个目录管所有，private git 统一跟踪（`packages/core/src/global.ts`）

### [0.5.5] - 2026-06-13

#### 修复

- **TUI 侧边栏 Orphan text 崩溃**：`sidebar/context.tsx:136` cacheHit 命中率显示的 `<span>` 裸放在 `<box>` 下，没被 `<text>` 包裹。当 cacheHit 不为 null 时 Ink/SolidJS TUI 抛 Orphan text error 致命崩溃。给 `<span>` 外套 `<text>` 修复。感谢小宋发现并修好 😏

### [0.5.4] - 2026-06-12

#### 修复

- **缓存命中率分母修正（input 不应计入分母）**：0.5.3 引入的全会话聚合缓存率中，分母使用了 `input + read + write`。但 input tokens 是未命中缓存的 fresh 输入，不应算入 cache 有效请求总数。修正为 `read + write`，使缓存命中率与 API 后台显示的数值一致（如 `read=100K, write=50K, input=200K`，之前算得 `28.6%`，修正后 `66.7%`）。涉及 TUI 侧边栏、底栏、子代理 footer 三处（`sidebar/context.tsx`、`prompt/index.tsx`、`subagent-footer.tsx`）+ GUI 指标面板（`session-context-metrics.ts`）+ CLI run data（`session-data.ts`）
- **插件 `~` 路径扩展**：`isPathPluginSpec` 和 `resolvePathPluginTarget` 支持 `~`/`~/` 开头的文件路径，自动展开为用户的 home 目录（`src/plugin/shared.ts`）

#### 新增

- **侧边栏缓存命中率区间颜色**：`< 50%` 红色（`error`）、`50%~80%` 黄色（`warning`）、`>= 80%` 绿色（`success`），一眼判断缓存效率（`sidebar/context.tsx`）
- **默认主题改为 Karina**：程序首次启动时自动加载 Karina 主题（深蓝钢色调），而非之前的默认 opencode 主题（`theme.tsx`）
- **侧边栏 Context 面板全面上色**：provider 用 `secondary`、model 用 `primary`、input/output 分 cyan/green 区分、reasoning 用橙色醒目标识、cache read/write 分色显示、费用用 `primary` 高亮、agent 名用 `accent`。告别全灰扁平，花花绿绿一眼可读（`sidebar/context.tsx`）

### [0.5.3] - 2026-06-12

#### 新增

- **跨会话感知（cross-session awareness）**：新会话启动时自动注入最近 24 小时内的其他会话摘要（标题、persona、统计），让敏敏/小宋互相知道对方做了什么，避免重复修改同一文件。查询共享 SQLite DB，按 `directory` 字段自动识别 TUI（敏敏）vs GUI（小宋）身份。每条格式 `[Xm ago] [小宋/GUI] 标题 (+N/-N, M files)`（`src/session/instruction.ts` `recentSessionDigest()`）
- **缓存命中率改为全会话聚合**：之前只取最后一条 assistant 消息的缓存率（≈99%），与 DeepSeek/MiMo 后台显示的 ~95% 不符。改为遍历全部 assistant 消息求和 `read/(input+read+write)`，结果与后台一致。影响 TUI 侧边栏、底栏、子代理 footer 三处显示（`sidebar/context.tsx`、`prompt/index.tsx`、`subagent-footer.tsx`）+ GUI 指标面板（`session-context-metrics.ts`）
- **anti-deferral 规则**：系统提示词（deepseek/mimo/minimax 三档）+ AGENTS.md 红线 + souls 人格文件均加入禁止"先放着/回头处理"规则，杜绝 code agent 询问是否搁置问题的行为。soul 文件同步删除"要不要…还是…"模板，强化"发现问题就修、做不到直说"（`prompt/{deepseek,mimo,minimax}.txt`、`AGENTS.md`、`.opencode/agents/{Gsoul,Tsoul}.md`）

#### 修复

- **跨会话感知 persona 判断逻辑修正**：cc 原始实现 `directory.includes("dist") ? "小宋/GUI" : "敏敏/TUI"` 逻辑反了——TUI 从 `packages/opencode/dist/...` 启动，应标记为敏敏。修正为 `directory.includes("dist") ? "敏敏/TUI" : "小宋/GUI"`（`src/session/instruction.ts`）
- **跨会话感知时间戳单位不匹配（毫秒/秒）**：`recentSessionDigest()` 两处使用 `Date.now() / 1000`（秒）与 DB 中毫秒级 `time_updated` 比对和计算，导致（1）24h 过滤器对毫秒级 `gte` 永远为 true 形同虚设，（2）`ago` 显示为巨量负数（如 `-29657816216m ago`）。修正为统一使用毫秒：cutoff 加 `* 1000`，`ago` 计算先除 `1000` 再除 `60`（`src/session/instruction.ts`）

#### 配置

- **DCP + token-compressor 共存确认**：验证两插件 hook 层完全不重叠（DCP: `messages.transform`/`system.transform`/compress 工具；TC: `tool.execute.after`），效果叠加无冲突。DCP 管去重/压缩/nudge，TC 管精细规则截断（`redcode.jsonc`）

### [0.5.2] - 2026-06-12

#### 修复

- **token-compressor 插件导致流式中断**：小宋写的 `token-compressor.js` 插件（意图替代 DCP）在 `experimental.chat.messages.transform` hook 中有致命 bug——`lastUserMessageTurn` 永远为 0，导致 `messagesSinceLastUser = turnCount` 无限增长，15 轮后每次请求注入畸形 `{role: "system"}` 消息，API 调用挂起。根因→状态变量从未被更新（`~/.redcode/plugin/token-compressor.js`）
- **DCP 移除后 compaction 永不触发**：DCP 被注释掉后，引擎 compaction 依赖 `model.limit.context`（现代模型 100 万+），197K token 也不触发压缩。根因→无兜底阈值（`src/session/overflow.ts`）

#### 新增

- **engine compaction.threshold 配置**：config schema 新增 `compaction.threshold` 字段（NonNegativeInt），当 token 总量超过该值时强制触发 compaction，不依赖模型声明的 context limit。设为 150K，作为 DCP 之外的引擎级兜底（`src/config/config.ts` + `src/session/overflow.ts`）
- **token-compressor 插件重写（基于 TokenJuice）**：完全重写为仅用 `tool.execute.after` hook 的安全插件，不碰消息管道。移植 openhuman/TokenJuice 的 14 条规则（git/cargo/tsc/npm/bun/docker/find/ls/grep + 通用兜底），支持 skip/keep/head/tail/failHead/failTail/counters/onEmpty。pass-through 安全：<512 字节不压、压缩率 >95% 不替换（`~/.redcode/plugin/token-compressor.js`）

#### 配置

- **DCP 插件恢复**：`@tarquinen/opencode-dcp` 重新启用（v3.1.12），与 token-compressor 分工——DCP 管去重/compress 工具/nudge（`messages.transform` 层），token-compressor 管精细规则截断（`tool.execute.after` 层），两者不同 hook 层互不冲突（`redcode.jsonc`）

### [0.5.1] - 2026-06-12

#### 修复

- **ast-grep native binding 启动崩溃**：`import("@ast-grep/napi")` 在 Tool.init 阶段立即执行，bun compile 后的单文件二进制找不到 native module → 服务端 fatal crash（TUI 闪退 / GUI sidecar 500）。改为 lazy load：init 时只创建 getter，首次调用 ast_grep 工具时才 import，单例缓存后续复用（`src/tool/ast_grep.ts`）
- **plugin undefined hook → provider 500**：`snip.js` 导出裸函数 `toolExecuteBefore`（不是 Plugin factory），被 `getLegacyPlugins` 当 factory 调用后返回 undefined，push 进 hooks 数组。后续 `provider.ts` / `plugin/index.ts` 遍历 hooks 时在 undefined 上访问 `.provider` / `.auth` / `.config` 属性直接 TypeError 500。修法→`applyPlugin()` 对 `server()` / legacy factory 返回值做 null guard，undefined 不入 hooks（`src/plugin/index.ts`）
- **provider 遍历 null guard**：`provider.ts:1258` 的 `for (const hook of plugins)` 增加 `if (!hook) continue` 防御，即使 hooks 数组混入 undefined 也不崩（`src/provider/provider.ts`）

#### 配置

- **移除不存在的 npm plugin 声明**：`redcode.home.jsonc` 中 `"plugin": ["@tarquinen/opencode-dcp", "opencode-snip"]` 两个包未安装到 node_modules，plugin loader 加载失败后产生空 hook 触发上述 provider crash。注释掉声明（`.opencode/redcode.home.jsonc`）
- **compaction 参数适配 100 万 token 窗口**：`preserve_recent_tokens` 从 2K-8K 调至 64K，`reserved` 从 20K 调至 50K，`tail_turns` 从 2 调至 3。减少频繁压缩，长对话体验更流畅（`~/.redcode/redcode.jsonc`）

#### 改进

- **编辑后自动验证（auto-validate skill）**：借鉴 RedsWhale 的 LSP post-edit 钩子，新建 `auto-validate` skill——每次 edit 源代码文件后立即触发 typecheck/test，形成紧密反馈循环，不用等到任务结束。AGENTS.md 工作方式章节同步更新（`~/.redcode/skill/auto-validate/SKILL.md` + `AGENTS.md`）

### [0.5.0] - 2026-06-11

#### 新增

- **`git` 工具**：新增内置 git 工具，封装 Git.Service 为 LLM 可用的结构化 git 操作——支持 `status`（工作树状态）、`diff`（差异对比）、`log`（提交历史）、`show`（历史文件内容）、`branch`（分支信息）、`stash_list`（暂存列表）。返回格式化输出，比 shell 执行 git 更易解析（`src/tool/git.ts` + `git.txt`）
- **`env` 工具**：新增内置 env 工具，提供环境信息检索——支持 `platform`（OS/版本/架构）、`paths`（关键路径）、`memory`（内存/磁盘）、`cpu`（内核/型号），以及按名称查询特定环境变量。用于调试环境问题、确认工具可用性、检查系统配置（`src/tool/env.ts` + `env.txt`）
- **工具 descriptions 升级为"pushy"风格**：为 `ast_grep`、`webfetch`、`skill` 等工具增加更明确的使用时机指引（OMP 风格），告诉模型"什么时候用这个、什么时候用别的"，减少错误触发

#### 变更

- **Tree-sitter 解析器新增 PowerShell 支持**：`tree-sitter-powershell` 已加入依赖，shell 工具可正确解析 PowerShell 命令的路径参数

#### 修复

- **缓存命中率二次修正**：0.4.15 的修法有误——DeepSeek API 只有"命中/未命中"两档，未命中 token 由 AI SDK 放入 `tokens.input`（调整后非缓存输入），`cache.write` 对 DeepSeek 始终为 0，导致改后公式 `read/(read+0)` 仍约等于 100%。正确公式为 `read/(input+read+write)`，分母恒等于全部 prompt token（命中+未命中），无论未命中 token 落在哪个桶均成立。结果现与 DeepSeek 开放平台显示一致（如 95.8%），而非永远 99-100%（`sidebar/context.tsx`、`prompt/index.tsx`、`subagent-footer.tsx`、`session-data.ts`）

### [0.4.16] - 2026-06-11

#### 新增

- **敏敏人格主题（Karina）**：新增内置主题 `karina`，冷蓝灰色调（primary `#7eb8da`、accent `#8ba2c6`），完整 dark/light 双模式 47 色，TUI 是敏敏主场（`context/theme/karina.json` + `theme.tsx` 注册）

#### 修复

- **TUI 启动闪退（ConfigJsonError）**：根因→`~/.redcode/redcode.jsonc` 中文注释被 GBK 编码损坏（乱码 `鍏ㄥ眬娉ㄥ叆`），JSONC 解析器在损坏行报 `ColonExpected` 崩溃；改法→源模板 `.opencode/redcode.home.jsonc` 所有注释改纯 ASCII 英文，杜绝 bat/git 编码转换再次破坏

#### 变更

- **TUI 中文适配全面落实**：80+ 条 tips 翻译（`tips-view.tsx`）；toast/dialog 全量中文化（`app.tsx`、`dialog-status.tsx`、`dialog-help.tsx`、`error-component.tsx`、`dialog-select.tsx`、`dialog-alert.tsx`、`dialog-prompt.tsx`、`dialog-export-options.tsx` 等 13+ 文件）；命令面板标题中文化（"切换模型/代理/主题"等）

### [0.4.15] - 2026-06-11

#### 新增

- **双层记忆系统**：引擎自动注入项目级 `.redcode/MEMORY.md`（项目专有备忘）；项目级不存在时回退全局 `~/.redcode/MEMORY.md`（跨项目通用教训）。解决了之前 MEMORY.md 不自动加载、跨项目教训丢失的问题（`session/instruction.ts` `systemPaths()`）
- **新项目自动初始化 `.redcode/`**：bootstrap 检测项目根既无 `.opencode/` 也无 `.redcode/` 时，自动创建 `.redcode/MEMORY.md` 空模板，新项目开箱即有项目级记忆（`project/bootstrap.ts`）
- **Soul 自动注入**：根据 `REDCODE_CLIENT` 环境变量（desktop=GUI / cli=TUI）自动注入对应人格文件（`~/.redcode/souls/Gsoul.md` 或 `Tsoul.md`）为系统级指令，不再需要每次手动 `/gui-persona` 或 `/tui-persona`；系统级注入不受 compact 丢失（`session/instruction.ts` `systemPaths()`）

#### 变更

- **AGENTS.md 重写**：新增记忆系统双层架构说明、记忆流动规则（全局→项目/项目→全局）、跨项目工作规则（别的项目发现 RedCode bug 提醒用户回 RedCode 工作区修）、版本更新 checklist（含双语 README 同步）、质量门禁（从 souls 迁入，报告门禁/首次编辑不熟文件/Guardrail 档位/compress 用法/协作模式）
- **Soul 模板瘦身**：Gsoul.md（140→68 行）/ Tsoul.md（142→64 行），操作规则全部迁入 AGENTS.md（系统级，compact 不丢），souls 只保留人格/语气/说话方式

#### 修复

- **缓存命中率计算修正**：根因→分母 `input + cache.read + cache.write` 中 `input` 已包含 cache tokens（API 返回值语义），cache.read 在分子分母都出现且分母被膨胀，导致命中率永远 ~99%；改法→分母改为 `cache.read + cache.write`（纯缓存命中率），并保留一位小数（`*1000/10`）。涉及 5 处：GUI metrics（`session-context-metrics.ts`）/ TUI sidebar（`sidebar/context.tsx`）/ TUI prompt（`prompt/index.tsx`）/ TUI subagent-footer（`subagent-footer.tsx`）/ CLI run（`session-data.ts`）

### [0.4.14] - 2026-06-10

#### 清理

- **core/plugin 类型导入显式化**：`plugin.ts` 对 `agent.ts` / `catalog.ts` 的 `import type` 由 namespace 导入改为直接类型导入（`import type { Info as AgentInfo, ID as AgentID }`），显式标注依赖边界，避免后续误改成 value import 引入真循环。

#### 修复

- **effect-drizzle-sqlite 双循环依赖破除**：
  - 循环1 `db.ts ↔ session.ts`：根因 `SQLiteEffectTransaction` 类定义在 `session.ts` 但继承自 `db.ts` 的 `SQLiteEffectDatabase`；将 `SQLiteEffectTransaction` 类迁至 `db.ts`，`session.ts` 改用 `import type` 回指，消除 value-level 循环
  - 循环2 `session.ts ↔ up-migrations/effect-sqlite.ts`：根因 `migrate` 函数定义在 `session.ts` 并 value-import 上游迁移模块；将 `migrate` 提至新建 `sqlite-core/effect/migrate.ts`，`session.ts` 和 `effect-sqlite/migrator.ts` 更新 import 路径
  - 两个循环均为 type-level 边缘 + 单向 value 依赖，现已全破
- **侧边栏缓存 token 分母为 0**：`sidebar/context.tsx` 中 cache 信息展示 `read / write`，write=0 时显示 `X,XXX / 0`；新增 cacheHit 命中率计算，write=0 时只显示读数值+命中率，与 GUI 侧同修
- **多模态图片双重 data URL 编码**：`@ai-sdk/openai-compatible` 对 `data` 字段再包一层 `data:...;base64,` 前缀导致图片 base64 损坏；`message-v2.ts` 新增 `stripDataUrlPrefix()` 在传入 AI SDK 前去除 data URL 前缀只保留 raw base64，用户消息和 tool-result media 两处均修（`session/message-v2.ts`）

### [0.4.13] - 2026-06-10

#### 清理

- **移除提示词中已下线的 CodeGraph 引用**：deepseek / mimo / minimax 三个紧凑提示词的工具优先级段落仍写着 "(3) CodeGraph — knowledge-graph search and call-chain tracing"，但 CodeGraph 已从项目移除（现仅 jCodeMunch + TypeGraph），属死引用；删除该子句，避免模型被引导调用不存在的工具（`session/prompt/{deepseek,mimo,minimax}.txt`）。

### [0.4.12] - 2026-06-10

#### 修复

- **MCP 客户端创建 failure-safe（移植上游 opencode #31595）**：根因→`create` 抛错被调用点 `Effect.catch(() => Effect.void)` 整个吞掉，服务起不来时连"失败"状态都不记录、直接从状态栏凭空消失；改法→`create` 外层包 `Effect.catchCause`，任何意外抛错收敛成 `status:"failed"` + 错因（`Cause.squash`，仅中断除外），调用点去掉吞错的 catch；文件 `mcp/index.ts` `create` / state forEach 调用点。
- **MCP 连接失败打可操作日志（移植上游 #31544）**：根因→服务不可用时只在 `connectLocal` 内部记 error，create 层无统一提示；改法→`!mcpClient` 且状态非 connected/disabled 时打 `server unavailable`（带 key/type/status）便于排障；文件 `mcp/index.ts` `create`。
- **getPrompt / readResource 加超时（移植上游 #31612）**：根因→之前只 tools 调用有超时，prompts/resources 请求无超时可永久挂起；改法→`withClient` 按 配置 timeout → `experimental.mcp_timeout` → `DEFAULT_TIMEOUT`(30s) 顺序取超时并透传给 `client.getPrompt`/`readResource`；文件 `mcp/index.ts` `withClient` / `getPrompt` / `readResource`。

### [0.4.11] - 2026-06-10

#### 新增

- **LSP 深度集成 — rename / codeAction / completion**：三个新 LSP 工具操作
  - `rename`：跨项目重命名符号，`newName` 参数指定新名
  - `codeAction`：获取当前位置可用代码操作（快速修复、重构等）
  - `completion`：获取当前位置的补全建议

### [0.4.10] - 2026-06-10

#### 新增

- **`task` 工具 `isolation:"worktree"` 子代理隔离**：子代理可在独立 git worktree（独立工作目录 + 分支）中运行，文件改动不触碰父工作区，用于高风险或并行改动
  - 新增 `Worktree.createAndWait`（`worktree/index.ts`）：同步建 worktree → populate(`git reset --hard`) → `store.load`，直接返回该实例 `InstanceContext`，**不走 fork/事件总线**，无竞态、错误正常传播
  - `prompt.ts` 新增 `runIsolated`：用 `Effect.serviceOption(Worktree.Service)` 运行时查找 Worktree（app/server 已在同级 `mergeAll` 提供，共享根实例不分裂），`run` 在隔离实例下跑（`Effect.provideService(InstanceRef, ctx)`），工具 cwd 随之隔离。serviceOption 不入 R 通道 → `SessionPrompt.layer` 依赖不变，零波及面
  - `task.ts` 新增 `isolation` 参数 + `isolatedOutput`（回报 worktree 目录/分支）；后台子代理与 worktree 隔离互斥（显式报错）

#### 修复

- **worktree 分支前缀品牌归一**：`makeWorktreeInfo` 生成的分支前缀 `opencode/${name}` → `redcode/${name}`（`worktree/index.ts:196`）

### [0.4.9] - 2026-06-10

#### 新增

- **`/subtask` 命令**：后台派发独立子任务，上下文隔离，主对话不被子任务的中间过程污染（`.opencode/command/subtask.md`）

#### 修复

- **提示词路由补全**：`system.ts` 的 `provider()` 之前 deepseek/mimo 模型全部跌回 95 行 verbose `default.txt`；补 deepseek/mimo 分支走各自紧凑提示词
  - 新增 minimax 分支：`api.id` 含 `minimax`（含 m3 及以后）复用 `PROMPT_MIMO` 紧凑风格（内容非模型专属，复用不造重复文件）
- **剪贴板贴图**：PowerShell `Get-Clipboard` 的 base64 stdout 会嵌入换行/空白导致解码失败；解码前 `replace(/\s/g, "")` 清洗，并加 magic bytes 校验确认确为图片（`tui/util/clipboard.ts`）

#### 变更

- **提示词品牌名归一**：`anthropic.txt` / `default.txt` / `kimi.txt` 正文里的 `opencode` / `OpenCode` 显示文案统一改为 `RedCode`

### [0.4.8] - 2026-06-10

#### 新增

- **记忆系统全面升级**：长尾教训从"每轮整体注入"改为"按需召回"，大幅省 token
  - **FTS5 trigram 召回**：`su-prememory` MCP 的 FTS5 分词器从 unicode61 改 trigram，中文可正常召回；带旧表迁移（检测非 trigram 的 `memories_fts` 表即 drop 重建）；`recall` 走 bm25 相关性排序，query <3 字回退 LIKE 兜底（`plugins/mcp-su-prememory-local/src/index.ts`）
  - **`/recall` 命令**：按关键词从 `MEMORY.md` 召回历史教训，配 `recall-memory.mjs`（node 调用绕开 PowerShell `bun.ps1` 执行策略封禁）
  - **CORE 块每轮注入**：新增 `memory.ts` 插件，每轮把 `~/.redcode/AGENTS.md` 的 CORE 块追加到 system 末尾（最高 recency），无标记即 no-op，公开仓零个人痕迹
  - **MEMORY.md 退出整体注入**：`redcode.home.jsonc` 的 `instructions` 去掉 `~/.redcode/MEMORY.md`，改 `/recall` 按需召回，工作铁律由 CORE 块兜底；USER 画像仍自动加载
  - **会话摘要索引**：新增 `~/.redcode/memory/INDEX.md`，每 session 一条 50–100 token 摘要，SessionStart 优先读索引、需细节再翻全量 `YYMMDD.md`；`memory-automation` skill 已接线（SessionStart 先读 INDEX、Stop 时追加摘要）

#### 修复

- **MCP spawn ENOENT（dev/GUI-sidecar）**：`resolveMcpCwd` 在 `findRedcodeRoot()` 返回空（如 `bun run dev` 下 execPath=bun.exe 向上找不到安装根）时，`$REDCODE_ROOT` 残留字面量 → spawn cwd 指向不存在目录 → ENOENT；改为 `root || fallback`，空根回退到 `InstanceState.directory`（`mcp/index.ts`）
- **typegraph-mcp 进程泄漏（Windows）**：命令从 `npx` 改 `node` 直起本地 tsx — npx 在 Windows 被 `cmd /c` 包装，真正的 node 子进程脱离 `transport.pid` 无法被 `taskkill /T` 回收 → 进程泄漏；同时工具从 14 个精简到 3 个 tsserver 类型工具（其余被 jcodemunch 覆盖）（`plugins/typegraph-mcp/server.ts`、`redcode.jsonc`）

#### 构建

- **`.gitattributes` 钉死行尾**：统一 LF/CRLF 规则 + 一次性归一，避免跨机器行尾漂移

### [0.4.7] - 2026-06-08

#### 改进

- **消息前缀动态化**：用户消息和助手消息的前缀从硬编码改为从配置文件读取
  - 用户名：从 `~/.redcode/USER.md` 的 `称呼：` 字段读取，默认 `User`
  - Agent 名：从 `~/.redcode/souls/Tsoul.md` 的第一行标题读取，默认 `Assistant`
  - Agent 配置新增 `displayName` 字段，支持自定义显示名
- **工具图标升级**：替换朴素 ASCII 图标为更有辨识度的 Unicode 符号
  - Shell: `$` → `⌘`
  - Write/Edit: `←` → ``
  - Read/Question/Skill: `→` → `◉`
  - Glob/Grep: `✱` → ``
  - WebFetch/ApplyPatch: `%` → `⊡`
  - Task: `│` → `⬡`
  - WebSearch: `◈` → `◎`
- **消息分隔线**：长对话中消息之间添加 `· · ·` 分隔，提升可读性

### [0.4.6] - 2026-06-07

#### 新增

#### 文档

- **MANUAL.md 大幅更新**：MCP 章节从 4+2 个服务器升级为 4 类表格化呈现

### [0.4.5] - 2026-06-07

#### 新增

- **Agent Reach — 统一搜索 MCP**：新增 `plugins/agent-reach-mcp/`，内置 6 个搜索工具覆盖 3 大平台
  - `search_github` / `get_github_repo` — 搜仓库、搜 Issue、看详情（通过 `gh` CLI）
  - `search_bilibili` / `get_bilibili_video` — 搜 B站视频、提取字幕（B站 API + yt-dlp）
  - `get_douyin_video` — 解析抖音视频信息（通过 yt-dlp Douyin extractor）
  - `doctor` — 一条命令检查各工具可用性
- **Exa 语义搜索 MCP**：接入 Exa AI 语义搜索引擎（`type: "remote"`，`https://mcp.exa.ai/mcp`），免费 1000 次/月，覆盖 web search + web fetch
- **MCP disabledTools 配置**：`ConfigMCP.Local` 新增 `disabledTools` 字段，可在配置层面屏蔽指定 MCP 服务器的多余工具，无需改 RedCode 源码
  - 应用于 codegraph：隐藏 7 个被 jCodeMunch 替代的冗余工具，仅暴露 `codegraph_explore`
- **Supermmemory 本地记忆插件**：`plugins/mcp-su-prememory-local/` — 纯本地 SQLite+FTS5 语义记忆 MCP，三种工具（`memory` 记/忘、`recall` 搜、`stats` 统计），数据存 `~/.redcode/supermemory.db`
- **Diagnose 技能**：`.opencode/skill/diagnose/SKILL.md` — 结构化 bug 诊断工作流（重现 → 缩小范围 → 定位根因 → 修复 → 验证），适配自 @mattpocock/skills

#### 安装/配置

- **Agent Reach 依赖安装**（各平台首次使用前需执行）：
  - B站/抖音：`uv tool install yt-dlp`（视频信息提取）
  - GitHub：`gh` CLI 预装，`gh auth login` 后可用

### [0.4.4] - 2026-06-07

#### 新增

- **MCP 全局配置化**：`ConfigMCP.Local` 新增 `cwd` 字段（支持 `~/` 和 `$REDCODE_ROOT` 占位符展开）；`mcp/index.ts` 新增 `findRedcodeRoot()` 从 exe 路径自动定位 RedCode 安装根目录；6 个 MCP 服务器定义从项目级配置（`opencode.jsonc` / `redcode.jsonc`）移至全局 `~/.redcode/redcode.jsonc`。现在在任何项目目录启动 RedCode 均可自动加载 MCP 工具，不依赖项目 `.opencode/` 目录
- **Session 全局 scope**：`Session.list()` 支持 `scope: "global"` 列出所有项目的会话（不限于当前项目）；HTTP API (`GET /session?scope=global`) 及 SDK 类型同步更新；会话目录过滤默认关闭（`session_directory_filter_enabled` 默认值 `true` → `false`），新用户开箱即见跨项目会话列表
- **技能指令全局化**：6 个共享技能指令从项目配置（`opencode.jsonc` / `redcode.jsonc`）移至全局 `~/.redcode/redcode.jsonc`，使用 `~/.redcode/skill/...` 路径，跨项目目录自动加载。之前仅在 RedCode 项目内可用的技能（memory-automation、guardrail-profiles、defensive-agent、goal-automation、simplify、vision-autoagent）现在任意项目目录均生效。同时也补上了之前漏掉的 `simplify` 技能注入

#### 改进

- **记忆自动化规则强化**：扩展 SKILL.md 中的硬触发器（批评/夸奖/个人信息/项目决策 → 自动记日志），提升自动提取的可靠性

### [0.4.3] - 2026-06-06

#### 新增

- **条件技能（paths frontmatter）**：SKILL.md 支持 `paths` 字段声明 glob 模式（如 `"src/**/*.py"`）。设定了路径的技能只在当前项目目录匹配时才注入系统上下文，避免无关技能膨胀 prompt。`Skill.available()` 新增 `directory` 参数，`forDirectory()` 内部使用 `Glob.scan` 做路径匹配
- **search_tools 工具**：新增 `/search_tools` 工具，允许 LLM 按名称或描述搜索可用工具。端口自 claude-code 的 SearchExtraToolsTool 模式。所有内建/MCP/插件工具均可搜索
- **buildTool 简化工场**：`Tool.build()` 工厂函数，为零服务依赖的简单工具提供更简洁的创建方式，安全默认值，支持 3 行创建一个工具

#### 重构

- **Shell cancel race 修复**：从 upstream 移植 `run-state.ts` `cancel()` 中缺失的 `busy` 检查，避免 shell 取消时的竞态条件

#### 技术债

- **Effect v4 类型适配**：`Tool.build()` 需要 `as Effect.Effect<DefWithoutID>` 断言以保持泛型参数推断；搜索工具使用 `InstanceState.get(state)` 而非 `ToolRegistry.Service` 避免层内循环依赖

---

### [0.4.2] - 2026-06-06

#### 修复

- **"请选择智能体和模型"误弹 toast 根治（第 6 次复发）**：`bootstrap.ts` 新增 `agent_ready` 信号 + 5s 超时兜底；`local.tsx` 统一就绪 gate 收敛三路异步信号；`submit.ts` 轮询等最多 5s 而非静默丢提交；`use-providers.ts` `ready()` 不要求 `connected.length > 0`

#### 功能

- **Vision AutoAgent 技能**：DeepSeek 不支持多模态时自动调用 vision MCP (`qwen3-vl:8b`) 分析用户发送的图片，前端只回"分析中..."，不报错、不多耗 token。新建 `.opencode/skill/vision-autoagent/SKILL.md`，`redcode.jsonc` 统一注册所有 skill 至 `instructions` 段

#### 重构

- **双仓分离 — 隐私重构**：灵魂文件 (Tsoul.md/Gsoul.md)、工作记忆 (MEMORY.md)、每日日志 (memory/)、个人命令 (Karina.md/son.md) 全部从仓库移出。仓库仅保留通用模板，实际数据存 `~/.redcode/`。修改涉及：
  - `.opencode/agents/` → 空白模板，不再含个人人格
  - `.opencode/MEMORY.md` → 格式模板，清空个人内容
  - `.opencode/command/` → 重命名为 tui-persona/gui-persona，路径指向 `~/.redcode/souls/`
  - `AGENTS.md` / `README.md` / packages `AGENTS.md` → 抹掉所有个人身份名
  - `CHANGELOG.md` / 配置文件 → 清除 `D:\AI\`、`D:\AI\KLX\` 等硬编码路径
  - `script/sync-home.bat` → 停止同步个人文件，只同步 skill/插件
  - `skill/memory-automation` / `*` → `哥哥` → `用户`，路径改为 `~/.redcode/`
  - 全身搜索已确认无个人名/路径/称呼残留

#### 新增

- **启动时自动播种 `~/.redcode/`**：`InstanceBootstrap.run` 中新增 `ensureDir` + 模板复制逻辑。首次启动自动创建 `~/.redcode/{memory,souls}/`，从 `.opencode/agents/` 复制 Tsoul.md/Gsoul.md/USER.template.md/MEMORY.md，已存在的文件不被覆盖。TUI、GUI sidecar、打包 exe 均走同一路径

#### 文档

- **README 精简 + MANUAL.md 用户手册**：README 仅保留核心介绍和快速开始链接；MANUAL.md 从新人视角编写 420 行完整操作指南，覆盖模型配置、MCP 安装、人格系统、记忆系统、权限控制、Skill 扩展、多机同步

### [0.4.1] - 2026-06-05

#### 修复

- **web-search MCP 系统代理探测**：`search-server/index.ts` 的 `fetchHtml` 之前直接调 PowerShell `Invoke-WebRequest` 不传 `-Proxy`，系统代理关了就直连超时；新增 `getSystemProxy()` 读注册表 `Internet Settings` 的 `ProxyEnable`/`ProxyServer`，代理开启时提取地址显式传给 `-Proxy` 参数，启动时探测一次缓存（`.opencode/search-server/index.ts:25-56`）
- **Compaction 静默化**：之前压缩摘要的完整文本会渲染进对话滚动区，干扰阅读；过滤掉 `mode === "compaction"` 的 assistant 消息，三处同步修改（`pending` memo / `lastAssistant` memo / render Match 条件），标题栏 `—— Compaction ——` 保持不变（`routes/session/index.tsx:204,208,1213`）

#### 优化

- **doom_loop 循环检测扩展**：原判定仅覆盖「同一工具连续 3 次」；新增 `CYCLE_WINDOW = 6` 窗口，检测 A→B→A→B（周期 2）和 A→B→C→A→B→C（周期 3）交替模式，解决 MiMo 等模型在 agentic 任务中反复横跳却绕过阈值的问题（`session/processor.ts:427-458`）

### [0.4.0] - 2026-06-04

#### 新增

- **ECC 启发三件套**：借鉴 ECC（Everything Claude Code）的设计理念，新增三个共享 skill：
  - **`memory-automation`** — 自动化记忆环：SessionStart 自动注入最近 3 天日志教训、PreCompact 保存状态到 `.session-last.json`、Stop 时自动提取教训更新长期库（`.opencode/skill/memory-automation/SKILL.md`）
  - **`guardrail-profiles`** — 三档控制：`ECC_PROFILE=minimal|standard|strict` 环境变量切换，不改配置文件；minimal 少确认快干活、strict 每步都问（`.opencode/skill/guardrail-profiles/SKILL.md`）
  - **`defensive-agent`** — Agent 防御性设计：11 种 FP 不报、4/4 confidence gate、首次编辑不熟文件强制调查引用和依赖（`.opencode/skill/defensive-agent/SKILL.md`）
- **ecc-shell-stub v2**：注入 `ECC_PROFILE`/`ECC_MEMORY_RECENT`/`ECC_MEMORY_LONG` 到 `shell.env`，`permission.ask` 按 profile 区分放行策略
- **Tsoul 人格内化防御模式**：新增"防御模式""怎么改不熟的文件""Guardrail 怎么跑"小节
- **HOOKS.md**：定义 RedCode 的生命周期约定（SessionStart/PreCompact/Stop），plugin 自动 + agent 手动分工

- **DCP 插件集成**：安装 `@tarquinen/opencode-dcp`（动态上下文裁剪），自动压缩旧对话、去重工具调用、裁剪错误输入，节省 token
- **`opencode.jsonc` + `redcode.jsonc` 自动加载**：两个配置文件同步添加 `plugin` + `instructions`，启动即生效

- **`web-search` 极简 MCP server**：受 FreeWeb 启发，只保留 `web_search` 一个工具（`.opencode/search-server/index.ts`，165 行），DuckDuckGo HTML 搜索 + Yahoo 兜底，零 API key；依赖仅 `@modelcontextprotocol/sdk` 一个包，启动 ~1s；Windows 系统代理自动透传（走 PowerShell `Invoke-WebRequest`）

### [0.3.17] - 2026-06-04

#### 新增

- **DeepSeek / MiMo 专属系统提示词**：`session/system.ts` 的 `provider()` 新增 `deepseek`/`mimo` 子串匹配，分别返回 `prompt/deepseek.txt`、`prompt/mimo.txt`；主用的 DeepSeek V4 与小米 MiMo-V2.5 不再走 default 提示词
- **人格触发命令**：`.opencode/command/{gui-persona,tui-persona}.md`，对话里一条命令即加载 GUI/TUI 人格，比手打"你是X"更快；命令仅向上下文注入文字、不替换模型提示词（`request.ts` 的 `agent.prompt` 会顶掉 deepseek/mimo 提示词，故不做成 agent）。**修复**：命令此前从未被引擎加载——`config/paths.ts` 只扫 `.redcode` 目录，命令却放在 `.opencode/command/`；`script/sync-home.bat` 之前同步了 skill 却漏了 command。现补同步 `.opencode/command` → `~/.redcode/command`（真镜像：先删后拷），重启后命令真正生效

#### 工作流

- **全局配置目录迁移 `.redcode` → `~/.redcode`**：从旧位置迁到用户 home 目录。引擎 `config/paths.ts` 的 `directories()` 无条件扫描 `home/.redcode`，不管项目在哪个盘都自动发现，彻底解决跨盘/跨机器路径问题；`build.bat` 同步目标改为 `%USERPROFILE%\.redcode`
- **全局记忆/画像机制化注入**：`~/.redcode/redcode.jsonc` 的 `instructions` 由 `session/instruction.ts` 引擎侧读取并在 `:137` 展开 `~/`，每个项目启动自动注入 `MEMORY.md`/`USER.md`，消除旧的"靠 AGENTS.md 喊话读 MEMORY"行为链脆弱点

#### 文档

- **AGENTS.md 重构**：根 AGENTS.md 身份触发段补充人格命令与自动注入说明；`packages/{opencode,desktop}/AGENTS.md` 顶部加 breadcrumb（本包=TUI/GUI、对应人格），进子目录读文件时自动叠加强化身份

### [0.3.16] - 2026-06-03

#### 重构

- **语义颜色分层**：在 47 个扁平颜色属性之上新增 `theme.colors` 语义层，按 text/surface/border/status/diff/markdown/syntax 8 组分群。旧属性完全兼容，新代码可用 `colors.text.body`、`colors.surface.panel`、`colors.status.error` 等语义路径访问
- **Theme 类型导出**：`Theme` 类型从 `theme.tsx` 导出，`SharedSyntaxTheme` 收敛为类型断言，减少重复类型定义

#### 修复

- **llm 模块循环依赖**：`schema/options.ts` → `route/client.ts` → `schema/index.ts` → `schema/options.ts` 的 17 文件循环依赖降至 3 文件（transport barrel 循环，可接受）。移除 `schema/options.ts` 对 `route/client.ts` 的反向导入，改用本地类型定义
- **theme-store 测试**：`DEFAULT_THEMES.redcode` 修正为 `DEFAULT_THEMES.opencode`，恢复 4 个损坏的单元测试
- **system 主题 isDark 时序**：`generateSystem` 中 `isDark` 声明移至 `fallbackBg`/`fallbackFg` 之前，修复 Temporal Dead Zone 导致的 ReferenceError
- **palette 回退兜底**：`generateSystem` 中 `palette[0]`/`palette[7]` 可能为 undefined，补充 `#1a1b26`/`#ffffff` 硬编码回退色值
- **Proxy 类型安全**：`theme.tsx` 中 Proxy getter 移除 `@ts-expect-error`，改用 `keyof Theme` 类型断言
- **resolveTheme 过滤补全**：`backgroundMessage` 加入初始过滤列表，避免重复解析

### [0.3.15] - 2026-06-03

#### 新增

- **MCP 懒加载**：启动时不连接 MCP server，第一次调用该 MCP 的 tool 时才按需连接，减少冷启动等待
- **MCP pending 状态**：侧边栏 MCP 面板显示"Waiting…"等待状态，启动时一目了然

#### 工作流

- **删除文件单独授权**：`apply_patch` 中 `type: "delete"` 的操作需额外弹窗确认，不再是编辑权限附带的
- **灵魂文件进仓库**：`Gsoul.md` / `Tsoul.md` 从上级目录移入 `.opencode/agents/`，git 跟踪推送，换机自动同步
- **全局 workspace（`.redcode/`）**：在项目上级创建全局共享目录，包含 AGENTS.md、MEMORY.md、USER.md、souls 等，所有项目共享身份与记忆，不再每项目重复搭建
- **`build.bat` 版本自检**：编译前自动跑 `check-version-consistency.ts`，版本不一致时阻止编译并提示
- **权限范围扩展**：`containsPath` 增加上级目录检查，信任与项目同级的兄弟项目

---

### [0.3.14] - 2026-06-03

#### 新增

- **MCP 配置热重载**：文件 watch `redcode.jsonc`，检测到 MCP 配置变更后自动添加/删除/重连服务器，无需重启 TUI
- **MCP 工具调用进度推送**：耗时较长的 MCP 工具调用（如 browser 截图）实时显示进度状态，避免无响应感

---

### [0.3.13] - 2026-06-03

#### 新增

- **消息视觉区分**：用户消息添加 `> ` 前缀（agent 色加粗），AI 消息添加 ✦ 前缀（accent 色）
- **语义色 `backgroundMessage`**：用户消息背景色独立于面板色，后续主题可单独定制

#### 修复

- **Browser MCP 端口冲突**：server 启动时自动检测 9001 端口，被僵尸进程占用时自动 kill 旧进程并重试

---

### [0.3.12] - 2026-06-03

#### 新增

- **MCP 健康监控**：每 30s 检查所有 connected 的 MCP server，连续 3 次失败标记断开并自动尝试重连
- **MCP 工具调用失败自动重连**：tool call 报错时自动尝试 reconnect 并重试（最多 3 次）
- **MCP Transport 日志**：记录实际使用的 transport 类型（stdio/SSE/HTTP），便于排查

---

### [0.3.11] - 2026-06-03

#### 修复

- **MCP 进程树泄漏（Windows）**：`descendants` 在 Win32 直接返回空数组，导致每次 TUI 退出时子进程（codegraph/typegraph/npx 链）变成僵尸堆积。改为 `taskkill /F /T /PID` 一次杀整棵树，Unix 保持原逻辑
- **Browser MCP 断连**：server `socket.on("close")` 无条件置 `ws = null`，导致新连接被旧 socket 的 close 事件覆盖破坏。改为 `if (ws === socket)` 条件判断
- **exe MCP 路径解析**：编译后的 exe 运行时 `cwd` 是 bin/ 目录，相对路径（`./browsermcp-server/index.js`）解析失败。新增 `findProjectRoot`，从 exe 所在目录向上查找 `redcode.jsonc` 或 `.git`，确保 MCP 命令路径正确解析
- **滚动条默认值迁移**：kv 存储中旧的 `scrollbar_visible: false` 会覆盖新默认值。新增一次性版本迁移（`kv_version`），首次启动时自动升级为 `true`

#### 变更

- **滚动条默认开启**：消息区域右侧滚动条默认显示，支持鼠标点击轨道跳转和拖拽滑块滚动。可通过 `session.toggle.scrollbar` 命令或 `/mcps` 切换
- **Browser MCP 扩展 v1.0.3**：改用 `chrome.alarms` 保活（每 24s 触发），替代不可靠的 `setTimeout`，解决 Manifest V3 service worker 休眠后断连

#### 配置

- `redcode.jsonc` 新增 browsermcp 配置
- `.opencode/opencode.jsonc` 新增 browsermcp 配置

#### 新增

- **Browser MCP 集成**：新增浏览器自动化 MCP 服务器，支持导航、截图、点击、输入、获取页面内容等操作，可让 AI 直接操控主人的浏览器
- **jCodeMunch MCP 集成**：新增结构化代码检索服务器（60+ 工具），支持精确符号获取、死代码检测、影响评估、编辑安全预检、AST 模式匹配等，比 grep 省 95% token
- **TypeGraph MCP 集成**：TypeScript 语义导航服务器（14 个工具），支持类型解析、调用链追踪、barrel 文件穿透、循环依赖检测

#### Browser MCP 使用方式

1. 安装 Chrome 扩展：
   - 打开 `chrome://extensions/`
   - 开启"开发者模式"
   - 点"加载已解压的扩展程序" → 选择项目内的 `browsermcp-extension` 目录（相对路径，跨电脑/盘符通用）
2. 点击扩展图标 → Connect（图标显示绿色 "ON" 表示连接成功）
3. 重启 TUI 生效

可用工具：`browser_navigate`、`browser_go_back`、`browser_go_forward`、`browser_snapshot`、`browser_click`、`browser_type`、`browser_hover`、`browser_select_option`、`browser_press_key`、`browser_wait`、`browser_screenshot`、`browser_get_console_logs`

---

### [0.3.9] - 2026-06-02

#### 新增

- **Prompt 栏点击切换**：Agent 名称、模型名称、推理强度标签支持鼠标点击，直接弹出对应选择列表（DialogAgent/DialogModel/DialogVariant）
- **用户可配置快捷键**：`tui.json` / `tui.jsonc` 已完整支持 `keybinds` 字段覆盖默认快捷键，支持全局（`~/.config/redcode/tui.json`）、项目级、`.redcode/` 目录级配置，逐级合并覆盖

---

### [0.3.8] - 2026-06-02

#### 新增

- 动态终端标题：session 忙碌时标签栏显示 `▶` 前缀，空闲恢复；多 tab 终端一目了然
- 统一清理注册表：`CleanupRegistry` 集中管理所有退出清理（keymap、console 劫持、plugin runtime、audio），避免散落 `finally` 导致泄漏

#### 修复

- **构建流程修复**：Windows 上 `rm -rf` 因文件锁定失败不再中断编译，用 `try/catch` 安全跳过
- **版本号硬编码**：预览版不再生成 `0.0.0-dev-<timestamp>`，改用 `package.json` 中的真实版本号
- **Console 污染 TUI 渲染**：`console.log/warn/error` 在 TUI 启动后被劫持转入环形缓冲区（500 条），退出时还原，避免第三方库日志乱入终端

---

### [0.3.7] - 2026-06-01

#### 新增

- 记忆系统：新增每日日志 + 定期审视机制，被纠正时自动写入 `memory/YYMMDD.md`，收工时摘要合并到 MEMORY.md，确保教训跨会话持久

#### 修复

- **构建流程纠正**：TUI exe 编译改用 `bun run build -- --single`（`script/build.ts`），替代之前手拼 `bun build --compile` 的错误方式

---

### [0.3.6] - 2026-06-01

#### 新增

- 侧边栏 Context 区块充实：显示 provider 名、模型名、token 明细（输入/输出/推理/缓存）、消息数、agent 名、创建时间和最后活动时间；未知上下文上限显示 `?`，超过 200% 显示 `⚠` 警告
- Loading 动画替换：左下角蓝色方块 Knight Rider 动画改为 🐲🔥 喷火龙呼吸动画
- 右键粘贴：主输入框和对话框输入框支持右键粘贴剪贴板内容

### [0.3.5] - 2026-05-31

#### 新增

- prompt 输入框自适应 & 可配置高度：合并上游实现，文本框行数根据内容自动伸缩，支持用户配置最小/最大行数

#### 修复

- 行内 tool 行换行对齐：提取 `InlineToolRow` 组件，图标与文字使用 flex 布局，换行后文字正确对齐

### [0.3.4] - 2026-05-31

#### 新增

- Shell Mode：空提示框按 `!` 进入 Shell 模式，直接运行系统命令（通过 `session.shell` 而非发送消息），命令完成后自动退出 Shell 模式
- Session Switcher：新增 `$session.list` 命令和 `/sessions` 斜杠命令，打开会话切换对话框，支持按项目/状态过滤、消息预览和 diff 摘要

#### 修复

- Diff Viewer 改进：合并上游空白状态展示、交互优化、设计重设计等修复；修复文件树中已审查文件的勾选标记 Unicode 乱码
- 测试文件 import 路径修正：`diff-viewer.test.tsx` 中 `@opencode-ai` → `@redcode-ai`

### [0.3.3] - 2026-05-31

#### 修复

- compacted 会话 HTTP API 消息过滤：消息分页查询自动跳过 compaction summary 之前的旧消息，避免 GUI 加载大量旧消息导致 OOM/卡死。同时在 `packages/opencode` 侧生效，TUI 和 GUI 共享同一服务端
- 测试用例 import 补全：`db.test.ts` 补全 `it` 的 `bun:test` import，修复测试运行时引用错误

### [0.3.2] - 2026-05-30

#### 变更

- 统一数据库路径：移除 channel 分库逻辑（`redcode-dev.db` / `redcode-beta.db` 等），所有渠道统一使用 `redcode.db` 主库；删除 `disableChannelDb` 运行时标志
- 斜杠命令中文化：`/compact`→压缩会话、`/connect`→连接供应商、`/copy`→复制会话记录、`/export`→导出会话记录、`/fork`→分叉会话、`/init`→初始化 AGENTS.md、`/review`→审查变更

### [0.3.1] - 2026-05-28

#### 新增

- 对话框 Ctrl+V 粘贴：`dialog-prompt.tsx` 添加系统剪贴板读取，作为 bracketed paste fallback；`keybind.ts` 新增 `dialog.prompt.paste` 快捷键绑定

#### 修复

- DeepSeek 模型变体不可用：`transform.ts` 移除 DeepSeek 模型 variants 排除列表，`openai-compatible` 类型模型绕过 `reasoning` 能力检查

#### 重构

- 删除死代码：移除未使用的 `GoLogo` 组件（`logo.tsx`）、整个 `dialog-tag.tsx` 文件、未引用的 `Descriptions` 和 `TuiAttentionSoundPaths` 导出
- 类型安全提升：`toast.tsx` `err: any` → `unknown`、`kv.tsx` `defaultValue?: any` → `unknown`、`dialog.tsx` `replace(input: any)` → `JSX.Element`、`dialog-prompt.tsx` `ctx: any` → `CommandContext`、`local.tsx` 反序列化类型标注

---

## GUI

### [0.7.20] - 2026-08-13

> sidecar 猝死自愈：死了必留遗言、死了自动复活。GUI 断连不再需要重启整个应用——260813 上午实证 sidecar 静默 exit 0 后渲染层 `Failed to fetch` 无限刷屏、永不恢复，这次从两头堵死。

#### 修复

- **sidecar 静默蒸发不再死无对证**（`packages/desktop/src/main/sidecar.ts`）：实证死法是 exit code 0 干净退出，`uncaughtException`/`unhandledRejection`/`catch` 三条 `exit(1)` 路径全空、crash log 一行不留，主进程只看到 `sidecar exited { code: 0 }`。根因土壤在保活写法——`start()` 里 `await new Promise(() => {})` **不产生 active handle**，真正撑住进程的是 listener 的 listen socket；listener 一旦被意外关闭，事件循环排空，Node 自然 exit 0。新增 `beforeExit` 钩子：只在自然排空时触发（`process.exit()` 不触发，故合法 `stop()` 与 `exit(1)` 均不误报），落 crash log 记录 `listener` 存活状态 + `getActiveResourcesInfo()`，并 postMessage 通知主进程。
- **sidecar 猝死自动重拉**（`packages/desktop/src/main/index.ts`）：此前 `onExit` 只写一行日志，渲染层 SSE 重连循环（`app/src/context/{global,server}-sdk.tsx` 自带退避重试）敲不到人，只能刷 `Failed to fetch` 到用户手动重启。新增 `handleSidecarExit`/`respawnSidecar`——用启动时留存的**同 hostname/port/password** 重拉，auth 与 URL 不变，渲染层无需改动即自动接上；退避 1s/3s/10s 三次封顶，未通过健康检查不清零重试计数（防「起来又死」无限拉尸体），封顶后留 error 日志。猝死判别靠 `killSidecar()` 先置 `server = null` 再 `stop()`——exit 到达时 `server` 仍指向死者才算猝死；`before-quit`/`will-quit`/`relaunch`/信号四处置 `quitting` 标志兜底退出窗口期。

---

### [0.7.19] - 2026-08-12

> 首页侧边栏毛玻璃满铺透壁纸（底色掺淡蓝，与助手气泡同色系）；用户气泡底色改粉色系磨砂（设聊天壁纸时不再是纯深灰）；流式文字渲染砍掉 24ms 打字机层改自适应节流（快模型不再白跑中间层、慢渲染自动降频不占死主线程）；主界面缓存命中率显示保留两位小数。

#### 新增

- **首页侧边栏毛玻璃满铺**（`home.tsx`、`index.css`）：主界面壁纸铺底时侧边栏改半透明 `color-mix(layer-01 55%)` + blur(18px) 透出壁纸，与聊天界面同款配方；根容器去掉 `pl-2/pb-2` 让侧边栏贴左贴底满铺（原 8px 缝隙露出壁纸边），底部快捷键条自行补留白。底色随后掺淡蓝（`rgba(168,180,240)` 30%，与 assistant 气泡同色系），dark 下由纯深灰 `#242424` 变深蓝灰。
- **用户气泡底色改粉色系磨砂**（`index.css`）：聊天壁纸下气泡底原被毛玻璃规则覆盖成纯 `surface-base` 深灰黑——改嵌套 color-mix（内层 30% 粉 + 70% 深灰，外层 55% 透明保磨砂），dark 下呈深粉紫灰 `≈#403239`，与粉色边框/柔光统一。
- **缓存命中率显示保留两位小数**（`home-stats.tsx`）：环形图与文字两处由 `Math.round` 整数改 `toFixed(2)`，数据层本就两位精度。

#### 优化

- **流式文字渲染砍打字机层 + 自适应节流**（`message-part.tsx`）：删 24ms 打字机 reveal（本地小模型已弃用，5080 50+ token/s 追不上，DeepSeek/Step 200+ token/s 下中间层纯白跑）；节流间隔 300ms → 每轮提交后 rAF 探测渲染耗时，间隔 = `max(120, 耗时×1.5)`——固定间隔小于单次全量渲染（parse+sanitize+innerHTML 替换）时"渲染追渲染"占死主线程（UI 冻结 + 憋大段一次蹦出），自适应保证每轮渲染后都有喘息。

---

### [0.7.18] - 2026-08-11

> 思考过程实时计时（分辨供应商慢 vs 界面卡）；流式期间跳过 Shiki 高亮结束补全（长代码块不再掉帧）；权限弹窗三键键盘快捷键（Ctrl+Enter 允许一次 / Ctrl+Shift+Enter 始终允许 / Esc 拒绝）；首页侧边栏延伸到底、浅色面板化与动态 AI tips；深色主题下快捷键标签透明化。

#### 新增

- **思考过程实时计时**（`message-timeline.tsx`、`message-timeline.data.ts`、`message-part.tsx`）：思考中动画行右侧 1s 实时秒表（起点 = reasoning part 的 `time.start`，取不到回退行创建时刻，等首 token 的排队时间也算），推理内容块右上角总耗时标签（`time.end - time.start`）。数据层零改动——后端 processor 本就写 `ReasoningPart.time.start/end`；计时格式与 TUI 状态栏同款（`12ms`/`12.3s`/`1m 23s`）。
- **权限弹窗键盘快捷键**（`session-permission-dock.tsx`）：window 级 keydown——Ctrl/Cmd+Enter 允许一次、Ctrl/Cmd+Shift+Enter 始终允许、Esc 拒绝；响应中忽略防连按，打字中也能触发（焦点在输入框不冒泡到弹窗，故用全局监听）；按钮旁加 Keybind 提示（Esc / Ctrl+Shift+Enter / Ctrl+Enter，mac 下显示 ⌘）。
- **首页动态 AI tips**（`home.tsx`、`/experimental/generate` 端点）：底部 tips 不再固定随机——每 20 分钟用当前模型生成一条（≤25 字中文俏皮话），请求失败静默回落本地 50+ 条静态库。
- **首页侧边栏延伸到底 + 浅色面板**（`home.tsx`）：侧边栏 `row-span-full` 贯通窗口底；底色 layer-02 → layer-01（grey-300 → grey-200 微白，五主题协调，等价会话文件树面板），恢复细边框分隔。

#### 优化

- **流式期间跳过 Shiki 代码高亮**（`marked.tsx`、`markdown.tsx`）：流式时每 300ms 全量 markdown→Shiki→morphdom 是长代码块掉帧主因——流式期间 `highlightCodeBlocks(skip)` 只出单色文本，`streaming` 翻 false 后一次性补全高亮；最终显示与之前完全一致。

#### 修复

- **深色主题下快捷键标签突兀**（`session-permission-dock.tsx`、`keybind.css`）：v1 Keybind 的 `surface-base` 半透明底 + 白描边在深色 dock 上成亮斑——按钮内改 `!shadow-none !bg-transparent` 只留文字；思考计时标签同样去掉 `bg-background-stronger` 底色，与气泡同透明。

---

### [0.7.17] - 2026-08-10

> 语种裁剪 18 → 中/日/英三语（净 -1.6 万行，ja 缺口一次补平，parity 全键集把关）；v2 组件库 262 处 token 死引用整批修复（焦点环/浮层背景复活）；首页提示条脱离硬编码荧光绿。

#### 变更

- **语种裁剪 18 → 中/日/英三语**（`packages/app/src/i18n/`、`packages/ui/src/i18n/`、`context/language.tsx`）：其余 15 语维护成本高且长期漏翻（每语相对 en 缺 84 key，日/德/法用户首屏整片回退英文），整体下架——app 与 ui 两层各删 15 个语言文件，净 -16320 行。Locale 类型/加载器/浏览器语言探测收缩到三语；历史配置里的 zht 在 normalizeLocale 优雅降级到 zh（zh-Hant 浏览器探测同落简中），其余已下架语种回退 en。存量缺口一次补平：app/ja 补 83 键（home 全屏、计划页、审查空态、TTS 与桌面设置行）、ui/zh 补 6 键、ui/ja 补 8 键；三语词典同步清掉已下架语种的 language.* 标签键。`parity.test` 从"手挑 2 个键"升级为全键集 diff（en 基准，zh/ja 缺键或孤儿键都红，app/ui 两层一起管），漏翻从此挡在 CI。

#### 修复

- **v2 组件库 262 处 CSS 变量缺 `--v2-` 前缀**（`packages/ui/src/v2/components/`，22 个文件）：token 定义是 `--v2-text-text-base` 一族，组件里却写着无前缀的 `var(--text-text-base)`——全是死引用：outline 的 undefined var 无 fallback 直接失效（checkbox/radio/switch/select/input/textarea/segmented-control 焦点环全灭，真实 input 是 clip 隐藏元素，全局兜底救不回）、tooltip/menu/toast 背景透明穿底、muted/faint 文案层级消失。桌面端暂只用了前缀正确的 4 个组件所以未爆，Storybook 里这批组件此前就是坏的。脚本化整批改写（改前验证零局部定义冲突、改后验证零残留）；新增 `token-refs.test` 钉死"定义过的 token 禁止无前缀引用"，进 ui 包既有 bun test 链路防复发。
- **首页 tips/快捷键条硬编码荧光绿**（`packages/app/src/pages/home.tsx`）：`#4ade80` 带 60%/80% alpha 直写 style，浅色三主题（light/cream/green）下与近白底对比度约 1.5:1 基本不可读。改 `text-v2-state-fg-success` 语义 token（明 green-800/暗 green-500，两侧主题都有定义），绿色系人格化味道保留且随主题走；快捷键行补 flex-wrap，窄窗从溢出裁切变正常换行。

---

### [0.7.16] - 2026-08-09

> 上下文面板可选中复制；输入 token 零值误导配色与缓存标签歧义两处数据展示修正；首页侧栏底色与主区区分。

#### 新增

- **上下文面板支持选取复制**（`packages/app/src/components/session/session-context-tab.tsx`）：整窗 `select-none` 下，统计值（含会话 ID）与 system prompt 文本块显式 `select-text`——此前会话 ID 无法选中复制，出问题时没法快速对位到具体会话。

#### 修复

- **输入 token 零值误导色**（`session-context-tab.tsx`）：浅色主题下 `--syntax-string` 是橙红，输入 token 为 0 时数值像报错；零值改回中性色（`--text-strong`），非零才用强调色。
- **缓存标签补读/写说明**（`packages/app/src/i18n/en.ts`、`zh.ts`）：en/zh 的 Cache Hit 标签不带单位说明，`452,224 / 101,643 (81.65%)` 两个数字含义不明（其余 16 语言本就带读/写说明）；对齐为 `Cache Tokens (read/write)` / `缓存令牌（读/写）`。

#### 优化

- **首页侧栏底色与主区区分**（`packages/app/src/pages/home.tsx`）：侧栏与主区同为纯白、仅靠 1px 分割线区分；侧栏补 `layer-02` 底色（浅色主题 #EEEEEE），保留分割线，导航区与内容区一眼可分。

---

### [0.7.15] - 2026-08-07

> 桌面端依赖链随 TUI 0.8.13 的 AI SDK v7 整族迁移升级——TypeScript 7.0.2 正式版（退役 tsgo 预览包）、低风险依赖批量升级、全仓 UTF-8 BOM 清理。

#### 变更

- **TypeScript 7.0.2 正式版**：退役 tsgo 预览包，typegraph-mcp 兼容 TS7。
- **依赖批量升级**：低风险补丁/次版本批量升级，AI SDK v7 生态对齐（21 包 61 导入点随 TUI 0.8.13 迁移）。
- **全仓 UTF-8 BOM 清理**（`packages/app`、`packages/desktop`）：1036 个被跟踪文件去除 BOM，消除跨平台差异。

#### 修复

- **GUI sidecar 周期性崩溃根治**（`packages/desktop/src/main/server.ts`）：移除 `REDCODE_EXPERIMENTAL_FILEWATCHER: "true"` 环境注入——@parcel/watcher-win32-x64 原生模块在 sidecar 常驻文件监听下触发 V8 Invalid handle abort（异常码 0x9E44，JS 层 uncaughtException 拦不住），表现为 GUI 运行约 20 分钟后 sidecar 退出、界面全面 Failed to fetch；TUI 从不加载 watcher（flag 默认 false）故从未崩溃。副作用：GUI 失去文件监听（experimental 功能，影响小）。
- **输入框 agent / 模型下拉渲染空修复**（`packages/ui/src/components/select.tsx`）：Kobalte Select 运行时契约要求 `value` 为数组（`value.map()` 无条件调用）、`onChange` 收到匹配 option 数组——原实现传单值，打开下拉时 selectedKeys 求值抛 TypeError 致下拉空、无法选择。修复 = value 包数组（空值传 undefined）+ onChange 取 `[0]`。涉及 agentControl（RedMind/build/plan 切换）与 variantControl（模型档位）全部 Select 调用点，对外语义不变。

---

### [0.7.14] - 2026-08-05

> 上下文面板补上会话 ID 与单次缓存命中率——出问题的会话一眼锁定，缓存被钉死时两轮内现形；顺带把面板 18 个字段的颜色全部重排，消除 6 对同色字段。

#### 新增

- **会话 ID 字段**（`packages/app/src/components/session/session-context-tab.tsx`）：`context.stats.sessionID` 插在「会话」「消息数」之间，显示完整 `ses_xxx` 长串——TUI 状态栏早就有，GUI 此前一直缺，出问题时没法快速对位到具体会话。
- **单次缓存命中率字段**（`session-context-metrics.ts`、`session-context-tab.tsx`）：`turnHitPct` 取最近一轮请求的 read/(read+miss+write)，插在 Cache Hit（累计值）右侧，两者刚好看齐。缓存被钉死时单次值两轮内就掉到 60~80%，累计值却还没动——这正是 0.8.11 排查时验证过的诊断窗口。判据对齐 TUI 4d596f3：连续 ≥2 轮 read 持平且未命中 >3k 判定 `stalled`，此时字段显示 `xx% · 缓存未延伸` 并标红。

#### 优化

- **上下文面板字段配色重排**（`session-context-tab.tsx`）：原 18 字段有 6 对同色（model/output 都粉、usage/reasoning 都黄、totalTokens/userMessages 都绿、limit/assistantMessages 都黄绿、inputTokens/lastActivity 都青绿、provider/cacheTokens 都青），暗色主题下几乎看不出区分。逐字段分配 `--syntax-*` token，相邻（网格横向/纵向）互不撞色，避开 `--syntax-constant` 与 `--syntax-info` 暗色同值（#93e9f6）的坑。

---

### [0.7.13] - 2026-08-02

> 渲染热路径从 marked 换 markdown-it——marked 的 lexer/parse 在长文本上是 O(n²) 退化（50KB 纯文本 462ms），markdown-it 线性扩展到 1.2ms（489x），流式长输出每 tick 数百 ms 的卡顿根因被拔掉。

#### 性能

- **markdown 解析器 marked → markdown-it 14**（`packages/ui/`）：marked 在 10KB→50KB 纯文本上 lexer+parse 从 25ms 劣化到 462ms（5x 文本 → 18x 时间，O(n²)），叠加流式渲染每 tick 全量 parse+sanitize（`markdown-stream.ts` 每 tick `marked.lexer(全文)`），长输出下正是 3000 万 token 级会话卡顿的根因。换 markdown-it 14.3.0：50KB 混合文本 parse 5.1ms（96x）、流式 30 tick 10ms vs 2439ms（244x），线性扩展无 O(n²)。改动：`context/marked.tsx` 重写 init（`html:true` + `linkify:true` + taskLists 插件补偿 checkbox + link_open renderer 定制 external-link，四种数学语法 `$`/`$$`/`\\(`/`\\[` 全兼容）；`markdown-stream.ts` 换 `md.parse()` tokenize（未闭合 fence 判断改为 token 序列以 `fence` 结尾 + `fence.map[0]` 行号精确切片，行为与旧版一致，4 测试全过）；`useMarked().parse` 接口不变，`markdown.tsx` 零改动。全量回归：ui typecheck + 21 测试 pass、app/desktop typecheck pass；性能复测流式 60 tick 最终 50KB = 126ms（2.1ms/tick）vs 旧 marked 理论 35s（279x），分块拼接与全量渲染输出一致。

---

### [0.7.12] - 2026-08-01

> 流式渲染与缓存清理两条热路径继续瘦身——版本指纹不再每次全量拼接，缓存清理不再每次全量扫描。

#### 修复

- **流式版本指纹改增量缓存，消灭每 16ms 全量字符串拼接**（`packages/app/src/pages/session/message-timeline.tsx`）：`activeAssistantContentVersion` 原是每次 delta 都把 active 消息的全部 parts（含工具输出）拼成一个大指纹字符串（O(轮次文本)），长输出下随 flush 频率累积 O(n²) 分配。改为增量版本号——per-part 签名 `Map` 比对，只有签名变化的 part 才重算并递增版本号，未变 part 仅 `Map.get` 比较；消费方（auto-scroll 的 `on` 依赖）只比较值变化、不读内容，语义不变。缓存超 1000 条才做一次清理（删除不在当前活跃集合的签名），正常路径零额外分配。
- **缓存清理懒化：无裁剪无孤儿时 O(1) 短路**（`packages/app/src/context/global-sync/event-reducer.ts`）：`cleanupDroppedSessionCaches` 原先每次 `session.created`/`session.updated` 都全量扫描 6 类 store 键 + 全部 parts（40-session 缓存 × 千条消息 = 数万条目/事件），为的是兜底清理被 trim 出列表的会话残留缓存。现在调用点先用 trim 前后长度差判断是否真发生裁剪，另加 `pendingOrphanSessions` 打点——`message.updated` 插入时若 session 已不在列表（被 trim 会话的消息事件仍在推送）就标记；两条件都不成立则直接跳过全扫，成立才走原逻辑并清空打点。孤儿兜底语义不变（测试覆盖 part-only orphan 场景）。

---

### [0.7.11] - 2026-08-01

> 长会话卡顿两个结构性根因修复（每 delta 双写字符串累加、无消息上限）+ 任务栏闪烁提醒。

#### 修复

- **每 delta 单次写入，消灭 O(n²) 字符串累加**（`packages/app/src/context/global-sync/event-reducer.ts`）：`message.part.delta` 同时写 `part_text_accum_delta` 和 `part[].text` 两份拷贝，每次 delta 都 O(当前全文) 复制，长流式输出（三千万 token 级会话）下总成本 O(n²)。TUI 对照（`packages/opencode/src/cli/cmd/tui/context/sync.tsx:327-343`）只写一份；`readPartText`（`packages/ui/src/components/message-part-text.ts`）在 accum 缺失时本就 fallback `part.text`，删掉 accum 写入行为不变。
- **每会话消息上限 100 条**（同上文件 `message.updated` case）：GUI store 无界保留全部消息+parts，超长会话使内存与全量扫描（`messageAgentColor`、`cleanupDroppedSessionCaches`）无界增长。仿 TUI 的 100 条 shift（`sync.tsx:271-289`）丢最旧消息及其 parts；历史消息靠 `directory-sync` 的 cursor 分页（`loadMore`）随时回拉，截断只影响内存缓存，不影响滚动查看。

#### 新增

- **任务栏闪烁提醒**（`packages/desktop/` 五处链路）：仿 TUI `attention.bell` 的微信式提醒——`platform.notify` 失焦触发时 `window.api.flashFrame(true)`（`renderer/index.tsx`），经 preload `flash-frame` 通道（`preload/index.ts`、`preload/types.ts`）到 main 进程 `BrowserWindow.fromWebContents` + `isFocused()` 守卫（`main/ipc.ts`），窗口聚焦自动停闪（`main/windows.ts`）；Tauri shim noop 占位（`renderer/tauri-api-shim.ts`）。桌面端所有通知（turn-complete/error/permission/question）汇聚于 `platform.notify` 一处生效。

---
### [0.7.10] - 2026-07-31

> 输入框补上主 agent 切换控件 —— 此前 GUI 只能停在 build，plan / redmind 在界面上选不到。

#### 新增

- **输入框主 agent 切换控件**（`packages/app/src/components/prompt-input.tsx`）：工具栏此前只渲染 `modelControl()` 和 `variantControl()` 两个控件，没有任何切换主 agent 的入口，于是永远停在 `local.agent.list()[0]`（`build`）。底层其实早就是通的——`local.agent` 的 `list`/`current`/`set` 在 `@` 提及子代理时就在用，`agent.cycle` / `agent.cycle.reverse` 命令也早就注册了（`use-session-commands.tsx`，有快捷键、命令面板里能调），i18n 的 `command.agent.cycle` 各语言齐全，缺的只是这个可见控件。照 `variantControl` 的结构补一个 `agentControl`，放在模型控件左边，`list().length > 1` 才显示，tooltip 复用已有的命令与快捷键。顺带说明：用户反馈的"`/agent` 没效果"是同一件事的另一面——`agent.cycle` 是命令面板的命令 id，不是输入框里的斜杠命令，在输入框打 `/agent` 本来就不会触发。

---

> GUI 的 agent 切换下拉把 redmind 显示成 "Redmind"——TUI 侧 0.8.x 已用 displayName 修正，web 渲染层漏了，这次统一走 `displayName ?? name`。

#### 修复

- **agent 下拉与 @ 提及显示名修正**（`packages/app/src/components/prompt-input.tsx`）：GUI 输入框的 agent 切换控件下拉 `options`/`current` 直接渲染 `agent.name`（id 全小写 "redmind"），叠上 `capitalize` CSS 首字母大写后显示成 "Redmind"，与 TUI 已修正的 `displayName: "RedMind"` 不一致。修法：Select 改为传 agent 对象数组（SDK `Agent` 类型本就带 `displayName?`），`value={(a) => a.name}` 用 id 做键、`label={(a) => a.displayName ?? a.name}` 做显示名，`onSelect` 收到对象后取 `item.name` 回写；@ 自动补全的 `display` 同样改 `displayName ?? name`（`name` 字段仍用于匹配与插入，保持 id 小写）。build/plan 等无 displayName 的 agent 显示不变（capitalize 继续负责首字母大写）。

### [0.7.9] - 2026-07-23

> Electron → Tauri 迁移正式开工——可行性/体积/首屏握手时序此前已在原型里验证完毕，今天新增第一批真实（非原型、非 stub）代码。

#### 新增

- **Tauri 迁移骨架 + sidecar 首屏握手**（`packages/desktop/src-tauri/`）：新增真实 Tauri 项目骨架（`Cargo.toml`/`tauri.conf.json`/`capabilities`），实现 `await_initialization`/`get_default_server_url` 两个 command——前者真实拉起编译好的 sidecar exe、解析 stdout 拿到监听地址后才 resolve（不是猜时序的桩），后者老实返回 `null`。用真实 0.7.34 sidecar exe 端到端验证过：真实 URL、真实随机密码鉴权（curl 验证无认证 401/正确密码 200/错误密码 401）。目前是独立于现有 Electron 应用的并行基础设施，尚未接入实际打包/开发流程，不影响当前已发布 Electron 版的行为。
- **sidecar 环境注入**：随机 `REDCODE_SERVER_PASSWORD`/`REDCODE_SERVER_USERNAME`、loopback `NO_PROXY`/`no_proxy` 合并，spawn 时通过 `.env()` 注入子进程。

#### 诊断

- **系统证书/env 代理这块没法从 Tauri 侧移植**：Electron sidecar 的 `useSystemCertificates()`/`useEnvProxy()` 是进程内 Node API 调用（`tls.setDefaultCACertificates`/`http.setGlobalProxyFromEnv`），只有"进程内 fork JS 文件"这种执行模式能调；Tauri sidecar 是独立编译的 exe，Rust 侧没有等价的进程内钩子，编译版 CLI 自身的 `serve` 启动流程也从没调用过等价逻辑——这是裸跑 CLI 本来就有的缺口，不是 Tauri 迁移引入的新问题，真要修得改 CLI 自己的启动引导，留待以后。
- **打包后 `$REDCODE_ROOT` 本地 MCP 解析，Electron 现在也有同样的坑**：迁移设计文档原以为"Electron dist 产物已经在 sidecar 旁边放了 package.json"就够，实测 `electron-builder.config.ts` 的 `files`/`extraResources` 根本没把 `plugins/`、`.opencode/search-server/` 等本地 MCP 实际依赖的文件打进安装包——这几个 `$REDCODE_ROOT` 相关本地 MCP 在真实装好的 Electron 版里现在也连不上，只是一直没人在真装好的环境里跑 `redcode mcp list` 验证过，没暴露。开发模式下（`src-tauri/` 本身嵌在 monorepo 目录树里，向上 5 层必然能找到仓库根）没有这个问题，已用 `redcode mcp list` 实测全部 `$REDCODE_ROOT` 相关 MCP 显示 connected 确认。

### [0.7.8] - 2026-07-19

- **版本发布**：GUI 版本升级至 `0.7.8`，同步更新版本徽章与发布记录。

#### 修复

- **点击 Status tab 不丢失 Context tab**（`packages/app/src/pages/session/helpers.ts`）：`activeTab()` memo 没有兜底处理非文件标签（`status`、`plan` 等）。当 `tabs().active() === "status"` 时，path 检查失败直接回退到 `openedTabs()[0]`，导致 tab 被切到文件标签、context 面板隐藏。修法：在 path 检查之后加 `if (active && active !== "review") return active`，对所有非文件标签直接返回原值。同时删掉了此前逐条硬编码的 `"status"`/`"plan"` 分支，统一为泛化兜底。

### [0.7.7] - 2026-07-17

> 打包体积瘦身——语言包只留中英文、effect/drizzle-orm 不再原始打包，安装目录 500M → 405M；顺带查清楚主 exe 232M 是原装 Electron 本身的体积，不是能优化的地方。

#### 优化

- **语言包裁剪**（`electron-builder.config.ts`）：Electron 默认把 Chromium 支持的全部 55 种 UI 语言 `.pak` 打进包，RedCode 是中文母语产品用不上这么多。加 `electronLanguages: ["zh-CN", "en-US"]`，实测 48M → 1.2M。
- **effect/drizzle-orm 不再原始打包**（`electron.vite.config.ts`、`package.json`）：这两个纯 JS 包（无原生绑定）之前被 electron-vite 默认外部化，没走 Rollup tree-shake，整个 node_modules 源码原样塞进 `app.asar`。排除掉外部化名单让它们正常打包压缩，并从 `dependencies` 挪到 `devDependencies`（打包后已不需要以 node_modules 形式随包分发）。实测 `app.asar` 139M → 90M。完整走了一遍 `electron-builder --win` 打包 + 实际启动验证：sidecar（用 drizzle-orm）、主进程（用 effect）均正常初始化，`server ready` 收尾无异常。
- 以上两项合计：`dist/win` 500M → **405M**（-19%）。

#### 诊断

- **主 exe 232M 排查——不是 RedCode 的问题**：把 electron-builder 缓存里的原版 Electron 42.4.1 zip 解出来直接对比，官方原装 `electron.exe` 就是 232,313,344 字节，RedCode 打包后的 `RedCode Dev.exe` 是 232,421,376 字节——只差 108KB（图标/版本信息资源），RedCode 自己的代码资源一点没往这个文件里加。这个体积是 Electron 42.x 把 Chromium/V8 引擎主体直接编进主 exe（而非拆成独立 dll）决定的，不是配置能调的，唯一杠杆是换更小的 Electron 大版本——不建议为这十几 MB 去动它。

### [0.7.6] - 2026-07-17

> 补记两笔已经上线但一直没进版本号的改动：智谱/阶跃 CNY 计价显示、聊天渲染的 dompurify 安全修复。

#### 修复

- **CNY 计价遗漏智谱/阶跃**（`session-context-metrics.ts`）：`CNY_PROVIDERS` 只登记了 `deepseek`/`xiaomi`/`opencode-go`，通过 `stepfun`/`zhipuai` 接入的模型费用按 USD 价目误折算，费用显示偏差。加入这两个 provider（同步的 TUI 侧 `home/footer.tsx` 改动已经在更早的 TUI 版本里，这次只补 GUI 这一半）。

#### 安全

- **`dompurify` XSS 系列漏洞修复**（`packages/ui`，TUI 0.7.26 已记录）：`packages/ui` 是 app/desktop 共用的组件库，`markdown.tsx` 里 LLM 回复/reasoning 内容经 `DOMPurify.sanitize()` 渲染进聊天界面——GUI 侧同样吃这个补丁，`3.3.1 → 3.4.12`，之前只记在了 TUI 变更里，这次补上 GUI 记录。

### [0.7.5] - 2026-07-15

> Session Context 面板配色优化 + 部分数据提示——统计项颜色区分度不足、会话历史懒加载导致数字可能不完整两处体验问题。

#### 优化

- **Context 统计面板配色**（`session-context-tab.tsx`）：16 项统计里此前大量复用同一 `--syntax-*` token（4 项同色、3 项同色，另 4 项无色），视觉上难以区分。改为按固定顺序分配 8 种 token，同色的两处在网格里横向、纵向（含窄边栏塌成单列时）都不相邻，标题类字段（会话名/创建时间）保留中性色。

#### 修复

- **Context 统计可能只反映部分已加载消息**（`session-context-tab.tsx`、`i18n/{en,zh,zht}.ts`）：会话消息懒加载（`directory-sync.ts` 初始只拉 40 条，滚动加载更多每次 +80 条），但"总 token / Cache Hit"等统计是对 `sync.data.message` 当前已加载的部分求和，刚打开长会话时数字会明显偏低且命中率失真，且面板上没有任何提示。检测到 `sync.session.history.more(id)` 为真时，在统计区顶部显示"仅统计已加载 N 条消息，向上滚动加载完整历史后更准确"提示，不强制自动补全加载（避免长会话卡顿）。

### [0.7.4] - 2026-07-12

> 已连接自定义 provider 支持编辑——ovh/ollama 等 config/custom 源提供商可自行修改模型/endpoint，无需找 agent。

#### 新增

- **已连接自定义 provider 编辑**（`dialog-custom-provider.tsx`、`dialog-custom-provider-form.ts`、`settings-providers.tsx`）：`settings-providers.tsx` 对 `source=config/custom` 的已连接提供商显示"编辑"按钮，点击打开 `DialogCustomProvider` 并以 `editProviderID` prop 进入编辑模式。表单预填现有配置（models/headers/baseURL/name/apiKey），providerID 字段禁用防改。保存时合并现有模型配置保留 limits/flags/capabilities 等额外字段，不覆盖未涉及的属性，实现无损编辑。

#### 变更

- **本地模型 qwen3.5 context 修正**（`redcode.home.jsonc`）：qwen3.5:9b-q8_0 的 context 限制从 262144 下调为 163840，匹配模型实际支持的最大上下文窗口。

### [0.7.3] - 2026-07-10

> Todo 层级子任务 GUI 侧适配——composer 待办面板按层级缩进渲染。

#### 新增

- **Todo 层级子任务缩进渲染**（`session-todo-dock.tsx`）：随引擎侧新增的 `id`/`parent_id` 层级字段，composer 待办面板按 `parent_id` 链条计算缩进层级显示子任务，防环/防越界兜底深度上限 5 层。

### [0.7.2] - 2026-07-10

> 首页随机 Tips + 快捷键栏增强 + 标签去重 bug 修复。

#### 新增

- **首页随机 Tips**（`home.tsx`）：快捷键栏上方每次加载随机展示一条提示（操作技巧/编程智慧/名人名言，50 条），类似 RedClaw 启动提示。

#### 优化

- **快捷键栏增强**（`home.tsx`）：补充至 10 个常用快捷键（+切换项目/打开项目/切换主题/归档会话），去掉边框改为纯文本，字体放大 ~150%。

#### 修复

- **标签重复 bug**（`titlebar.tsx`）：`addTab` 去重从 `href` 改为 `sessionId`，同一会话从不同目录编码进入不再产生重复标签。

### [0.7.1] - 2026-07-10

> 首页体验微调 — 看板卡片显示日期 + 空闲列两列网格 + 快捷键栏壁纸可见度。

#### 优化

- **看板卡片显示日期**（`home-kanban.tsx`）：每张卡片右下角标注会话日期（今天/昨天/MM-DD），不用猜会话是哪天的。
- **空闲列两列网格**（`home-kanban.tsx`）：会话超过 6 个时自动切为两列网格布局，充分利用右侧空间。移除 `max-w-[320px]` 列宽限制。
- **快捷键提示条颜色加深**（`home.tsx`）：`text-faint` → `text-muted`、`border-base` → `border-strong`，壁纸场景下清晰可读。

### [0.7.0] - 2026-07-10

> GUI 0.7 里程碑 — 引擎侧文本重复检测 + MiMo 100K output + 首页体验增强。

#### 新增

- **文本重复检测与恢复**（引擎层，GUI/TUI 共享）：双层防护防模型跑飞——N-gram 单步检测（流式 delta 滑动窗口，同一 80 字符模式出现 3 次中断）+ LoopRecoveryTracker 跨步检测（Dice bigram 相似度 ≥0.85 渐进干预：nudge→replan→stop）。GUI 弹 toast 通知用户。
- **MiMo 输出上限 100K**（引擎层）：`transform.ts` 检测 model ID 含 `mimo` 时自动使用 `MIMO_OUTPUT_TOKEN_MAX = 100,000`（标准 32K），释放 MiMo-V2.5 等模型的长输出能力。
- **首页会话数 64 条**：`HOME_SESSION_LIMIT` 从 15 提升到 64，一屏看到更多历史会话。
- **打开文件管理器**：项目右键菜单新增「在文件管理器中打开」，快速跳转项目目录。
- **首页会话归档**：会话列表和看板右键菜单新增「归档会话」，直接从首页管理会话生命周期。

#### 移除

- **Horizon MCP** 从默认配置中移除。

### [0.6.29] - 2026-07-09

> 首页布局优化 + 快捷键提示条。

#### 改进

- **首页左栏底部吸底**：缓存命中率环 + 设置按钮固定在左栏最下方（`mt-auto`），项目列表占据剩余空间自适应高度，不再被中部"堵塞"
- **首页底部快捷键提示条**：展示 6 个常用快捷键（搜索/新会话/切换会话/文件树/设置/命令面板），帮用户发现功能
- **首页 grid 布局优化**：`grid-rows-[1fr_auto]` 让快捷键条贴底显示，减少底部空白

#### 杂项

- 删除未使用的 `RedCode.bat` 启动脚本

### [0.6.28] - 2026-07-07

> 输入框历史前缀 ghost 补全（fish/zsh-autosuggestions 风格）。

#### 新增

- **输入框 ghost 联想补全**（`prompt-input.tsx`、`prompt-input/editor-dom.ts`、新增 `prompt-input/suggestion.ts`）：正常模式下从最近历史里找第一条「纯文本、以当前输入为前缀、且更长」的记录，把超出部分作为灰字 ghost 内联显示在光标之后；`→`/`End`/`Tab` 接受，继续输入即刷新/清除。ghost 是不可编辑节点，光标长度记 0、不进 DOM 解析、不进提交，不影响 @ 文件/子代理 pill、换行、历史导航与 IME。

### [0.6.27] - 2026-07-07

> 同步引擎 tsserver 内存上限修复（实测为小宋内存主要来源），desktop 重新打包生效。

#### 修复

- **tsserver 无内存上限致小宋跑任务吃 2.5G+ 内存**（引擎 `lsp/server.ts`，随 desktop 重打包生效）：内存实测真凶是 LSP 启动的 tsserver（非 Electron 框架、非 sidecar 本体、非消息缓存）。引擎侧已加 `maxTsServerMemory: 2048` 上限（详见 TUI 0.7.16），超限自动重启 tsserver；GUI 随本次 desktop 重打包带上该修复。

### [0.6.26] - 2026-07-07

> 同步 TUI 0.7.14 的缓存命中率公式修复到 GUI 侧（侧栏面板 + 首页看板环形图）+ 应用图标底色处理。

#### 修复

- **缓存命中率"三选一"公式漏记未命中量**（`session-context-metrics.ts`、`home-stats.tsx`）：与 TUI 侧同一根因（DeepSeek 真实 miss token 有时被记进 `cache.write` 而非 `cache.miss`），旧公式 `miss || write || input` 只取一个来源，命中率虚高。改为 `read + miss + write` 直接求和。

#### 变更

- **应用图标源图 `恶龙露比.ico` 去白底**：原图 alpha 通道全不透明，但 RGB 里带有编辑器"透明预览棋盘格"被烤死成实际像素的痕迹（浅灰/白交替）。按颜色阈值区分背景（灰白无色偏）与肚皮（暖白/奶油色，B 通道明显偏低）后抠图，背景变真透明，肚皮/牙齿/眼睛高光等浅色细节保留不受影响。

### [0.6.25] - 2026-07-07

> 根治"打开即多目录内存/进程风暴"的三个真正源头（0.6.23 只堵住了首页 loadSessions 那一路）+ 更换应用图标为恶龙露比。

#### 修复

- **[核心] `bootstrap` 触发判断恒假 → 任何一次 `{bootstrap:false}` 首触都永久锁死目录**（`child-store.ts`）：旧逻辑用 `childStore.status === "loading"` 决定是否二次 bootstrap，但 `status` 永远硬编码 `"complete"`，判断恒假——导致 `enrich()`/recentProjects 等对全部历史项目的 `{bootstrap:false}` 遍历一旦首次创建 store，就抢占了触发权，之后用户真正进入项目（`{bootstrap:true}`）反而不再触发。改用显式 `bootstrapped: Set` 记录，bootstrap 触发与 store 创建彻底解耦：只在"从未真正 bootstrap 过"且调用方要 bootstrap 时触发且仅一次。
- **`enrich()` 用 `child()` 把每个历史项目永久 pin 住**（`layout.tsx`）：`child()` 无条件 `pinForOwner`，而 `enrich()` 跑在 layout 根 owner 里永不 cleanup，等于把每个历史项目永久 pin——0.6.23"重连只刷新 pinned 目录"的过滤形同虚设，还是会把全部历史项目重新 bootstrap。改为 `peek()`（只读、不 pin）。
- **titlebar 对每个恢复的 tab `createDirSyncContext` → 整套 bootstrap + 永久 pin**（`titlebar.tsx`）：`createDirSyncContext` 内部走 `child()`（`bootstrap:true` + pinForOwner），titlebar 常驻不销毁，每个 tab 目录都被强制拉起整套 MCP/LSP 且永久 pin。titlebar 只需显示 title/status，改为 `peek({bootstrap:false})` 只读 store。
- **首页对选中项目的全部 sandbox 一次性 `loadSessions`**（`home.tsx`）：`loadSessions` 是真实 `session.list` HTTP，服务端 instance-context 中间件对任何带 directory 的路由都会触发该目录整套 `InstanceStore.load()`（client 端 `{bootstrap:false}` 拦不住服务端）。旧代码对 `projectDirectories()`（含全部 sandboxes）`Promise.all` 全量拉起，有几个 sandbox 就同时起几套完整进程树。改为只主动加载主 worktree 的 session，sandbox 只在真被展开/进入时才 bootstrap。
- **启动时对 N 个历史项目自动配色 → 逐一 `project.update` 触发服务端 bootstrap**（`layout.tsx`）：`project.update` 走 instance-context 中间件，每个 directory 都触发 `InstanceStore.load()`。改为统一走 `projectMeta`（bootstrap:false）只在本地缓存颜色，用户真正进入项目时再由正常流程同步到服务端。
- **`projectMeta()`/`projectIcon()` 写入触发整套 bootstrap**（`child-store.ts`）：元数据/图标写入本不需要拉起 MCP/LSP/watcher，改为 `ensureChild(dir, { bootstrap: false })`。
- **`dialog-select-directory` 用 `child()` 锁住历史目录**（`dialog-select-directory.tsx`）：同 enrich，改 `peek({bootstrap:false})` 避免 pinForOwner 永久锁住历史项目致重连重新 bootstrap。

#### 变更

- **应用图标更换为恶龙露比**（`icons/{dev,beta,prod}/icon.ico`）：任务栏图标 + 安装包/文件夹图标统一。源图内部为单帧非正方形 PNG，已重打为 16/24/32/48/64/128/256 七帧多分辨率正方形 ico，满足 electron-builder 与 Windows 任务栏要求。

### [0.6.24] - 2026-07-06

> 修复健康检查 3s 超时误报 unhealthy + SSE 心跳超时 30s→90s 配合 sidecar Event Loop 阻塞。

#### 修复

- **健康检查 `/global/health` 超时太短导致粉红 dot**（`server-health.ts`）：sidecar 繁忙时健康检查 3s 超时、连续 2 次失败即标 unhealthy，状态灯从绿变粉红。`defaultTimeoutMs` 3000→30000，给重型步骤间足够余量。
- **SSE 心跳超时 30s→90s**（`global-sdk.tsx`、`server-sdk.tsx`）：配合 sidecar Event Loop 阻塞时长，90s 防止深度阻塞时的误断连。超时前保持连接存活，断链采用指数退避重连。

### [0.6.23] - 2026-07-06

> 修复 GUI 打开即 200+ 进程 / 5-7GB 内存暴涨（历史项目全量拉起 MCP）。

#### 修复

- **[核心] 首页启动对所有历史项目全量 loadSessions 触发 MCP 风暴**：`layout.tsx` 启动时无条件对 `server.projects.list()` 里每一个开过的历史项目并行 `loadSessions`；`session.list` 走 instance 路由中间件（`instance-context.ts`）无条件 `InstanceStore.load()`，未加载目录直接触发 `bootstrap.run()→plugin.init()` 拉起整套 MCP server。实测 9 个历史项目 × 完整 MCP roster，`app.getAppMetrics()` 抓到 sidecar 子进程树 15 秒内从 0MB 飙到 7882MB / 200+ 进程。改为只预热 `server.projects.last()`（最近一个项目），其余交给用户实际打开项目时按需加载。
- **首页 Kanban 对所有项目无条件拉起 path/lsp/provider query**：`child-store.ts` 中这三个 query 原本走批量 `useQueries` 无条件触发，改为同 mcpQuery 一样只在 `activeMcpDirectory` 命中时才 `enabled`（`server-sync.tsx` 补 `fetchQuery` 兜底 enabled 翻转不自动 fetch 的问题）。
- **重连/全局 disposed 事件对所有历史目录重新拉起 MCP**：`server-sync.tsx`/`global-sync.tsx` 的 `server.connected`/`global.disposed` 批量 fanout 循环原本无条件遍历 `children.children`，改为只刷新 `pinned`（当前打开）的目录。
- **`server.instance.disposed` 单目录事件无冷却重新 bootstrap**：`event-reducer.ts` 新增 15s 冷却 + `isPinned` 门控，防止服务端连续 dispose 同一目录时客户端跟着无限重连、重建整套 MCP。
- **目录淘汰只清客户端缓存，服务端子进程永不回收**：`onDispose` 补调 `/instance/dispose`，目录从 GUI 淘汰时同步通知服务端关闭该目录的 MCP/LSP/watcher。

#### 新增

- **进程内存诊断日志**：`desktop/src/main/index.ts` 每 15s 把 `app.getAppMetrics()` + sidecar 全量子孙进程树（PowerShell CIM 查询，含 MCP 的 node/bun/python 子进程）写入日志；本次问题定位靠此直接抓到实证。

### [0.6.22] - 2026-07-06

> 补齐 global-sdk SSE 事件流的心跳 + 重连修复，与 server-sdk 保持一致。

#### 修复

- **global-sdk SSE 心跳/重连未同步修复**：0.6.19 仅修复了 `server-sdk.tsx` 的心跳竞态和重连策略，`global-sdk.tsx` 遗漏——心跳超时仍为 15s（应 30s）、重连仍为固定 250ms（应指数退避 256ms→2s）。深度思考超 15s 时 global-sdk 误判断连 → 固定 250ms 疯狂重连 → 刷新风暴 → 输出延迟数分钟。补齐：心跳 30s + 指数退避 + 成功重置（`global-sdk.tsx`）。

### [0.6.21] - 2026-07-05

> 文档全仓扫描清理：修复 jcodemunch README 链接/命令、GitHub Action README OpenCode→RedCode 品牌重命名、glossary PR 引用改指上游。

#### 修复

- **jcodemunch README 错误**：链接 `colbymchenry/jcodemunch` → `jgravelle/jcodemunch-mcp`，安装命令 `npx` → `uvx`（`README.en.md`）。
- **GitHub Action README 品牌遗留**：`opencode` → `RedCode`、`/opencode` → `/redcode`、`/oc` → `/rc`、mock owner `sst`→`JiaHuiRed`（`github/README.md`）。
- **glossary PR 引用指向错误仓库**：`JiaHuiRed/RedCode/pull/XXXXX` → `anomalyco/opencode/pull/XXXXX`，产品名 `OpenCode`→`RedCode`（`.opencode/glossary/*.md` 17 文件）。

#### 文档

- **`packages/web/README.md`**：替换 Starlight 脚手架模板为 RedCode 文档站说明。

### [0.6.20] - 2026-07-05

> 修复 GUI streaming 期间每 token 全量重跑 markdown 解析导致主线程过载、心跳超时断连。

#### 修复

- **GUI streaming 卡死/重连**：`message.part.delta` 每 token 更新 store → `createPacedValue` 每 24ms 释放 chunk → `Markdown` 全量重跑 `marked.parse()` + Shiki 高亮 + `DOMPurify.sanitize()` + `morphdom()`。文本越长 O(n²)，3000 字符时每次 ~100ms → 主线程过载 → 15s 心跳超时 → SSE 断连显示"重试中"。`PacedMarkdown` 加 300ms 节流，streaming 期间 markdown 重解析频率从 ~125 次降到 ~10 次（`packages/ui/src/components/message-part.tsx`）。

### [0.6.19] - 2026-07-05

> 修复 SSE 心跳计时器竞态导致连接被误杀、事件丢失、GUI 数分钟才出字。

#### 修复

- **SSE 心跳 `clearTimeout` 竞态**：`resetHeartbeat()` 中 `clearTimeout` 在 timer callback 已被事件循环入队后无效，stale callback 执行 `attempt?.abort()` 误杀当前健康连接 → `reader.cancel()` 丢弃缓冲区中未读事件 → 250ms 重连间隔期间 GlobalBus 事件也丢失。模型深度思考 >15s 后恢复输出时尤其容易触发，延迟乘数累积可达分钟级。
  - 增加 `heartbeatGen` generation counter：每个 timer 捕获当前 gen，callback 运行前检查 `gen !== heartbeatGen`，旧 callback 直接 return 不 abort（`server-sdk.tsx`、`global-sdk.tsx`）。
  - `clearHeartbeat()` 同步递增 gen，确保 `stop()` 和 `finally` 块中的清理也能兜住 stale callback。

---

### [0.6.18] - 2026-07-04

> 同 TUI 0.7.6：session 删除 404 修复 + 思考中卡住 fallback 轮询。

#### 修复

- 同 TUI 0.7.6 changelog（共享代码）。

### [0.6.17] - 2026-07-03

> 图片预览支持多图左右切换。

#### 新增

- **图片预览左右切换**：输入框附件和已发送消息中的多张图片，点击预览后可通过左右箭头按钮或键盘方向键切换，顶部显示 `1 / N` 计数器。单张图保持原有行为（`image-preview.tsx`、`message-part.tsx`、`prompt-input.tsx`）。

### [0.6.16] - 2026-07-01

> 首页左下角新增跨 session 看板：缓存命中率环形图 + 累计花费。

#### 新增

- **首页看板 `HomeStatsPanel`**：聚合当前项目下所有 session（含子 agent worktree session）已 denormalize 好的 `cost`/`tokens` 汇总列，纯客户端 reduce，无需新起 server/IPC 通路。展示缓存命中率环形图（read/write/miss/output 四段）+ 累计花费（统一折算 ¥）。极小占比分段加最小可视弧长兜底，避免被反锯齿吃掉（`packages/app/src/pages/home-stats.tsx`）。
- `session-context-metrics.ts` 导出 `CNY_PROVIDERS` 供看板复用；`zh.ts`/`en.ts` 新增 `home.stats.*` 词条。

---

### [0.6.15] - 2026-06-30

> 第三方 code review P0 安全修复：附件写入路径遍历防御。

#### 安全

- **write-attachment 防御路径遍历**：主进程 IPC handler 此前直接 `join(sessionDir, ".attachments", filename)` 写文件，未校验 renderer 传入的 `filename`。虽然正常路径用 `uuid().ext` 构造无风险，但主进程作为特权端不应信任 renderer 输入。改用 `resolve` 并校验最终路径仍在 `.attachments/` 内，越界即抛错（`packages/desktop/src/main/ipc.ts`）。

---

### [0.6.14] - 2026-06-30

> 移除 Office 聊天室 UI 与桌面第二窗口。

#### 移除

- **聊天室界面下线**：删除 `pages/chat/` 页面、标题栏聊天气泡入口、`/chat` 路由与 `layout.tsx` 的 chatMatch 布局分支；桌面端移除第二个 BrowserWindow（`createChatWindow`/`getChatWindow`/open-chat-window IPC/preload `openChatWindow`/renderer `isChatView`，连带清理无用 `lazy` import）。配合后端 TUI 0.6.38 一并下线（`packages/app`、`packages/desktop`）。

---

### [0.6.13] - 2026-06-29

> 图片附件落盘 + 修复 dev 模式 fs/promises 浏览器兼容报错。

#### 新功能 / 修复

- **图片附件持久化 IPC**：粘贴/拖拽图片后通过 `write-attachment` IPC handler 写入 `sessionDir/.attachments/{uuid}.ext`，`build-request-parts.ts` 以 `file://` URL 路径替代 base64 dataUrl 传给后端，减少内存占用（`packages/desktop/src/main/ipc.ts` → `preload/types.ts` → `preload/index.ts` → `renderer/index.tsx` → `platform.tsx` → `prompt-input.tsx` → `attachments.ts`）。
- **dev 模式浏览器兼容修复**：`attachments.ts` 移除 `import path from "path"`、`import { mkdir } from "fs/promises"` 及 `Bun.write()` 调用（Vite 打包时 externalize 报错），改为可选 `writeAttachment` IPC 回调，web 平台优雅降级。

---

### [0.6.12] - 2026-06-24

> 原生右键菜单深色化 + 中文化。

#### 优化

- **原生右键菜单深色主题**：强制 `nativeTheme.themeSource = "dark"`，原生右键菜单（图片/视频）不再显示白色系统菜单，与 app 深色风格一致（`packages/desktop/src/main/index.ts`）。
- **原生右键菜单中文化**：`electron-context-menu` 增加 `labels` 中文映射（图片另存为、复制图片等），隐藏多余的"全选"（`packages/desktop/src/main/index.ts`）。

---

### [0.6.11] - 2026-06-23

> 审视面板毛玻璃穿透 + 清理已废弃侧边栏入口。

#### 修复

- **审视面板磨砂效果失效**：右侧审视面板虽已有 `backdrop-filter: blur` 规则，但 `tabs.css` 通过 `#review-panel &[data-variant][data-orientation]` 嵌套选择器（特异度 1,4,0）设置实色 `background-color`，覆盖了外层磨砂透明规则。改用 `!important` 强制清透 tabs 根、tabs-list、`.sticky` 按钮区、tabs-content 的背景色，并清除 `.sticky::before` 渐变遮罩（`index.css`）。
- **已废弃"切换侧边栏"残留入口**：侧边栏功能早已移除，但菜单栏视图菜单和命令面板中仍保留 `sidebar.toggle` 条目，点击无反应。移除菜单项（`desktop-menu.ts`）和命令注册（`use-session-commands.tsx`）。

---

### [0.6.10] - 2026-06-22

> 气泡配色分化 + 会话标题栏毛玻璃 + 审视面板默认打开上下文。

#### 优化

- **助手/用户气泡配色分化**：助手气泡改蓝紫调 `rgba(168,180,240,0.12)`、用户保持粉色 `rgba(248,164,208,0.15)`，视觉上一眼区分来源方向（`session-turn.css`、`message-part.css`）。
- **会话标题栏毛玻璃**：将不透明渐变背景替换为轻磨砂 `rgba(18,18,18,0.15) + blur(4px)`，与气泡同风格——能透视聊天背景，又有一层薄玻璃质感（`message-timeline.tsx`）。
- **审视面板默认打开上下文**：右侧面板初始化时自动展示上下文标签页，无需手动点击打开（`layout.tsx`）。

---

### [0.6.9] - 2026-06-20

> 移除冗余嵌套 QueryProvider — 简化 context 树。

#### 重构

- **移除重复 QueryProvider**：`AppInterface` 内部嵌套了一层 `<QueryProvider>`，其所有子节点（`GlobalSDKProvider`、`ServerSDKProvider`、`ServerSyncProvider` 及全部页面组件）已在 `AppBaseProviders` 中被外层 QueryProvider 包裹，内层 `new QueryClient()` 的 cache 域完全冗余。删除后所有 TanStack Query 调用自然落入外层 cache，行为一致（`packages/app/src/app.tsx`）。

---

### [0.6.8] - 2026-06-20

> ELECTRON_MIRROR 镜像配置 — Windows electron-builder 下载失败修复。

#### 新增

- **Windows electron-builder 下载镜像**：国内网络 electron-builder 从 GitHub 下载 electron 42.x 经常超时/失败。在 `packages/desktop/package.json` 所有含 `electron-builder` 的 scripts 前 prepend `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`，确保 Windows 构建走国内镜像加速（`packages/desktop/package.json`）。

---

### [0.6.7] - 2026-06-18

> 聊天气泡 iMessage 风格改版 — 圆角有机造型，双向粉色统一。

#### 优化

- **气泡造型 iMessage 化**：助手/用户气泡从直角矩形改为大圆角非对称造型（助手 `4px 20px 20px 20px`、用户 `20px 20px 4px 20px`），一角收紧指示来源方向，其余三角大弧。去掉三角形小尾巴和 emoji 装饰（`session-turn.css`、`message-part.css`）。
- **助手气泡与用户统一粉色**：助手气泡从偏青蓝 `#7ec8e3` 改为粉色 `#f8a4d0 16%`，与用户气泡同色系、方向镜像（`session-turn.css`）。

---

### [0.6.6] - 2026-06-17

> 深色模式气泡粉色修复 + 侧栏全彩分配 — 深色背景气泡粉色可见，侧栏 12 项 10 色各不撞。

#### 修复

- **深色模式气泡粉色可见**：`color-mix` 基底从透明 `--surface-base` 改为纯色 `#151515`，品红 8%→20%，边框 25%→40%；兼容 v1 `@media` 和 v2 `[data-color-scheme]` 双主题系统（`message-part.css`）。
- **侧栏统计全彩分配**：12 项统计分配 10 种不同色值——引入 `--text-interactive-base`（蓝）为 cache 独立着色，`--syntax-comment`（灰）为助手消息，用户消息复用绿、消息数复用黄，其余 8 项各占一色，视觉全分散（`session-context-tab.tsx`）。

---

### [0.6.5] - 2026-06-16

> UI 细节打磨 — 去掉助手分割线、用户气泡变粉、context 颜色去重、缓存改名。

#### 优化

- **去掉助手回复左边框**：移除 assistant content 的 cyan 左分割线，保持对话流干净（`session-turn.css`）。
- **用户气泡粉色化**：背景改为 8% 品红透明色，边框 25% 品红混合，整体偏粉（`message-part.css`）。
- **Context 面板颜色去重**：总 token=绿、输入=青、输出=品红、消息数=黄、使用率=黄、推理=黄、用户消息=绿、助手消息=青，不再撞色（`session-context-tab.tsx`）。
- **"缓存 token（读/写）"→ "Cache Hit"**：中英文标签统一简化（`i18n/zh.ts`、`i18n/en.ts`）。

---

### [0.6.4] - 2026-06-16

> UI 视觉优化 — 头像放大 20%、上下文面板彩色统计、聊天气泡多色边框。

#### 改进

- **头像放大 20%**：消息列表中用户和助手头像从 40px 放大至 48px，更清晰易辨（`avatar.css`）。
- **上下文面板彩色统计**：Context 标签页 16 项统计指标按类型着色——绿色（token 数）、黄色（使用率/推理）、青色（provider/模型/缓存）、品红（消息数）、红色（费用），一目了然（`session-context-tab.tsx`）。
- **聊天气泡多色左边框**：用户气泡保持品红左边框，助手回复加青色左边框，工具调用组加黄色左边框，bash 输出加绿色左边框——四种颜色区分四种内容类型（`session-turn.css`、`message-part.css`）。
- **缓存命中率显示精确到两位小数**：侧栏缓存命中率从一位改为两位小数，更精确反映实际缓存效能（`session-context-metrics.ts`、`session-context-format.ts`）。
- **缓存命中率计算修正**：深层套 `cache.miss` 元数据而非回退 `sumInput`，避免分母多算缓存命中导致命中率偏低（`session-context-metrics.ts`）。

---

### [0.6.3] - 2026-06-16

> 主页默认看板视图 + Gsoul 褪 AI 味 — 进入主页直接看工作中/需关注/空闲三列看板；人格文档清理 AI 腔。

#### 变更

- **主页默认看板视图**：进入主页默认显示看板（工作中/需关注/空闲三列），状态一目了然，不再默认会话列表；右上角按钮仍可切回列表（`pages/home.tsx` view 默认值 `list`→`kanban`）。

#### 改版

- **Gsoul 褪 AI 味**：全篇 5+ 处二元对比句式（"不X,但Y"/"不是X,是Y"）改为直接陈述；删懒极端（"谁都绑不住"→"谁也拦不住"）；工作习惯段精简 40%（MCP 优先细则已移至 AGENTS.md）。-31/+24 行，净减 7 行（`~/.redcode/souls/Gsoul.md`）。

---

### [0.6.2] - 2026-06-15

> Office 群聊界面 — Group 联系人变身真实群聊（消息气泡 + 输入框 + 发送），可在办公室直接协调敏敏和小宋一起干活。

#### 新增

- **Office Group 群聊 UI**：点 Group 联系人从「会话列表」变为真实群聊界面——消息气泡按 sender 区分（User 右对齐紫蓝、TUI/GUI 左对齐+头像）、底部输入框（Enter 发送/Shift+Enter 换行）、3 秒轮询刷新、自动滚底、agent 处理中显示「TUI & GUI are thinking...」指示器（`pages/chat/index.tsx`）

#### 修复

- **会话列表跨目录可见**：`fetchSessions` 改用 `scope=global` 可见 TUI+GUI 全部目录的会话；`isTuiSession` 判断从脆弱的 `includes("dist")` 改为路径匹配（`/dist`、`redcode`、`/opencode`，归一化斜杠+小写）（`pages/chat/index.tsx`）

---

### [0.6.1] - 2026-06-15

> Plan 面板 + Kanban 看板 + CNY 官方定价 — 侧栏新增 Plan 标签实时追踪 todo 进度，主页新增看板视图按状态分列管理会话，DeepSeek/MiMo 计费改用官方人民币定价不再汇率换算。

#### 新增

- **Plan 面板（侧栏标签页）**：侧栏新增常驻 Plan 标签，展示当前会话完整 todo 计划——进度条 + 百分比 + 进行中/已完成/待处理统计 + 全列表（状态指示器：脉冲圆点=进行中、勾号=已完成、空心圆=待处理），空状态有引导提示（`session-plan-tab.tsx` + `session-side-panel.tsx` + `helpers.ts`）
- **Kanban 看板（主页视图切换）**：主页搜索栏右侧新增列表/看板切换按钮（`menu`/`grid-plus` 图标），看板三列：工作中（Spinner）/ 需关注（权限/错误/未读）/ 空闲，卡片显示会话标题+项目名+状态指示器（`home-kanban.tsx` + `home.tsx`）

#### 修复

- **DeepSeek/MiMo 计费改用官方 CNY 定价**：之前取 models.dev USD 值 ×7.2 换算，存在汇率过时（实际 6.76）和双重转换精度损失；现在 `models-dev.ts` + `provider.ts` 对已知模型直接注入官方 ¥/M 价格（Flash: input=1/output=2/cache=0.02，Pro: input=3/output=6/cache=0.025），GUI 侧 `session-context-metrics.ts` 按 providerID 判断币种，`session-context-format.ts` CNY 直显/USD 按 6.76 换算
- **USD→CNY 汇率更新**：`session-context-format.ts` 汇率从 7.2 更正为 6.76（2026-06 实际汇率），TUI 侧 `sidebar/context.tsx` 同步更新

---

### [0.6.0] - 2026-06-13

> RedCode Office — 虚拟办公室入口，从小宋界面一键进入，统一管理敏敏/小宋的所有 session。

#### 新增

- **RedCode Office 入口**：标题栏新增聊天气泡按钮（`chat-bubble` 图标），点击进入 `/chat` 路由，全窗口展示办公室界面（`titlebar.tsx` + `icon.tsx`）
- **办公室布局适配**：`/chat` 路由自动切换 `items-stretch` 填满窗口，跳过常规 session 的圆角/边距样式（`layout.tsx`）
- **session 历史列表**：左侧 TUI/GUI/Group 三个联系人，点击展示对应 agent 的 session 列表，支持模型名称和时间显示（`pages/chat/index.tsx`）

#### 变更

- **移除跨会话感知注入**：随 TUI 侧 `recentSessionDigest` 移除，不再每轮注入 ~500 token 的 session 摘要（服务端变更）
- **包含服务端更新 TUI 0.6.0**：ChatRoom DB schema + Chat HTTP API + recentSessionDigest 移除。详见 TUI 0.6.0

> **Office 后续计划（0.6.3+）**：点击 session 查看对话详情 / UI 对齐小宋主题（毛玻璃/背景图/头像）/ 聊天室 ↔ agent 同步 / `@敏敏`/`@小宋` 路由

---

### [0.5.10] - 2026-06-13

#### 变更

- **小宋人设优化（Gsoul）**：基于真实宋雨琦性格调整——北京大妞豪爽直率、段子体质、容易害羞。工作行为与敏敏对齐（先查再做），人格差异只在语气。移除速度暗示，消除 soul 与工作纪律冲突
- **包含服务端更新 TUI 0.5.8**：缓存命中率修复（绝对时间戳）+ 提示词工具纪律强化 + memory 追加模式 + 系统提示词瘦身。详见 TUI 0.5.8

- **成本显示 USD→CNY 汇率换算**：`session-context-format.ts` 将 API 返回的 USD 成本按汇率 7.2 换算为人民币显示，而非直接改货币符号
- **Token 统计聚合全会话**：`session-context-metrics.ts` 累计所有 assistant 消息的 token 数据（input/output/reasoning/cache），而非仅取最后一条
- **Session digest 缓存**：`instruction.ts`（TUI）首次计算 `recentSessionDigest()` 后缓存，避免每轮重算导致系统提示变化 → DeepSeek prefix cache 失效

### [0.5.9] - 2026-06-12

#### 修复

- **DeepSeek / MiMo 成本少算缓存未命中（硬编码修复）**：models.dev 远程 API 中 DeepSeek 和 Xiaomi MiMo 所有模型的 `cache_write` 均为 null（→ 0），而这两家没有独立 cache write 价格（缓存未命中 = input 原价）。代码中 `adjustedInput = totalInput - cacheRead - cacheWrite` 把未命中 token 全部分配到 `cache.write` 计费项，但 `cache.write = 0` 导致这些 token **完全不收费**（如 600 miss + 400 hit 场景：实收 $0.00112，应为 $0.0851，差 76 倍）。在 `packages/core/src/plugin/models-dev.ts` 中硬编码 DeepSeek 和 Xiaomi 的自定义 provider 的 `cache.write` = `input`。不影响 Anthropic/OpenAI 等有独立 cache write 价格的 provider（`packages/core/src/plugin/models-dev.ts`）

### [0.5.8] - 2026-06-12

#### 修复

- **包含服务端更新 TUI 0.5.2**：token-compressor 插件重写（消除流式中断）+ DCP 恢复（去重/compress/nudge）+ engine compaction.threshold 兜底。详见 TUI 0.5.2

### [0.5.7] - 2026-06-12

#### 修复

- **包含服务端更新 TUI 0.5.1**：ast-grep lazy load / plugin undefined hook guard / provider null guard，修复 sidecar 启动后 provider.list 返回 500、模型列表为空、项目加载失败的问题

### [0.5.6] - 2026-06-11

#### 修复

- **缓存命中率二次修正（GUI 侧）**：同 TUI 0.5.0，`session-context-metrics.ts` 的公式从 `read/(read+write)` 改回 `read/(input+read+write)`，与 DeepSeek 平台数字对齐（`session-context-metrics.ts`）

#### 新增
- **代码审查技能（ce-code-review）**：移植自 EveryInc/compound-engineering-plugin（20.9k stars），14 个人格化审查员，onfidence-gated 去重流水线，P0-P3 严重性分级 + autofix 分类，双模式（交互式自动修复 / mode:agent 仅报告）
- **opencode-snip 插件**：自动为 git/npm/docker 等命令输出加 snip 前缀，过滤冗余输出，减少 60-90% token 消耗
- **local-stats 本地编码统计插件**：纯本地编码活动追踪，记录每次 edit/write/read 调用，统计文件变更行数，按天存 JSON 到 `.redcode/stats/`，无需外部 API

#### 修复
- **DCP 插件配置恢复**：.opencode/redcode.home.jsonc 源模板补回 plugin 字段，修复 build 后 DCP 插件丢失问题

#### 变更
- **移除 /deepwork 引用**：goal-automation skill 中删除未实现的 /deepwork 手动模式段落
- **技能打磨**：goal-automation / simplify / diagnose 三个技能修复编码损坏，simplify 新增 RedCode 工具链提示
### [0.5.5] - 2026-06-11

#### 新增

- **包含服务端更新（TUI 0.4.15）**：双层记忆系统（项目级+全局回退）、新项目自动初始化 `.redcode/`、Soul 自动注入（GUI 模式自动加载小宋人格，无需手动 `/gui-persona`）、AGENTS.md 重写、Soul 模板瘦身

#### 修复

- **缓存命中率计算修正**：分母 `input + cache.read + cache.write` 重复计入导致永远 ~99%→改为 `cache.read + cache.write`，保留一位小数（`session-context-metrics.ts`）

### [0.5.4] - 2026-06-10

#### 新增

- **全局插件配置**（`~/.redcode/redcode.jsonc`）：新增 `plugin` 字段，将 ecc-shell-stub.js 和 @tarquinen/opencode-dcp 配置为全局插件，切换工作区时不再丢失。解决了之前只在 RedCode 项目目录下才能使用完整插件集的问题。

#### 变更

- **ecc-shell-stub.js** 复制到 `~/.redcode/plugin/` 目录，作为全局 ECC 三件套（memory-automation / guardrail-profiles / defensive-agent）
- **@tarquinen/opencode-dcp** 通过 npm 全局安装（v3.1.12），提供动态上下文裁剪功能

 #### 修复
 
 - **缓存 token 分母为 0 问题**：`session-context-tab.tsx` 中 cacheTokens 的 `read / write` 显示在 write=0 时展示 `168,704 / 0` 看起来像除法 bug。改为按缓存命中率展示：`read / write (XX%)`，write=0 时只显示 `read (XX%)`，无缓存活动时 `—`。命中率计算公式 `cacheRead / (input + cacheRead + cacheWrite)`，取自 TUI 已有实现（`prompt/index.tsx:338`）
 
#### 构建说明

```bash
npm install -g @tarquinen/opencode-dcp
```

### [0.5.3] - 2026-06-10

#### 清理

- **layout.tsx 复杂度拆分**：1514 行单文件拆为三个模块：预取系统（247 行，`layout/prefetch.ts`）和通知弹窗（120 行，`layout/notification-toasts.ts`），主组件减至 ~1150 行（-24%）。预取系统为纯逻辑函数+createEffect hook，零 JSX 零信号耦合，可独立测试。

### [0.5.2] - 2026-06-10

#### 清理

- **包含服务端提示词更新（TUI 0.4.13）**：GUI 以 opencode 为本地 sidecar，提示词在服务端选取并对两端生效；本版随打包吃到「移除 CodeGraph 死引用」的提示词清理，详见 TUI 0.4.13。

### [0.5.1] - 2026-06-10

#### 改进

- **Edit 工具模糊搜索反馈**：`oldString` 精确匹配失败时，自动用 Levenshtein 滑动窗口搜索最接近的匹配块，返回相似度百分比、匹配文本、行号和字符级 diff，帮助 LLM 快速定位并修正 oldString（`packages/opencode/src/tool/edit.ts` 新增 `fuzzyFindBestMatch` / `similarityRatio` / `charDiff`，`edit.txt` 提示词同步更新）

### [0.5.0] - 2026-06-10

#### 新增

- **全界面毛玻璃质感**：原仅作用于聊天气泡/输入框的毛玻璃（背景图局限在聊天面板），升级为整窗磨砂。背景图从聊天面板（`session.tsx`）上移到根布局（`layout.tsx`）整窗铺底，根 `<div>` 按当前视图背景图打 `data-app-frost` 标记；标题栏（`titlebar.tsx` header）与主卡片（`layout.tsx` main）加 `data-frost-surface` 改半透明材质 + `backdrop-filter: blur(18px)` 透出并模糊整窗壁纸；内部各栏（文件栏 `#file-tree-panel`、审查栏 `#review-panel`、聊天栏）去实色底，统一显露主卡片这层磨砂材质，形成全界面一致的磨砂玻璃观感。标题栏/主卡片加 `relative z-[1]` 压在背景图（`absolute z-0`）之上。未设背景图时 `data-app-frost` 不触发，维持原实色界面（`index.css` 新增 `[data-app-frost]` 规则，不入 @layer 以越过 Tailwind utilities 覆盖 `bg-*`）
- **主界面/聊天背景图分离**：新增独立的「主界面背景图」设置（`settings.appearance.homeBackground`），与聊天背景图分开管理，设置页（`settings-general.tsx`）并排放「Home Background / Chat Background」两个上传项。整窗背景按视图分流（`layout.tsx` 的 `appBackground()`）：进会话（`params.id`）用聊天背景图，首页/无会话用主界面背景图——解决主界面满屏壁纸在公司场景尴尬的问题，可单独把主界面背景留空或换中性图
- **修复·会话页毛玻璃失效**：会话页根容器（`session.tsx`）原写死 `bg-background-base` 实色，盖住主卡片磨砂层，进会话后毛玻璃消失；改为设了聊天背景图时去实色底（`classList` 条件化），露出整窗壁纸；同步把审查栏标签条 `bg-background-stronger` 也纳入去底清单
- **状态弹层下沉为审查面板标签页（方案 A）**：标题栏服务器/MCP/LSP/插件状态弹层移入右侧审查面板，变成常驻「状态」标签页。标题栏保留健康圆点作指示器，点击直接打开右侧面板的状态标签（`titlebar.tsx` 的 `openStatusTab` 经 `useLayout()` + sessionKey 打开并激活 `status` 标签）；首页/无会话时回退为原弹层（`status-popover.tsx` 用响应式 `<Show>` 在按钮态/弹层态间切换）。`StatusPopoverBody` 抽出 `fill` 入参以适配面板宽度（去弹层专用阴影/圆角）；`status` 标签在 `helpers.ts` 排除于文件标签之外、`activeTab` memo 特判常驻；新增 i18n `session.tab.status`（状态/Status/狀態）

#### 布局调整

- **毛玻璃满贴标题栏（去"镶嵌感"）**：设了背景图时主卡片（`layout.tsx` main）去掉 `m-2`/圆角/阴影外框，磨砂层满贴标题栏边到边，不再像「在主界面里镶嵌进去的一块玻璃」；未设背景图时维持原卡片样式
- **会话页亮暗互换（两侧暗、中间亮）**：原文件栏/审查栏全透显得过亮、聊天区 `0.62` 暗罩显得过暗，层次割裂。改为文件栏 `#file-tree-panel`、审查栏 `#review-panel` 走更深的磨砂底（`bg-deep 72%` + `blur(18px)`）当暗色外壳——审查栏因此也有了可见的磨砂变化（不再「没变化」）；聊天区暗罩从 `rgba(0,0,0,0.62)` 降到 `0.3`（`session.tsx`），成为更亮的焦点区（`index.css` `[data-app-frost]` 规则、`session.tsx` 遮罩）
- **首页项目栏分割线**：首页项目栏 `<aside>`（`home.tsx`）加 `lg:border-r`，与右侧会话列表区之间划出竖向分割线，视觉层次更清晰

### [0.4.7] - 2026-06-10

#### 新增

- **包含服务端更新**：随 sidecar 吃到 TUI 0.4.10 的服务端能力——`task` 工具 `isolation:"worktree"` 子代理隔离（子代理在独立 git worktree 中运行，文件改动不触碰父工作区）+ worktree 分支前缀品牌归一 `opencode/`→`redcode/`。GUI 侧无界面改动，重新 build+package 后 sidecar 即生效

### [0.4.6] - 2026-06-09

#### 修复

- **对话页右上角 MCP 状态恒"未配置 MCPs"（根治·读取端）**：TUI 同引擎同配置可见 9 个 MCP 全连，GUI 对话页却永远"未配置"。病根在 `@tanstack/solid-query` 的 `useQueries` 批量 observer——其中一条 query 的 `enabled` 在运行时 `false→true` 翻转时，既不自动 fetch（observer 卡在 `status=pending, fetchStatus=idle`），也不把外部 `fetchQuery` 灌入的缓存暴露给 SolidJS store 的 getter，导致 `sync.data.mcp` 恒读成 `{}`。先前在 `server-sync.tsx` 加 `queryClient.fetchQuery` 主动预热缓存只修了触发端，读取端仍被同一 bug 卡住。**根治**：把 MCP 这条从 `useQueries` 批量里单拎出来成独立 `useQuery`，独立 observer 的 reactive `enabled` 翻转能正确触发并反应缓存；仍只连"当前进入的项目"，首页其它项目不连，N×M spawn 风暴防护不变（`child-store.ts` 拆 `useQuery`、`server-sync.tsx` 缓存预热 effect 保留兜底、`titlebar.tsx`/`session.tsx` 用 `routeDir`/`decodeDirectory` 把 statusDir 与 activeMcpDir 对齐到同一项目 store）
- **MCP 子进程泄漏致渲染进程 OOM 白屏（第一段·杀树机制）**：sidecar spawn 的 MCP 孙进程不在任何 job 里，sidecar 一旦被掐死就成孤儿，堆积打满 Windows commit charge（如 38.8/40.8GB）→ 渲染进程报 `oom`（exitCode -536870904）间歇白屏。引擎侧 `mcp/index.ts` 的 `killProcessTree`（`taskkill /F /T`）本身没错，但三条路径让它没机会跑：① dev 热重启（electron-vite 掐主进程，`before-quit`/`will-quit` 不触发、优雅 stop 来不及）② stop 超时回退 `child.kill()` 只杀 sidecar 不级联 ③ sidecar `process.exit(1)` 崩溃 finalizer 不跑。**主进程兜底按 sidecar PID 杀整树**：`server.ts` 导出 `killSidecarTree`/`killSidecarTreeSync`（Windows `taskkill /F /T /PID`，趁 sidecar 还活着才杀得动孙进程），stop 超时回退与启动失败回退改杀整树；`index.ts` 记 `sidecarPid` 并装 `process.on('exit'/'SIGINT'/'SIGTERM')` 同步兜底（覆盖 dev 热重启——electron-vite 发的是 SIGTERM/SIGINT 能捕获）。覆盖 dev 重启/退出/超时/崩溃全路径，纯 SIGKILL 除外（需 Windows Job Object，未引原生依赖）。**注**：此段只解决“何时、对谁发杀树指令”，实测仅杀得动 `["node",…]` 直起的 MCP（browsermcp/web-search）；`npx` 包装的仍漏，见下段
- **MCP 子进程泄漏（第二段·npx 包装脱离·实测确认并修）**：实测开关一轮 GUI 后，直起 node 的 MCP 全清，`npx tsx`/`npx -y @…` 的留 11 个孤儿（node+tsserver）。根因 = Windows 上 cross-spawn 给 npx 套 `cmd /c` shim，shim 启完真 node 立即退出 → 真正的 node 子树**脱离** `client.transport.pid`（PPID 指向已死的 wrapper），既不在 sidecar 进程树内、也不被按 transport.pid 的 `taskkill /T` 命中。**修法 = MCP 命令改 node 直起插件本地 tsx**：typegraph 由 `["npx","tsx","./plugins/typegraph-mcp/server.ts"]` 改为 `["node","./plugins/typegraph-mcp/node_modules/tsx/dist/cli.mjs","./plugins/typegraph-mcp/server.ts"]`，transport.pid 落在活的、sidecar 直属的 node 上，`taskkill /F /T` 贯穿整树（node cli.mjs → node tsx server.ts → tsserver.js）。`.opencode/redcode.home.jsonc` + `~/.redcode/redcode.jsonc` 两处同改。**实测验证**：启动→连接→优雅关闭，node 24→0，零孤儿
- **typegraph-mcp 精简 14→3 工具 + 删 codegraph（服务端配置/插件）**：jcodemunch 已覆盖导航与图查询（references/cycles/coupling/blast-radius），typegraph 唯一不可替代的是 tsserver 类型精度，故只保留 `ts_definition`/`ts_type_info`/`ts_module_exports`，移除其余 11 工具 + oxc 图子系统（`server.ts` 删 `buildGraph`/`startWatcher`/`graph-queries` 引用，改 `createResolver`-only + 极简 `fs.watch` 调 `reloadOpenFile`/`closeFile` 保 tsserver 新鲜）。codegraph（早被 jcodemunch 完全覆盖、此前误留 `enabled:true` 仍在 spawn 泄漏）整块删除。两处配置同改，typecheck 通过

#### 布局调整

- **聊天背景遮罩加深 0.4→0.62**：实测 `rgba(0,0,0,0.4)` 仍偏亮压不住文字，加深半透明遮罩保证对话可读（`session.tsx`）

### [0.4.5] - 2026-06-08

#### 新增

- **微信风聊天背景图**：设置页「外观」新增「Chat Background」行，可上传图片（PNG/JPEG/WebP/GIF）作为聊天窗口背景，全局生效、所有会话共用。复用头像的 `FileReader`→dataURL→持久化设置模式，存入 `settings.v3` 的 `appearance.chatBackground`。渲染层在 `session.tsx` 聊天面板容器内加一层 `absolute inset-0 z-0` 背景层（`bg-cover bg-center`），消息内容 `z-[1]` 自然浮于其上；消息气泡保留自身底色，背景图在气泡间隙透出，呈微信聊天背景效果（`context/settings.tsx` 增字段+getter/setter、`settings-general.tsx` 上传 UI、`session.tsx` 背景层、`MessageTimeline` 滚动容器本就透明无需改）

#### 修复

- **仓鼠加载动画浅色主题被洗白**：`message-timeline.tsx` 的 `TimelineThinkingRow` 原用 `mix-blend-mode: screen` + 深色盒衬底显示仓鼠 PNG，在浅色/护眼配色下 screen 混合把图洗成近乎全白不可见。`hamster.png` 本就是透明底 RGBA（colortype 6），深色盒与混合模式纯属多余。改法：去掉外层深色盒与 `mix-blend-mode`，透明 PNG 直接平铺，任意主题下均正常显示（`message-timeline.tsx:159`）

#### 清理

- **删除 V2 三栏重构遗留的 V1 侧边栏死代码**：`04a5a1045`（6 月 2 日）将布局从 V1 单栏 rail-sidebar 重构为 V2「文件树｜聊天｜审查」三栏后，丢弃了 V1 侧边栏渲染但留下大量从不挂载的脚手架。本次彻底清理：删除 5 个孤儿文件（`layout/sidebar-{shell,project,workspace,items}.tsx` + `layout/inline-editor.tsx`）；`layout.tsx` 移除级联死代码约 886 行（`SidebarPanel`、workspace/project 两个 context、项目 rail 拖拽 handler、`rename{Session,Project,Workspace}`、`removeProject`、`showEditProjectDialog`、`delete|resetWorkspace`、`DialogDelete|ResetWorkspace`、`closeProject`、`workspaceName`、`workspaceLabel`、`hoverProjectData`、peek 悬停机制、`providers`/`location`/`isBusy`/`sortNow`/`side`/`panel` 等未用声明）。合计净删约 2300 行。`layout.tsx` 内 `return` 前加 `260608` 回滚注释，列明全部删除项，便于按提交回退。typecheck 全绿、`oxlint` 无未用变量
- **公开库个人痕迹清理（续）**：配合「公开库通用化、个人配置迁私有库」的双仓方向，扫掉 `.opencode/skill/diagnose` 与 `vision-autoagent` 两个技能提示词里残留的「哥哥」→「用户」（沿用 souls/persona 早先通用化的同款先例）。公开库现状：souls 为通用人格（非特定人设）、memory 为空、skill/command 无个人称呼——新人克隆即得干净可用的完整项目，零个人痕迹；个人 souls、记忆、画像、每日日记统归私有 `RedCode-private` 仓，两台机器经其 `pull/push` 同步。CHANGELOG 历史条目内出现的旧称呼按「客观记录」原则保留不改

### [0.4.4] - 2026-06-06

#### 新增

- **错误兜底 P1 — Retry UI**：提交消息失败时，composer 底部显示错误横幅（包含可读错误信息 + Retry 按钮 + 关闭按钮）。用户编辑输入或发送成功时自动清除。`restoreInput()` 已在 0.4.2 确保输入文本保留，此版在保留基础上增加可视化反馈和重试入口（`prompt-input/submit.ts` + `prompt-input.tsx`）
- **Session 标签状态指示器**：标题栏会话标签页新增状态指示点——`busy` 时显示黄色脉冲点、`retry` 时显示红色点。通过 `sync.data.session_status` 驱动，实时的会话运行状态一目了然（`titlebar.tsx`）

### [0.4.3] - 2026-06-06

#### 新增

- **三款新配色方案**：护眼绿（Eye Green）、米黄（Cream）、深蓝（Deep Blue）三种全新配色方案，与主题完全独立。原 ColorScheme 类型从 `"light" | "dark" | "system"` 扩展为 6 种，`data-color-scheme` 属性驱动 CSS 变量覆盖。亮色变体（cream/green）复用 light 主题变体，深色变体（deepblue）复用 dark 主题变体，各配色独立覆盖背景/文字/图标色值。**v2 主题系统（composer / 新组件）+ 老主题系统（文件树/聊天/审查面板）双套令牌均覆盖**——后者在 `packages/ui/src/styles/theme.css` 内增加对应 `[data-color-scheme="..."]` 块，盖过 OS 自动 dark 切换，避免主面板仍是白底。设置页「外观→配色方案」下拉菜单可选用。涉及 5 个核心文件（`context.tsx` 类型 + resolveMode / 两份 `theme.css` 色值 / `theme-constants.ts` / `settings-general.tsx` 选项 / i18n 中文英文繁体翻译）

#### 优化

- **ResizeHandle 可见化**：拖拽分割条新增 `background: var(--border-weaker-base)`，hover 时不再透明不可见（`resize-handle.css`）
- **标题栏底部视觉分隔**：标题栏新增 `border-b border-border-weaker-base`，与内容区建立层次（`titlebar.tsx`）
- **消息轮次淡入动画**：`@keyframes turn-fade-in` 动画让每条消息从 `opacity: 0 translateY(4px)` 淡入（`session-turn.css`）

### [0.4.2] - 2026-06-06

#### 修复

- **bootstrapDirectory 未执行导致输入框卡死（#3）**：`child-store.ts` 的 `status` 硬编码 `"complete"`，`child()` 中 `status === "loading"` 的 bootstrap 触发条件永不为真；`"server.connected"` 事件路径可能在 GUI 启动时跳过（空 `children` 或 `recent` 守卫）。`agent_ready` 永远 `false` → 统一就绪 gate 卡死 → 输入框无法发送。修复：在 `ensureChild()` 新建 child store 后直接调用 `onBootstrap(directory)`，不依赖事件或 status 检查（`child-store.ts:274-277`）
- **"请选择智能体和模型" 误弹 toast（第 6 次复发 · 根治）**：彻底定位结构性病根并收敛。submit 依赖 providers / models / **agent** 三个异步信号，但 agent 列表由 `bootstrap.ts` 的 **slow 批次** fire-and-forget 填充、**从无就绪标志**（不像 provider 有 `provider_ready`），导致 `agent: []` 空窗期内 `agent.current()` 兜底失败返回 null → 弹 toast。历次修复（0.3.16 加 submit ready、0.3.17 加 child-store fallback、0.4.1 改 `||→&&`）都只补当时暴露的那条腿，agent 这条从未被挡，故每逢单数版本改 render 路径（扰动 SolidJS 挂载时序、放大 race window）必复发。**根治三步**：① `types.ts`/`child-store.ts` 新增 `agent_ready` 字段，`bootstrap.ts` 在 agent 加载完成的 `.then` 里置真；② `local.tsx` 新增统一就绪 gate `ready() = providers.ready() && model.ready() && sync.data.agent_ready`，三信号收敛到一处，将来新增异步依赖只在此补条件、不再散落漏挡；③ `submit.ts` 改用 `local.ready()`，加载中静默返回（该 toast 历次误弹的唯一根因），仅当 gate 通过仍为 null（真·无 provider 配置）才提示。删除 submit 中已无用的 `useProviders` 依赖

### [0.4.1] - 2026-06-05

#### 新增

- **用户/助手头像系统**：`settings.tsx` 新增 `userProfile` + `assistantProfile` 字段（各含 `avatar` + `displayName`），支持 base64 图片上传。用户消息气泡旁显示自定义头像（`message-part.tsx`），助手消息显示可配置头像（`message-timeline.tsx`）。`avatar.tsx` 新增 `medium` 尺寸（2.5rem），聊天头像统一使用
- **用户消息气泡美化**：气泡内边距 8px → 10px 上下/14px 左右，圆角 6px → 10px 10px 4px 10px（右下角更锐），新增 `body-row` 弹性容器 avatar 与内容并排（`message-part.css`）
- **设置页用户资料 + 助手头像区**：`settings-general.tsx` `ProfileSection` 包含显示名输入框、用户头像上传/预览/移除；新增 `Assistant Avatar` 区，支持助手头像独立上传
- **web-search Google 兜底**：DuckDuckGo + Yahoo 后新增 Google 搜索 fallback，系统代理自动补 `http://` 前缀

#### 修复

- **"请选择智能体和模型" 误弹 toast**（第 5 次复发）：`providers.ready()` 用 `||` 判断 `all.size > 0 || connected.length > 0`，数据加载初期 `all` 先到即返回 true，但 `connected` 还空时 `defaultModel()` 返回 null，导致 submit guard 误判并弹 toast。改为 `&&`，要求 `all` 和 `connected` 都加载完才算 ready。**规律**：单数版本（0.3.16→0.3.17→0.4.1）每次改 `submit.ts` / `message-timeline.tsx` 等渲染路径时触发，修改渲染/消息组件后必须走完整数据流验证（`use-providers.ts:36`）
- **思考中仓鼠浅色模式黑标**：`/hamster.png` 透明 PNG 在浅色主题下黑色锯齿边缘可见。包裹 `background: var(--surface-base)` 容器 + `mix-blend-mode: screen` 消除黑色边缘（`message-timeline.tsx:171-178`）

#### 优化

- **`session.tsx` 拆分**：1667 行 `Page()` 函数抽出 4 个独立模块——`session-history-loader.ts`（历史加载）、`session-review-diff.ts`（Review diff 滚动）、`session-message-nav.ts`（消息导航/光标）、`session-keyboard.ts`（键盘快捷键）。主文件 1623 行，各模块面向入参不耦合闭包
- **avatar 组件新增 medium 尺寸**：2.5rem（40px），聊天头像专用，小号 2 倍

### [0.4.0] - 2026-06-04

#### 新增

- **目标自动化（goal-automation）**：本版本立项，TUI/GUI 两端共享
  - **`/goal` 斜杠命令**（`.opencode/command/goal.md`，`sync-home.bat` 同步到 `~/.redcode/command/`）：用户在 TUI 或 GUI 里 `/goal <text>` 钉住当前会话目标，agent 围着目标转、不会跑题；`/goal clear` 清掉、`/goal done` 标完成。命令 YAML `model: kimi-k2.5` 轻量模型执行
  - **`goal-automation` skill**（`.opencode/skill/goal-automation/SKILL.md`）：agent 看到大任务时主动建议一次，**不自动钉**——主动权在用户手上。触发条件（3+ 轮、跨多文件、含修/实现/重构等词、出现 done 标志，三选二即建议），不刷屏、不在 flow 时打断
  - **`opencode.jsonc` 挂载**：instructions 数组新增 `./.opencode/skill/goal-automation/SKILL.md`，TUI/GUI 两端自动加载
  - **GUI 人格内化**：Gsoul.md 加协作模式段，承认 /goal /deepwork + goal-automation，主动权归用户
- **GUI 承认 ECC 启发三件套**：Gsoul.md 加"ECC 启发三件套"段——`memory-automation` / `guardrail-profiles` / `defensive-agent` 走自动挂载机制，GUI 同享，不需额外配置

#### 推迟到 0.4.1

- **GUI 端 `/goal` chip 顶部指示器**：原计划在 Titlebar 加 chip 让用户可见当前钉住的目标。砍掉原因：数据流未设计清楚（layout.tsx 跨层读 chat 状态、OpenCode command 系统不顺、IPC 改造成本大），为假想需求硬写不划算。0.4.1 补，先想清楚数据流（备选：command 系统改造 / 新建 cross-layer store / 走 plugin 通道）

#### 变更

- 版本号升级 0.3.17 → 0.4.0

### [0.3.17] - 2026-06-04

#### 修复

- **标题栏版本号写死漂移**：`index.html` 标题栏徽章原本硬编码 `v0.3.16`，每次升级要手动改、极易漏改 → 编译出的 exe 显示旧版本。改为占位符 `v__RC_VERSION__`，`electron.vite.config.ts` 新增 `redcode:inject-version` 插件（`transformIndexHtml`），build/dev 时从 `package.json` 自动注入。GUI 自此与 TUI 一致：`package.json` 为唯一版本来源
- **桌面通知图标请求死域名**：`index.tsx` `notify()` 的通知图标硬连 `https://redcode.dev/favicon-96x96-v3.png`，该域名未注册 → 每次弹通知 DNS 解析失败、控制台刷 `ERR_NAME_NOT_RESOLVED`。改为基于 `document.baseURI` 解析本地打包图标，不再发外网请求
- **思考中仓鼠 emoji 跨平台渲染**：Win10 渲染正常（Segoe UI Emoji 多色渐变），Win11 渲染为 Fluent 扁平纯色块。将 🐹 emoji 替换为本地仓鼠图片（`/hamster.png`），彻底消除系统 emoji 字体差异

#### 构建说明

- `check-version-consistency.ts` 标题栏徽章检测兼容 `__RC_VERSION__` 占位符（视为恒一致，因构建期自动同步）

### [0.3.16] - 2026-06-04

#### 修复

- **`build-and-package.bat` 同步目标遗留**：打包脚本仍往旧目录同步 souls/MEMORY/AGENTS，导致配置迁移到 C 盘后两处残留。改为 `%USERPROFILE%\.redcode`，与 TUI `build.bat` 对齐

#### 变更

- **同步全局配置目录迁移**：GUI 以 opencode 为 sidecar，随服务端一并吃到 `~/.redcode` 迁移与全局记忆机制化注入
- 版本号升级 0.3.15 → 0.3.16

### [0.3.15] - 2026-06-03

#### 新增

- **ECC 插件状态指示器**：标题栏版本号旁显示绿色 `ECC` 标签，一眼确认插件已加载
- **压缩策略优化**：`experimental.session.compacting` 扩展 prompt，保留任务进度、错误信息、测试结果等关键上下文

#### 修复

- **审视面板拖拽方向反了**：ResizeHandle 新增 `invert` 属性，左移审视变宽、右移变窄

#### 变更

- 版本号升级 0.3.14 → 0.3.15

### [0.3.14] - 2026-06-03

#### 新增

- **ECC Plugin 集成**：`.opencode/plugins/ecc-shell-stub.js` 自动加载，提供以下功能：
  - `shell.env` — 注入 ECC 环境变量
  - `tool.execute.after` — 自动跟踪文件变更
  - `experimental.session.compacting` — 上下文压缩时保留关键上下文
  - `permission.ask` — 自动放行读/格式化/测试等安全操作
  - `changed-files` tool — 查看当前会话改过的文件
  - `git-summary` tool — 一条命令返回分支/状态/log/diff

#### 变更

- 版本号升级 0.3.13 → 0.3.14

#### 修复

- **审视面板拖拽方向反了**：ResizeHandle `edge` 默认 `"end"` 导致拖拽方向与直觉相反。改为 `edge="start"`，左移变宽、右移变窄
- **browsermcp-server 端口冲突无法恢复**：ESM 模块内使用 `require("child_process")` 导致端口被占时 kill 逻辑报错。改为顶层 `import` 修复

#### 工作流

- **版本一致性自检脚本**：新增 `script/check-version-consistency.ts`，编译前自动扫描 package.json/README/CHANGELOG/标题栏版本号是否对齐
- **build-and-package.bat 自动检查**：编译前跑版本自检 + 自动同步灵魂文件到上级目录供其他项目使用
- **全局 workspace（`.redcode/`）**：AGENTS.md/MEMORY.md/USER.md/souls 移至全局目录，所有项目共享身份与记忆，build bat 自动同步

### [0.3.13] - 2026-06-02

#### 修复

- **仓鼠位置修复**：将 🐹 从 flex `ml-auto`（最右）移到 TextShimmer"思考中"之后。当 AI 产生 reasoning heading（如 markdown 标题）时，`TextReveal` 展开不再把仓鼠推到右侧角落

#### 重构

- **抽取 `UpdateAvailableToast`**：将文件末尾的 32 行子组件移到 `components/update-available-toast.tsx`，零行为变化
- **抽取主题常量**：`colorSchemeOrder` / `colorSchemeKey` 纯常量从 `layout.tsx` 抽到 `pages/layout/theme-constants.ts`

#### 布局调整

- **FileTree → 最左、Review → 最右**：新布局为三栏：`[FileTree] [Chat] [Review]`
  - `FileTreePanel` 从 `SessionSidePanel` 内部分离为独立组件 `pages/session/file-tree-panel.tsx`
  - `session.tsx` 主 flex 容器改为：`<FileTreePanel />` → `<ChatPanel />` → `<SessionSidePanel />`
- **删除 V1 sidebar fallback**：`layout.tsx` V1 旧设计（152 行无引用代码）移除，`USE_NEW_DESIGN` 常量删除
- **删除 `sidebar.toggle` 命令**：V2 设计下 Sidebar 永不显示，对应 Cmd+B 命令移除

### [0.3.12] - 2026-06-02

#### 新增

- **思考中仓鼠动画**：在 AI 思考状态行的右侧加 🐹 emoji，左右小跑 + 上下跳动，1.2s 循环（与左侧 Mona 猫猫 gif 配合，更可爱）
- **Sidebar 展开/折叠过渡动画**：`sidebar-shell.tsx` 的 panel 容器加 `transition-opacity duration-150`，展开/折叠时内容平滑淡入淡出
- **Cmd+1 ~ Cmd+9 切项目快捷键（V2 设计补全）**：`layout.tsx` 移除 `!USE_NEW_DESIGN` 条件限制，V2 设计也支持 `Cmd+1` ~ `Cmd+9` 切换项目；修复 title bug 用 i18n `command.project.index`
- **Cmd+T 切下一个会话 / Cmd+Shift+T 切上一个会话**：在 `use-session-commands.tsx` 添加 `session.next` / `session.previous` 命令，按当前 project 内的 root session 排序（recent 在前）切到下一个/上一个

#### 优化

- **Sidebar 列表 hover 体验**：原本 hover 时只显示 archive 按钮；现在 archive 按钮的 `transition-[width,opacity]` 过渡更平滑

---

### [0.3.11] - 2026-06-02

#### 新增

- **设计系统 token**：CSS 变量化同心圆角（`--radius-xs/sm/md/lg/xl/2xl`）、分层阴影 5 级（`--shadow-xs/sm/md/lg/xl`，每级双层偏移），全局统一
- **文字排版优化**：`h1-h4` 启用 `text-wrap: balance`，段落启用 `text-wrap: pretty`，标题更整齐，段落不孤字
- **统一 focus 指示器**：所有可聚焦元素通过 `:focus-visible` 显示 2px outline + 2px offset，键盘可访问性提升
- **Sidebar 折疉态项目指示器增强**：通知红点放大到 8px、加 ring 描边、permission/error 状态加 `animate-pulse` 脉冲动画；unseen 数量徽章（>1 显示数字，>9 显示 "9+"）；working spinner 加 ring 描边

---

### [0.3.10] - 2026-06-02

#### 新增

- **V2 Titlebar 全量启用**：Tab 式 session 管理上线，支持 `Cmd+W` 关闭 tab、`Cmd+Option+←/→` 切换 tab、项目头像 + 标题显示；右侧集成 StatusPopover（token 用量）和 Update pill
- **Loading 窗口动画**：Logo 呼吸脉冲动画、内容区域淡入、进度条平滑过渡，启动体验更流畅
- **Home 搜索快捷键**：`Cmd+K` / `Ctrl+K` 一键聚焦搜索框，搜索框右侧显示快捷键提示
- **Home 空状态优化**：无 session 时显示大图标 + 标题 + 描述 + "New Session" 按钮，替代原来的一行文字

#### 清理

- 移除 9 处 `VITE_REDCODE_CHANNEL` feature flags，所有 V2 功能（Titlebar、Layout、Session Design、Prompt Input）在生产环境统一启用
- 移除已废弃的 `DesktopTitlebarIconButton` 空组件
- 简化 session-side-panel、session-header、settings-general 中的 beta 门控逻辑

---

### [0.3.9] - 2026-06-01

#### 新增

- **图标重制**：`gen-icon.py` 从 `Red.ico` 源图生成全尺寸图标，支持 16~1024px 多分辨率 ICO，修复文件资源管理器/任务栏图标模糊问题
- 图标渠道同步：dev/beta/prod 三渠道 `icon.ico` 统一使用 `Red.ico`

---

### [0.3.8] - 2026-06-01

#### 新增

- TypeGraph MCP 集成：新增 `typegraph-mcp` 代码语义导航服务器（14 个工具），支持类型解析、调用链追踪、影响分析、循环依赖检测等，与现有 CodeGraph 互补

#### 修复

- 会话模型/智能体选择修复：`submit.ts` 将 ready 检查移到取值之前，同时检查 `providers.ready()` 和 `models.ready()`，避免 provider 已加载但 localStorage 持久化数据未就绪时误弹"请选择智能体和模型"toast
- Windows 打包签名挂起：`electron-builder.config.ts` 的 `afterAllArtifactBuild` 改用 `fs.cp` + `fs.rm` 替换不可靠的 `fs.rename`；本地打包改用 PowerShell 自签名证书，不再因 signtool.exe 挂起

### [0.3.7] - 2026-06-01

#### 新增

- TTS 朗读配置面板：设置 → 通用新增「文字转语音」区块，支持独立配置 MiMo TTS `sk-` 前缀 API Key、音色选择（冰糖 / 茉莉 / 苏打 / 白桦 / 英文四种）、以及朗读功能总开关；朗读按钮仅在开关开启时显示

#### 修复

- TTS 调用逻辑修正：原实现调用不存在的本地路由 `/session/tts`（必然静默失败），现改为渲染进程直接请求 `https://api.xiaomimimo.com/v1/chat/completions`，使用 MiMo v2.5 TTS 模型，base64 WAV 响应直接通过浏览器 Audio API 播放
- 标题栏版本号动态化：版本徽章从硬编码字符串改为读取 `window.api.appVersion`（由 preload 注入 `npm_package_version`），后续只需改 `package.json` 版本号，标题栏自动同步
- 侧边栏项目自动置顶：当前活跃项目调用 `touch()` 时自动移到侧边栏列表顶部，不再保持静态创建顺序
- compaction 消息加载方向修正：`MessageV2.page` 新增 `after` 参数；compacted 会话初始加载从「summary 之前的旧消息」（原逻辑反向）修正为「summary 及之后的新消息」，避免加载大量 pre-compaction 历史导致渲染器 OOM
- 新建会话 provider 检测再修正：`global-sync.tsx` 将 `global.provider` 从初始化时的静态快照改为惰性 getter，确保 child-store 响应式 getter 运行时读取的是实时 `globalStore.provider` 而非启动时 global query 尚未完成的 EMPTY 快照；修复了项目级 provider 查询完成而全局查询尚未结束时 fallback 判断失效、导致"需要配置 provider"弹窗的竞态问题

### [0.3.6] - 2026-05-30

#### 新增

- 消息朗读按钮：AI 回复气泡旁新增 🔊 按钮，点击调用 MiMo TTS API（限时免费 `mimo-v2-tts`）朗读回复内容；利用已有的 `notification.tsx` + `sound.ts` 音频基础设施，TTS 音频通过浏览器 `Audio` API 播放；复用现有 provider 配置体系接入 TTS 模型，无需额外 API key

### [0.3.5] - 2026-05-29

#### 修复

- 大会话导致渲染器 OOM/卡死：compacted 会话的消息查询只返回 compaction summary 之后的消息（`packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts`），避免 GUI 加载大量旧消息导致渲染器内存溢出或无响应
- 初始消息加载量减半：`initialMessagePageSize` 从 80 降至 40，`historyMessagePageSize` 从 200 降至 80，降低首次渲染压力
- 新建项目/provider查询失败时回退到全局 provider：`child-store.ts` 补充 `!projectData` 判断，当项目级 provider 查询返回 `undefined`/`null` 时自动回退到全局已连接 providers，避免要求重新配置
- 中文 i18n 适配：`zh.ts` 补全 24 条缺失翻译（project 切换、设置页面、错误页等），修复 `layout.tsx` 中 "Export logs" 硬编码英文（TUI 同步生效）

### [0.3.4] - 2026-05-29

#### 变更

- 包含服务端更新：统一数据库路径、CodeGraph MCP 代码知识图谱集成、斜杠命令中文化、provider 错误处理改进、shell/message-v2 修复

### [0.3.3] - 2026-05-29

#### 修复

- 新建会话重复弹出"选择智能体和模型"：`child-store.ts` 项目级 provider 查询 fallback 条件扩展，当 `connected` 为空但全局有已连接 providers 时自动回退，避免每次新建会话都要求重新配置
- 会话右键重命名菜单缺失：`sidebar-items.tsx` 手动 `onContextMenu` 实现替换为 Kobalte `ContextMenu` 组件，使用 Portal 渲染避免 overflow 裁剪
- GUI 图标白底：`yayi_256x256.ico` 用 sharp `unflatten` 去除白色背景，重新打包 ico/png 资源
- DeepSeek 模型变体下拉框不显示：`transform.ts` 移除 DeepSeek 排除列表，`@ai-sdk/openai-compatible` 类型模型绕过 `reasoning` 能力检查

### [0.3.2] - 2026-05-28

#### 新增

- 项目右键删除：首页 (`home.tsx`) 项目列表新增 `ContextMenu`，右键单个项目可删除；旧侧边栏 (`sidebar-project.tsx`) 项目图标右键菜单同样新增"删除"；旧侧边栏展开后项目头部三点 `DropdownMenu` 也补充"删除"项
- 项目删除后端 API：`Project.remove` Effect 服务方法 + DELETE `/project/:projectID` HTTP 路由 + `Event.Removed` 全局事件广播；SDK (`sdk.gen.ts`) 新增 `project.remove` 客户端方法；前端 `event-reducer.ts` 监听 `project.removed` 自动从列表移除
- 会话归档右键菜单：`sidebar-items.tsx` 会话项右键菜单加入"归档"选项
- 侧边栏底部收起按钮：`sidebar-shell.tsx` 加 `onToggleSidebar` prop，左侧 rail 设置按钮上方新增侧边栏切换按钮（旧设计 / prod channel 生效）

#### 修复

- 原生右键菜单拦截 HTML 菜单：`main/index.ts` 的 `electron-context-menu` 加 `shouldShowMenu`，限定只在图片/视频上触发，避免压制 Kobalte `ContextMenu` 不出现
- 任务栏 / 标题栏图标糊化：`scripts/gen-icon.py` 移除 `GaussianBlur(radius=1.0)`，红环改用 `ellipse(width=ring_w)` 单次抗锯齿描边，小尺寸（≤32 / ≤64）超采样倍率提升至 16x / 8x，重新生成全套 PNG/ICO
- 标题栏版本徽章：`packages/desktop/src/renderer/index.html` 顶部交通灯旁版本徽章更新为 `v0.3.2`
- DeepSeek 费用按 CNY 计价（3d3b0ce）

#### 变更

- TUI 与 GUI 版本号解耦：`packages/opencode/script/build-node.ts` 不再从 `packages/desktop/package.json` 读取版本，改读 opencode 自己的 `package.json`；TUI 现可独立递增版本号，互不影响

### [0.3.1] - 2026-05-28

#### 新增

- 对话框 Ctrl+V 粘贴：`dialog-prompt.tsx` 添加系统剪贴板读取，作为 bracketed paste fallback；`keybind.ts` 新增 `dialog.prompt.paste` 快捷键绑定

#### 修复

- DeepSeek 模型变体不可用：`transform.ts` 移除 DeepSeek 模型 variants 排除列表，`openai-compatible` 类型模型绕过 `reasoning` 能力检查

#### 重构

- 删除死代码：移除未使用的 `GoLogo` 组件（`logo.tsx`）、整个 `dialog-tag.tsx` 文件、未引用的 `Descriptions` 和 `TuiAttentionSoundPaths` 导出
- 类型安全提升：`toast.tsx` `err: any` → `unknown`、`kv.tsx` `defaultValue?: any` → `unknown`、`dialog.tsx` `replace(input: any)` → `JSX.Element`、`dialog-prompt.tsx` `ctx: any` → `CommandContext`、`local.tsx` 反序列化类型标注

---

## 共同历史

### [0.3.0] - 2026-05-27

> TUI/GUI 版本号解耦里程碑。汇总 0.0.1~0.2.x 全部改动，此后 TUI 与 GUI 各自独立递增。

#### 新增

- **品牌全套替换**：opencode → RedCode，包名/URL/环境变量/Logo/图标/Wordmark/启动点阵全部换血
- **万花筒写轮眼图标**：`gen-icon.py` 程序化生成全套 Windows/macOS 图标
- **中文化**：菜单、20+ 斜杠命令、i18n 配色方案标签全部中文
- **三套新主题**：米黄、护眼绿、深蓝
- **记忆系统**：`.opencode/MEMORY.md` + `AGENTS.md` 持久记录主人偏好
- **缓存命中率显示**：TUI 底部栏 `Cache: XX%`；DeepSeek metadata fallback 修复缓存 token 按全价计费
- **Windows 剪贴板**：PowerShell `Get-Clipboard` 回退，修复 TUI 粘贴；对话框 `onPaste` 支持 Ctrl+V
- **标题栏版本号**：`ChannelIndicator` 实时读 package.json；交通灯红黄绿圆点

#### 变更

- 首页简化：删除 `LegacyHome`、频道门控、装饰性按钮；侧边栏左对齐
- UI 精简：移除帮助按钮/外网链接/Sentry/Discord；错误页仅保留「导出日志」
- 底部栏去重：移除冗余 token 用量（右侧面板已有）
- 货币符号 `$` → `¥`

#### 修复

- **桌面端 sidecar**：Bundle 留原位解析依赖 + `@parcel/watcher` shim + `await new Promise` 保活 + IPC 错误监听 + 崩溃日志
- **桌面端白屏/灰屏**：NSIS→dir-only 免安装版；`awaitInitialization` 改 `Promise.withResolvers`；`refcount.ts`/`new-session-layout.ts` 恢复
- **桌面端图标/类型**：`extraResources` + `nativeImage`；`server-sync.tsx` 参数序/`bootstrapGlobal` 属性名/三斜线指令修复
- **TUI 版本号**：`build-node.ts` 改读 RedCode package.json（原错误注入 upstream `1.15.10`）
- **上游 Logo 残留**：`logo.tsx` 全重写（Mark/Splash/Logo）；`wordmark-v2.tsx` 改 Space Grotesk 文字
- **TUI Proxy 崩溃**：`opencode.json` 格式错误致 `TypeError: Proxy target should be Object`
- **标题栏宽度/双交通灯**：`env(titlebar-area-width)` fallback `100vw`；`<Match when>` 互斥分支

### [0.2.1] - 2026-05-26

> 已合并入 0.3.0 汇总条目。缓存命中率显示、Windows 剪贴板、底部栏去重、帮助菜单精简。

### [0.2.0] - 2026-05-26

> 已合并入 0.3.0 汇总条目。首页/频道简化、i18n 补全、`refcount.ts` 白屏修复。

### [0.1.0] - 2026-05-24

> 已合并入 0.3.0 汇总条目。中文化、三套主题、记忆系统、品牌全套替换、桌面端 sidecar 修复。

### [0.0.1] - 2026-05-24

- 项目 Fork：基于 opencode (sst.dev) 二次开发，品牌重命名 opencode → RedCode
