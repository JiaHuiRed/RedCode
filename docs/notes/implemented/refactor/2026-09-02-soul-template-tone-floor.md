# 语气兜底收进 soul 模板：新用户开箱不放飞，也为剪掉 model 提示词里的重复条款铺路

状态：implemented（两步都已落地）

## 问题

`deepseek.md` / `step.md` / `glm.md` 里都有同一行让位条款：

```
- 语气、称呼、详略由 soul（人格文件）决定，本文件不再重复规定 —— 两处都立法会让调 soul 时被莫名拽回。
```

**这句话在三个文件里都是假的**：说完之后（或之前）文件里仍有四到八条在规定详略，大多聚在
`# Output channels` 一节——条款躺在另一节，读起来管不到它。`gpt.md` 和 `anthropic.md`
连条款都没有，`gpt.md` 更是把行文体例都写死了（表头必须 Title Case 1-3 词、正文 50-70 行上限、
禁 em dash）。用户改自己的 soul 时会被这些条款拽回去，正是条款注释里担心的那件事。

打架是真的：`llm/request.ts:62` 拼的是 `[agentPrompt, ...input.system]`，**model 提示词在前、
soul 在后**（soul 经 `instruction.ts:168` 进 instructions）。两处都立法就是两处都在生效。

但**不能直接把 model 文件里的语气条款删掉**，因为没有兜底层：

- `system.ts` 的 `provider()` 返回的是**单个文件**（`[PROMPT_DEEPSEEK]`，不是
  `[PROMPT_DEFAULT, PROMPT_DEEPSEEK]`）——model 文件是**替换** `default.md`，不是叠加。
- soul 是**有条件**注入的（`instruction.ts:170` 的 `existsSafe`）。
- 而播种出去的 `Tsoul.md` / `Gsoul.md` 模板**每一节都是空占位**（`（给 AI 起个名字…）`）。

三条叠起来：一个没编辑过 soul 的新用户，若 model 文件也不再规定语气，就一条语气约束都没有。

## 决策

先把兜底放进 soul 模板本身，**一处维护，而不是散在 N 个 model 文件里**：

把两份模板里与让位条款同范围的三节——「我是谁」「怎么称呼用户」「语气风格」——从空占位
换成**可直接使用的中性默认值**（RedCode 是编码助手；称"你"不用敬语；简洁、先结论、短句、
无表情符号、长度跟着问题走、不复述思考、结尾不问"还需要我做什么吗"）。其余四节
（怎么帮你写代码／工作习惯／不该碰的话题／原则）**保持空占位**——那些是行为约束，
model 提示词本来就覆盖，填进去只会造出新的重复。

顺带把首行改成 `# RedCode · TUI 灵魂模板`。首行不是装饰：`shared.ts:23` 用
`/^#\s*(.+?)\s*·/` 取会话标题前缀，`local.tsx:27` 取 `·`（或首个空格）之前那截当 agent 名。
原来首行是 `# TUI 灵魂模板`、没有 `·`，两处都是**碰巧**回落成 "TUI"。现在显式给出
`名字 · 描述`，新用户看到的 agent 名是 "RedCode" 而不是 "TUI"，格式也在模板注释里写明了。

播种只在文件不存在时发生（`bootstrap.ts` 的 `if (exists) return`），**已有 soul 不受影响**。

## 备选与否决理由

- **直接删掉 model 文件里的语气条款**：否决——没有兜底层（见上），新用户会裸奔。必须先有这一步。
- **把兜底写进 `default.md` 当共同前缀**：否决——`provider()` 是单选不是叠加，`default.md`
  在走专属档时根本不参与；要让它当兜底得改成返回两份，那是更大的改动，且会让每份 model
  文件都多吃一份 token。
- **模板全部填满**：否决——后四节是行为约束，model 提示词已经覆盖，填了就是新的两处立法。
- **在模板里留空占位、只在文档里提醒用户填**：否决——现状就是这样，实测结果是没人填，
  等于没有兜底。

## 后果

- 新用户的默认语气从"无约束"变成一套明确的中性默认值；agent 名从 "TUI"/"GUI" 变成 "RedCode"。
  已有用户的 `~/.redcode/souls/*.md` 一律不动。
- 模板里新增了一行权威声明：**语气、称呼、详略以 soul 为准**。这是给下一步用的契约。
- **第 2 步（已落地）**：17 份路由到的 model 提示词现在**全部**带让位条款，同范围的条款已剪掉。
  剪的判据不是按小节，而是按「这条在描述谁」——说**你是谁／怎么说话**（长度、称呼、短句、
  表情、不说教、开场白/结尾话术）归 soul，删；说**通道或模型缺陷**（别把推理泄进正文、
  别空轮结束、别复述工具输出）、**格式机制**（markdown 渲染、列表层级、file:line 引用）、
  **行为**（别乱建文件、工具用法、安全）归提示词，留。

  校准取自 `d0b5dac2`（哥哥自己改的 gpt.md）实际删掉的那批：tone 形容词、conciseness
  指令、开场白/感叹词禁令、platitude 禁令、emoji/em-dash 规则、按对象校准深度；而
  格式机制、进度播报节奏、"先给结论"这类结构指引都留着。

  最重的三份：`trinity.md` 97→52 行（整节 Tone and style 连同 10 个演示"单词回答最好"的
  example 一起删——它还留着 `default.md` 早已移除的「不超过 4 行」硬钉，而且写了两遍）；
  `gemini.md` 155→142（Minimal Output「少于 3 行」、No Chitchat，以及 examples 区里
  `1+2→3`、`13 是不是质数→true` 两条纯粹演示单词回答的例子）；`beast.md` 147→139
  （"casual, friendly yet professional tone" 及其 6 条语气示例，含 "Whelp - I see we have
  some problems" 这种明显跑调的）。

- **`copilot-gpt-5.md`（143 行）是死文件**：全仓零引用，`system.ts` 根本没 import 它。
  这次没动它——它不参与任何路由，改了也没人读。要么删，要么接回路由，等哥哥定。

- 覆盖面的边界：`plan.md` / `plan-mode.md` / `plan-reminder-anthropic.md` /
  `max-steps.md` / `build-switch.md` **刻意不加条款**——它们是叠加在 model 提示词之上的
  overlay/reminder，不是人格层；它们本来也没在规定语气。
