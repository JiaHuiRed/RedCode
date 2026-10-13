# 工具描述散在 schema 里的代价审查：一条规则应该住在哪一层

状态:implemented（源码预算门禁与 edit 格式引用落地；规则上提方案因模型覆盖回归已撤回，恢复原描述，见文末。已提交：`9f708820`）

## 问题

起因是一个直觉性的疑问：「工具用法散在 schema 里有什么不好的吗」。散着放看起来很方便——就近、自解释、改工具时顺手改描述。但本仓已经因为「同一条规范三层各说一遍」栽过一次（`prompt.ts:1778` 的 P21 记录：「重复没换来遵守」）。所以值得把这件事量一遍，而不是凭感觉判断。

**第一条判据：删掉这个工具之后，这条规则还成立吗？**

- 成立 → 它是全局规则或跨工具路由规则，放在单个工具的 schema 里是**寄居**——载体错了。
- 不成立 → 它是工具自描述（「这个参数是干嘛的」「本工具的前置条件」），schema 就是它的正确归宿。

这条判据的作用是：它把「散着放好不好」这种口味问题，变成一个可以逐条核对的事实问题。

**第二条判据：搬走之后，谁还看得到它？** 第一条只决定是否属于工具自描述，不决定搬迁后的覆盖面；本仓 `default.md` 不是全模型共享层。下文原提案的上提部分已据此撤回，详见 [第三方复核](../../proposed/architecture/2026-10-13-tool-description-change-audit.md)。

## 原始盘查（顶层口径漏计 shell.md，更正见文末）

体量：`packages/opencode/src/tool/*.md` 共 **24 个文件、24,555 字节、422 行**，由各自的 `*.ts` 以 `import DESCRIPTION from "./x.md" with { type: "text" }` 静态引入，进 system prompt 的工具定义区。

按判据过一遍，落到五类问题。前三类是载体错误，第四类是漂移，第五类是缺预算。

### A. 全局规则寄居在工具 schema 里

「不要随便建文件、优先改现有文件」是一条**与工具无关**的工作规范——删掉 `edit` 和 `write` 工具，这条规则依然成立。但它现在有 **5 处副本、3 种措辞**：

| 位置 | 原文 |
| --- | --- |
| `tool/edit.md:51` | `ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.` |
| `tool/write.md:7` | 与上一行**逐字相同** |
| `session/prompt/default.md:30` | `Never create a file unless it is necessary for the goal — including markdown. Prefer editing an existing file. No summary documents unless asked.` |
| `session/prompt/hy.md:38` | 与 `default.md:30` 逐字相同 |
| `session/prompt/sensenova.md:13` | `NEVER create files unless they are necessary for the goal. Always prefer editing an existing file over creating a new one — including markdown files. Do not write a summary document unless asked.` |

同一判据下更干净的一个例子是 emoji 规则——它**只存在于工具层**，两处，且已经漂移：

- `tool/edit.md:52`：`Avoid adding emojis to files unless asked.`
- `tool/write.md:9`：`Avoid writing emojis to files unless asked.`

「用户没要求就别往文件里塞 emoji」是一条用户偏好，不是 `edit`/`write` 的工具属性。它现在没有全局主人，于是只能靠「两个碰巧都要写文件的工具各自记得说一遍」来维持。**新增第三个写文件的工具（比如 `apply_patch`）时，这条规则不会跟过去。** 这就是载体错误的具体代价——不是理论上的重复，是**规则覆盖会漏**。

### B. 跨工具路由指令写在单工具描述里

「什么时候该用别的工具」是路由决策，需要全局视野；写在单个工具的描述里，等于让模型从某一把锤子的视角去理解整箱工具。

- `tool/grep.md:7`：`If you need to identify/count the number of matches within files, use the Bash tool with rg (ripgrep) directly. Do NOT use grep.`
- `tool/grep.md:8` **和** `tool/glob.md:5`：`When you are doing an open-ended search that may require multiple rounds of globbing and grepping, use the Task tool instead`——**同一句话复制在两处**。
- `tool/read.md:10`：`If you are unsure of the correct file path, use the glob tool to look up filenames by glob pattern.`
- `tool/write.md:6`：`If this is an existing file, you MUST use the Read tool first...`

其中 `grep.md:7` 尤其微妙：它是**唯一一处「本工具不推荐用」的自贬说明**。这种「否定式路由」按说该由全局层统一裁决（本仓已有 `default.md:57` 的「Use dedicated code-navigation, search, and file tools... Use shell for terminal-native work」这条总纲），现在被下沉到 `grep` 一个工具的角落里。

### C. 生产者 / 消费者格式契约分裂在两处

`read` 产出带行号前缀的内容，`edit` 消费它。同一条契约写在两端：

- 生产端 `tool/read.md:11`：`Contents are returned with each line prefixed by its line number as <line>: <content>.`
- 消费端 `tool/edit.md:50`：`The line number prefix format is: line number + colon + space (e.g., 1: ).`

两处用的是**不同的记法**（`<line>: <content>` vs `line number + colon + space (e.g. 1: )`）。契约的单一真源不在任何一处，而是隐含在「两端碰巧描述一致」里。任一端单独改，另一端静默失配——而失败模式是模型照旧用错误格式去编辑，`edit` 报 `oldString not found`，排查时没人会想到是 `read.md` 的描述没跟着改。

### D. 同一条规则多处措辞漂移

跨文件做精确行比对：`tool/*.md` 与 `session/prompt/*.md` 两个集合的**非空行精确交集为 0**。

这个 0 是关键证据：规则明明是重复的（A 类 5 处、emoji 2 处），但**没有一处是逐字复制过来的**——全被各自改写了一遍。也就是说漂移不是「可能发生」，是**已经发生，且是这个仓库的默认演化方式**。行级去重抓不到语义重复，所以人工抽查前它一直是隐形的。

### E. 工具描述没有注入预算

`AGENTS.md` 的「模型可见改动四问」第 4 条是本仓红线：**任何进入模型上下文的东西都必须有确定的字节或 token 上限，没有上限就是缺陷不是待办**。同一条红线还点名了两次翻车（`tool/read.ts` 图片分支无上限、`summary.diffs` 无上限）。

工具描述区目前**没有预算**：24 个 `.md` 自由增长，没有 cap、没有「超过 X 字节需说明」的门禁。24,555 字节按混合文本粗估约 5–7K token，量级不大，但它是**每次请求都付的固定前缀**，且没有任何机制阻止它翻倍。

同时要公允地说：`prompt.ts:1518-1532` 已经做了工具定义**固定**（首步缓存 `description` + `inputSchema`，后续步 overlay），防的是**运行时漂移**（build agent 建文件导致 skill 描述变化 → 整个前缀缓存失效）。但那是防「同一会话内变化」，**不防「内容体量增长」**——两者是不同的问题，别把前者的存在当成后者已被解决。

## 原提案（上提部分已撤回）

**核心动作是把三层拆清楚，各归其位**：

| 层 | 装什么 | 载体 | 单一所有者 |
| --- | --- | --- | --- |
| 工具自描述 | 本工具的语义、参数含义、本工具特有的前置条件与失败模式 | 工具 `.md`（schema） | 各工具自己 |
| 跨工具路由 | 什么时候用 A、什么时候用 B、什么时候别用 | system prompt 的工具总纲段（**一处**） | 全局提示词 |
| 全局策略 | 与工具无关的工作规范（建文件纪律、emoji 偏好、密钥、审批） | system prompt | 全局提示词 |

据此提出四步，**按杠杆从高到低排序**：

1. **给 emoji 规则找主人**（A 类里最干净的切口）。从 `edit.md:52` / `write.md:9` 移到全局层一处，两处工具描述删除。收益直接：规则从此对**所有**写文件的工具生效，包括未来新增的。
2. **把「建文件纪律」收敛到一处**。`default.md:30` 保留为单一真源，删 `edit.md:51` / `write.md:7`（工具自描述里这条属寄居）；顺带把 `hy.md:38` / `sensenova.md:13` 的模型变体副本改为继承而非重写。
3. **把跨工具路由集中到 `default.md` 的工具总纲段**。删 `grep.md:7-8` / `glob.md:5` / `read.md:10` 的路由句，在总纲里统一写清「计数用 rg、开放式多轮搜索用 Task、路径不确定用 glob」。注意 `grep.md:8` 与 `glob.md:5` 是**逐字重复**，合并零信息损失。
4. **行号前缀契约指定单一真源**。以 `read.md`（生产端）为准，`edit.md:50` 改为**引用**而非重述；或反过来，但必须只有一处定义格式。

第 5 类（预算）不是「一步」而是「加一道闸」：给工具描述区设字节/token 上限门禁，与 `bench:budget` 同风格。

## 原提案的模型可见四问（不是本次验收）

按 `AGENTS.md` 要求逐条回答。**注意：全部四步都是模型可见改动，动手前必须答完。**

1. **模型看到什么变了**：净删若干行（emoji 2 处、建文件纪律 2 处、路由 3–4 处），净增约 2–3 行（总纲里补统一路由句 + 全局 emoji 句）。字节净变化预估 **−1KB 上下**，需实测。
2. **token 影响**：固定前缀**减少**（约 200–400 token），用 `session/prefix-shape.ts` 实测确认，别用估算值进 commit。
3. **KV cache 影响**：工具描述区在 system prompt 里、环境块之前还是之后，决定影响面。**若工具定义区位于前缀靠前位置，任何一处改动都会从该点起作废整个后续前缀**——这是本仓红线里「移动一段的代价是从它开始往后的整个前缀作废」的直接适用场景。四步应**合并成一次改动**提交，不要分四次（分四次 = 四次前缀作废）。
4. **注入项有没有硬上限**：这正是第 5 类问题本身。当前**没有上限，按红线定义属于缺陷**。四步只减不增不解决这个问题，需要单独加门禁。

## 备选与否决理由

- **备选 A：维持现状，不动**。否决——但理由要说清：不是「重复本身有害」。如果这些副本能保持同步，重复的代价只是多付几百 token，可以忍。**否决的真实理由是 D 类证据——精确行交集为 0，说明这个仓库的演化方式就是「复制后改写」，同步从来不会自发发生。** 在已经观察到漂移的前提下保留重复，等于把「下次不一致」排进日程。
- **备选 B：全部下沉到工具 schema，让每个工具自足**。否决——与判据直接冲突。删掉工具后仍成立的规则不该住在工具里；且 emoji 这类全局偏好在「新增工具」时会漏（A 类已给出具体失败路径）。
- **备选 C：全部上提到 system prompt，工具描述只留参数说明**。否决——过度纠正。工具特有的前置条件与失败模式（如 `edit.md:53-54` 的 fuzzy match / multiple matches 错误语义、`edit.md:41` 的缩进计数陷阱）**必须**留在 schema：它们只在用这个工具时才成立，且 schema 天然提供「工具被禁用则描述随之消失」的自动门控。判据的「不成立」分支就是为这类内容留的。
- **备选 D：写脚本做语义去重，自动合并**。否决——语义重复没有可靠的机械判据（D 类正是「精确比对抓不到」），自动合并会误伤 C 类那种**看起来重复、实则两端语义不同**的契约。这一步只能人工，判据就是那一句问话。

## 原提案预计后果（未作为现行方案落地）

- **收益**：规则获得单一真源；新增写文件类工具时全局规则自动生效；工具描述区回归「只讲这个工具自己」；前缀 token 略降。
- **代价**：`grep.md:7` 那条「本工具不推荐用」的否定式路由离开 `grep` 的原地后，模型读 `grep` 描述时不再顺带看到——路由总纲必须真的写清，否则是**可发现性下降**。这是本次改动唯一的真实风险点，验收时要专门确认。
- **防复发的识别签名**：**「精确行交集为 0 但语义重复」= 漂移已发生。** 下次再有人往工具描述里加规则，先问判据那句：「删掉这个工具，这条规则还成立吗？」成立就说明放错了层。
- **牵连**：本次是纯提示词可见改动，不碰代码逻辑，但**受 `AGENTS.md` 的四问门禁约束**；落地时需在 commit 说明里逐条回答，并回链本 note。

## 关联

- 判据与「三层分离」的原始来源：`prompt.ts:1778`（P21「同一条规范三层各说一遍，重复没换来遵守」）。
- 前缀缓存固定逻辑（防漂移、不防膨胀）：`prompt.ts:1518-1532`。
- 注入上限红线与两次历史翻车：`AGENTS.md`「模型可见改动的四问」第 4 条。

## 32KiB 源码预算门禁

用户确认采用显式常量 `MAX_TOOL_DESCRIPTION_BYTES = 32 * 1024`，即 **32,768 字节**。实现位于 `script/check-tool-description-budget.ts`；`bun run check:tool-description-budget` 接入 `.husky/pre-push`，扫描失败即停止推送；全仓类型检查现由 CI `typecheck.yml` 兜底。

- **口径**：递归统计 `packages/opencode/src/tool/**/*.md` 的原始 UTF-8 字节，包含 `tool/shell/shell.md`；计换行，不把字符数或粗估 token 数当作字节数。
- **边界**：等于上限通过，超过 1 字节也失败；扫描不到任何描述时失败，避免路径错误变成假绿。脚本路径锚定 `import.meta.dir`，不依赖调用目录。
- **策略**：仅报错，不删除、改写或运行时截断描述；后续要增加预算须显式修改该常量并审查理由。预算变更不随部署自动调整。
- **范围限制**：这只是仓库内静态描述源码的预算，不包含 MCP、插件或运行时动态描述，也不包含参数 schema；不能宣称整个模型工具表已受此上限约束。

复核更正：此前 `24,555 → 23,650` 只统计了顶层 `.md`，漏计 `shell/shell.md` 的 1,293 字节；试改阶段递归口径为 25 个文件、`25,848 → 24,943` 字节。随后按用户选择恢复原规则覆盖，仅保留 edit 的格式引用；**当前 25 个文件合计 25,841 字节，门禁余量 6,927 字节**。门禁不修改模型提示词装配。

验证：`test/script/tool-description-budget.test.ts` 7 pass / 0 fail，覆盖递归扫描、中文 UTF-8、上限前/正好上限/超 1 字节、空扫描失败、超限进程退出码及文件不被改写；根 `typecheck:scripts` 与 opencode `typecheck` 通过（后者由 tsgo 回退 TypeScript）。

模型可见四问（仅本次门禁）：

1. **模型看到什么变了**：提示词、工具 schema 与工具输出均未修改；新增内容只供开发期检查。
2. **token 影响**：固定前缀零变化；32KiB 是源码字节限制，不是实测 token 数。
3. **KV cache 影响**：门禁本身不改变模型输入，不使前缀失效；此前重排的影响须独立验收。
4. **硬上限**：递归静态描述源码总量为 32,768 字节，由 pre-push 执行；不是运行时全工具表的硬上限。

## 覆盖恢复决策

`system.ts` 的独立模型分支不加载 default.md。只把全局规则移到 default.md，会让原本随工具描述可见的规则在这些分支消失。用户选择先恢复覆盖，不为本次重排新增共享产品提示词层。

- 恢复 edit/write 的建文件纪律和 emoji 句，恢复 grep/glob/read 的原路由句。
- 撤销 default.md 的两句新增内容；模型分支及原有提示词不改。
- 保留 edit 对 Read 格式的引用及“不把行号写进匹配内容”的行为要求。
- write 的 Read-first 前置门及文档创建纪律不动；本批不顺带清理独立变体的 DCP 旧指令。

模型可见四问：

1. **内容**：撤回上提试改，回到原工具覆盖；与原 dev 相比，仅 edit 的行号格式句由重述改为引用 Read 定义。
2. **token**：静态描述总字节 `25,848 → 25,841`，净 −7B；未做 tokenizer 或真实请求 token 对照，不声称每请求节省固定 token。
3. **KV cache**：源码需新进程加载；edit 描述变化可能使该工具区开始的缓存前缀一次失效，不改变运行时每轮固定机制。本会话现有缓存数据不能归功于尚未重编的改动。
4. **上限**：32KiB 门禁约束递归静态 Markdown 源码；其他工具表来源及 schema 不在此范围。

验证：compaction、system、system-prompt-routing 三文件 87 pass / 0 fail，opencode typecheck 通过。GPT 测试的旧声线句在 HEAD 中已经缺失，本批将断言对齐当前公共提示词与 Soul 的归属，不修改 GPT 提示词来迁就测试。
